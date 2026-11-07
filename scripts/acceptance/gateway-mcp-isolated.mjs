// Full provider-path proof WITHOUT user Chrome: a real Gateway process
// (in-process startGateway) + a real spawned `mcp-stdio.js` child +
// JSON-RPC tools/call → IPC → tool server (token/§4.8) →
// playwright-isolated backend → headless Chromium → fixture server.
//
// This is the exact chain a coding agent's MCP client uses in
// gatewayMode — the only substituted piece is the provider itself
// (scripted JSON-RPC instead of codex/claude). Task is pinned to
// playwright-isolated so no extension host or user session is needed.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { randomUUID } from "node:crypto";
import { startGateway } from "../../packages/bridge/dist/gateway/main.js";
import { startFixtureServer } from "./fixtures/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../..");
const ARTIFACT_DIR = join(here, "../../artifacts/acceptance/gateway-mcp-isolated", new Date().toISOString().replace(/[:.]/g, "-"));

const results = [];
const note = (m) => {
  results.push(m);
  console.log(`  ${m}`);
};
const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAIL: ${label}`);
  note(`ok — ${label}`);
};

// ---- minimal framed IPC client (same protocol as mcp-stdio/native-host)
const FRAME_HEADER = 4;
class GatewayIpc {
  #socket = null;
  #buf = Buffer.alloc(0);
  #pending = new Map();
  #helloDone = null;
  constructor(endpoint, token) {
    this.endpoint = endpoint;
    this.token = token;
  }
  #connect() {
    if (this.#socket && !this.#socket.destroyed) return Promise.resolve(this.#socket);
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.endpoint);
      sock.once("error", reject);
      sock.once("connect", () => {
        sock.off("error", reject);
        sock.on("error", () => this.#failAll(new Error("ipc socket error")));
        sock.on("data", (d) => this.#onData(d));
        sock.on("close", () => this.#failAll(new Error("ipc socket closed")));
        this.#socket = sock;
        resolve(sock);
      });
    });
  }
  #failAll(err) {
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
    this.#socket = null;
  }
  #onData(d) {
    this.#buf = Buffer.concat([this.#buf, d]);
    for (;;) {
      if (this.#buf.length < FRAME_HEADER) return;
      const len = this.#buf.readUInt32LE(0);
      if (this.#buf.length < FRAME_HEADER + len) return;
      const body = this.#buf.subarray(FRAME_HEADER, FRAME_HEADER + len);
      this.#buf = this.#buf.subarray(FRAME_HEADER + len);
      let env;
      try { env = JSON.parse(body.toString("utf8")); } catch { continue; }
      if (env.kind === "response" && typeof env.id === "string") {
        const p = this.#pending.get(env.id);
        if (!p) continue;
        this.#pending.delete(env.id);
        if (env.error) p.reject(new Error(`${env.error.code ?? "error"}: ${env.error.message ?? ""}`));
        else p.resolve(env.result);
      }
    }
  }
  #send(sock, env) {
    const body = Buffer.from(JSON.stringify(env), "utf8");
    const frame = Buffer.alloc(FRAME_HEADER + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, FRAME_HEADER);
    sock.write(frame);
  }
  async request(method, payload) {
    this.#helloDone ??= (async () => {
      const sock = await this.#connect();
      const id = `hello-${randomUUID()}`;
      await new Promise((resolve, reject) => {
        this.#pending.set(id, { resolve, reject });
        this.#send(sock, {
          v: 1, kind: "request", id, method: "hello",
          payload: {
            protocolVersion: 1,
            clientVersion: "chromex-gateway-mcp-e2e/0.1.0",
            clientId: "gateway-mcp-e2e",
            profileId: "e2e",
            browserInstanceId: null,
            hostInstanceId: "",
            token: this.token,
          },
        });
      });
    })();
    await this.#helloDone;
    const sock = await this.#connect();
    const id = `req-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send(sock, { v: 1, kind: "request", id, method, payload });
    });
  }
}

