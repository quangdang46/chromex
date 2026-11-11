// S19 — Real Claude multi-tab browser ownership.
//
// Extends S18: one Claude turn must coordinate TWO task-scoped tabs —
// open /counter?start=10 and /counter?start=20, click "inc" exactly
// once in EACH, then report both counts. PASS requires both pages to
// show their seeded+1 values (11 and 21) — proving the agent's tab
// handles stayed scoped and it didn't cross wires between tabs.
//
// Non-deterministic by nature: assertions are on outcomes (both tabs
// mutated correctly), never on Claude's exact wording.
import { runScenario, sleep } from "./lib/harness.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "s19-claude-multitab";

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
      await sp.evaluate(() => {
        document.querySelector("[data-usage-notice-accept]")?.click();
      });
      await sp.waitForSelector("#composer", { timeout: 20_000 });
      await sleep(1500);

      await sp.evaluate(() =>
        chrome.runtime.sendMessage({
          type: "settings.update",
          settings: { agentProviderId: "claude", usageNoticeAccepted: true, rememberChats: true },
        }),
      );
      await sleep(1000);

      const urlA = fixture.url("/counter?start=10");
      const urlB = fixture.url("/counter?start=20");
      const prompt =
        `Browser task — use ONLY your chromex_browser MCP tools, nothing else ` +
        `(no shell commands, no file reads): ` +
        `1) browser_tab_create TWO tabs: one at ${urlA} and one at ${urlB}. ` +
        `2) In EACH tab, browser_page_snapshot to find the "inc" button, then ` +
        `browser_page_click it exactly once — keep the two tabs separate, ` +
        `click each tab's own button. ` +
        `3) browser_page_extract the #count text from each tab. ` +
        `Reply with just the two numbers, tab A then tab B.`;

      await sp.fill("#composer", prompt);
      await sp.press("#composer", "Enter");
      evidence.note("claude prompt sent");

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

      const deadline = Date.now() + 300_000;
      let evs = [];
      let terminal = null;
      while (Date.now() < deadline) {
        await sleep(2000);
        evs = await runner.syncEvents(taskId).catch(() => []);
        terminal = evs.find((e) => ["turn.completed", "turn.failed", "turn.cancelled", "turn.unknown"].includes(e.type)) ?? null;
        if (terminal) break;
      }
      const toolName = (e) => String(e.payload?.tool ?? e.tool ?? "");
      const toolCalls = evs.filter((e) => e.type === "tool.completed");
      const browserTools = toolCalls.filter((e) => /browser/i.test(toolName(e)));
      const creates = browserTools.filter((e) => /tab_create|tab\.create/i.test(toolName(e)));
      const clicks = browserTools.filter((e) => /page_click|page\.click/i.test(toolName(e)));
      evidence.note(
        `turn=${terminal?.type ?? "timeout"} toolCalls=${toolCalls.length} browserTools=${browserTools.length} ` +
          `creates=${creates.length} clicks=${clicks.length}`,
      );

      // verify both tabs independently — distinguish by ?start= param
      const counts = { A: null, B: null };
      const pageDeadline = Date.now() + 20_000;
      while (Date.now() < pageDeadline && (counts.A === null || counts.B === null)) {
        for (const p of browser.context.pages()) {
          try {
            const u = p.url();
            if (u.includes("start=10")) {
              counts.A = await p.evaluate(() => document.getElementById("count")?.textContent ?? null);
            } else if (u.includes("start=20")) {
              counts.B = await p.evaluate(() => document.getElementById("count")?.textContent ?? null);
            }
          } catch {}
        }
        if (counts.A === null || counts.B === null) await sleep(500);
      }
      evidence.note(`counts A(start=10)=${counts.A} B(start=20)=${counts.B}`);

      const pass =
        terminal?.type === "turn.completed" &&
        creates.length >= 1 &&
        clicks.length >= 2 &&
        counts.A === "11" &&
        counts.B === "21";
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "real claude turn → two task-scoped tabs → each counter clicked exactly once (11 and 21)"
          : `turn=${terminal?.type ?? "timeout"} creates=${creates.length} clicks=${clicks.length} counts=${counts.A}/${counts.B}`,
        details: {
          taskId,
          terminal: terminal?.type ?? null,
          toolCalls: toolCalls.length,
          creates: creates.length,
          clicks: clicks.length,
          counts,
          browserTools: browserTools.map((e) => `${toolName(e)}:${e.payload?.outcome ?? "?"}`).slice(0, 30),
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
