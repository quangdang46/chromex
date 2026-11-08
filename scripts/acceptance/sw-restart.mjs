// sw-restart — service-worker / extension reload recovery on the real
// extension (headless Chrome for Testing).
//
// S5 proves gateway SIGKILL recovery; this proves the other half of
// "close panel / kill service worker": chrome.runtime.reload() kills
// the MV3 service worker, orphans every content script ("Extension
// context invalidated"), and drops the native-messaging host. The
// agent must recover with NO user action: SW restarts → NM host
// re-registers as browser host → browser calls dispatch again →
// ensureContentScript re-injects content.js into the live page →
// actions land exactly once (counter page proves no duplicate
// listeners survived the reload).
import { runScenario, sleep } from "./lib/harness.mjs";
import process from "node:process";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "sw-restart";

function findSnapshotId(outcome) {
  const s = JSON.stringify(outcome?.result ?? {});
  const m = s.match(/"snapshotId"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

await runScenario(
  SCENARIO,
  async ({ runner, browser, evidence, gateway }) => {
    const fixture = await startFixtureServer();
    try {
      const taskId = await runner.createTask({
        title: "sw restart e2e",
        cwd: "/tmp",
        backend: { backendId: "chrome-extension", pinnedBy: "user" },
        tabIntent: { scope: "untitled" },
      });
      const { token } = await runner.spawnBrowserScope(taskId);

      const page = await browser.context.newPage();
      await page.goto(fixture.url("/counter"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();

      // baseline: one agent-driven click → count must be exactly 1
      const snap1 = await runner.browserToolCall(taskId, "browser.page.snapshot", {}, token, 60_000);
      const snapId1 = findSnapshotId(snap1);
      const ref1 = snap1?.result?.elements?.find(
        (e) => String(e.label ?? "").includes("inc") || String(e.text ?? "").includes("inc"),
      )?.ref;
      evidence.note(`baseline snapshot=${snap1?.status} ref=${ref1}`);
      const click1 = await runner.browserToolCall(
        taskId, "browser.page.click",
        { ref: ref1 ?? "dom-1", ...(snapId1 ? { snapshotId: snapId1 } : {}) },
        token, 60_000,
      );
      evidence.note(`baseline click → ${click1?.status}`);
      await sleep(300);
      // NOTE: content scripts live in an isolated world — page.evaluate
      // (main world) cannot see __chromexContentScriptInstanceId. The
      // exact-count check below is the delivery proof instead.
      const count1 = await page.evaluate(() => document.getElementById("count")?.textContent);
      evidence.note(`count after baseline=${count1}`);
      if (count1 !== "1") {
        return { status: "FAIL", summary: `baseline click delivered ${count1} times, expected 1`, details: { click1 } };
      }

      // ---- reload the whole extension: SW dies, content scripts orphan ----
      const swsBefore = browser.context.serviceWorkers();
      try {
        const sp = await browser.context.newPage();
        await sp.goto(`chrome-extension://${browser.extensionId}/sidepanel.html?mode=popup&test=1`);
        await sp.evaluate(() => chrome.runtime.reload());
        await sp.close().catch(() => {});
      } catch (e) {
        evidence.note(`reload trigger failed: ${e?.message ?? e}`);
      }
      evidence.note(`extension reload triggered (sws before=${swsBefore.length})`);

      // wait for a NEW service worker (old object identities won't match)
      const swDeadline = Date.now() + 30_000;
      let newSw = null;
      while (Date.now() < swDeadline) {
        const sws = browser.context.serviceWorkers();
        newSw = sws.find((w) => !swsBefore.includes(w) && w.url().includes(browser.extensionId));
        if (newSw) break;
        await sleep(500);
      }
      evidence.note(`new service worker=${newSw ? newSw.url() : "none"}`);

      // host re-registration: the respawned SW must reconnect its NM host
      // and re-hello as a browser host. If it stays lazy, a tool call or a
      // sidepanel wake provides the traffic — either way it must recover.
      let authed = 0;
      const authedDeadline = Date.now() + 60_000;
      while (Date.now() < authedDeadline) {
        try {
          const d = await gateway.conn.request("diagnostics.snapshot", {});
          authed = d?.diagnostics?.endpoint?.authedConnections ?? d?.endpoint?.authedConnections ?? 0;
        } catch {}
        if (authed >= 2) break;
        if (authed === 1 && Date.now() > authedDeadline - 45_000) {
          // one wake attempt mid-window, like a user clicking the icon
          try {
            const sp = await browser.context.newPage();
            await sp.goto(`chrome-extension://${browser.extensionId}/sidepanel.html?mode=popup&test=1`);
            await sleep(3_000);
            await sp.close().catch(() => {});
            evidence.note("sidepanel wake during host re-registration wait");
          } catch {}
        }
        await sleep(1_000);
      }
      evidence.note(`authed gateway connections post-reload=${authed}`);

      // ---- agent calls must recover: page.get → snapshot → click ----
      const hostDeadline = Date.now() + 90_000;
      let get = null;
      while (Date.now() < hostDeadline) {
        try {
          get = await runner.browserToolCall(taskId, "browser.page.get", {}, token, 60_000);
        } catch (e) {
          get = { status: "threw", error: { code: e?.code ?? e?.message } };
        }
        if (get?.status === "completed") break;
        if (get?.error?.code !== "browser.no_host") break;
        evidence.note("browser.no_host post-reload — waiting for host re-register");
        await sleep(3_000);
      }
      evidence.note(`post-reload page.get → ${get?.status} ${JSON.stringify(get?.error ?? "")}`);

      let click2 = null;
      let count2 = null;
      let ariaOk = false;
      if (get?.status === "completed") {
        const snap2 = await runner.browserToolCall(taskId, "browser.page.snapshot", {}, token, 60_000);
        const snapId2 = findSnapshotId(snap2);
        const ref2 = snap2?.result?.elements?.find(
          (e) => String(e.label ?? "").includes("inc") || String(e.text ?? "").includes("inc"),
        )?.ref;
        evidence.note(`post-reload snapshot=${snap2?.status} ref=${ref2}`);
        click2 = await runner.browserToolCall(
          taskId, "browser.page.click",
          { ref: ref2 ?? "dom-1", ...(snapId2 ? { snapshotId: snapId2 } : {}) },
          token, 60_000,
        );
        evidence.note(`post-reload click → ${JSON.stringify(click2)?.slice(0, 250)}`);
        await sleep(300);
        count2 = await page.evaluate(() => document.getElementById("count")?.textContent);
        evidence.note(`count after post-reload click=${count2}`);

        // CDP tier must self-heal too: fresh SW has empty session state
        // while Chrome may still hold the debugger attach. mode:"aria"
        // forces acquireCdp → re-attach/"already attached" → AX tree.
        const aria = await runner.browserToolCall(
          taskId, "browser.page.snapshot", { mode: "aria" }, token, 60_000,
        );
        const ariaTree = JSON.stringify(aria?.result ?? {});
        evidence.note(`post-reload aria snapshot=${aria?.status} len=${ariaTree.length}`);
        ariaOk =
          aria?.status === "completed" &&
          /inc|button/i.test(ariaTree);
      }

      const pass =
        newSw != null &&
        authed >= 2 &&
        get?.status === "completed" &&
        click2?.status === "completed" &&
        count2 === "2" &&
        ariaOk === true;
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "extension reload → new SW + NM host re-registered → calls + CDP tier recovered → post-reload click delivered exactly once"
          : `newSw=${!!newSw} authed=${authed} get=${get?.status} click=${click2?.status} count=${count1}→${count2} aria=${ariaOk}`,
        details: { newSw: newSw?.url?.() ?? null, authed, getStatus: get?.status, click2Status: click2?.status, count1, count2, ariaOk },
      };
    } finally {
      await fixture.close();
    }
  },
  { autoAnswer: "allow", gatewayProviders: [], headless: process.env.CHROMEX_ACCEPTANCE_HEADFUL !== "1" },
);
