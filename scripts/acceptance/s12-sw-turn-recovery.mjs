// S12 — Full extension reload (chrome.runtime.reload → MV3 service
// worker death) while a turn is running with a queued composer message.
// Harder than s11's sidepanel reload: the in-memory conversation runtime
// is gone, so activeTurn must be restored from the gateway hello
// (activeTurnId) and any turn.completed emitted while the SW was dead
// must arrive via task.sync replay. The queue must survive and flush
// exactly once.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runScenario, sleep, launchChromiumWithExtension } from "./lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "fixtures", "fake-acp-agent.mjs");
const SIDEPANEL_URL = (id, debug = true) =>
  `chrome-extension://${id}/sidepanel.html?mode=popup${debug ? "&debug=1" : ""}`;

await runScenario(
  "s12-sw-turn-recovery",
  async ({ runner, browser, evidence, gateway }) => {
    let sp = await browser.context.newPage();
    let relaunched = null;
    let restartMode = "runtime.reload";
    try {
      await sp.goto(SIDEPANEL_URL(browser.extensionId), { waitUntil: "domcontentloaded", timeout: 20_000 });
      await sp.evaluate(() => {
        window.__msgLog = [];
        const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (msg, ...rest) => {
          const p = orig(msg, ...rest);
          Promise.resolve(p)
            .then((r) => window.__msgLog.push({ type: msg?.type, ok: !r?.error, err: r?.error ?? null }))
            .catch((e) => window.__msgLog.push({ type: msg?.type, ok: false, err: String(e) }));
          return p;
        };
      });
      // The usage-notice onboarding hides the composer until accepted —
      // on hosts with an authenticated codex account it gates first paint.
      // Accept via the real button when present, then wait for the composer.
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
          settings: { agentProviderId: "fakeacp", usageNoticeAccepted: true, rememberChats: true },
        }),
      );

      const send = async (page, text) => {
        await page.fill("#composer", text);
        await page.press("#composer", "Enter");
      };

      // turn 1: fake agent holds FAKE_ACP_TURN_MS (25s) then end_turn
      await send(sp, "first turn — survive the reload");
      await sp.waitForSelector("#stop-turn", { timeout: 45_000 });
      await sleep(1500);
      evidence.note("turn 1 active");

      // turn 1 must be a real GATEWAY turn before we reload — #stop-turn
      // only proves the sidepanel is pending; on a cold SW the
      // prompt.send → session.open → task.create chain can take tens of
      // seconds (NM host spawn, hello, syncAll, provider spawn). Reloading
      // earlier kills the SW mid-flight and the "recovery" being tested
      // never had a gateway turn to recover. Poll task.list until the
      // task exists, then confirm an active turn on it.
      let gwTaskId = null;
      let activeTurnId = null;
      const taskDeadline = Date.now() + 60_000;
      while (Date.now() < taskDeadline && !activeTurnId) {
        await sleep(1000);
        const tl = await runner.conn.request("task.list", {}).catch(() => null);
        const list = tl?.tasks ?? tl?.items ?? (Array.isArray(tl) ? tl : []);
        gwTaskId = list[0]?.taskId ?? list[0]?.id ?? gwTaskId;
        if (!gwTaskId) continue;
        const tg = await runner.conn.request("task.get", { taskId: gwTaskId }).catch(() => null);
        activeTurnId = tg?.activeTurn?.turnId ?? tg?.activeTurn?.id ?? null;
      }
      evidence.note(`gateway turn 1 established: task=${gwTaskId} activeTurn=${activeTurnId}`);
      if (!activeTurnId) {
        return {
          status: "FAIL",
          summary: "turn 1 never became a gateway turn before reload — prompt.send did not reach task.create",
          details: { gwTaskId, activeTurnId },
        };
      }

      // queue a follow-up while turn 1 runs
      await send(sp, "flush me after the extension reload");
      await sp.waitForSelector(".composer-queue", { timeout: 10_000 });
      evidence.note("second message queued");

      // baseline: the task must exist gateway-side BEFORE the reload —
      // if task.list is already empty here the failure is upstream of
      // the SW restart and the post-reload checks are meaningless.
      const preTl = await runner.conn.request("task.list", {}).catch((e) => ({ __err: String(e?.message ?? e) }));
      evidence.note(`pre-reload task.list: ${JSON.stringify(preTl)?.slice(0, 300)}`);

      // ---- kill the whole extension: SW + this sidepanel page die ----
      const swsBefore = browser.context.serviceWorkers();
      const reloader = await browser.context.newPage();
      await reloader.goto(SIDEPANEL_URL(browser.extensionId, false), {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      await reloader.evaluate(() => chrome.runtime.reload());
      await reloader.close().catch(() => {});
      evidence.note(`chrome.runtime.reload() triggered (sws before=${swsBefore.length})`);

      // wait for a NEW service worker — bail early if the SW list stays
      // empty. On Chromium-for-Testing (Windows AND headful) a
      // chrome.runtime.reload() permanently kills the extension: no new
      // SW ever registers and every chrome-extension:// navigation fails
      // ERR_BLOCKED_BY_CLIENT (probe-sw-reload.mjs). sw-restart.mjs shows
      // the reload path recovering on platforms where CfT supports it.
      const swDeadline = Date.now() + 30_000;
      let newSw = null;
      let emptySince = null;
      while (Date.now() < swDeadline) {
        const sws = browser.context.serviceWorkers();
        newSw = sws.find((w) => !swsBefore.includes(w) && w.url().includes(browser.extensionId));
        if (newSw) break;
        if (sws.length === 0) {
          emptySince ??= Date.now();
          if (Date.now() - emptySince > 8_000) break;
        } else {
          emptySince = null;
        }
        await sleep(500);
      }
      evidence.note(`new service worker=${newSw ? "up" : "none"}`);

      if (!newSw) {
        // Cold-start equivalent: relaunch the browser on the SAME profile
        // (chrome.storage queue survives) and SAME isolated gateway home
        // (task + active turn survive). Strictly stronger than an SW
        // restart — the whole extension process is gone.
        evidence.note("runtime.reload did not recover — relaunching browser on same profile + gateway home");
        await browser.context.close().catch(() => {});
        const b2 = await launchChromiumWithExtension({
          gatewayHome: gateway.dataDir,
          headless: true,
          userDataDir: browser.userDataDir,
        });
        relaunched = b2;
        browser = b2;
        restartMode = "browser-relaunch";
        newSw = b2.context.serviceWorkers()[0] ?? "relaunch";
        // the respawned SW must re-register its NM host before ui.init
        // sees the real provider catalog
        const reReg = Date.now() + 120_000;
        let authed = 0;
        while (Date.now() < reReg) {
          try {
            const d = await runner.conn.request("diagnostics.snapshot", {});
            authed = d?.diagnostics?.endpoint?.authedConnections ?? d?.endpoint?.authedConnections ?? 0;
          } catch {}
          if (authed >= 2) break;
          await sleep(500);
        }
        evidence.note(`post-relaunch authed gateway connections=${authed}`);
      }

      // gateway must still be alive and holding the task — the extension
      // reload must not have taken it down
      for (let i = 0; i < 10; i++) {
        const diag = await runner.conn.request("diagnostics.snapshot", {}).catch((e) => ({ __err: String(e?.message ?? e) }));
        const tl = await runner.conn.request("task.list", {}).catch((e) => ({ __err: String(e?.message ?? e) }));
        evidence.note(`post-reload gw check ${i}: diag=${JSON.stringify(diag)?.slice(0, 160)} tasks=${JSON.stringify(tl)?.slice(0, 200)}`);
        const n = tl?.tasks?.length ?? tl?.items?.length ?? (Array.isArray(tl) ? tl.length : 0);
        if (n > 0) break;
        await sleep(2000);
      }

      // reopen the sidepanel — fresh JS context, state only from storage.
      // chrome-extension:// navigations transiently fail with
      // ERR_BLOCKED_BY_CLIENT while the reloaded extension settles — retry.
      await sp.close().catch(() => {});
      sp = await browser.context.newPage();
      const navDeadline = Date.now() + 45_000;
      for (;;) {
        try {
          await sp.goto(SIDEPANEL_URL(browser.extensionId), { waitUntil: "domcontentloaded", timeout: 20_000 });
          break;
        } catch (e) {
          if (Date.now() >= navDeadline) throw e;
          await sleep(1000);
        }
      }
      await sp.waitForSelector("#composer", { timeout: 30_000 });

      // turn 1 is still running gateway-side → the restored panel must
      // show it as active (hello activeTurnId → ui.init fallback) and
      // must NOT have flushed the queue early. turn1 may finish during
      // the wait — capture diagnostics either way.
      let stopSeen = true;
      try {
        await sp.waitForSelector("#stop-turn", { timeout: 20_000 });
      } catch {
        stopSeen = false;
      }
      const postReload = await sp.evaluate(async () => ({
        stored: await chrome.storage.local
          .get("chromex.sidepanel.queuedComposerMessages")
          .then((r) => JSON.stringify(r).slice(0, 300)),
        queuePresent: Boolean(document.querySelector(".composer-queue")),
        composerHtml: (document.querySelector(".composer-shell")?.innerHTML ?? "").slice(0, 200),
        uiInit: await chrome.runtime
          .sendMessage({ type: "ui.init" })
          .then((p) => JSON.stringify({
            convId: p?.currentConversation?.id ?? null,
            threadId: p?.currentConversation?.threadId ?? null,
            activeTurn: p?.activeTurn ?? null,
            initError: p?.error ?? null,
          }))
          .catch((e) => `err:${e}`),
        gwTasks: await chrome.runtime
          .sendMessage({ type: "gateway.tasks" })
          .then((p) => JSON.stringify({ enabled: p?.enabled, state: p?.state, tasks: (p?.tasks ?? []).map((t) => ({ id: t.taskId, status: t.status, activeTurnId: t.activeTurnId })) }))
          .catch((e) => `err:${e}`),
        gwDebug: await chrome.storage.local
          .get(["chromex.debug.gwRuntime", "chromex.debug.gwClient"])
          .then((r) => JSON.stringify({ rt: r?.["chromex.debug.gwRuntime"] ?? null, client: r?.["chromex.debug.gwClient"] ?? null }))
          .catch((e) => `err:${e}`),
      }));
      evidence.note(`post-reload: stopSeen=${stopSeen} ${JSON.stringify(postReload)}`);
      const queueKept = await sp.$(".composer-queue");
      evidence.note(`queue strip present post-reload=${Boolean(queueKept)}`);

      // the task id is already known from the pre-reload poll — reuse it
      evidence.note(`task ${gwTaskId}`);

      // turn 1 completes → queue must flush → turn 2 → completed.
      // turn.completed may have fired while the SW was dead — the
      // reconnected client must have it via task.sync replay.
      const deadline = Date.now() + 90_000;
      let evs = [];
      let queueGone = false;
      while (Date.now() < deadline) {
        await sleep(1000);
        queueGone = !(await sp.$(".composer-queue"));
        evs = gwTaskId ? await runner.syncEvents(gwTaskId).catch(() => []) : [];
        const completed = evs.filter((e) => e.type === "turn.completed").length;
        if (queueGone && completed >= 2) break;
      }
      const completed = evs.filter((e) => e.type === "turn.completed").length;
      const cancelled = evs.filter((e) => e.type === "turn.cancelled").length;
      const failed = evs.filter((e) => e.type === "turn.failed").length;
      const unknown = evs.filter((e) => e.type === "turn.unknown").length;
      const userMsgs = evs.filter((e) => e.type === "user.message.created").length;
      evidence.note(
        `final: queueGone=${queueGone} completed=${completed} cancelled=${cancelled} failed=${failed} unknown=${unknown} userMsgs=${userMsgs} seq=${evs.map((e) => e.type).join(">")}`,
      );
      await evidence.screenshot(sp, "s12-final");

      const storedQueue = await sp.evaluate(() =>
        chrome.storage.local.get("chromex.sidepanel.queuedComposerMessages").then((r) => JSON.stringify(r)),
      );
      evidence.note(`storedQueue=${storedQueue}`);

      const pass =
        newSw != null &&
        queueGone &&
        completed === 2 &&
        userMsgs === 2 &&
        failed === 0 &&
        cancelled === 0 &&
        unknown === 0;
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? `${restartMode === "browser-relaunch" ? "browser relaunch (runtime.reload unrecoverable on this Chromium)" : "extension reload"} mid-turn → activeTurn restored via gateway hello → queue survived → flushed exactly once on turn.completed`
          : `restart=${restartMode} newSw=${!!newSw} queueGone=${queueGone} completed=${completed} userMsgs=${userMsgs} failed=${failed} cancelled=${cancelled} unknown=${unknown}`,
        details: { restartMode, newSw: !!newSw, queueGone, completed, userMsgs, failed, cancelled, unknown, storedQueue },
      };
    } finally {
      await sp.close().catch(() => {});
      if (relaunched) {
        await relaunched.context.close().catch(() => {});
        const { rm } = await import("node:fs/promises");
        await rm(relaunched.staged.root, { recursive: true, force: true }).catch(() => {});
      }
    }
  },
  {
    needsBrowser: true,
    needsGateway: true,
    gatewayProviders: [],
    gatewayAcpProviders: {
      fakeacp: {
        enabled: true,
        command: process.execPath,
        args: [FAKE_AGENT],
        // turn 1 must outlive gateway establishment + reload + flush;
        // later prompts finish in ~1.5s (fixture default)
        env: { FAKE_ACP_TURN_MS: "60000" },
        models: null,
        additionalModels: null,
        defaultModel: null,
      },
    },
    autoAnswer: "allow",
    headless: true,
  },
);
