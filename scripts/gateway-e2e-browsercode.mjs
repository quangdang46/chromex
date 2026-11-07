import "./lib/require-browser-consent.mjs";

// E2E (chromex-d9o): browser↔code feedback loop — the agent edits code,
// drives a browser at the result, observes, verifies, iterates.
//
// Realistic version without a real dev server: the script spawns a tiny
// http.server serving a fixture index.html from a temp cwd. The agent
// (codex, model $CHROMEX_E2E_MODEL || "xxx") gets BOTH provider-native
// file/shell tools and the chromex_browser MCP tools (playwright-
// isolated backend — deterministic, never touches the user's Chrome).
//
// Scenario:
//  1. fixture index.html served at http://127.0.0.1:<port>/ contains
//     <h1>before</h1>; token CHROMEX-VERIFIED-<rand> is the target text.
//  2. task.send instructs: navigate → observe → edit index.html
//     (h1 → token) → reload → observe → confirm token visible.
//  3. PASS = turn.completed AND:
//     a) index.html on disk contains the token (edit happened),
//     b) http://127.0.0.1:<port>/ now serves the token (verify target),
//     c) ≥1 browser.page.navigate + ≥1 observation tool
//        (snapshot/get/extract) reached the tool server
//        (browser.tool.classified), AND
//     d) an observation tool call happened AFTER the edit — proxied by
//        a second navigate or a snapshot/get occurring after the first
//        navigate in the classified sequence.
//
// Env: same as gateway-e2e-browserloop.mjs.
import { randomUUID } from "node:crypto";
import http from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureGateway } from "/Users/tranquangdang21/Projects/chromex/packages/native-host/dist/gateway-client.js";

const PROVIDER = process.env.CHROMEX_E2E_PROVIDER || "codex";
const MODEL = process.env.CHROMEX_E2E_MODEL || "xxx";
const TURN_DEADLINE_MS = Number(process.env.CHROMEX_E2E_TIMEOUT_MS || 420_000);
const dataDir = process.env.CHROMEX_GATEWAY_HOME || `${process.env.HOME}/.chromex/gateway`;

const TOKEN = `CHROMEX-VERIFIED-${randomUUID().slice(0, 8).toUpperCase()}`;

const hardDeadline = setTimeout(() => {
  console.error("FAIL — overall deadline exceeded");
  process.exit(2);
}, TURN_DEADLINE_MS + 60_000);

