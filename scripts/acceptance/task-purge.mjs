// task.purge lifecycle proof WITHOUT user Chrome: a real Gateway + a
// fake extension host (same IPC protocol as gateway-host-routing).
//
// Proves the purge path end-to-end:
//   - in-flight browser.tool.call resolves `unknown`
//     (browser.cancel_unconfirmed) and the host gets browser.tool.cancel
//   - task.get / task.sync / task.snapshot.chunk all → task.not_found
//   - second purge → task.not_found (idempotent refusal)
//   - MCP scope file deleted; gateway.task_purged tombstone replayable
//   - gateway stays healthy: a fresh task works afterwards
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway } from "../../packages/bridge/dist/gateway/main.js";
import { GatewayIpc } from "./lib/gateway-ipc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../..");
const ARTIFACT_DIR = join(here, "../../artifacts/acceptance/task-purge", new Date().toISOString().replace(/[:.]/g, "-"));

const results = [];
const note = (m) => { results.push(m); console.log(`  ${m}`); };
const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAIL: ${label}`);
  note(`ok — ${label}`);
};

const HOST_ID = "fake-ext-host-purge";
const BROWSER_ID = "fake-browser-purge";
const dataDir = await mkdtemp(join(tmpdir(), "chromex-task-purge-"));
let gateway = null;
const conns = [];
let taskIdForDebug = null;

const hello = (clientId) => ({ clientId, clientVersion: "chromex-task-purge-e2e/0.1.0", profileId: "e2e" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  gateway = await startGateway({ dataDir, log: (m) => console.log(`[gw] ${m}`) });
  const ep = gateway.ipc.endpointPath();
  const token = (await readFile(join(dataDir, "auth", "token"), "utf8")).trim();

  const ipc = new GatewayIpc(ep.path, token, hello("task-purge-client"));
  conns.push(ipc);

  // fake host — slow only for the marked in-flight call
  const hostMethods = [];
  const host = new GatewayIpc(ep.path, token, {
    ...hello(HOST_ID),
    hostInstanceId: HOST_ID,
    browserInstanceId: BROWSER_ID,
  });
  conns.push(host);
  host.setRequestHandler(async (method, payload) => {
    hostMethods.push(method);
    if (method === "browser.tool.cancel") return { cancelled: true };
    if (payload?.args?.slow) {
      await sleep(30_000); // purge must not wait for this
      return { tabs: [] };
    }
    return { tabs: [{ id: 7, url: "https://purge.test/", title: "P", active: true }] };
  });
  await host.request("diagnostics.snapshot", {});
  note("ok — fake host registered");

  const created = await ipc.request("task.create", {
    cwd: REPO,
    title: "task-purge-e2e",
    backend: { backendId: "chrome-extension", pinnedBy: "user" },
    browserInstanceId: BROWSER_ID,
    tabIntent: { scope: "untitled" },
  });
  const taskId = created?.taskId;
  taskIdForDebug = taskId;
  assert(typeof taskId === "string" && taskId.length > 0, `task.create → ${taskId}`);

  // MCP scope (token source for direct browser.tool.call)
  const spawnDesc = await ipc.request("browser.mcp.spawn", { taskId });
  assert(spawnDesc?.scopeFile && existsSync(spawnDesc.scopeFile), "scope file written");
  const scope = JSON.parse(await readFile(spawnDesc.scopeFile, "utf8"));

  // baseline: task readable + a normal tool call completes
  const got = await ipc.request("task.get", { taskId });
  assert(got?.task?.taskId === taskId, "task.get before purge");
  const call1 = await ipc.request("browser.tool.call", {
    taskId, tool: "browser.tabs.list", args: {}, token: scope.token,
  });
  assert(call1?.status === "completed", `baseline tool call completed (status=${call1?.status})`);

  // ---- in-flight call + purge → unknown + host cancel ----
  const inflight = ipc.request("browser.tool.call", {
    taskId, tool: "browser.tabs.list", args: { slow: true }, token: scope.token,
  });
  await sleep(400); // let dispatch reach the host
  const purgeRes = await ipc.request("task.purge", { taskId });
  assert(purgeRes?.purged === true, "task.purge returned purged:true");
  const inflightRes = await inflight;
  assert(
    inflightRes?.status === "unknown" &&
      String(inflightRes?.error?.code ?? "").includes("cancel"),
    `in-flight call resolved unknown/cancel_unconfirmed (got ${inflightRes?.status}/${inflightRes?.error?.code})`,
  );
  assert(
    hostMethods.includes("browser.tool.cancel"),
    "host received browser.tool.cancel for the in-flight call",
  );

  // ---- post-purge surface: everything task-scoped is gone ----
  for (const [method, payload, label] of [
    ["task.get", { taskId }, "task.get"],
    ["task.sync", { taskId, fromSeq: 0, maxEvents: 10 }, "task.sync"],
    ["task.snapshot", { taskId }, "task.snapshot"],
    ["task.purge", { taskId }, "second task.purge"],
  ]) {
    try {
      await ipc.request(method, payload);
      throw new Error(`ASSERT FAIL: ${label} did not reject after purge`);
    } catch (e) {
      assert(String(e?.message ?? e).includes("task.not_found") || e?.code === "task.not_found",
        `${label} → task.not_found after purge`);
    }
  }
  assert(!existsSync(spawnDesc.scopeFile), "MCP scope file deleted on purge");

  // tombstone replayable on the gateway stream
  const gsync = await ipc.request("gateway.sync", { fromSeq: 0, maxEvents: 500 });
  const tomb = (gsync?.events ?? []).find(
    (e) => e.type === "gateway.task_purged" && e.payload?.taskId === taskId,
  );
  assert(!!tomb, "gateway.task_purged tombstone present in gateway.sync replay");

  // chunk RPC refuses dead taskIds even with a bogus ref
  try {
    await ipc.request("task.snapshot.chunk", { taskId, snapshotRef: "snap_x", chunkIndex: 0 });
    throw new Error("ASSERT FAIL: snapshot.chunk served a purged task");
  } catch (e) {
    assert(String(e?.message ?? e).includes("task.not_found") || e?.code === "task.not_found",
      "task.snapshot.chunk → task.not_found for purged task");
  }

  // ---- gateway still healthy ----
  const next = await ipc.request("task.create", {
    cwd: REPO,
    title: "post-purge",
    backend: { backendId: "chrome-extension", pinnedBy: "user" },
    browserInstanceId: BROWSER_ID,
    tabIntent: { scope: "untitled" },
  });
  assert(typeof next?.taskId === "string" && next.taskId !== taskId, "fresh task.create works after purge");
  await ipc.request("task.purge", { taskId: next.taskId });

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "task-purge", status: "PASS", asserts: results.length, taskId }, null, 2),
  );
  console.log(`\nTASK-PURGE: PASS (${results.length} asserts)`);
} catch (err) {
  await mkdir(ARTIFACT_DIR, { recursive: true }).catch(() => {});
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "task-purge", status: "FAIL", error: String(err?.stack ?? err), asserts: results }, null, 2),
  ).catch(() => {});
  console.log(`\nTASK-PURGE: FAIL — ${err?.stack ?? err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  for (const c of conns) { try { c.close(); } catch {} }
  try { await gateway?.shutdown("e2e done"); } catch {}
  try { await rm(dataDir, { recursive: true, force: true }); } catch {}
}
process.exit(process.exitCode ?? 0);
