// S18 — Real Claude integration through the real extension UI.
//
// Unlike the fake-ACP scenarios, the provider is the genuine
// @anthropic-ai/claude-agent-sdk path (Claude Code OAuth on this
// machine). The sidepanel prompt goes UI → gateway → claude session →
// claude decides which chromex_browser MCP tools to call → gateway tool
// server → chrome-extension backend → the CfT browser. PASS requires a
// real browser mutation (counter page #count === "1"), not just a
// completed turn — a chatty non-answer FAILs honestly.
//
// Non-deterministic by nature: assertions are on outcomes (tool calls
// happened, page changed), never on Claude's exact wording.
import { runScenario, sleep } from "./lib/harness.mjs";
import process from "node:process";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "s18-claude-browser";

await runScenario(
  SCENARIO,
  async ({ runner, browser, evidence }) => {
    const fixture = await startFixtureServer();
    try {
      const sp = await browser.context.newPage();
      await sp.goto(`chrome-extension://${browser.extensionId}/sidepanel.html?mode=popup&debug=1`, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      await sp
        .waitForSelector("#composer, [data-usage-notice-accept]", { timeout: 20_000 })
        .catch(() => {});
      const noticeAccepted = await sp.evaluate(() => {
        const btn = document.querySelector("[data-usage-notice-accept]");
        if (!btn) return false;
        btn.click();
        return true;
      });
      evidence.note(`usage notice accept clicked=${noticeAccepted}`);
      await sp.waitForSelector("#composer", { timeout: 20_000 });
      await sleep(1500);

      await sp.evaluate(() =>
        chrome.runtime.sendMessage({
          type: "settings.update",
          settings: { agentProviderId: "claude", usageNoticeAccepted: true, rememberChats: true },
        }),
      );
      await sleep(1000);

      const target = fixture.url("/counter");
      const prompt =
        `Quick browser task — use ONLY your chromex_browser MCP tools, nothing else ` +
        `(no shell commands, no file reads, no exploration): ` +
        `1) browser_tab_create a new tab at ${target}. ` +
        `2) browser_page_snapshot that tab and find the button labeled "inc". ` +
        `3) browser_page_click it exactly once. ` +
        `4) browser_page_extract the #count element text. ` +
        `Then reply with just the final count number.`;

      await sp.fill("#composer", prompt);
      await sp.press("#composer", "Enter");
      evidence.note("claude prompt sent");

      // find the gateway task this UI send created
      let taskId = null;
      const taskDeadline = Date.now() + 60_000;
      while (Date.now() < taskDeadline && !taskId) {
        await sleep(1000);
        const tl = await runner.conn.request("task.list", {}).catch(() => null);
        const list = tl?.tasks ?? tl?.items ?? (Array.isArray(tl) ? tl : []);
        taskId = list[0]?.taskId ?? list[0]?.id ?? null;
      }
      evidence.note(`gateway task=${taskId}`);
      if (!taskId) {
        return { status: "FAIL", summary: "no gateway task appeared after UI send" };
      }

      // wait for terminal turn — real claude turns take tens of seconds
      const deadline = Date.now() + 300_000;
      let evs = [];
      let terminal = null;
      while (Date.now() < deadline) {
        await sleep(2000);
        evs = await runner.syncEvents(taskId).catch(() => []);
        terminal = evs.find((e) => ["turn.completed", "turn.failed", "turn.cancelled", "turn.unknown"].includes(e.type)) ?? null;
        if (terminal) break;
      }
      const toolCalls = evs.filter((e) => e.type === "tool.completed");
      // durable events wrap the inner event in `payload`; claude MCP
      // tools surface as mcp__chromex_browser__browser_*
      const toolName = (e) => String(e.payload?.tool ?? e.tool ?? "");
      const browserTools = toolCalls.filter((e) => /browser/i.test(toolName(e)));
      evidence.note(
        `turn=${terminal?.type ?? "timeout"} toolCalls=${toolCalls.length} browserTools=${browserTools.length} ` +
          `seq=${evs.map((e) => e.type).join(">").slice(0, 400)}`,
      );

      // did the browser actually change? find the counter page among
      // the CfT context pages (agent-created tab lives there)
      let countText = null;
      const pageDeadline = Date.now() + 15_000;
      while (Date.now() < pageDeadline && countText === null) {
        for (const p of browser.context.pages()) {
          try {
            if (p.url().includes("/counter")) {
              countText = await p.evaluate(() => document.getElementById("count")?.textContent ?? null);
              break;
            }
          } catch {}
        }
        if (countText === null) await sleep(500);
      }
      evidence.note(`counter #count=${countText}`);

      const pass =
        terminal?.type === "turn.completed" &&
        browserTools.length > 0 &&
        countText === "1";
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "real claude turn via extension UI → chromex_browser MCP tools → counter page clicked exactly once (#count=1)"
          : `turn=${terminal?.type ?? "timeout"} browserTools=${browserTools.length} count=${countText}`,
        details: {
          taskId,
          terminal: terminal?.type ?? null,
          toolCalls: toolCalls.length,
          browserTools: browserTools.map((e) => `${toolName(e)}:${e.payload?.outcome ?? "?"}`).slice(0, 20),
          countText,
        },
      };
    } finally {
      await fixture.close();
    }
  },
  {
    needsBrowser: true,
    needsGateway: true,
    gatewayProviders: ["claude"],
    autoAnswer: "allow",
    headless: true,
  },
);
