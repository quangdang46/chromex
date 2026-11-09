// result_lost reconcile proof WITHOUT user Chrome: a real Gateway +
// fake extension hosts (same IPC protocol as task-purge).
//
// Proves §4.2 end-to-end:
//   - host drops mid-dispatch → gateway records honest `unknown`
//     (browser.host_lost_after_dispatch), never a guessed failure
//   - a re-registered host is asked browser.tool.reconcile for the
//     tracked unknown calls
//   - host-confirmed outcome amends the durable stream via
//     tool.reconciled; unreported ids stay `unknown` forever
//   - a second reconcile does not double-amend
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway } from "../../packages/bridge/dist/gateway/main.js";
import { GatewayIpc } from "./lib/gateway-ipc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../..");
const ARTIFACT_DIR = join(here, "../../artifacts/acceptance/tool-reconcile", new Date().toISOString().replace(/[:.]/g, "-"));

const results = [];
const note = (m) => { results.push(m); console.log(`  ${m}`); };
const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAIL: ${label}`);
  note(`ok — ${label}`);
};

const BROWSER_ID = "fake-browser-reconcile";
const dataDir = await mkdtemp(join(tmpdir(), "chromex-tool-reconcile-"));
let gateway = null;
const conns = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const hello = (clientId, extra = {}) => ({
  clientId,
  clientVersion: "chromex-tool-reconcile-e2e/0.1.0",
  profileId: "e2e",
  ...extra,
});

async function waitFor(pred, label, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await pred();
    if (v) return v;
    await sleep(150);
  }
  throw new Error(`ASSERT FAIL: timed out waiting for ${label}`);
}

try {
  // sqlite store so the restart leg survives on durable events
  await writeFile(join(dataDir, "gateway.json"), JSON.stringify({ store: "sqlite" }));
  gateway = await startGateway({ dataDir, log: (m) => console.log(`[gw] ${m}`) });
  const ep = gateway.ipc.endpointPath();
  const token = (await readFile(join(dataDir, "auth", "token"), "utf8")).trim();

  const ipc = new GatewayIpc(ep.path, token, hello("tool-reconcile-client"));
  conns.push(ipc);

  // ---- host v1: accepts requests, never answers the held ones ----
  const host1Methods = [];
  const host1 = new GatewayIpc(ep.path, token, {
    ...hello("fake-ext-host-r1"),
    hostInstanceId: "fake-ext-host-r1",
    browserInstanceId: BROWSER_ID,
  });
  conns.push(host1);
  host1.setRequestHandler(async (method, payload) => {
    host1Methods.push(method);
    // Hold forever — the disconnect below is what produces `unknown`.
    if (payload?.args?.hold) return new Promise(() => {});
    return { tabs: [{ id: 7, url: "https://reconcile.test/", title: "R", active: true }] };
  });
  await host1.request("diagnostics.snapshot", {});
  note("ok — host v1 registered");

  const created = await ipc.request("task.create", {
    cwd: REPO,
    title: "tool-reconcile-e2e",
    backend: { backendId: "chrome-extension", pinnedBy: "user" },
    browserInstanceId: BROWSER_ID,
    tabIntent: { scope: "untitled" },
  });
  const taskId = created?.taskId;
  assert(typeof taskId === "string" && taskId.length > 0, `task.create → ${taskId}`);

  const spawnDesc = await ipc.request("browser.mcp.spawn", { taskId });
  const scope = JSON.parse(await readFile(spawnDesc.scopeFile, "utf8"));

  // baseline completes normally
  const ok = await ipc.request("browser.tool.call", {
    taskId, tool: "browser.tabs.list", args: {}, token: scope.token,
    toolCallId: "tc-recon-baseline",
  });
  assert(ok?.status === "completed", `baseline call completed (status=${ok?.status})`);

  // ---- two in-flight calls, then the host vanishes mid-dispatch ----
  const callA = ipc.request("browser.tool.call", {
    taskId, tool: "browser.tabs.list", args: { hold: true }, token: scope.token,
    toolCallId: "tc-recon-a",
  });
  const callB = ipc.request("browser.tool.call", {
    taskId, tool: "browser.tabs.list", args: { hold: true }, token: scope.token,
    toolCallId: "tc-recon-b",
  });
  await sleep(400); // let both dispatches reach host1
  assert(host1Methods.filter((m) => m === "browser.tool.request").length >= 3,
    "host1 received the held browser.tool.request calls");
  host1.close(); // transport loss AFTER dispatch → unknown, not failed
  conns.splice(conns.indexOf(host1), 1);

  const [resA, resB] = await Promise.all([callA, callB]);
  for (const [res, id] of [[resA, "tc-recon-a"], [resB, "tc-recon-b"]]) {
    assert(
      res?.status === "unknown" && res?.error?.code === "browser.host_lost_after_dispatch",
      `${id} resolved unknown/host_lost_after_dispatch (got ${res?.status}/${res?.error?.code})`,
    );
  }
  note("ok — transport loss recorded honest unknown for both calls");

  // ---- host v2 registers (same browserInstanceId) → reconcile ----
  const host2Methods = [];
  const host2 = new GatewayIpc(ep.path, token, {
    ...hello("fake-ext-host-r2"),
    hostInstanceId: "fake-ext-host-r2",
    browserInstanceId: BROWSER_ID,
  });
  conns.push(host2);
  host2.setRequestHandler(async (method, payload) => {
    host2Methods.push(method);
    if (method === "browser.tool.reconcile") {
      const ids = payload?.toolCallIds ?? [];
      // Host truth: tc-recon-a completed; tc-recon-b is NOT in the
      // buffer (e.g. evicted) — it must stay unknown, never guessed.
      return {
        outcomes: Object.fromEntries(
          ids.filter((id) => id === "tc-recon-a").map((id) => [
            id,
            { status: "completed", result: { ok: true, tabs: 1, verified: true } },
          ]),
        ),
      };
    }
    return { tabs: [] };
  });
  await host2.request("diagnostics.snapshot", {});
  note("ok — host v2 registered; reconcile fired on hello");

  // ---- durable stream shows the amendment ----
  const events = await waitFor(async () => {
    const sync = await ipc.request("task.sync", { taskId, fromSeq: 0, maxEvents: 500 });
    const evs = sync?.events ?? [];
    return evs.some((e) => e.type === "tool.reconciled" && e.payload?.toolCallId === "tc-recon-a")
      ? evs
      : null;
  }, "tool.reconciled event for tc-recon-a");

  const reconA = events.find((e) => e.type === "tool.reconciled" && e.payload?.toolCallId === "tc-recon-a");
  assert(reconA?.payload?.outcome === "succeeded", `tool.reconciled outcome=succeeded (got ${reconA?.payload?.outcome})`);
  assert(
    !events.some((e) => e.type === "tool.reconciled" && e.payload?.toolCallId === "tc-recon-b"),
    "no tool.reconciled for unreported tc-recon-b",
  );
  const completedA = events.filter((e) => e.type === "tool.completed" && e.payload?.toolCallId === "tc-recon-a");
  assert(
    completedA.length === 1 && completedA[0].payload?.outcome === "unknown",
    "original tool.completed stays unknown (reconcile amends, never rewrites)",
  );
  assert(host2Methods.includes("browser.tool.reconcile"), "host v2 received browser.tool.reconcile");

  // ---- snapshot merge: amended outcome visible, unreported stays unknown ----
  const snap = await ipc.request("task.snapshot", { taskId });
  const toolCalls = Array.isArray(snap?.toolCalls)
    ? snap.toolCalls
    : Array.isArray(snap?.snapshot?.toolCalls)
      ? snap.snapshot.toolCalls
      : [];
  const byId = Object.fromEntries(toolCalls.map((c) => [c.toolCallId, c]));
  assert(byId["tc-recon-a"]?.outcome === "succeeded",
    `snapshot tc-recon-a outcome=succeeded (got ${byId["tc-recon-a"]?.outcome})`);
  assert(byId["tc-recon-b"]?.outcome === "unknown",
    `snapshot tc-recon-b stays unknown (got ${byId["tc-recon-b"]?.outcome})`);

  // second host registration must not double-amend (unreconciled entry gone)
  const host3 = new GatewayIpc(ep.path, token, {
    ...hello("fake-ext-host-r3"),
    hostInstanceId: "fake-ext-host-r3",
    browserInstanceId: BROWSER_ID,
  });
  conns.push(host3);
  host3.setRequestHandler(async (method, payload) => {
    if (payload?.args?.hold) return new Promise(() => {});
    return { tabs: [] };
  });
  await host3.request("diagnostics.snapshot", {});
  await sleep(600);
  const sync2 = await ipc.request("task.sync", { taskId, fromSeq: 0, maxEvents: 500 });
  const reconCount = (sync2?.events ?? []).filter(
    (e) => e.type === "tool.reconciled" && e.payload?.toolCallId === "tc-recon-a",
  ).length;
  assert(reconCount === 1, `exactly one tool.reconciled for tc-recon-a after re-register (got ${reconCount})`);

  // ---- restart leg: gateway dies with an unknown call in flight;
  // the durable seed must re-queue it for reconcile (§4.2 + §5.6) ----
  host2.close(); // only host3 remains live for this browserInstanceId
  conns.splice(conns.indexOf(host2), 1);
  const callC = ipc.request("browser.tool.call", {
    taskId, tool: "browser.tabs.list", args: { hold: true }, token: scope.token,
    toolCallId: "tc-recon-c",
  });
  await sleep(400);
  host3.close();
  conns.splice(conns.indexOf(host3), 1);
  const resC = await callC;
  assert(
    resC?.status === "unknown",
    `tc-recon-c unknown before gateway restart (got ${resC?.status})`,
  );

  // Gateway restart on the SAME dataDir — durable events survive,
  // in-memory unreconciled/outcomes are rebuilt by seeding.
  await gateway.shutdown("restart leg");
  gateway = await startGateway({ dataDir, log: (m) => console.log(`[gw2] ${m}`) });
  const ep2 = gateway.ipc.endpointPath();
  const token2 = (await readFile(join(dataDir, "auth", "token"), "utf8")).trim();

  const ipc2 = new GatewayIpc(ep2.path, token2, hello("tool-reconcile-client-2"));
  conns.push(ipc2);
  const host4Methods = [];
  const host4 = new GatewayIpc(ep2.path, token2, {
    ...hello("fake-ext-host-r4"),
    hostInstanceId: "fake-ext-host-r4",
    browserInstanceId: BROWSER_ID,
  });
  conns.push(host4);
  host4.setRequestHandler(async (method, payload) => {
    host4Methods.push(method);
    if (method === "browser.tool.reconcile") {
      const ids = payload?.toolCallIds ?? [];
      // Post-restart host truth: BOTH previously-unknown calls
      // actually completed host-side while the gateway was down.
      return {
        outcomes: Object.fromEntries(
          ids
            .filter((id) => id === "tc-recon-b" || id === "tc-recon-c")
            .map((id) => [id, { status: "completed", result: { ok: true, postRestart: true } }]),
        ),
      };
    }
    return { tabs: [] };
  });
  await host4.request("diagnostics.snapshot", {});
  note("ok — gateway restarted; host v4 registered → seeded reconcile fired");

  const events2 = await waitFor(async () => {
    const sync = await ipc2.request("task.sync", { taskId, fromSeq: 0, maxEvents: 500 });
    const evs = sync?.events ?? [];
    const hasB = evs.some((e) => e.type === "tool.reconciled" && e.payload?.toolCallId === "tc-recon-b");
    const hasC = evs.some((e) => e.type === "tool.reconciled" && e.payload?.toolCallId === "tc-recon-c");
    return hasB && hasC ? evs : null;
  }, "post-restart tool.reconciled for tc-recon-b and tc-recon-c");
  for (const id of ["tc-recon-b", "tc-recon-c"]) {
    const ev = events2.find((e) => e.type === "tool.reconciled" && e.payload?.toolCallId === id);
    assert(ev?.payload?.outcome === "succeeded", `post-restart ${id} reconciled succeeded (got ${ev?.payload?.outcome})`);
  }
  assert(host4Methods.includes("browser.tool.reconcile"), "host v4 received browser.tool.reconcile");

  // tc-recon-a was already amended pre-restart — its durable
  // tool.reconciled makes the seed "completed", NOT reconcile-eligible.
  const reconA2 = events2.filter((e) => e.type === "tool.reconciled" && e.payload?.toolCallId === "tc-recon-a");
  assert(reconA2.length === 1, `tc-recon-a still has exactly one reconciled after restart (got ${reconA2.length})`);

  const snap2 = await ipc2.request("task.snapshot", { taskId });
  const toolCalls2 = Array.isArray(snap2?.toolCalls) ? snap2.toolCalls : [];
  const byId2 = Object.fromEntries(toolCalls2.map((c) => [c.toolCallId, c]));
  assert(byId2["tc-recon-b"]?.outcome === "succeeded", `post-restart snapshot tc-recon-b=succeeded (got ${byId2["tc-recon-b"]?.outcome})`);
  assert(byId2["tc-recon-c"]?.outcome === "succeeded", `post-restart snapshot tc-recon-c=succeeded (got ${byId2["tc-recon-c"]?.outcome})`);

  await ipc2.request("task.purge", { taskId }).catch(() => {});

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "tool-reconcile", status: "PASS", asserts: results.length, taskId }, null, 2),
  );
  console.log(`\nTOOL-RECONCILE: PASS (${results.length} asserts)`);
} catch (err) {
  await mkdir(ARTIFACT_DIR, { recursive: true }).catch(() => {});
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "tool-reconcile", status: "FAIL", error: String(err?.stack ?? err), asserts: results }, null, 2),
  ).catch(() => {});
  console.log(`\nTOOL-RECONCILE: FAIL — ${err?.stack ?? err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  for (const c of conns) { try { c.close(); } catch {} }
  try { await gateway?.shutdown("e2e done"); } catch {}
  try { await rm(dataDir, { recursive: true, force: true }); } catch {}
}
process.exit(process.exitCode ?? 0);
