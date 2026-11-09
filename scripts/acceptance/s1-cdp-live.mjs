// S1 variant — live provider (codex) drives the playwright-cdp backend:
// the coding agent owns a REAL attached Chromium over CDP. Same shape
// as s1-build-feature but the task is pinned to playwright-cdp with a
// dedicated --remote-debugging-port Chromium standing in for the user's
// browser. Proves the provider→MCP→gateway→connectOverCDP chain with a
// real agent, not a scripted caller.
import { chromium } from "playwright-core";
import { runScenario } from "./lib/harness.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "s1-cdp-live";
const PROVIDER = process.env.CHROMEX_E2E_PROVIDER || "codex";
const MODEL = process.env.CHROMEX_E2E_MODEL || "xxx";
const TURN_DEADLINE_MS = Number(process.env.CHROMEX_E2E_TIMEOUT_MS || 300_000);
const CDP_PORT = 19400 + Math.floor(Math.random() * 200);
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

await runScenario(
  SCENARIO,
  async ({ runner, evidence }) => {
    const fixture = await startFixtureServer();
    let cdpBrowser = null;
    try {
      // the "user's browser": plain chromium + remote debugging
      cdpBrowser = await chromium.launch({
        headless: true,
        args: [`--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1"],
      });
      const userPage = await cdpBrowser.newContext().then((c) => c.newPage());
      await userPage.goto("data:text/html,<title>USER-OWNED</title>");

      // opt the gateway in: user consent + endpoint + allowlist
      await runner.conn.request("config.update", {
        patch: {
          browser: {
            playwright: { enabledByUser: true, cdpEndpoint: CDP_ENDPOINT },
            allowedBackends: ["chrome-extension", "playwright-isolated", "playwright-cdp"],
          },
        },
      });

      let taskId;
      try {
        taskId = await runner.createTask({
          title: "s1 cdp live e2e",
          cwd: "/tmp",
          providerId: PROVIDER,
          model: MODEL,
          backend: { backendId: "playwright-cdp", pinnedBy: "user" },
          tabIntent: { scope: "untitled" },
        });
      } catch (e) {
        return { status: "BLOCKED", summary: `task.create failed: ${e?.message ?? e}` };
      }
      evidence.note(`task ${taskId} provider=${PROVIDER} backend=playwright-cdp endpoint=${CDP_ENDPOINT}`);

      let mcpDesc = null;
      try {
        mcpDesc = await runner.conn.request("browser.mcp.spawn", { taskId });
        evidence.note(`mcp descriptor scopeFile=${mcpDesc?.scopeFile}`);
      } catch (e) {
        evidence.note(`browser.mcp.spawn failed: ${e?.message ?? e}`);
      }
      const mcpFallback = mcpDesc
        ? [
            `If those tools are not callable as functions, the same MCP server is available as a stdio process you can drive yourself:`,
            `run \`${mcpDesc.command} ${mcpDesc.args.join(" ")}\` with env CHROMEX_MCP_SCOPE_FILE=${mcpDesc.scopeFile}`,
            `It speaks MCP JSON-RPC on stdio (initialize → tools/list → tools/call). Tool names are browser_page_navigate, browser_page_snapshot, browser_page_get, browser_page_click, browser_page_extract, browser_page_screenshot.`,
          ]
        : [];

      const prompt = [
        `You have MCP tools from the "chromex_browser" server (tool names like mcp__chromex_browser__browser_page_navigate, or browser_page_navigate inside the server).`,
        `Use them to drive a browser. Do exactly these steps, in order:`,
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

      const events = await runner.syncEvents(taskId);
      const classified = events.filter((e) => e.type === "browser.tool.classified");
      const actions = classified.map((e) => e.payload?.action).filter(Boolean);
      const browserDone = events.filter(
        (e) => e.type === "tool.completed" && String(e.payload?.tool ?? "").startsWith("browser."),
      );
      const browserSucceeded = browserDone.filter((e) => e.payload?.outcome === "succeeded" || e.payload?.status === "completed").length;
      const OBSERVE = new Set(["browser.page.snapshot", "browser.page.get", "browser.page.extract", "browser.page.screenshot"]);
      const firstNav = actions.findIndex((a) => a === "browser.page.navigate");
      const lastObserve = actions.map((a, i) => (OBSERVE.has(a) ? i : -1)).filter((i) => i >= 0).pop() ?? -1;
      const observeActObserve = firstNav >= 0 && lastObserve > firstNav;

      // the attached browser's own tab must never appear in tool results
      const tabsEv = events.filter((e) => e.type === "tool.completed" && e.payload?.tool === "browser.tabs.list");
      const userTabLeaked = tabsEv.some((e) => JSON.stringify(e.payload ?? {}).includes("USER-OWNED"));

      const pass =
        terminal?.type === "turn.completed" &&
        classified.length >= 3 &&
        browserSucceeded >= 3 &&
        observeActObserve &&
        !userTabLeaked;
      return {
        status: pass ? "PASS" : terminal ? "FAIL" : "BLOCKED",
        summary: pass
          ? "live provider iterated playwright-cdp browser tools observe→act→observe; user tab never leaked"
          : `terminal=${terminal?.type ?? "timeout"} classified=${classified.length} browserDone=${browserSucceeded}/${browserDone.length} oao=${observeActObserve} userTabLeaked=${userTabLeaked}`,
        details: { taskId, turnId, terminal: terminal?.type, actions, classified: classified.length, browserDone: browserDone.length, browserSucceeded, userTabLeaked },
      };
    } finally {
      await cdpBrowser?.close().catch(() => {});
      await fixture.close();
    }
  },
  { autoAnswer: "allow", gatewayProviders: [PROVIDER] },
);
