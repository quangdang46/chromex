// S1 — Build a web feature: agent drives the REAL extension backend.
// Live-provider run (codex, model $CHROMEX_E2E_MODEL || "xxx"):
// navigate fixture → snapshot → click → observe, on chrome-extension
// backend (not playwright-isolated). PASS = turn.completed + ≥3
// browser.tool.classified + observe→act→observe ordering.
// BLOCKED when the provider cannot run (no creds/binary) — never faked.
import { runScenario, sleep, TERMINAL_TURN, GATEWAY_BIN } from "./lib/harness.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";
import { dirname, join } from "node:path";

const SCENARIO = "s1-build-feature";
const PROVIDER = process.env.CHROMEX_E2E_PROVIDER || "codex";
const MODEL = process.env.CHROMEX_E2E_MODEL || "xxx";
const TURN_DEADLINE_MS = Number(process.env.CHROMEX_E2E_TIMEOUT_MS || 300_000);
const BACKEND = { backendId: "chrome-extension", pinnedBy: "user" };

await runScenario(
  SCENARIO,
  async ({ runner, browser, evidence }) => {
    const fixture = await startFixtureServer();
    try {
      // pre-open + activate the fixture tab so the untitled scope binds it
      const page = await browser.context.newPage();
      await page.goto(fixture.url("/"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      await evidence.screenshot(page, "s1-initial");

      let taskId;
      try {
        taskId = await runner.createTask({
          title: "s1 build feature e2e",
          cwd: "/tmp",
          providerId: PROVIDER,
          model: MODEL,
          backend: BACKEND,
          tabIntent: { scope: "untitled" },
        });
      } catch (e) {
        return { status: "BLOCKED", summary: `task.create failed: ${e?.message ?? e}` };
      }
      evidence.note(`task ${taskId} provider=${PROVIDER} model=${MODEL}`);

      // Fetch the chromex_browser MCP stdio descriptor the gateway
      // registered for this task — gives the agent a concrete fallback
      // when the provider doesn't surface MCP tools natively (codex
      // 0.165 exposes them as empty namespaces).
      let mcpDesc = null;
      try {
        mcpDesc = await runner.conn.request("browser.mcp.spawn", { taskId });
        evidence.note(`mcp descriptor scopeFile=${mcpDesc?.scopeFile}`);
      } catch (e) {
        evidence.note(`browser.mcp.spawn failed: ${e?.message ?? e}`);
      }

      const mcpFallback = mcpDesc
        ? [
            // Same fallback the codex session injects itself: the
            // maintained mcp-call.js CLI (discovery + error recovery +
            // artifact paths), never hand-rolled JSON-RPC.
            `If the chromex_browser MCP tools are not callable as functions, use the maintained CLI instead:`,
            `node "${join(dirname(GATEWAY_BIN), "..", "browser", "mcp-call.js")}" --list --scope "${mcpDesc.scopeFile}"`,
            `node "${join(dirname(GATEWAY_BIN), "..", "browser", "mcp-call.js")}" <tool_name> '<json_args>' --scope "${mcpDesc.scopeFile}"`,
            `Tool names are browser_page_navigate, browser_page_snapshot, browser_page_get, browser_page_extract, browser_page_click, browser_page_screenshot.`,
          ]
        : [];

      const prompt = [
        `You have MCP tools from the "chromex_browser" server (tool names like mcp__chromex_browser__browser_page_navigate, or browser_page_navigate inside the server).`,
        `Use them to drive the user's real Chrome browser. Do exactly these steps, in order:`,
        `1. browser_page_navigate to ${fixture.url("/")}`,
        `2. browser_page_snapshot to observe the page`,
        `3. browser_page_click the "Go" button`,
        `4. browser_page_get (or browser_page_snapshot) to observe the result`,
        ...mcpFallback,
        `Then reply with one line: the h1 text and the #status text you observed.`,
      ].join("\n");

      let turnId;
      try {
        turnId = await runner.sendTurn(taskId, prompt);
      } catch (e) {
        return { status: "BLOCKED", summary: `task.send failed (provider unavailable?): ${e?.message ?? e}`, details: { taskId } };
      }
      evidence.note(`turn ${turnId}`);

      const terminal = await runner.waitTerminal(taskId, turnId, TURN_DEADLINE_MS);
      await evidence.screenshot(page, "s1-final");

      // latency attribution: turn wall-time vs measured browser tool
      // execution — the split the review asked for (model/MCP vs Chrome).
      let diag = null;
      try {
        diag = (await runner.conn.request("diagnostics.snapshot", {}))?.diagnostics;
        evidence.note(
          `latency turn=${diag?.turns?.durationMs?.last ?? "?"}ms tools=${diag?.tools?.latencyMs?.last ?? "?"}ms approvalWait=${diag?.tools?.approvalWaitMs?.last ?? "?"}ms`,
        );
      } catch (e) {
        evidence.note(`diagnostics.snapshot failed: ${e?.message ?? e}`);
      }

      const events = await runner.syncEvents(taskId);
      const classified = events.filter((e) => e.type === "browser.tool.classified");
      const actions = classified.map((e) => e.payload?.action).filter(Boolean);
      // Gateway-emitted completions for real browser executions
      // (toolCallId mcp-N-*), regardless of how the agent reached the
      // MCP server — same convention as scripts/gateway-e2e-browserloop.mjs.
      const browserDone = events.filter(
        (e) => e.type === "tool.completed" && String(e.payload?.tool ?? "").startsWith("browser."),
      );
      const browserSucceeded = browserDone.filter((e) => e.payload?.outcome === "succeeded" || e.payload?.status === "completed").length;
      const mcpDone = events.filter((e) => e.type === "tool.completed" && e.payload?.tool === "mcpToolCall");
      const OBSERVE = new Set(["browser.page.snapshot", "browser.page.get", "browser.page.extract", "browser.page.screenshot"]);
      const firstNav = actions.findIndex((a) => a === "browser.page.navigate");
      const lastObserve = actions.map((a, i) => (OBSERVE.has(a) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
      const observeActObserve = firstNav >= 0 && lastObserve > firstNav;

      const pass =
        terminal?.type === "turn.completed" &&
        classified.length >= 3 &&
        browserSucceeded >= 3 &&
        observeActObserve;
      return {
        status: pass ? "PASS" : terminal ? "FAIL" : "BLOCKED",
        summary: pass
          ? "provider iterated real-extension browser tools observe→act→observe"
          : `terminal=${terminal?.type ?? "timeout"} classified=${classified.length} browserDone=${browserSucceeded}/${browserDone.length} mcpDone=${mcpDone.length} oao=${observeActObserve}`,
        details: { taskId, turnId, terminal: terminal?.type, actions, classified: classified.length, browserDone: browserDone.length, browserSucceeded, mcpDone: mcpDone.length, latency: diag ? { turnMs: diag.turns?.durationMs, toolMs: diag.tools?.latencyMs, approvalWaitMs: diag.tools?.approvalWaitMs } : null },
      };
    } finally {
      await fixture.close();
    }
  },
  { autoAnswer: "allow", gatewayProviders: [PROVIDER] },
);
