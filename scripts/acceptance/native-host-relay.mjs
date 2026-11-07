// Native-host relay proof: spawn the REAL packages/native-host
// bin.js in gateway mode and speak Chrome Native Messaging to it —
// the exact stdio protocol the extension service worker uses.
//
// Chain proven end-to-end minus chrome.* APIs:
//   fake extension (NM stdio) → native-host process (token +
//   hostInstanceId/browserInstanceId injection, framing, lazy gateway
//   connect) → gateway IPC → host registry → MCP stdio → tool server
//   → browser.tool.request back down the same path → typed result.
// Plus host kill → browser.no_host → respawn → recovery, and gateway
// kill → native-host self-heal (proactive reconnect + re-hello →
// ensureGateway respawn) → calls recover with NO extension traffic —
// the real S5 tail that used to strand every call behind no_host.
import { spawn } from "node:child_process";
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
const NM_HOST = join(REPO, "packages/native-host/dist/bin.js");
const ARTIFACT_DIR = join(here, "../../artifacts/acceptance/native-host-relay", new Date().toISOString().replace(/[:.]/g, "-"));

const results = [];
const note = (m) => { results.push(m); console.log(`  ${m}`); };
const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAIL: ${label}`);
  note(`ok — ${label}`);
};

// ---- minimal Native Messaging client (4-byte LE length + JSON) ----
class NativeHostClient {
  #child;
  #buf = Buffer.alloc(0);
  #pending = new Map();
  #nextId = 0;
  onRequest = null; // (method, payload) → result  for server→client calls
  stderrText = "";
  constructor(dataDir) {
    this.#child = spawn(process.execPath, [NM_HOST], {
      env: { ...process.env, CHROMEX_GATEWAY_MODE: "1", CHROMEX_GATEWAY_HOME: dataDir },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stderr.on("data", (d) => { this.stderrText += d; });
    this.#child.stdout.on("data", (d) => this.#onData(d));
    this.#child.on("exit", (c) => this.#failAll(new Error(`native host exited code=${c}; stderr=${this.stderrText.slice(-300)}`)));
  }
  #failAll(err) {
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }
  #send(env) {
    const body = Buffer.from(JSON.stringify(env), "utf8");
    const frame = Buffer.alloc(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    this.#child.stdin.write(frame);
  }
  #onData(d) {
    this.#buf = Buffer.concat([this.#buf, d]);
    for (;;) {
      if (this.#buf.length < 4) return;
      const len = this.#buf.readUInt32LE(0);
      if (this.#buf.length < 4 + len) return;
      const body = this.#buf.subarray(4, 4 + len);
      this.#buf = this.#buf.subarray(4 + len);
      let env;
      try { env = JSON.parse(body.toString("utf8")); } catch { continue; }
      if (env.kind === "response" && typeof env.id === "string") {
        const p = this.#pending.get(env.id);
        if (!p) continue;
        this.#pending.delete(env.id);
        if (env.error) p.reject(Object.assign(new Error(`${env.error.code}: ${env.error.message ?? ""}`), { code: env.error.code }));
        else p.resolve(env.result);
      } else if (env.kind === "request" && typeof env.id === "string") {
        void this.#answer(env);
      }
      // kind:"event" envelopes (task broadcasts) are ignored here
    }
  }
  async #answer(env) {
    try {
      const result = this.onRequest ? await this.onRequest(env.method, env.payload) : undefined;
      this.#send({ v: 1, kind: "response", id: env.id, result });
    } catch (err) {
      this.#send({ v: 1, kind: "response", id: env.id, error: { code: err?.code ?? "host.error", message: err?.message ?? String(err) } });
    }
  }
  request(method, payload) {
    const id = `ext-${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send({ v: 1, kind: "request", id, method, ...(payload !== undefined ? { payload } : {}) });
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`nm request ${method} timeout; stderr=${this.stderrText.slice(-300)}`));
      }, 30000);
    });
  }
  close() { try { this.#child.kill("SIGKILL"); } catch {} }
}

const dataDir = await mkdtemp(join(tmpdir(), "chromex-nm-relay-"));
// sqlite store so tasks survive the gateway respawn — the spawned
// gateway reads the same <dataDir>/gateway.json (production parity).
await mkdir(join(dataDir, "run"), { recursive: true });
await writeFile(join(dataDir, "gateway.json"), JSON.stringify({ version: 1, store: "sqlite" }));
let gateway = null;
const conns = [];
let mcp = null;
let nm = null;
let taskIdForDebug = null;
let spawnedGatewayPid = null;
const hostRequests = [];

const makeHost = () => {
  const client = new NativeHostClient(dataDir);
  client.onRequest = async (method, payload) => {
    if (method !== "browser.tool.request") throw new Error(`unexpected host method ${method}`);
    hostRequests.push(payload);
    if (payload?.tool === "browser.tabs.list") {
      return { tabs: [{ id: 301, url: "https://nm.example.test/", title: "NM", active: true }] };
    }
    return { ok: true, tool: payload?.tool };
  };
  return client;
};

try {
  gateway = await startGateway({ dataDir, log: (m) => console.log(`[gw] ${m}`) });
  const ep = gateway.ipc.endpointPath();
  const token = (await readFile(join(dataDir, "auth", "token"), "utf8")).trim();
  const ipc = new GatewayIpc(ep.path, token, { clientId: "nm-relay-client", profileId: "e2e" });
  conns.push(ipc);

  // ---- real native-host process, real NM framing ---------------
  nm = makeHost();
  // extension hello carries NO token — the host must inject it
  const helloRes = await nm.request("hello", {
    protocolVersion: 1,
    clientId: "fake-extension",
    clientVersion: "0.0.0-e2e",
    profileId: "prof-e2e",
    browserInstanceId: null,
    hostInstanceId: "",
  });
  assert(helloRes && typeof helloRes === "object", "native host relayed hello → gateway hello response");
  assert(!JSON.stringify(helloRes).includes(token), "gateway token never echoed back to extension");

  // browserInstanceId is resolved host-side from the browser-instance
  // record the native host wrote under the shared dataDir
  const biRecord = JSON.parse(await readFile(join(dataDir, "browser-instance.json"), "utf8"));
  const browserInstanceId = biRecord.browserInstanceId;
  assert(typeof browserInstanceId === "string" && browserInstanceId.length === 32,
    `native host resolved browserInstanceId=${browserInstanceId.slice(0, 8)}…`);

  const created = await ipc.request("task.create", {
    cwd: REPO,
    title: "nm-relay-e2e",
    backend: { backendId: "chrome-extension", pinnedBy: "user" },
    browserInstanceId,
    tabIntent: { scope: "untitled" },
  });
  const taskId = created?.taskId;
  taskIdForDebug = taskId;
  assert(typeof taskId === "string", `task.create → ${taskId}`);

  const spawnDesc = await ipc.request("browser.mcp.spawn", { taskId });
  mcp = spawnMcpClient({ command: spawnDesc.command, args: spawnDesc.args, env: spawnDesc.env });
  const { rpc, callTool } = mcp;
  await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });

  // ---- full chain: MCP → gateway → registry → native-host → ext --
  const tabs = await callTool("browser_tabs_list", {});
  assert(tabs.raw.includes("UNTRUSTED BROWSER DATA"), "result fenced through NM relay");
  assert(JSON.stringify(tabs.data ?? tabs.raw).includes("nm.example.test"),
    "browser.tool.request round-tripped through the real native host");
  const dispatched = hostRequests.at(-1);
  assert(dispatched?.tool === "browser.tabs.list" && dispatched?.taskId === taskId,
    "native host delivered browser.tool.request with taskId intact");

  // ---- host kill → no_host → respawn → recovery -----------------
  nm.close();
  await new Promise((r) => setTimeout(r, 500));
  try {
    await callTool("browser_tabs_list", {});
    throw new Error("ASSERT FAIL: call succeeded with dead native host");
  } catch (e) {
    assert(String(e.rpcMessage ?? e.message).includes("browser.no_host"),
      `native host kill → browser.no_host`);
  }

  nm = makeHost();
  await nm.request("hello", {
    protocolVersion: 1, clientId: "fake-extension", clientVersion: "0.0.0-e2e",
    profileId: "prof-e2e", browserInstanceId: null, hostInstanceId: "",
  });
  const recovered = await callTool("browser_tabs_list", {});
  assert(JSON.stringify(recovered.data ?? recovered.raw).includes("nm.example.test"),
    "respawned native host serves calls again — real S5 recovery tail");

  // ---- gateway restart → native host self-heals (real S5) --------
  // Kill the GATEWAY, not the host. The extension's NM port stays
  // alive, so nothing pokes the relay — recovery must come from the
  // native host itself: conn close → proactive reconnect → ensureGateway
  // respawns the gateway → cached hello re-registers the host.
  await gateway.shutdown("e2e gateway restart");
  gateway = null;
  spawnedGatewayPid = null;
  const healDeadline = Date.now() + 90_000;
  let healed = null;
  let healErr = null;
  while (Date.now() < healDeadline) {
    try {
      healed = await callTool("browser_tabs_list", {});
      break;
    } catch (e) {
      healErr = e;
      await new Promise((r) => setTimeout(r, 1_000));
    }
  }
  // the respawned gateway is a detached child of the native host —
  // record its pid so cleanup can stop it (also retried in finally)
  let respawnedEndpoint = ep.path;
  try {
    const epJson = JSON.parse(await readFile(join(dataDir, "run", "gateway.json"), "utf8"));
    spawnedGatewayPid = epJson.gatewayPid ?? null;
    if (typeof epJson.path === "string") respawnedEndpoint = epJson.path;
    else if (typeof epJson.endpoint === "string") respawnedEndpoint = epJson.endpoint;
  } catch {}
  assert(
    healed && JSON.stringify(healed.data ?? healed.raw).includes("nm.example.test"),
    `gateway restart → native host self-healed without extension traffic ` +
      `(last err: ${healErr ? String(healErr?.rpcMessage ?? healErr?.message ?? healErr).slice(0, 120) : "none"})`,
  );

  // old ipc socket died with the old gateway — reconnect for task.sync
  const ipc2 = new GatewayIpc(respawnedEndpoint, token, { clientId: "nm-relay-client-2", profileId: "e2e" });
  conns.push(ipc2);
  const sync = await ipc2.request("task.sync", { taskId, fromSeq: 0, maxEvents: 300 });
  const toolEvents = (sync?.events ?? []).filter((e) => e.type === "tool.completed" || e.type === "tool.started");
  assert(toolEvents.length >= 4, `task.sync shows ${toolEvents.length} durable tool events`);

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "native-host-relay", status: "PASS", asserts: results.length, taskId, browserInstanceId, hostRequests: hostRequests.length }, null, 2),
  );
  console.log(`\nNATIVE-HOST-RELAY: PASS (${results.length} asserts)`);
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
    JSON.stringify({ scenario: "native-host-relay", status: "FAIL", error: String(err?.stack ?? err), asserts: results, nmStderr: nm?.stderrText?.slice(-500) }, null, 2),
  ).catch(() => {});
  console.log(`\nNATIVE-HOST-RELAY: FAIL — ${err?.stack ?? err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  try { mcp?.close(); } catch {}
  try { nm?.close(); } catch {}
  for (const c of conns) { try { c.close(); } catch {} }
  try { await gateway?.shutdown("e2e done"); } catch {}
  // detached gateway spawned by the native host's ensureGateway during
  // the self-heal leg — SIGTERM it so no orphan survives the run
  if (!spawnedGatewayPid) {
    try {
      const epJson = JSON.parse(await readFile(join(dataDir, "run", "gateway.json"), "utf8"));
      spawnedGatewayPid = epJson.gatewayPid ?? null;
    } catch {}
  }
  if (spawnedGatewayPid) {
    try { process.kill(spawnedGatewayPid, "SIGTERM"); } catch {}
    await new Promise((r) => setTimeout(r, 500));
    try { process.kill(spawnedGatewayPid, 0); process.kill(spawnedGatewayPid, "SIGKILL"); } catch {}
  }
  try { await rm(dataDir, { recursive: true, force: true }); } catch {}
}
process.exit(process.exitCode ?? 0);