const fixture = await startFixtureServer();
const dataDir = await mkdtemp(join(tmpdir(), "chromex-gw-e2e-"));
let gateway = null;
let mcpChild = null;
let taskIdForDebug = null;
let approver = null;

try {
  gateway = await startGateway({ dataDir, log: (m) => console.log(`[gw] ${m}`) });
  const ep = gateway.ipc.endpointPath();
  assert(ep.transport === "unix", `ipc endpoint is unix socket (${ep.path})`);
  const token = (await readFile(join(dataDir, "auth", "token"), "utf8")).trim();
  assert(token.length === 64, "gateway published auth token");
  const ipc = new GatewayIpc(ep.path, token);

  // enable the isolated backend + confirm the runtime sees a browser
  await ipc.request("config.update", { patch: { browser: { playwright: { enabledByUser: true } } } });
  const status = await ipc.request("browser.backend.status", {});
  assert(status?.playwrightIsolated?.available === true, `playwright runtime available (${status?.playwrightIsolated?.browserExecutablePath ?? "?"})`);

  // task pinned to playwright-isolated — untitled scope, no user tabs
  const created = await ipc.request("task.create", {
    cwd: REPO,
    title: "gateway-mcp-e2e",
    backend: { backendId: "playwright-isolated", pinnedBy: "user" },
    tabIntent: { scope: "untitled" },
  });
  const taskId = created?.taskId;
  taskIdForDebug = taskId;
  assert(typeof taskId === "string" && taskId.length > 0, `task.create → ${taskId}`);

  // Auto-approver standing in for the human clicking the permission
  // card: watch the durable task stream for permission.requested and
  // answer through the real permission.respond RPC — preferring the
  // task-scoped egress grant so repeated page reads don't re-prompt.
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

  // the same spawn path SessionManager uses at provider session open
  const spawnDesc = await ipc.request("browser.mcp.spawn", { taskId });
  assert(spawnDesc?.scopeFile && spawnDesc?.command, "browser.mcp.spawn returned descriptor");
  assert(existsSync(spawnDesc.scopeFile), "scope file written (0600)");

  // ---- spawn the REAL mcp-stdio.js and speak JSON-RPC over stdio ----
  mcpChild = spawn(spawnDesc.command, spawnDesc.args, {
    env: { ...process.env, ...spawnDesc.env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let mcpBuf = "";
  const mcpPending = new Map();
  let mcpStderr = "";
  mcpChild.stderr.on("data", (d) => { mcpStderr += d; });
  mcpChild.stdout.on("data", (d) => {
    mcpBuf += d.toString("utf8");
    let idx;
    while ((idx = mcpBuf.indexOf("\n")) >= 0) {
      const line = mcpBuf.slice(0, idx).trim();
      mcpBuf = mcpBuf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && mcpPending.has(msg.id)) {
          mcpPending.get(msg.id)(msg);
          mcpPending.delete(msg.id);
        }
      } catch { /* non-JSON noise */ }
    }
  });
  let mcpId = 0;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++mcpId;
      mcpPending.set(id, resolve);
      mcpChild.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`mcp rpc ${method} timeout; stderr=${mcpStderr.slice(-300)}`)), 30000);
    });
  const callTool = async (name, args = {}) => {
    const res = await rpc("tools/call", { name, arguments: args });
    const result = res.result;
    if (!result || result.isError) {
      const msg = result?.content?.[0]?.text ?? JSON.stringify(res.error ?? res);
      const e = new Error(msg);
      e.rpcMessage = msg;
      throw e;
    }
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    const jsonLine = text.split("\n").find((l) => l.startsWith("{") || l.startsWith("["));
    return { raw: text, data: jsonLine ? JSON.parse(jsonLine) : null };
  };

  const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
  assert(init.result?.serverInfo?.name === "chromex-browser-tools", "mcp-stdio initialize handshake");
  const list = await rpc("tools/list", {});
  const names = (list.result?.tools ?? []).map((t) => t.name);
  assert(names.includes("browser_page_snapshot") && !names.includes("browser_windows_create"),
    `tools/list scoped to playwright-isolated (${names.length} tools)`);

  // ---- provider-style iteration through the whole stack -------------
  const createdTab = await callTool("browser_tab_create", { url: fixture.url("/form"), active: false });
  const tabId = createdTab.data?.tabId ?? createdTab.data?.openedTabId;
  assert(Number.isInteger(tabId), `tab.create through gateway+mcp → tabId=${tabId}`);

  const snap = await callTool("browser_page_snapshot", { tabId });
  assert(snap.raw.includes("UNTRUSTED BROWSER DATA"), "snapshot fenced through real MCP stdio");

  await callTool("browser_page_fill", { tabId, selector: "#name", value: "Gateway Agent" });
  const next = await callTool("browser_page_click", {
    tabId, selector: "#next",
    expect: { selector: "#step2:not([hidden])", timeoutMs: 5000 },
  });
  assert(next.data?.expect?.met === true, "args.expect verified through full stack");
  await callTool("browser_page_select", { tabId, selector: "#plan", value: "pro" });
  await callTool("browser_page_submit", { tabId, selector: "#submit" });
  await callTool("browser_page_wait", { tabId, text: "Submitted", timeoutMs: 8000 });
  const done = await callTool("browser_page_extract", { tabId, selector: "#done" });
  assert(String(done.data?.text ?? "").includes("ok"), "form submitted end-to-end via gateway MCP");
  const post = fixture.requests.find((r) => r.method === "POST" && r.path === "/submit" && r.body);
  assert(!!post && post.body.includes("name=Gateway"), "fixture server saw POST /submit");

  // honest refusals still hold through the full stack
  try {
    await callTool("browser_windows_create", { url: fixture.url("/") });
    throw new Error("ASSERT FAIL: windows.create did not reject");
  } catch (e) {
    assert(String(e.rpcMessage ?? e.message).includes("proto.unsupported"), "unsupported tool refused at MCP scope");
  }

  // durable evidence: tool.completed events landed in the task stream
  const sync = await ipc.request("task.sync", { taskId, fromSeq: 0, maxEvents: 200 });
  const toolEvents = (sync?.events ?? []).filter((e) => e.type === "tool.completed" || e.type === "tool.started");
  assert(toolEvents.length >= 8, `task.sync shows ${toolEvents.length} durable tool events`);

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "gateway-mcp-isolated", status: "PASS", asserts: results.length, taskId, toolEvents: toolEvents.length }, null, 2),
  );
  console.log(`\nGATEWAY-MCP ISOLATED: PASS (${results.length} asserts)`);
} catch (err) {
  // debug: did the hung tool actually complete server-side?
  try {
    const dbgIpc = new GatewayIpc(gateway.ipc.endpointPath().path, (await readFile(join(dataDir, "auth", "token"), "utf8")).trim());
    if (taskIdForDebug) {
      const sync = await dbgIpc.request("task.sync", { taskId: taskIdForDebug, fromSeq: 0, maxEvents: 200 });
      const evs = (sync?.events ?? []).map((e) => `${e.type}:${e.tool ?? ""}:${e.outcome ?? ""}`).join(" | ");
      console.log("[debug] events:", evs.slice(0, 1200));
    }
  } catch (e) {
    console.log("[debug] task.list failed:", String(e).slice(0, 200));
  }
  await mkdir(ARTIFACT_DIR, { recursive: true }).catch(() => {});
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "gateway-mcp-isolated", status: "FAIL", error: String(err?.stack ?? err), asserts: results }, null, 2),
  ).catch(() => {});
  console.log(`\nGATEWAY-MCP ISOLATED: FAIL — ${err?.stack ?? err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  try { clearInterval(approver); } catch {}
  try { mcpChild?.kill("SIGKILL"); } catch {}
  try { await gateway?.shutdown("e2e done"); } catch {}
  try { await rm(dataDir, { recursive: true, force: true }); } catch {}
  await fixture.close();
}
