// playwright-cdp end-to-end proof: a REAL Gateway process + spawned
// mcp-stdio child + JSON-RPC tools/call → IPC → tool server →
// PlaywrightCdpBackend → connectOverCDP → a live Chromium that was
// launched WITH --remote-debugging-port (standing in for a user's
// Chrome). The attached browser's own tab must never leak into tool
// results; each task gets an isolated newContext over CDP.
//
// Also proves the honesty gates: playwright-cdp is unavailable until
// enabledByUser + cdpEndpoint are configured, and pinning it early
// fails browser.backend_unavailable — never a silent fallback.
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GatewayIpc } from "./lib/gateway-ipc.mjs";
import { spawnMcpClient } from "./lib/mcp-stdio-client.mjs";
import { startGateway } from "../../packages/bridge/dist/gateway/main.js";
import { startFixtureServer } from "./fixtures/server.mjs";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../..");
const ARTIFACT_DIR = join(here, "../../artifacts/acceptance/gateway-mcp-cdp", new Date().toISOString().replace(/[:.]/g, "-"));
const CDP_PORT = 19230 + Math.floor(Math.random() * 200);
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

const results = [];
const note = (m) => { results.push(m); console.log(`  ${m}`); };
const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAIL: ${label}`);
  note(`ok — ${label}`);
};

const fixture = await startFixtureServer();
const dataDir = await mkdtemp(join(tmpdir(), "chromex-gw-cdp-"));
let gateway = null;
let mcp = null;
let mcp2 = null;
let approver = null;
let userBrowser = null;
let ipc = null;

try {
  // ---- the "user's browser": plain chromium + remote debugging ----
  userBrowser = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1"],
  });
  const userCtx = await userBrowser.newContext();
  const userPage = await userCtx.newPage();
  await userPage.goto("data:text/html,<title>USER-TAB-MARKER</title><h1>user owned</h1>");

  gateway = await startGateway({ dataDir, log: (m) => console.log(`[gw] ${m}`) });
  const ep = gateway.ipc.endpointPath();
  const token = (await readFile(join(dataDir, "auth", "token"), "utf8")).trim();
  ipc = new GatewayIpc(ep.path, token, { clientId: "gateway-mcp-cdp-e2e", clientVersion: "chromex-gateway-mcp-cdp/0.1.0", profileId: "e2e" });

  // ---- honesty gate 1: pinned before opt-in → backend_unavailable --
  let earlyErr = null;
  try {
    await ipc.request("task.create", {
      cwd: REPO, title: "cdp-early", backend: { backendId: "playwright-cdp", pinnedBy: "user" },
      tabIntent: { scope: "untitled" },
    });
  } catch (e) { earlyErr = e; }
  assert(earlyErr && String(earlyErr.message ?? earlyErr).includes("backend_unavailable"),
    "playwright-cdp pin before opt-in → browser.backend_unavailable (no silent fallback)");

  // ---- opt in: enabledByUser + endpoint + allowedBackends -----------
  await ipc.request("config.update", {
    patch: {
      browser: {
        playwright: { enabledByUser: true, cdpEndpoint: CDP_ENDPOINT },
        allowedBackends: ["chrome-extension", "playwright-isolated", "playwright-cdp"],
      },
    },
  });

  const hello = await ipc.request("gateway.hello", {}).catch(() => null);
  void hello; // hello shape varies; availability is proven by the pin succeeding below

  const created = await ipc.request("task.create", {
    cwd: REPO, title: "gateway-mcp-cdp-e2e",
    backend: { backendId: "playwright-cdp", pinnedBy: "user" },
    tabIntent: { scope: "untitled" },
  });
  const taskId = created?.taskId;
  assert(typeof taskId === "string" && taskId.length > 0, `task.create pinned playwright-cdp → ${taskId}`);

  // Auto-approver (same pattern as gateway-mcp-isolated): page-content
  // tools are agentEgress class — answer permission.requested with the
  // task-scoped egress grant so reads don't stall on a human.
  const answered = new Set();
  approver = setInterval(() => {
    (async () => {
      const sync = await ipc.request("task.sync", { taskId, fromSeq: 0, maxEvents: 500 });
      for (const e of sync?.events ?? []) {
        if (e.type !== "permission.requested") continue;
        const req = e.payload?.request ?? e.request ?? {};
        const rid = req.requestId;
        if (!rid || answered.has(rid)) continue;
        answered.add(rid);
        const opts = Array.isArray(req.options) ? req.options : [];
        const pick =
          opts.find((o) => o.id === "allow_egress_task") ??
          opts.find((o) => o.id === "allow_task") ??
          opts.find((o) => o.id === "allow_once") ??
          opts.find((o) => o.kind === "allow_once");
        if (!pick) continue;
        await ipc.request("permission.respond", { requestId: rid, optionId: pick.id }).catch(() => {});
      }
    })().catch(() => {});
  }, 400);

  const spawnDesc = await ipc.request("browser.mcp.spawn", { taskId });
  assert(spawnDesc?.scopeFile && spawnDesc?.command, "browser.mcp.spawn returned descriptor");

  const mcpClient = spawnMcpClient({ command: spawnDesc.command, args: spawnDesc.args, env: spawnDesc.env });
  mcp = mcpClient;
  const { rpc, callTool } = mcpClient;
  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  assert(init.result?.serverInfo?.name === "chromex-browser-tools", "mcp-stdio handshake");
  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  assert(names.includes("browser_page_snapshot") && names.length > 50,
    `tools/list advertises the shared executor surface (${names.length} tools)`);

  // ---- observe → act → verify through the attached browser ---------
  const nav = await callTool("browser_page_navigate", { url: fixture.url("/form") });
  assert(nav.raw !== undefined || nav.data !== undefined, "navigate dispatched over CDP attach");

  const snap = await callTool("browser_page_snapshot", {});
  assert(String(snap.raw ?? snap.data ?? "").includes("UNTRUSTED BROWSER DATA"),
    "snapshot fenced through cdp backend");

  await callTool("browser_page_fill", { selector: "#name", value: "CDP Agent" });
  await callTool("browser_page_click", { selector: "#next" });
  await callTool("browser_page_select", { selector: "#plan", value: "pro" });
  await callTool("browser_page_submit", { selector: "#submit" });
  await callTool("browser_page_wait", { text: "Submitted", timeoutMs: 8000 });
  const done = await callTool("browser_page_extract", { selector: "#done" });
  assert(String(done.data?.text ?? "").includes("ok"), "form submitted end-to-end via CDP-attached browser");
  const post = fixture.requests.find((r) => r.method === "POST" && r.path === "/submit" && r.body);
  assert(!!post && post.body.includes("name=CDP"), "fixture server saw the submission");

  // ---- isolation: user's own tab is never surfaced ------------------
  const tabs = await callTool("browser_tabs_list", {});
  const tabsJson = JSON.stringify(tabs.data ?? tabs.raw ?? tabs);
  assert(!tabsJson.includes("USER-TAB-MARKER"), "attached browser's user tab NOT visible to task tools");
  assert(tabsJson.includes("/form") || tabsJson.includes("fixture") || tabsJson.includes("Submitted") || tabsJson.includes("http"),
    "tabs.list shows only the task's own context pages");

  // second task → completely separate context, zero shared tabs
  const created2 = await ipc.request("task.create", {
    cwd: REPO, title: "gateway-mcp-cdp-e2e-2",
    backend: { backendId: "playwright-cdp", pinnedBy: "user" },
    tabIntent: { scope: "untitled" },
  });
  const spawn2 = await ipc.request("browser.mcp.spawn", { taskId: created2.taskId });
  mcp2 = spawnMcpClient({ command: spawn2.command, args: spawn2.args, env: spawn2.env });
  try {
    const { callTool: callTool2 } = mcp2;
    await mcp2.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e2", version: "0" } });
    const tabs2 = await callTool2("browser_tabs_list", {});
    const tabs2Json = JSON.stringify(tabs2.data ?? tabs2.raw ?? tabs2);
    assert(!tabs2Json.includes("/form") && (tabs2Json.includes('"tabs":[]') || tabs2Json.includes('"tabs": []')),
      "second task's context is isolated — zero tabs from task 1");
  } finally {
    try { mcp2.close?.(); } catch {}
    await ipc.request("task.purge", { taskId: created2.taskId }).catch(() => {});
  }

  // ---- honest refusal + durable evidence ----------------------------
  try {
    await callTool("browser_windows_create", { url: fixture.url("/") });
    throw new Error("ASSERT FAIL: windows.create did not reject");
  } catch (e) {
    assert(String(e.rpcMessage ?? e.message).includes("proto.unsupported"), "unsupported tool refused through cdp scope");
  }

  const sync = await ipc.request("task.sync", { taskId, fromSeq: 0, maxEvents: 300 });
  const toolEvents = (sync?.events ?? []).filter((e) => e.type === "tool.completed" || e.type === "tool.started");
  assert(toolEvents.length >= 8, `task.sync shows ${toolEvents.length} durable tool events`);

  // purge → releaseTask closes the task's CDP context; user browser survives
  await ipc.request("task.purge", { taskId });
  assert(userBrowser.isConnected(), "attached user browser still alive after task purge + releaseTask");

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "gateway-mcp-cdp", status: "PASS", asserts: results.length, taskId, cdpEndpoint: CDP_ENDPOINT }, null, 2),
  );
  console.log(`\nGATEWAY-MCP CDP: PASS (${results.length} asserts)`);
} catch (err) {
  console.log(`\nGATEWAY-MCP CDP: FAIL — ${err.message}`);
  process.exitCode = 1;
} finally {
  clearInterval(approver);
  try { mcp?.close(); } catch {}
  try { mcp2?.close?.(); } catch {}
  try { ipc?.close(); } catch {}
  await gateway?.shutdown?.("scenario-end").catch(() => {});
  await userBrowser?.close().catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  await fixture.close().catch(() => {});
}
