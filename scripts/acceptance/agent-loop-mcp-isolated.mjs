// Agent-loop proof through the REAL MCP path: JSON-RPC tools/call →
// BrowserMcpServer (scope allowlist + untrusted-content fencing) →
// BrowserToolServer (token verify, dedup, §4.8 classify + approval) →
// PlaywrightIsolatedBackend → headless Chromium → fixture server.
//
// Unlike agent-loop-isolated.mjs (which calls backend.execute directly),
// this exercises the same layers a provider's MCP client hits: tool-name
// mapping, allowedTools gating, result fencing, and approval plumbing.
// No user Chrome, no gateway daemon, no token file — the scope/token are
// minted in-process exactly as the gateway would.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PlaywrightIsolatedBackend } from "../../packages/bridge/dist/browser/backends/playwright/isolated.js";
import { BrowserToolServer } from "../../packages/bridge/dist/browser/tool-server.js";
import { ToolTokenManager } from "../../packages/bridge/dist/browser/tool-token.js";
import { BrowserMcpServer } from "../../packages/bridge/dist/browser/mcp-server.js";
import { supportedToolsForBackend } from "../../packages/bridge/dist/browser/mcp-scope.js";
import { startFixtureServer } from "./fixtures/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(here, "../../artifacts/acceptance/agent-loop-mcp-isolated", new Date().toISOString().replace(/[:.]/g, "-"));

const shellCandidates = [
  join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
];
const executablePath = shellCandidates.find((p) => existsSync(p));

