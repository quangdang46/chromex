// S17 — Goal Mode extension UX through the real sidepanel UI
// (headless Chrome for Testing + built extension + fake ACP providers).
//
//   Leg A (fakegoal — config declares capabilities.goalMode=true):
//     attachment menu shows Goal mode → toggle arms → .composer-goal-armed
//     badge → send consumes it once (useGoal+goalObjective reach the
//     gateway turn ctx) → turn completes.
//   Leg B (fakeacp — no goalMode): menu hides the Goal mode item.
//   Leg C: disarm via [data-goal-disarm] → next send is a plain turn.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runScenario, sleep, TERMINAL_TURN } from "./lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "fixtures", "fake-acp-agent.mjs");

await runScenario(
  "s17-goal-ui",
  async ({ runner, browser, evidence }) => {
    const sp = await browser.context.newPage();
    try {
      await sp.goto(`chrome-extension://${browser.extensionId}/sidepanel.html?mode=popup&debug=1`, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      await sp
        .waitForSelector("#composer, [data-usage-notice-accept]", { timeout: 20_000 })
        .catch(() => {});
      await sp.evaluate(() => {
        const btn = document.querySelector("[data-usage-notice-accept]");
        btn?.click();
      });
      await sp.waitForSelector("#composer", { timeout: 20_000 });
      await sleep(1500);

      const setProvider = (id) =>
        sp.evaluate(
          (providerId) =>
            chrome.runtime.sendMessage({
              type: "settings.update",
              settings: { agentProviderId: providerId, usageNoticeAccepted: true },
            }),
          id,
        );

      const openMenu = async () => {
        await sp.click(".composer-attach-button");
        await sp.waitForSelector(".attachment-menu", { timeout: 5_000 });
      };
      const goalItem = () => sp.$('[data-attachment-menu-action="toggle-goal-mode"]');
      const closeMenu = async () => sp.keyboard.press("Escape").catch(() => {});

      // ---------- Leg A: goal-capable provider ----------
      await setProvider("fakegoal");
      if (process.env.CHROMEX_S17_NM_PROBE) {
        const sw = (await browser.context.serviceWorkers())[0];
        if (sw) {
          const probe = await sw.evaluate(
            () =>
              new Promise((resolve) => {
                try {
                  const port = chrome.runtime.connectNative("com.codex.sidepanel.bridge");
                  const timer = setTimeout(() => resolve({ result: "still-connected-after-8s" }), 8000);
                  port.onDisconnect.addListener(() => {
                    clearTimeout(timer);
                    resolve({ result: "disconnected", lastError: chrome.runtime.lastError?.message ?? null });
                  });
                  port.onMessage.addListener(() => {});
                } catch (e) {
                  resolve({ result: "threw", error: String(e) });
                }
              }),
          );
          evidence.note(`NM probe: ${JSON.stringify(probe)}`);
        } else {
          evidence.note("NM probe: no service worker found");
        }
      }
      // provider.catalog feeds state.agentProviders asynchronously
      // (cold SW → gateway connect → catalog fetch → settings-change
      // force-refresh) — poll ui.init until fakegoal appears.
      let diag = null;
      const pollProviders = async (tries) => {
        for (let i = 0; i < tries; i++) {
          await sleep(1000);
          diag = await sp.evaluate(async () => {
            const init = await chrome.runtime.sendMessage({ type: "ui.init" }).catch((e) => ({ err: String(e) }));
            return {
              agentProviders: init?.agentProviders ?? null,
              providerId: init?.settings?.agentProviderId ?? init?.agentProviderId ?? null,
              gatewayMode: init?.settings?.gatewayMode ?? null,
            };
          });
          if ((diag?.agentProviders ?? []).some((p) => p.id === "fakegoal")) return true;
        }
        return false;
      };
      if (!(await pollProviders(15))) {
        // First catalog fetch may have raced the lazy NM-host spawn and
        // timed out (30s request timeout, no retry). Flip the provider
        // away and back to force refreshCatalogAfterProviderChange again.
        evidence.note("catalog poll 1 missed fakegoal — retriggering provider change");
        await setProvider("fakeacp");
        await sleep(2000);
        await setProvider("fakegoal");
        await pollProviders(45);
      }
      evidence.note(`ui.init diag: ${JSON.stringify(diag).slice(0, 600)}`);
      await openMenu();
      const itemA = await goalItem();
      evidence.note(`fakegoal goal menu item present=${Boolean(itemA)}`);
      if (!itemA) {
        return { status: "FAIL", summary: "goal-capable provider did not expose Goal mode in attachment menu", details: { diag } };
      }
      await itemA.click();
      await closeMenu();
      await sp.waitForSelector(".composer-goal-armed", { timeout: 5_000 });
      const pressed = await sp.$eval(
        '[data-attachment-menu-action="toggle-goal-mode"]',
        (el) => el.getAttribute("aria-pressed"),
      ).catch(() => null);
      evidence.note(`armed badge visible, menu aria-pressed=${pressed}`);

      // send while armed → badge consumed once, useGoal reaches gateway
      await sp.fill("#composer", "s17 armed goal message");
      await sp.press("#composer", "Enter");
      await sleep(1500);
      const armedAfterSend = Boolean(await sp.$(".composer-goal-armed"));
      evidence.note(`armed badge after send=${armedAfterSend} (expect false — consumed once)`);

      // wait for the turn to finish, then inspect the durable ctx
      let turnDone = false;
      let useGoalSeen = null;
      const deadline = Date.now() + 60_000;
      while (Date.now() < deadline && !turnDone) {
        await sleep(1000);
        const tl = await runner.conn.request("task.list", {}).catch(() => null);
        const list = tl?.tasks ?? tl?.items ?? (Array.isArray(tl) ? tl : []);
        const tid = list[list.length - 1]?.taskId ?? list[list.length - 1]?.id;
        if (!tid) continue;
        const evs = await runner.syncEvents(tid).catch(() => []);
        const userMsg = evs.find((e) => (e.type ?? e.payload?.type) === "user.message.created");
        const msg = userMsg?.message ?? userMsg?.payload?.message ?? userMsg?.payload ?? {};
        const meta = msg?.ctx?.metadata ?? null;
        if (meta) useGoalSeen = meta.useGoal === true;
        turnDone = evs.some((e) => TERMINAL_TURN.includes(e.type ?? e.payload?.type));
      }
      evidence.note(`turnDone=${turnDone} useGoal in durable ctx=${useGoalSeen}`);
      if (!turnDone || useGoalSeen !== true) {
        return {
          status: "FAIL",
          summary: `armed send did not produce a completed goal turn (turnDone=${turnDone} useGoal=${useGoalSeen})`,
        };
      }

      // ---------- Leg C: disarm → plain send ----------
      await openMenu();
      const itemC = await goalItem();
      if (itemC) await itemC.click();
      await closeMenu();
      await sp.waitForSelector(".composer-goal-armed", { timeout: 5_000 });
      await sp.click("[data-goal-disarm]");
      await sleep(500);
      const armedAfterDisarm = Boolean(await sp.$(".composer-goal-armed"));
      evidence.note(`armed badge after disarm=${armedAfterDisarm} (expect false)`);
      await sp.fill("#composer", "s17 disarmed plain message");
      await sp.press("#composer", "Enter");
      await sleep(1500);

      // ---------- Leg B: unsupported provider hides the item ----------
      await setProvider("fakeacp");
      await sleep(1500);
      await openMenu();
      const itemB = await goalItem();
      evidence.note(`fakeacp goal menu item present=${Boolean(itemB)} (expect false)`);
      await closeMenu();
      if (itemB) {
        return { status: "FAIL", summary: "unsupported provider still exposes Goal mode in attachment menu" };
      }

      const pass = !armedAfterSend && !armedAfterDisarm;
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "Goal Mode UX: menu toggle arms badge, send consumes once with useGoal ctx, disarm works, unsupported provider hides the item"
          : `armedAfterSend=${armedAfterSend} armedAfterDisarm=${armedAfterDisarm}`,
        details: { turnDone, useGoalSeen, armedAfterSend, armedAfterDisarm, itemB: Boolean(itemB) },
      };
    } finally {
      await sp.close().catch(() => {});
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
        env: { FAKE_ACP_TURN_MS: "1500" },
        models: null,
        additionalModels: null,
        defaultModel: null,
      },
      fakegoal: {
        enabled: true,
        command: process.execPath,
        args: [FAKE_AGENT],
        env: { FAKE_ACP_TURN_MS: "1500" },
        capabilities: { goalMode: true },
        models: null,
        additionalModels: null,
        defaultModel: null,
      },
    },
    autoAnswer: "allow",
    headless: true,
  },
);
