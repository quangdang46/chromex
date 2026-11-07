// E2E (chromex-cl0): prove a provider actually iterates browser_* MCP
// tools inside a gateway task — observe → act → observe.
//
// Flow:
//  1. ensureGateway → config.read; playwright-isolated is enabled via
//     config.update for the run and restored afterwards (the user's
//     default backend stays chrome-extension; the isolated backend is
//     the only deterministic host-free target).
//  2. Spawn a local http.server fixture page (no external network).
//  3. task.create (codex, model $CHROMEX_E2E_MODEL || "xxx",
//     backend pin playwright-isolated, tabIntent untitled).
//  4. task.send a prompt that forces tool iteration:
//     navigate → snapshot → click → snapshot.
//  5. PASS = turn.completed AND ≥3 browser.tool.classified executions
//     (navigate + observation + action) AND ≥1 provider mcpToolCall
//     tool.completed, with a snapshot/get observed AFTER the first
//     navigate (observe→act→observe ordering).
//
// Evidence: live event stream + durable task.sync replay. Auto-answers
// permission.requested with the first non-deny option so the run is
// unattended; denials are still honored if the model picks deny itself.
//
// Env: CHROMEX_E2E_PROVIDER (default codex), CHROMEX_E2E_MODEL
//      (default "xxx"), CHROMEX_E2E_TIMEOUT_MS (default 300000),
//      CHROMEX_GATEWAY_HOME, CHROMEX_E2E_NO_PLAYWRIGHT=1 to skip the
//      config flip (task.create then uses the default backend).
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureGateway } from "/Users/tranquangdang21/Projects/chromex/packages/native-host/dist/gateway-client.js";

const PROVIDER = process.env.CHROMEX_E2E_PROVIDER || "codex";
const MODEL = process.env.CHROMEX_E2E_MODEL || "xxx";
const TURN_DEADLINE_MS = Number(process.env.CHROMEX_E2E_TIMEOUT_MS || 300_000);
const dataDir = process.env.CHROMEX_GATEWAY_HOME || `${process.env.HOME}/.chromex/gateway`;

const hardDeadline = setTimeout(() => {
  console.error("FAIL — overall deadline exceeded");
  process.exit(2);
}, TURN_DEADLINE_MS + 60_000);

