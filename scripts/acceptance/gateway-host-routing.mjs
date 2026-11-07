// Extension-host routing proof WITHOUT user Chrome: a real Gateway +
// a fake extension host speaking the exact IPC protocol the native
// host uses (hello with hostInstanceId/browserInstanceId, then
// answering browser.tool.request server→client requests).
//
// Proves the chrome-extension dispatch path end-to-end minus the
// chrome.* APIs themselves:
//   MCP stdio → IPC browser.tool.call → tool server (token, §4.8,
//   approval) → host registry → browser.tool.request on the host conn
//   → typed result back → durable task events.
// Also proves scope isolation (wrong browserInstanceId → no_host),
// host-loss → browser.no_host, and re-registration recovery (S5 tail).
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startGateway } from "../../packages/bridge/dist/gateway/main.js";
import { GatewayIpc } from "./lib/gateway-ipc.mjs";
import { spawnMcpClient } from "./lib/mcp-stdio-client.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../..");
const ARTIFACT_DIR = join(here, "../../artifacts/acceptance/gateway-host-routing", new Date().toISOString().replace(/[:.]/g, "-"));

const results = [];
const note = (m) => { results.push(m); console.log(`  ${m}`); };
const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAIL: ${label}`);
  note(`ok — ${label}`);
};

const HOST_ID = "fake-ext-host-1";
const BROWSER_ID = "fake-browser-1";
const dataDir = await mkdtemp(join(tmpdir(), "chromex-host-route-"));
let gateway = null;
const conns = [];
let mcp = null;
let taskIdForDebug = null;

const hello = (clientId) => ({ clientId, clientVersion: "chromex-host-route-e2e/0.1.0", profileId: "e2e" });

try {
  gateway = await startGateway({ dataDir, log: (m) => console.log(`[gw] ${m}`) });
  const ep = gateway.ipc.endpointPath();
  const token = (await readFile(join(dataDir, "auth", "token"), "utf8")).trim();

  // control-plane client (not a host)
  const ipc = new GatewayIpc(ep.path, token, hello("host-route-client"));
  conns.push(ipc);

  // ---- fake extension host: registers via hello, answers
  // browser.tool.request with canned per-tool results ----
  const hostRequests = [];
  const host = new GatewayIpc(ep.path, token, {
    ...hello(HOST_ID),
    hostInstanceId: HOST_ID,
    browserInstanceId: BROWSER_ID,
  });
  conns.push(host);
  host.setRequestHandler(async (method, payload) => {
    assert(method === "browser.tool.request", `host only receives browser.tool.request (got ${method})`);
    hostRequests.push(payload);
    const { tool, args } = payload;
    if (tool === "browser.tabs.list") {
      return { tabs: [{ id: 101, url: "https://example.test/", title: "Example", active: true }] };
    }
    if (tool === "browser.tab.create") {
      return { openedTabId: 102, tabId: 102, url: args?.url ?? "", title: "created" };
    }
    if (tool === "browser.page.get") {
      return { tabId: args?.tabId ?? 101, url: "https://example.test/", title: "Example", value: "fake page text" };
    }
    return { ok: true, tool };
  });
  // force the hello handshake → hostRegistry.register
  await host.request("diagnostics.snapshot", {});
  note("ok — fake host registered via hello (hostInstanceId + browserInstanceId)");

  // task pinned to chrome-extension bound to the fake browser instance
  const created = await ipc.request("task.create", {
    cwd: REPO,
    title: "host-routing-e2e",
    backend: { backendId: "chrome-extension", pinnedBy: "user" },
    browserInstanceId: BROWSER_ID,
    tabIntent: { scope: "untitled" },
  });
  const taskId = created?.taskId;
  taskIdForDebug = taskId;
  assert(typeof taskId === "string" && taskId.length > 0, `task.create → ${taskId}`);

  // second task bound to a DIFFERENT browser instance — must never
  // resolve to our host
  const other = await ipc.request("task.create", {
    cwd: REPO,
    title: "host-routing-other",
    backend: { backendId: "chrome-extension", pinnedBy: "user" },
    browserInstanceId: "other-browser-9",
    tabIntent: { scope: "untitled" },
  });
  const otherTaskId = other?.taskId;
  assert(typeof otherTaskId === "string", `second task.create → ${otherTaskId}`);

  const spawnDesc = await ipc.request("browser.mcp.spawn", { taskId });
  assert(spawnDesc?.scopeFile && spawnDesc?.command, "browser.mcp.spawn returned descriptor");
  assert(existsSync(spawnDesc.scopeFile), "scope file written");
  mcp = spawnMcpClient({ command: spawnDesc.command, args: spawnDesc.args, env: spawnDesc.env });
  const { rpc, callTool } = mcp;

  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  assert(init.result?.serverInfo?.name === "chromex-browser-tools", "mcp-stdio initialize handshake");
  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  assert(names.includes("browser_tabs_list") && names.includes("browser_windows_create"),
    `tools/list advertises full chrome-extension surface (${names.length} tools): ${names.filter((n) => n.includes("window") || n.includes("tab")).join(",")}`);

  // ---- tool call routed to the fake host through the whole stack ----
  const tabs = await callTool("browser_tabs_list", {});
  assert(tabs.raw.includes("UNTRUSTED BROWSER DATA"), "host result fenced as untrusted data");
  assert(JSON.stringify(tabs.data ?? tabs.raw).includes("example.test"), "fake host tab.list result reached MCP caller");

  const dispatched = hostRequests.at(-1);
  assert(dispatched?.tool === "browser.tabs.list", `host received browser.tool.request for tab.list`);
  assert(dispatched?.taskId === taskId, "host payload carries taskId");
  assert(typeof dispatched?.toolCallId === "string" && dispatched.toolCallId.length > 0, "host payload carries toolCallId");
  assert(dispatched && "tabScope" in dispatched, "chrome-extension dispatch carries tabScope payload");

  // args flow through verbatim
  await callTool("browser_tab_create", { url: "https://example.test/new", active: false });
  const createReq = hostRequests.at(-1);
  assert(createReq?.tool === "browser.tab.create" && createReq?.args?.url === "https://example.test/new",
    "tool args forwarded to host verbatim");

  // ---- scope isolation: other browserInstanceId must NOT reach host --
  const otherSpawn = await ipc.request("browser.mcp.spawn", { taskId: otherTaskId });
  const otherMcp = spawnMcpClient({ command: otherSpawn.command, args: otherSpawn.args, env: otherSpawn.env });
  try {
    await otherMcp.rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
    const before = hostRequests.length;
    try {
      await otherMcp.callTool("browser_tabs_list", {});
      throw new Error("ASSERT FAIL: cross-instance call did not reject");
    } catch (e) {
      assert(String(e.rpcMessage ?? e.message).includes("browser.no_host"),
        `wrong browserInstanceId → browser.no_host (${String(e.rpcMessage ?? e.message).slice(0, 120)})`);
    }
    assert(hostRequests.length === before, "host never saw the out-of-scope call");
  } finally {
    otherMcp.close();
  }

  // ---- host loss → typed no_host, then re-registration recovery -----
  host.close();
  conns.splice(conns.indexOf(host), 1);
  await new Promise((r) => setTimeout(r, 300)); // let unregisterByConnection land
  try {
    await callTool("browser_tabs_list", {});
    throw new Error("ASSERT FAIL: call succeeded with no host");
  } catch (e) {
    assert(String(e.rpcMessage ?? e.message).includes("browser.no_host"),
      `host disconnect → browser.no_host (${String(e.rpcMessage ?? e.message).slice(0, 120)})`);
  }

  // same hostInstanceId + browserInstanceId reconnects (SW restart shape)
  const host2 = new GatewayIpc(ep.path, token, {
    ...hello(HOST_ID),
    hostInstanceId: HOST_ID,
    browserInstanceId: BROWSER_ID,
  });
  conns.push(host2);
  host2.setRequestHandler(async (method, payload) => {
    hostRequests.push(payload);
    if (payload?.tool === "browser.tabs.list") {
      return { tabs: [{ id: 201, url: "https://back.example.test/", title: "Back", active: true }] };
    }
    return { ok: true };
  });
  await host2.request("diagnostics.snapshot", {});
  const recovered = await callTool("browser_tabs_list", {});
  assert(JSON.stringify(recovered.data ?? recovered.raw).includes("back.example.test"),
    "re-registered host serves calls again (S5 recovery shape)");

  // durable evidence on the task stream
  const sync = await ipc.request("task.sync", { taskId, fromSeq: 0, maxEvents: 300 });
  const toolEvents = (sync?.events ?? []).filter((e) => e.type === "tool.completed" || e.type === "tool.started");
  assert(toolEvents.length >= 6, `task.sync shows ${toolEvents.length} durable tool events`);

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "gateway-host-routing", status: "PASS", asserts: results.length, taskId, hostRequests: hostRequests.length }, null, 2),
  );
  console.log(`\nGATEWAY-HOST-ROUTING: PASS (${results.length} asserts)`);
} catch (err) {
  try {
    const dbgIpc = new GatewayIpc(gateway.ipc.endpointPath().path, (await readFile(join(dataDir, "auth", "token"), "utf8")).trim());
    try {
      if (taskIdForDebug) {
        const sync = await dbgIpc.request("task.sync", { taskId: taskIdForDebug, fromSeq: 0, maxEvents: 200 });
        const evs = (sync?.events ?? []).map((e) => `${e.type}:${e.tool ?? ""}:${e.outcome ?? ""}`).join(" | ");
        console.log("[debug] events:", evs.slice(0, 1200));
      }
    } finally { dbgIpc.close(); }
  } catch (e) {
    console.log("[debug] sync failed:", String(e).slice(0, 200));
  }
  await mkdir(ARTIFACT_DIR, { recursive: true }).catch(() => {});
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "gateway-host-routing", status: "FAIL", error: String(err?.stack ?? err), asserts: results }, null, 2),
  ).catch(() => {});
  console.log(`\nGATEWAY-HOST-ROUTING: FAIL — ${err?.stack ?? err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  try { mcp?.close(); } catch {}
  for (const c of conns) { try { c.close(); } catch {} }
  try { await gateway?.shutdown("e2e done"); } catch {}
  try { await rm(dataDir, { recursive: true, force: true }); } catch {}
}
process.exit(process.exitCode ?? 0);