const results = [];
const note = (m) => {
  results.push(m);
  console.log(`  ${m}`);
};
const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAIL: ${label}`);
  note(`ok — ${label}`);
};

const fixture = await startFixtureServer();

// ---- wire the real stack -------------------------------------------------
const backend = new PlaywrightIsolatedBackend({
  ...(executablePath ? { executablePath: async () => executablePath } : {}),
});
const TASK = "agent-loop-mcp-e2e";

const tokens = ToolTokenManager.forTest("00".repeat(32));
const allowed = supportedToolsForBackend("playwright-isolated");
const { token } = tokens.issue({
  taskId: TASK,
  profileId: "profile-e2e",
  backendId: "playwright-isolated",
  allowedTools: allowed,
});

// The host channel the tool server dispatches to — same contract the
// gateway's extension/native relay implements, backed by the real
// playwright backend here.
const host = {
  hostInstanceId: "isolated-e2e",
  profileId: "profile-e2e",
  send: async (_method, payload) => {
    const { tool, args } = payload;
    return backend.execute(TASK, tool, args ?? {});
  },
  onDisconnect: () => {},
};

const approvals = [];
const toolServer = new BrowserToolServer({
  tokens,
  resolveHost: () => host,
  requestApproval: async (ctx) => {
    approvals.push({ tool: ctx.tool, risk: ctx.risk });
    return { verdict: "approved" };
  },
});

const mcp = new BrowserMcpServer({
  scope: { taskId: TASK, profileId: "profile-e2e", backendId: "playwright-isolated", token },
  server: toolServer,
  allowedTools: new Set(allowed),
});

// ---- minimal JSON-RPC client ---------------------------------------------
let rpcId = 0;
const rpc = async (method, params) => {
  const line = await mcp.handleLine(JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }));
  return JSON.parse(line);
};
const init = await rpc("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
assert(init.result?.serverInfo?.name === "chromex-browser-tools", "MCP initialize handshake");

const list = await rpc("tools/list", {});
const names = (list.result?.tools ?? []).map((t) => t.name);
assert(names.includes("browser_page_snapshot") && names.includes("browser_page_click"), "tools/list advertises page tools");
assert(!names.includes("browser_windows_create"), "tools/list omits backend-unsupported tools");
assert(names.length === allowed.length, `tools/list count matches allowedTools (${names.length})`);

/** Parse a completed tools/call result: content[0].text is the fenced
 *  untrusted-data envelope; the JSON payload is the line between the
 *  marker lines. */
const call = async (name, args = {}) => {
  const res = await rpc("tools/call", { name, arguments: args });
  const result = res.result;
  if (!result || result.isError) {
    const msg = result?.content?.[0]?.text ?? JSON.stringify(res.error ?? res);
    const err = new Error(msg);
    err.rpcMessage = msg;
    throw err;
  }
  const text = result.content?.find((c) => c.type === "text")?.text ?? "";
  const jsonLine = text.split("\n").find((l) => l.startsWith("{") || l.startsWith("["));
  return { raw: text, data: jsonLine ? JSON.parse(jsonLine) : null };
};

try {
  // ── Loop 1: open the form, snapshot through the fenced envelope ──────
  const created = await call("browser_tab_create", { url: fixture.url("/form"), active: false });
  const tabId = created.data?.tabId ?? created.data?.openedTabId;
  assert(Number.isInteger(tabId), `browser_tab_create → tabId=${tabId}`);

  const snap = await call("browser_page_snapshot", { tabId });
  assert(snap.raw.includes("UNTRUSTED BROWSER DATA"), "snapshot result is fenced as untrusted data");
  assert(snap.raw.includes("CHROMEX_UNTRUSTED_BROWSER_DATA"), "nonce markers present");
  assert(String(snap.data?.snapshot ?? "").includes("form") || String(snap.data?.snapshot ?? "").length > 0, "snapshot returned page content");

  // ── Loop 2: fill → click → select → submit (the S1 shape) ──────────
  await call("browser_page_fill", { tabId, selector: "#name", value: "Agent" });
  await call("browser_page_type", { tabId, selector: "#email", value: "agent@chromex.dev" });
  const nextRes = await call("browser_page_click", {
    tabId,
    selector: "#next",
    expect: { selector: "#step2:not([hidden])", timeoutMs: 5000 },
  });
  assert(nextRes.data?.expect?.met === true && nextRes.data?.verified === true,
    "args.expect verified step2 revealed (through MCP)");
  await call("browser_page_select", { tabId, selector: "#plan", value: "pro" });
  await call("browser_page_submit", { tabId, selector: "#submit" });
  await call("browser_page_wait", { tabId, text: "Submitted", timeoutMs: 8000 });

  const done = await call("browser_page_extract", { tabId, selector: "#done" });
  assert(String(done.data?.text ?? "").includes("ok"), "extract verifies submit-ok page");
  const post = fixture.requests.find((r) => r.method === "POST" && r.path === "/submit" && r.body);
  assert(!!post && post.body.includes("name=Agent"), "fixture server received POST /submit with name=Agent");

  // ── Loop 3: approval plumbing — an action on an auth.* origin is
  // financial-risk → needsApproval → the hook must approve it ──────────
  const gated = await call("browser_tab_create", { url: fixture.gatedUrl("/form"), active: false });
  const gTab = gated.data?.tabId ?? gated.data?.openedTabId;
  assert(Number.isInteger(gTab), `gated tab created (tabId=${gTab})`);
  await call("browser_page_click", { tabId: gTab, selector: "#next" });
  assert(approvals.some((a) => a.risk === "financial"), `approval hook saw financial-risk action(s): ${JSON.stringify(approvals)}`);

  // ── Loop 4: scope honesty — a backend-unsupported tool fails at the
  // MCP layer before ever reaching the tool server/backend ─────────────
  try {
    await call("browser_windows_create", { url: fixture.url("/") });
    throw new Error("ASSERT FAIL: windows.create did not reject");
  } catch (e) {
    assert(String(e.rpcMessage ?? e.message).includes("proto.unsupported"), "unsupported tool refused at MCP scope gate");
  }

  // ── Loop 5: hard-blocked tool (cookies) — needs a token whose
  // allowedTools includes it, otherwise the scope check fires first ────
  const { token: wideToken } = tokens.issue({
    taskId: TASK,
    profileId: "profile-e2e",
    backendId: "playwright-isolated",
    allowedTools: [...allowed, "browser.page.cookies"],
  });
  const blocked = await toolServer.execute({
    toolCallId: "mcp-e2e-blocked-1",
    taskId: TASK,
    tool: "browser.page.cookies",
    args: {},
    token: wideToken,
    profileId: "profile-e2e",
    backendId: "playwright-isolated",
  });
  assert(blocked.status === "failed" && blocked.error?.code === "browser.tool_blocked", "cookies hard-blocked by tool server");

  // ── Loop 6: token rejection — a forged token never reaches dispatch ──
  const forged = await toolServer.execute({
    toolCallId: "mcp-e2e-forged-1",
    taskId: TASK,
    tool: "browser.page.get",
    args: {},
    token: token.slice(0, -4) + "AAAA",
    profileId: "profile-e2e",
    backendId: "playwright-isolated",
  });
  assert(forged.status === "failed", `forged token rejected (${forged.error?.code})`);

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "agent-loop-mcp-isolated", status: "PASS", asserts: results.length, approvals }, null, 2),
  );
  console.log(`\nAGENT-LOOP MCP ISOLATED: PASS (${results.length} asserts)`);
} catch (err) {
  await mkdir(ARTIFACT_DIR, { recursive: true }).catch(() => {});
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "agent-loop-mcp-isolated", status: "FAIL", error: String(err?.stack ?? err), asserts: results }, null, 2),
  ).catch(() => {});
  console.log(`\nAGENT-LOOP MCP ISOLATED: FAIL — ${err?.stack ?? err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  await backend.close().catch(() => {});
  await fixture.close();
}