// ---- fixture http server ----
const FIXTURE_HTML = `<!doctype html><html><body>
<h1 id="title">Chromex Loop Fixture</h1>
<p id="status">ready</p>
<button id="go" onclick="document.getElementById('status').textContent='clicked'">Go</button>
</body></html>`;
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "text/html" });
  res.end(FIXTURE_HTML);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}/`;
console.log("fixture server:", BASE);

const conn = await ensureGateway(dataDir, {
  hello: {
    protocolVersion: 1,
    clientId: `e2e-loop-${randomUUID().slice(0, 8)}`,
    clientVersion: "0.0.1",
    profileId: "default",
    hostInstanceId: randomUUID(),
    browserInstanceId: null,
  },
  log: (m) => console.log("[gw]", m),
});
console.log("connected");

// ---- playwright gate: enable isolated backend for this run ----
let restorePlaywright = false;
const cfg = await conn.request("config.read", {});
const pwEnabled = cfg.config?.browser?.playwright?.enabledByUser === true;
const useIsolated = process.env.CHROMEX_E2E_NO_PLAYWRIGHT !== "1";
if (useIsolated && !pwEnabled) {
  await conn.request("config.update", { patch: { browser: { playwright: { enabledByUser: true } } } });
  restorePlaywright = true;
  console.log("enabled browser.playwright.enabledByUser for this run (will restore)");
}
const backend = useIsolated
  ? { backendId: "playwright-isolated", pinnedBy: "user" }
  : undefined;

// ---- live event capture ----
let taskId = null;
const live = [];
conn.onEvent((env) => {
  if (env.kind !== "event") return;
  if (taskId && env.taskId && env.taskId !== taskId) return;
  const p = env.payload ?? {};
  const type = p.type ?? env.type;
  const entry = { seq: env.seq, type, turnId: p.turnId ?? null, payload: p };
  live.push(entry);
  if (["turn.started", "turn.completed", "turn.failed", "turn.cancelled", "turn.unknown", "assistant.message", "tool.started", "tool.completed", "permission.requested"].includes(type)) {
    console.log(
      "EV", type,
      `turn=${entry.turnId ?? "-"}`,
      type === "assistant.message" ? JSON.stringify(p.text ?? "").slice(0, 200) :
      type === "tool.started" || type === "tool.completed" ? `tool=${p.tool} id=${p.toolCallId} outcome=${p.outcome ?? "-"}` : "",
    );
  }
  if (type === "permission.requested" && p.request?.requestId) {
    void answerPermission(p.request.requestId, p.request);
  }
});

async function answerPermission(requestId, request) {
  const options = request?.options ?? [];
  const allow = options.find((o) => o.kind !== "deny" && !/deny|reject|dismiss/i.test(String(o.id))) ?? options.find((o) => o.kind !== "deny") ?? options[0];
  const payload = { requestId };
  if (allow?.id) payload.optionId = allow.id;
  // question-style requests need answers; pick first option label per question
  const questions = request?.details?.argsPreview?.questions;
  if (Array.isArray(questions) && questions.length) {
    payload.answers = {};
    for (const q of questions) {
      const qOpts = Array.isArray(q.options) ? q.options : [];
      const pick = qOpts.find((o) => !/deny|reject|dismiss/i.test(String(o.id ?? "") + " " + String(o.label ?? ""))) ?? qOpts[0];
      payload.answers[String(q.id ?? "")] = [String(pick?.label ?? pick?.id ?? "yes")];
    }
  }
  if (!payload.optionId && !payload.answers) {
    console.log("!!! permission.requested", requestId, "has no answerable option — left pending");
    return;
  }
  try {
    await conn.request("permission.respond", payload);
    console.log(">>> permission.respond", requestId, "→", payload.optionId ?? "answers");
  } catch (err) {
    console.log("!!! permission.respond failed:", err?.message ?? err);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = ["turn.completed", "turn.failed", "turn.cancelled", "turn.unknown"];

async function waitTerminal(turnId, label) {
  const deadline = Date.now() + TURN_DEADLINE_MS;
  while (Date.now() < deadline) {
    const hit = live.find((e) => e.turnId === turnId && TERMINAL.includes(e.type));
    if (hit) {
      console.log(`${label}: terminal ${hit.type}`);
      return hit;
    }
    await sleep(300);
  }
  console.log(`${label}: TIMEOUT`);
  return null;
}

const cwd = mkdtempSync(path.join(tmpdir(), "chromex-e2e-loop-"));
let exitCode = 1;
try {
  const created = await conn.request("task.create", {
    cwd,
    providerId: PROVIDER,
    model: MODEL,
    title: "e2e browser tool loop",
    ...(backend ? { backend } : {}),
    tabIntent: { scope: "untitled" },
  });
  taskId = created.taskId ?? created.task?.taskId ?? created.id;
  console.log("task:", taskId, "backend:", JSON.stringify(backend ?? "default"));

  const prompt = [
    `You have MCP tools from the "chromex_browser" server (tool names like browser_page_navigate, browser_page_snapshot, browser_page_get, browser_page_click, browser_page_extract).`,
    `Use them to drive a real browser. Do exactly these steps, in order:`,
    `1. browser_page_navigate to ${BASE}`,
    `2. browser_page_snapshot to observe the page`,
    `3. browser_page_click the "Go" button`,
    `4. browser_page_get (or browser_page_snapshot) to observe the result`,
    `Then reply with one line: the h1 text and the #status text you observed.`,
  ].join("\n");

  const res = await conn.request("task.send", {
    taskId,
    clientMessageId: `e2e-loop-${Date.now()}`,
    content: [{ type: "text", text: prompt }],
  });
  const turnId = res.turnId ?? res.turn?.turnId;
  console.log("sent → turnId=", turnId);

  const terminal = await waitTerminal(turnId, "turn");

  // ---- evidence: durable replay ----
  const sync = await conn.request("task.sync", { taskId, fromSeq: 0, maxEvents: 10_000 });
  const events = sync.events ?? sync.replay?.events ?? [];
  const norm = events.map((e) => {
    const p = e.payload ?? e;
    return { seq: e.seq, type: e.type ?? p.type, payload: p };
  });
  const classified = norm.filter((e) => e.type === "browser.tool.classified");
  const toolDone = norm.filter((e) => e.type === "tool.completed" && e.payload?.tool === "mcpToolCall");
  const toolStart = norm.filter((e) => e.type === "tool.started" && e.payload?.tool === "mcpToolCall");
  const actions = classified.map((e) => e.payload?.action).filter(Boolean);
  console.log(`\nevidence: classified=${classified.length} mcpToolCall started=${toolStart.length} completed=${toolDone.length}`);
  console.log("classified actions:", JSON.stringify(actions));
  const succeeded = toolDone.filter((e) => e.payload?.outcome === "succeeded").length;
  console.log(`mcpToolCall succeeded=${succeeded} failed=${toolDone.length - succeeded}`);

  const OBSERVE = new Set(["browser.page.snapshot", "browser.page.get", "browser.page.extract", "browser.page.screenshot"]);
  const firstNav = actions.findIndex((a) => a === "browser.page.navigate");
  const lastObserve = actions.map((a, i) => (OBSERVE.has(a) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  const hasObserveActObserve = firstNav >= 0 && lastObserve > firstNav;

  console.log("\n=== RESULT ===");
  if (terminal?.type === "turn.completed" && classified.length >= 3 && toolDone.length >= 3 && hasObserveActObserve) {
    console.log(`PASS — provider iterated browser MCP tools (task ${taskId}, turn ${turnId})`);
    console.log("sequence:", JSON.stringify(actions));
    exitCode = 0;
  } else {
    console.log(`FAIL — terminal=${terminal?.type ?? "timeout"} classified=${classified.length} mcpDone=${toolDone.length} observeActObserve=${hasObserveActObserve}`);
    const tail = norm.slice(-30).map((e) => `${e.seq}:${e.type}`);
    console.log("event tail:", tail.join(" "));
    const assistant = norm.filter((e) => e.type === "assistant.message").map((e) => String(e.payload?.text ?? "").slice(0, 200));
    console.log("assistant tail:", JSON.stringify(assistant.slice(-3)));
  }
} finally {
  if (restorePlaywright) {
    try {
      await conn.request("config.update", { patch: { browser: { playwright: { enabledByUser: false } } } });
      console.log("restored browser.playwright.enabledByUser=false");
    } catch (err) {
      console.log("!!! failed to restore playwright config:", err?.message ?? err);
    }
  }
  server.close();
  clearTimeout(hardDeadline);
  process.exit(exitCode);
}