// ---- fixture: cwd dir + http server ----
const cwd = mkdtempSync(path.join(tmpdir(), "chromex-e2e-code-"));
const indexPath = path.join(cwd, "index.html");
writeFileSync(
  indexPath,
  `<!doctype html><html><body>\n<h1>before</h1>\n<p id="note">edit me</p>\n</body></html>\n`,
);
const server = http.createServer((req, res) => {
  try {
    const body = readFileSync(indexPath);
    res.writeHead(200, { "content-type": "text/html" });
    res.end(body);
  } catch {
    res.writeHead(500);
    res.end("missing");
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const BASE = `http://127.0.0.1:${port}/`;
console.log("fixture:", indexPath, "served at", BASE, "token:", TOKEN);

const conn = await ensureGateway(dataDir, {
  hello: {
    protocolVersion: 1,
    clientId: `e2e-code-${randomUUID().slice(0, 8)}`,
    clientVersion: "0.0.1",
    profileId: "default",
    hostInstanceId: randomUUID(),
    browserInstanceId: null,
  },
  log: (m) => console.log("[gw]", m),
});
console.log("connected");

// ---- playwright gate ----
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

let exitCode = 1;
try {
  const created = await conn.request("task.create", {
    cwd,
    providerId: PROVIDER,
    model: MODEL,
    title: "e2e browser-code loop",
    ...(backend ? { backend } : {}),
    tabIntent: { scope: "untitled" },
  });
  taskId = created.taskId ?? created.task?.taskId ?? created.id;
  console.log("task:", taskId, "backend:", JSON.stringify(backend ?? "default"));

  const prompt = [
    `This directory contains index.html, which is being served at ${BASE} by a static file server (it serves whatever index.html currently contains).`,
    `You have two tool families: your normal file/shell tools, and MCP browser tools from the "chromex_browser" server. The exact tool names are mcp__chromex_browser__browser_page_navigate, mcp__chromex_browser__browser_page_snapshot, mcp__chromex_browser__browser_page_get, mcp__chromex_browser__browser_page_extract, mcp__chromex_browser__browser_page_click, mcp__chromex_browser__browser_page_fill. If your tool list only shows a namespace, use your tool-search/discovery mechanism to load them; do not call the namespace itself.`,
    `Do the browser↔code loop, in order:`,
    `1. mcp__chromex_browser__browser_page_navigate to ${BASE} and observe the page (snapshot or get). Confirm the h1 says "before".`,
    `2. Edit index.html in this directory: change the <h1> text to exactly ${TOKEN} (keep it a single h1).`,
    `3. Reload the page in the browser (navigate to ${BASE} again) and observe it again.`,
    `4. Verify via get/snapshot that the page now shows ${TOKEN}.`,
    `5. Reply with one line: DONE plus the h1 text you observed after reload.`,
  ].join("\n");

  const res = await conn.request("task.send", {
    taskId,
    clientMessageId: `e2e-code-${Date.now()}`,
    content: [{ type: "text", text: prompt }],
  });
  const turnId = res.turnId ?? res.turn?.turnId;
  console.log("sent → turnId=", turnId);

  const terminal = await waitTerminal(turnId, "turn");

  // ---- independent verification (not trusting the agent's word) ----
  const diskHtml = readFileSync(indexPath, "utf8");
  const diskHasToken = diskHtml.includes(TOKEN);
  let servedHtml = "";
  try {
    const r = await fetch(BASE);
    servedHtml = await r.text();
  } catch (err) {
    console.log("fixture fetch failed:", err?.message ?? err);
  }
  const servedHasToken = servedHtml.includes(TOKEN);

  const sync = await conn.request("task.sync", { taskId, fromSeq: 0, maxEvents: 10_000 });
  const events = sync.events ?? sync.replay?.events ?? [];
  const norm = events.map((e) => {
    const p = e.payload ?? e;
    return { seq: e.seq, type: e.type ?? p.type, payload: p };
  });
  const classified = norm.filter((e) => e.type === "browser.tool.classified");
  const actions = classified.map((e) => e.payload?.action).filter(Boolean);
  const toolDone = norm.filter((e) => e.type === "tool.completed" && e.payload?.tool === "mcpToolCall");
  // Gateway-emitted browser tool executions (any reach path).
  const browserDone = norm.filter(
    (e) => e.type === "tool.completed" && String(e.payload?.tool ?? "").startsWith("browser."),
  );
  const browserSucceeded = browserDone.filter((e) => e.payload?.outcome === "succeeded").length;
  const OBSERVE = new Set(["browser.page.snapshot", "browser.page.get", "browser.page.extract", "browser.page.screenshot"]);
  const navCount = actions.filter((a) => a === "browser.page.navigate").length;
  const observeCount = actions.filter((a) => OBSERVE.has(a)).length;
  const firstNav = actions.indexOf("browser.page.navigate");
  const lastObserve = actions.map((a, i) => (OBSERVE.has(a) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
  const reobserveAfterAct = lastObserve > firstNav && firstNav >= 0;

  console.log(`\nevidence: classified=${classified.length} actions=${JSON.stringify(actions)}`);
  console.log(`browserExec completed=${browserDone.length} succeeded=${browserSucceeded}; provider mcpToolCall completed=${toolDone.length}`);
  console.log(`diskHasToken=${diskHasToken} servedHasToken=${servedHasToken} navCount=${navCount} observeCount=${observeCount}`);

  console.log("\n=== RESULT ===");
  const pass =
    terminal?.type === "turn.completed" &&
    diskHasToken &&
    servedHasToken &&
    navCount >= 2 &&
    observeCount >= 2 &&
    browserSucceeded >= 3 &&
    reobserveAfterAct;
  if (pass) {
    console.log(`PASS — browser↔code loop proven (task ${taskId}, turn ${turnId}, token ${TOKEN})`);
    exitCode = 0;
  } else {
    console.log(
      `FAIL — terminal=${terminal?.type ?? "timeout"} disk=${diskHasToken} served=${servedHasToken} ` +
        `nav=${navCount} observe=${observeCount} browserExec=${browserSucceeded} reobserve=${reobserveAfterAct}`,
    );
    const assistant = norm.filter((e) => e.type === "assistant.message").map((e) => String(e.payload?.text ?? "").slice(0, 300));
    console.log("assistant tail:", JSON.stringify(assistant.slice(-3)));
    const tail = norm.slice(-40).map((e) => `${e.seq}:${e.type}${e.payload?.tool ? `(${e.payload.tool})` : ""}`);
    console.log("event tail:", tail.join(" "));
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
