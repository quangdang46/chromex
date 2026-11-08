// S14 — browser.windows.* on the real extension, headful: the agent
// creates a dedicated window, drives its tab through the normal scope
// path, updates window state, and targets browser.tab.create at that
// windowId. This is the "own the browser chrome" leg — window/focus
// behavior cannot be verified headless.
import { runScenario, sleep } from "./lib/harness.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "s14-windows";

await runScenario(
  SCENARIO,
  async ({ runner, browser, evidence }) => {
    const fixture = await startFixtureServer();
    const openedTabIds = [];
    let taskId;
    let token;
    try {
      taskId = await runner.createTask({
        title: "s14 windows e2e",
        cwd: "/tmp",
        backend: { backendId: "chrome-extension", pinnedBy: "user" },
        tabIntent: { scope: "untitled" },
      });
      evidence.note(`task ${taskId}`);
      ({ token } = await runner.spawnBrowserScope(taskId));
      evidence.note("browser.mcp scope acquired");

      const call = (tool, args = {}, timeoutMs = 60_000) =>
        runner.browserToolCall(taskId, tool, args, token, timeoutMs);
      const result = (r) => r?.result ?? r ?? {};

      // baseline — window list is browser-wide, not tab-scoped
      const before = result(await call("browser.windows.list"));
      const beforeWindows = Array.isArray(before.windows) ? before.windows : [];
      evidence.note(`windows before=${beforeWindows.length} ids=${beforeWindows.map((w) => w.id).join(",")}`);
      if (!beforeWindows.length) {
        return { status: "FAIL", summary: "windows.list returned no windows", details: { before } };
      }

      // create a dedicated unfocused window with a fixture tab
      const created = result(
        await call("browser.windows.create", {
          url: fixture.url("/"),
          focused: false,
          width: 900,
          height: 700,
        }),
      );
      const windowId = created.windowId ?? created.id;
      const winTabId = created.openedTabId ?? created.tabs?.[0]?.id;
      evidence.note(`windows.create → windowId=${windowId} tabId=${winTabId} tabs=${created.tabs?.length}`);
      if (!Number.isInteger(windowId) || !Number.isInteger(winTabId)) {
        return { status: "FAIL", summary: "windows.create did not return windowId+tab", details: { created } };
      }
      openedTabIds.push(winTabId);
      await sleep(800);

      // the created tab entered task scope like tab.create — drive it
      const got = result(await call("browser.page.get", { tabId: winTabId, key: "title" }));
      evidence.note(`page.get on window tab → ${JSON.stringify(got).slice(0, 160)}`);
      if (got.value !== "Fixture Home") {
        return { status: "FAIL", summary: `window tab not drivable in scope (title=${got.value})`, details: { got } };
      }

      // a second tab targeted at the new windowId lands there
      const tab2 = result(
        await call("browser.tab.create", { url: fixture.url("/slow"), windowId, active: false }),
      );
      const tab2Id = tab2.tabId ?? tab2.openedTabId ?? tab2.id;
      evidence.note(`tab.create windowId=${windowId} → tabId=${tab2Id}`);
      if (!Number.isInteger(tab2Id)) {
        return { status: "FAIL", summary: "tab.create with windowId failed", details: { tab2 } };
      }
      openedTabIds.push(tab2Id);
      // tab.create returns before the new tab is observable in tabs.list —
      // poll briefly rather than racing the registration.
      let tab2Row;
      for (let i = 0; i < 10 && !tab2Row; i++) {
        const tabsNow = result(await call("browser.tabs.list"));
        tab2Row = (tabsNow.tabs ?? []).find((t) => t.id === tab2Id);
        if (!tab2Row) await sleep(500);
      }
      evidence.note(`tabs.list row for tab2 → ${JSON.stringify(tab2Row).slice(0, 200)}`);
      if (tab2Row?.windowId !== windowId) {
        return {
          status: "FAIL",
          summary: `tab.create windowId ignored (windowId=${tab2Row?.windowId}, want ${windowId})`,
          details: { tab2Row },
        };
      }

      // window state update round-trips through windows.list
      await call("browser.windows.update", { windowId, state: "maximized" });
      await sleep(400);
      const maximized = result(await call("browser.windows.list"));
      const winRow = (maximized.windows ?? []).find((w) => w.id === windowId);
      evidence.note(`windows.update maximized → state=${winRow?.state}`);
      if (winRow?.state !== "maximized") {
        return { status: "FAIL", summary: `windows.update state not applied (got ${winRow?.state})`, details: { winRow } };
      }
      await call("browser.windows.update", { windowId, state: "normal" });

      // invalid inputs fail honestly (browser.tool.call reports
      // status:"failed" + protocol error, never throws)
      const badState = await call("browser.windows.update", { windowId, state: "bogus" });
      const badCode = badState?.error?.code ?? badState?.result?.error?.code;
      if (badState?.status !== "failed" || !String(badCode ?? "").startsWith("proto.")) {
        return { status: "FAIL", summary: `windows.update accepted bogus state (${JSON.stringify(badState).slice(0, 200)})` };
      }
      evidence.note(`bogus state refused → ${badCode}`);

      // windows.remove — the window lifecycle closer. On headful Chrome
      // this must close the window AND leave the browser host alive
      // (headless CfT crashes inside chrome.windows.remove — a
      // Chromium headless bug — which is why this leg lives here).
      const rmRes = await call("browser.windows.remove", { windowId });
      const rmResult = result(rmRes);
      evidence.note(`windows.remove → ${JSON.stringify(rmRes)?.slice(0, 200)}`);
      await sleep(800);
      const afterRm = result(await call("browser.windows.list"));
      const stillThere = (afterRm.windows ?? []).some((w) => w.id === windowId);
      evidence.note(`post-remove window present=${stillThere} (host alive = list answered)`);
      if (rmRes?.status === "failed" || rmResult.removed !== true) {
        return { status: "FAIL", summary: `windows.remove failed (${JSON.stringify(rmRes).slice(0, 200)})`, details: { rmRes } };
      }
      if (stillThere) {
        return { status: "FAIL", summary: "windows.remove returned but window still listed", details: { afterRm } };
      }

      // cleanup: any tabs we opened outside the removed window
      for (const id of [...openedTabIds].reverse()) {
        await call("browser.tab.close", { tabId: id }).catch(() => {});
      }
      await sleep(500);

      return {
        status: "PASS",
        summary:
          "agent created a dedicated window, drove its tab in-scope, targeted tab.create at windowId, maximized+restored window state, bogus state refused, windows.remove closed it and the host stayed alive",
        details: { windowId, winTabId, tab2Id, beforeCount: beforeWindows.length },
      };
    } finally {
      // best-effort: close any tabs we opened so the CfT profile stays clean
      for (const id of openedTabIds) {
        if (taskId && token) {
          await runner
            .browserToolCall(taskId, "browser.tab.close", { tabId: id }, token, 15_000)
            .catch(() => {});
        }
      }
    }
  },
  {},
);
