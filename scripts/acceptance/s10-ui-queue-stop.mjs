// S10 — UI-level Stop + composer queue on the REAL extension sidepanel.
// Headless Chrome for Testing loads the built extension; the sidepanel
// runs as a tab (?mode=popup&test=1) and is driven through its real DOM.
// Provider is the deterministic fake ACP agent — no codex cost.
//
// Proves: composer send during an active turn lands in the queue strip
// (not steer); Stop cancels the provider turn AND does not flush the
// queue; the queued message stays visible for the user to send later.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runScenario, sleep } from "./lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "fixtures", "fake-acp-agent.mjs");

await runScenario(
  "s10-ui-queue-stop",
  async ({ runner, browser, evidence }) => {
    const sp = await browser.context.newPage();
    try {
      // NOTE: no ?test=1 — that enables smokeTestMode which dry-runs sends.
      await sp.goto(`chrome-extension://${browser.extensionId}/sidepanel.html?mode=popup`, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
      // record every runtime message + response for debugging
      await sp.evaluate(() => {
        window.__msgLog = [];
        const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = (msg, ...rest) => {
          const p = orig(msg, ...rest);
          Promise.resolve(p)
            .then((r) => window.__msgLog.push({ type: msg?.type, ok: !r?.error, err: r?.error ?? null, resp: JSON.stringify(r)?.slice(0, 200) }))
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

      // route new conversations to the deterministic fake ACP provider
      const setProvider = await sp.evaluate(() =>
        chrome.runtime.sendMessage({
          type: "settings.update",
          settings: { agentProviderId: "fakeacp", usageNoticeAccepted: true },
        }),
      );
      evidence.note(`settings.update → ${JSON.stringify(setProvider)?.slice(0, 160)}`);
      const snap = await sp.evaluate(() =>
        chrome.runtime.sendMessage({ type: "ui.settings.snapshot" }),
      );
      evidence.note(`settings.agentProviderId now: ${snap?.settings?.agentProviderId}`);

      const providerOptions = await sp.evaluate(() =>
        [...document.querySelectorAll("#agent-provider-select option")].map((o) => `${o.value}:${o.textContent}`),
      );
      evidence.note(`provider options: ${JSON.stringify(providerOptions)}`);

      const send = async (text) => {
        await sp.fill("#composer", text);
        await sp.press("#composer", "Enter");
      };

      // ---- turn 1: long-running fake prompt ----
      await send("first long turn — keep working");
      // gateway-side truth while UI catches up: a task + running turn must exist
      let gwTaskId = null;
      for (let i = 0; i < 15 && !gwTaskId; i++) {
        await sleep(1000);
        const tl = await runner.conn.request("task.list", {}).catch(() => null);
        const list = tl?.tasks ?? tl?.items ?? (Array.isArray(tl) ? tl : []);
        gwTaskId = list[0]?.taskId ?? list[0]?.id ?? null;
      }
      evidence.note(`gateway task after send: ${gwTaskId}`);
      if (gwTaskId) {
        const t = await runner.conn.request("task.get", { taskId: gwTaskId }).catch((e) => ({ err: String(e) }));
        evidence.note(`task.get → providerId=${t?.providerId ?? t?.task?.providerId} ${JSON.stringify(t).slice(0, 300)}`);
      }
      try {
        await sp.waitForSelector("#stop-turn", { timeout: 30_000 });
      } catch (err) {
        const diag = await sp.evaluate(() => ({
          composerValue: document.querySelector("#composer")?.value ?? "(no composer)",
          bodyTail: (document.body?.innerText ?? "").slice(-1200),
          msgLog: (window.__msgLog ?? []).filter((m) => /prompt|conversation|turn|task|send/i.test(m.type ?? "")).slice(-15),
          buttons: [...document.querySelectorAll("button")].map((b) => b.id || b.className).filter(Boolean).slice(0, 30),
        }));
        evidence.note(`diag after send: ${JSON.stringify(diag).slice(0, 1500)}`);
        throw err;
      }
      evidence.note("stop button visible — turn 1 active");

      // ---- turn 2 attempt while active → must QUEUE, not steer ----
      await send("queued second message");
      await sp.waitForSelector(".composer-queue", { timeout: 10_000 });
      const queueText = (await sp.textContent(".composer-queue")) ?? "";
      evidence.note(`queue strip: ${queueText.trim().slice(0, 120)}`);
      if (!queueText.includes("queued second")) {
        return { status: "FAIL", summary: "second message did not land in the queue strip", details: { queueText } };
      }

      // ---- Stop: cancels provider turn, must NOT flush the queue ----
      await sp.click("#stop-turn");
      await sleep(4_000);

      const afterStop = await sp.evaluate(async () => ({
        queueStillThere: Boolean(document.querySelector(".composer-queue")),
        queueText: (document.querySelector(".composer-queue")?.textContent ?? "").slice(0, 160),
        stopVisible: Boolean(document.querySelector("#stop-turn")),
        errorText: (document.querySelector(".init-error, .error-banner, [class*=error]")?.textContent ?? "").slice(0, 200),
        storedQueue: await chrome.storage.local.get("chromex.sidepanel.queuedComposerMessages").then((r) => JSON.stringify(r).slice(0, 300)),
      }));
      evidence.note(`after stop: ${JSON.stringify(afterStop)}`);
      await evidence.screenshot(sp, "s10-after-stop");

      // gateway-side truth: exactly one cancelled turn, no second turn started
      const evs = gwTaskId ? await runner.syncEvents(gwTaskId).catch(() => []) : [];
      const cancelled = evs.filter((e) => e.type === "turn.cancelled").length;
      const completed = evs.filter((e) => e.type === "turn.completed").length;
      const failed = evs.filter((e) => e.type === "turn.failed").length;
      const started = evs.filter((e) => e.type === "turn.started" || e.type === "user.message.created").length;
      evidence.note(`task ${gwTaskId} events=${evs.length} cancelled=${cancelled} completed=${completed} failed=${failed} userMsgs=${started} seq=${evs.map((e) => `${e.seq}:${e.type}`).join(">")}`);
      evidence.note(`failPayloads=${JSON.stringify(evs.filter((e) => e.type === "turn.failed").map((e) => e.payload)).slice(0, 800)}`);

      const queueKept = afterStop.queueStillThere && afterStop.queueText.includes("queued second");
      const noFlush = cancelled >= 1 && completed === 0 && failed === 0;
      const pass = queueKept && noFlush;
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "UI queue held the second message; Stop cancelled the provider turn without flushing the queue"
          : `queueKept=${queueKept} noFlush=${noFlush} cancelled=${cancelled} completed=${completed}`,
        details: { afterStop, cancelled, completed, started },
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
        env: { FAKE_ACP_TURN_MS: "90000" },
        models: null,
        additionalModels: null,
        defaultModel: null,
      },
    },
    autoAnswer: "allow",
    headless: true,
  },
);
