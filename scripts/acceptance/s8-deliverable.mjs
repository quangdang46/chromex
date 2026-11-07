// S8 — Verifiable deliverable: durable task.sync evidence (tool calls,
// events) + sidepanel UI rendering. Provider-free core is deterministic;
// the agent-authored deliverable card needs a live provider run (covered
// by s1) — noted in result, not faked.
import { runScenario, sleep } from "./lib/harness.mjs";
import process from "node:process";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "s8-deliverable";

await runScenario(
  SCENARIO,
  async ({ runner, browser, evidence }) => {
    const fixture = await startFixtureServer();
    try {
      const taskId = await runner.createTask({
        title: "s8 deliverable e2e",
        cwd: "/tmp",
        backend: { backendId: "chrome-extension", pinnedBy: "user" },
        tabIntent: { scope: "untitled" },
      });
      const { token } = await runner.spawnBrowserScope(taskId);

      const page = await browser.context.newPage();
      await page.goto(fixture.url("/"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();

      // generate durable evidence: navigate → snapshot → click → get
      const nav = await runner.browserToolCall(taskId, "browser.page.navigate", { url: fixture.url("/form") }, token, 60_000);
      const snap = await runner.browserToolCall(taskId, "browser.page.snapshot", {}, token, 60_000);
      // let the form paint before clicking — headless first-paint can lag
      // a domcontentloaded navigate just enough to flake element_not_visible
      await runner.browserToolCall(taskId, "browser.page.wait", { text: "Next", timeoutMs: 8000 }, token, 30_000).catch(() => {});
      let click = await runner.browserToolCall(taskId, "browser.page.click", { label: "Next" }, token, 60_000);
      if (click?.status === "failed" && /element_not_visible|stale_snapshot/.test(click?.error?.code ?? "")) {
        // same recovery a real agent does: re-observe, then retry once
        await runner.browserToolCall(taskId, "browser.page.snapshot", {}, token, 60_000);
        click = await runner.browserToolCall(taskId, "browser.page.click", { label: "Next" }, token, 60_000);
      }
      const get = await runner.browserToolCall(taskId, "browser.page.get", {}, token, 60_000);
      evidence.note(`calls: nav=${nav?.status} snap=${snap?.status} click=${click?.status} get=${get?.status}`);
      await evidence.screenshot(page, "s8-final-page");

      // durable dump
      const events = await runner.syncEvents(taskId);
      const toolStarted = events.filter((e) => e.type === "tool.started").length;
      const toolCompleted = events.filter((e) => e.type === "tool.completed").length;
      const classified = events.filter((e) => e.type === "browser.tool.classified").length;
      evidence.note(`durable events=${events.length} started=${toolStarted} completed=${toolCompleted} classified=${classified}`);

      // sidepanel as a regular tab (design: ?mode=popup&test=1)
      const sp = await browser.context.newPage();
      await sp.goto(`chrome-extension://${browser.extensionId}/sidepanel.html?mode=popup&test=1`, {
        waitUntil: "domcontentloaded",
        timeout: 15_000,
      });
      await sleep(1500);
      const spShot = await evidence.screenshot(sp, "s8-sidepanel");
      const spState = await sp.evaluate(() => ({
        title: document.title,
        bodyText: (document.body?.innerText ?? "").slice(0, 400),
        hasComposer: Boolean(document.querySelector("#composer")),
      })).catch((e) => ({ error: String(e) }));
      evidence.note(`sidepanel state: ${JSON.stringify(spState).slice(0, 400)}`);
      await sp.close().catch(() => {});

      const callsOk = [nav, snap, click, get].every((o) => o?.status === "completed");
      const durableOk = callsOk && events.length > 0 && toolStarted >= 4 && toolCompleted >= 4 && classified >= 4;
      const uiOk = Boolean(spState.hasComposer || (spState.bodyText ?? "").length > 20);
      const pass = durableOk && uiOk;
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "task.sync carries full tool evidence; sidepanel renders in real Chrome"
          : `durableOk=${durableOk} uiOk=${uiOk}`,
        details: {
          durableOk,
          uiOk,
          events: events.length,
          toolStarted,
          toolCompleted,
          classified,
          callsOk,
          callStatuses: { nav: nav?.status, snap: snap?.status, click: click?.status, get: get?.status },
          spState,
          note: "agent-authored deliverable card requires a live provider turn (see s1)",
        },
      };
    } finally {
      await fixture.close();
    }
  },
  { autoAnswer: "allow", gatewayProviders: [], headless: process.env.CHROMEX_ACCEPTANCE_HEADFUL !== "1" },
);
