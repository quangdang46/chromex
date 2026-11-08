// tab-close-last — headless Chromium crashes on window teardown:
// closing a window's LAST tab kills the whole browser (BUS_ADRALN,
// reproduced on CfT 158 — same bug as chrome.windows.remove). The
// tool host must refuse that close with proto.unsupported, and the
// documented workaround (open a sibling tab first) must actually work.
import { runScenario, sleep } from "./lib/harness.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

await runScenario(
  "tab-close-last",
  async ({ runner, browser, evidence }) => {
    const fixture = await startFixtureServer();
    try {
      const taskId = await runner.createTask({
        title: "last-tab-close crash guard",
        cwd: "/tmp",
        backend: { backendId: "chrome-extension", pinnedBy: "user" },
        tabIntent: { scope: "untitled" },
      });
      const { token } = await runner.spawnBrowserScope(taskId);

      // dedicated window with exactly one tab
      const wc = await runner.browserToolCall(
        taskId, "browser.windows.create", { url: fixture.url("/"), focused: false }, token, 60_000,
      );
      const win = wc?.result?.window ?? wc?.window ?? wc?.result ?? {};
      const windowId = win.id ?? win.windowId;
      const tabId = win.openedTabId ?? win.tabId ?? win.tabs?.[0]?.id;
      evidence.note(`windows.create → ${JSON.stringify(wc)?.slice(0, 300)}`);
      if (typeof tabId !== "number" || typeof windowId !== "number") {
        return { status: "FAIL", summary: "could not resolve window/tab ids", details: { wc } };
      }

      // 1) closing the ONLY tab must be refused, not crash the browser
      const close1 = await runner.browserToolCall(
        taskId, "browser.tab.close", { tabId }, token, 60_000,
      );
      const err1 = close1?.error ?? {};
      evidence.note(`last-tab close → ${JSON.stringify(close1)?.slice(0, 300)}`);
      const refusedOk = close1?.status === "failed" && err1.code === "proto.unsupported";

      // host must still be alive
      await sleep(1000);
      const probe = await runner.browserToolCall(taskId, "browser.windows.list", {}, token, 30_000).catch((e) => ({ err: String(e) }));
      const alive = probe && probe.status !== "failed" && !probe.err;
      evidence.note(`post-refusal probe → ${JSON.stringify(probe)?.slice(0, 200)} alive=${alive}`);

      // 2) workaround: sibling tab into the same window, then close the
      //    original — window keeps one tab, no teardown, close succeeds
      let workaroundOk = false;
      let siblingId = null;
      if (alive) {
        const tc = await runner.browserToolCall(
          taskId, "browser.tab.create",
          { url: fixture.url("/fetch"), windowId, active: false }, token, 60_000,
        );
        siblingId = tc?.result?.openedTabId ?? tc?.result?.tabId ?? tc?.openedTabId ?? tc?.tabId;
        evidence.note(`sibling create → ${JSON.stringify(tc)?.slice(0, 300)}`);
        if (typeof siblingId === "number") {
          await sleep(500);
          const close2 = await runner.browserToolCall(
            taskId, "browser.tab.close", { tabId }, token, 60_000,
          );
          evidence.note(`sibling-present close → ${JSON.stringify(close2)?.slice(0, 300)}`);
          workaroundOk = close2?.status === "completed" || close2?.result?.closed === tabId;
          // leave the sibling tab — it is now the window's last tab and
          // must NOT be closed (that would crash); scenario teardown
          // quits the whole browser cleanly instead.
        }
      }

      return {
        status: refusedOk && alive && workaroundOk ? "PASS" : "FAIL",
        summary: `refused=${refusedOk} alive=${alive} workaround=${workaroundOk}`,
        details: { windowId, tabId, siblingId, close1, probe, refusedOk, alive, workaroundOk },
      };
    } finally {
      await fixture.close();
    }
  },
  { headless: true },
);
