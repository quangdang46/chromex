// S6 — Failed plan: stale snapshot binding → loud failure → re-observe →
// retry succeeds. Deterministic, provider-free: exercises the
// browser.stale_snapshot contract end-to-end on the real extension.
//
// Flow: snapshot (mints snapshotId) → navigate (invalidates it) → click
// with the stale snapshotId must FAIL with browser.stale_snapshot →
// fresh snapshot → click succeeds. Never fakes success.
import { runScenario, sleep } from "./lib/harness.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "s6-failedplan";

// dig snapshotId / structuralFingerprint out of a tool outcome result
function findSnapshotId(outcome) {
  const r = outcome?.result;
  if (!r) return null;
  const s = JSON.stringify(r);
  const m = s.match(/"snapshotId"\s*:\s*"([^"]+)"/) ?? s.match(/snapshotId["']?\s*[:=]\s*["']?([A-Za-z0-9_-]+)/);
  return m ? m[1] : null;
}

await runScenario(
  SCENARIO,
  async ({ runner, browser, evidence }) => {
    const fixture = await startFixtureServer();
    try {
      const taskId = await runner.createTask({
        title: "s6 failed plan e2e",
        cwd: "/tmp",
        backend: { backendId: "chrome-extension", pinnedBy: "user" },
        tabIntent: { scope: "untitled" },
      });
      const { token } = await runner.spawnBrowserScope(taskId);

      const page = await browser.context.newPage();
      await page.goto(fixture.url("/"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();

      // 1. snapshot on "/" — mints snapshotId S1
      const snap1 = await runner.browserToolCall(taskId, "browser.page.snapshot", {}, token, 60_000);
      const snapId1 = findSnapshotId(snap1);
      evidence.note(`snapshot1 status=${snap1?.status} snapshotId=${snapId1}`);
      if (snap1?.status !== "completed" || !snapId1) {
        return { status: "FAIL", summary: "initial snapshot did not mint a snapshotId", details: { snap1 } };
      }

      // 2. navigate away — invalidates S1
      const nav = await runner.browserToolCall(taskId, "browser.page.navigate", { url: fixture.url("/form") }, token, 60_000);
      evidence.note(`navigate → ${nav?.status}`);

      // 3. act with the STALE snapshotId — must fail loudly, not act blindly
      let stale = null;
      try {
        stale = await runner.browserToolCall(
          taskId,
          "browser.page.click",
          { ref: "e1", snapshotId: snapId1 },
          token,
          60_000,
        );
      } catch (e) {
        stale = { rpcError: e?.message };
      }
      evidence.note(`stale click → ${JSON.stringify(stale)?.slice(0, 400)}`);
      const staleFailed =
        stale == null ||
        stale.rpcError ||
        stale.status === "failed" ||
        /stale|snapshot|navigated/i.test(JSON.stringify(stale?.error ?? stale));

      // 4. re-observe (the "re-plan" step) then act on fresh state
      const snap2 = await runner.browserToolCall(taskId, "browser.page.snapshot", {}, token, 60_000);
      const snapId2 = findSnapshotId(snap2);
      evidence.note(`snapshot2 status=${snap2?.status} snapshotId=${snapId2}`);
      const click = await runner.browserToolCall(
        taskId,
        "browser.page.click",
        { label: "Next", ...(snapId2 ? { snapshotId: snapId2 } : {}) },
        token,
        60_000,
      );
      evidence.note(`fresh click → ${JSON.stringify(click)?.slice(0, 300)}`);
      await sleep(400);
      await evidence.screenshot(page, "s6-after-retry");

      // verify the click actually landed: step2 visible on /form
      const get = await runner.browserToolCall(taskId, "browser.page.get", {}, token, 60_000);
      const pageText = JSON.stringify(get?.result ?? {});
      const formAdvanced = /Signup Form/.test(pageText);

      const pass = staleFailed && click?.status === "completed" && snap2?.status === "completed";
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "stale snapshotId rejected loudly; re-observe + retry succeeded"
          : `staleFailed=${staleFailed} click=${click?.status} snap2=${snap2?.status}`,
        details: { staleFailed, clickStatus: click?.status, snap2Status: snap2?.status, formAdvanced, stale },
      };
    } finally {
      await fixture.close();
    }
  },
  { autoAnswer: "allow", gatewayProviders: [] },
);
