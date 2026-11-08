// S11 — Composer queue auto-flush on turn.completed through the real
// sidepanel UI (headless Chrome for Testing + built extension + fake
// ACP provider). Companion to s10 (which covers the cancel path):
// here turn 1 finishes normally, so the queued message must dequeue
// and send itself as the next turn — FIFO, exactly once.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runScenario, sleep } from "./lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "fixtures", "fake-acp-agent.mjs");

await runScenario(
  "s11-ui-queue-flush",
  async ({ runner, browser, evidence }) => {
    const sp = await browser.context.newPage();
    const consoleLines = [];
    sp.on("console", (msg) => {
      const text = msg.text();
      if (text.includes("chromex-queue")) consoleLines.push(text);
    });
    try {
      await sp.goto(`chrome-extension://${browser.extensionId}/sidepanel.html?mode=popup&debug=1`, {
        waitUntil: "domcontentloaded",
        timeout: 20_000,
      });
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
      await sp.waitForSelector("#composer", { timeout: 20_000 });
      await sleep(1500);

      await sp.evaluate(() =>
        chrome.runtime.sendMessage({
          type: "settings.update",
          // rememberChats is required for the conversation (and therefore
          // its queue key) to survive the reload below
          settings: { agentProviderId: "fakeacp", usageNoticeAccepted: true, rememberChats: true },
        }),
      );

      const send = async (text) => {
        await sp.fill("#composer", text);
        await sp.press("#composer", "Enter");
      };

      // turn 1: fake agent holds FAKE_ACP_TURN_MS (8s) then end_turn
      await send("first turn — finish soon");
      await sp.waitForSelector("#stop-turn", { timeout: 45_000 });
      // #stop-turn can render from promptActivity before state.activeTurn
      // lands; the local queue path requires activeTurn — give the
      // turn.started event a beat to arrive (s10 covers this gap too)
      await sleep(1500);
      evidence.note("turn 1 active");

      // queue a follow-up while turn 1 runs
      await send("auto-flush me after turn one");
      // snapshot queue state immediately — before any turn.completed flush
      const early = await sp.evaluate(async () => ({
        queuePresent: Boolean(document.querySelector(".composer-queue")),
        queueText: (document.querySelector(".composer-queue")?.textContent ?? "").slice(0, 120),
        stored: await chrome.storage.session.get("chromex.sidepanel.queuedComposerMessages").then((r) => JSON.stringify(r).slice(0, 300)),
      }));
      evidence.note(`early after send2: ${JSON.stringify(early)}`);
      try {
        await sp.waitForSelector(".composer-queue", { timeout: 10_000 });
      } catch (err) {
        const diag = await sp.evaluate(() => ({
          composerValue: document.querySelector("#composer")?.value ?? "",
          queuePresent: Boolean(document.querySelector(".composer-queue")),
          stopVisible: Boolean(document.querySelector("#stop-turn")),
          msgLog: (window.__msgLog ?? []).filter((m) => /prompt|conversation|turn|task|send/i.test(m.type ?? "")).slice(-10),
        }));
        evidence.note(`diag: ${JSON.stringify(diag).slice(0, 1200)}`);
        throw err;
      }
      evidence.note("second message queued");

      // queue must survive a sidepanel reload (chrome.storage.session +
      // hydrate on init) and still flush when turn 1 completes
      // turn 1 must outlive the reload window so the queue is still
      // pending when the panel comes back; turn.completed then drives
      // the flush. 25s keeps total runtime reasonable.
      await sp.reload({ waitUntil: "domcontentloaded" });
      await sp.waitForSelector("#composer", { timeout: 20_000 });
      // turn 1 is still running → active turn state must have been
      // restored from ui.init, and the queue must NOT have flushed early
      await sp.waitForSelector("#stop-turn", { timeout: 15_000 });
      const postReload = await sp.evaluate(async () => ({
        stored: await chrome.storage.session.get("chromex.sidepanel.queuedComposerMessages").then((r) => JSON.stringify(r).slice(0, 300)),
        queuePresent: Boolean(document.querySelector(".composer-queue")),
        composerValue: document.querySelector("#composer")?.value ?? "",
        frameClass: document.querySelector(".composer-frame")?.className ?? "",
        approvalPanel: Boolean(document.querySelector(".approval-panel, .plan-input-panel, [class*=approval], [class*=plan-input]")),
        footerHtml: (document.querySelector(".composer-shell")?.innerHTML ?? "").slice(0, 400),
        bgCurrentConv: await chrome.storage.local.get("codex.sidepanel.currentConversationId").then((r) => JSON.stringify(r)),
        dbgEvents: await chrome.storage.session.get(null).then((r) =>
          Object.fromEntries(Object.entries(r).filter(([k]) => k.startsWith("chromex.debug.")).slice(0, 60)),
        ),
        chatIds: [...document.querySelectorAll("[data-chat-id]")].map((el) => el.dataset.chatId).slice(0, 5),
        uiInit: await chrome.runtime.sendMessage({ type: "ui.init" }).then((p) => JSON.stringify({
          convId: p?.currentConversation?.id ?? null,
          activeTurn: p?.activeTurn ?? null,
          recentCount: (p?.recentChats ?? []).length,
        })).catch((e) => `err:${e}`),
      }));
      const dbg = await sp.evaluate(() => window.__chromexQueueDebug?.() ?? null);
      postReload.dbg = dbg;
      evidence.note(`post-reload: ${JSON.stringify(postReload)}`);
      evidence.note(`queue console: ${JSON.stringify(consoleLines.slice(-10))}`);
      await sp.waitForSelector(".composer-queue", { timeout: 15_000 });
      evidence.note("queue survived sidepanel reload while turn still active");

      // find the gateway task
      let gwTaskId = null;
      for (let i = 0; i < 15 && !gwTaskId; i++) {
        await sleep(1000);
        const tl = await runner.conn.request("task.list", {}).catch(() => null);
        const list = tl?.tasks ?? tl?.items ?? (Array.isArray(tl) ? tl : []);
        gwTaskId = list[0]?.taskId ?? list[0]?.id ?? null;
      }
      evidence.note(`task ${gwTaskId}`);

      // turn 1 completes (~8s prompt) → queue must flush → turn 2 runs (~1.5s)
      // wait until the queue strip disappears AND gateway shows 2 completed turns
      const deadline = Date.now() + 60_000;
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
      await evidence.screenshot(sp, "s11-final");

      const storedQueue = await sp.evaluate(() =>
        chrome.storage.session.get("chromex.sidepanel.queuedComposerMessages").then((r) => JSON.stringify(r)),
      );
      evidence.note(`storedQueue=${storedQueue}`);
      evidence.note(`queue console final: ${JSON.stringify(consoleLines.slice(-20))}`);

      const pass = queueGone && completed === 2 && userMsgs === 2 && failed === 0 && cancelled === 0 && unknown === 0;
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "turn.completed auto-flushed the queued message exactly once as the next turn"
          : `queueGone=${queueGone} completed=${completed} userMsgs=${userMsgs} failed=${failed} cancelled=${cancelled} unknown=${unknown}`,
        details: { queueGone, completed, userMsgs, failed, cancelled, unknown, storedQueue },
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
        // turn 1 holds 25s so it outlives the reload; later prompts
        // finish in 1.5s (fixture default)
        env: { FAKE_ACP_TURN_MS: "25000" },
        models: null,
        additionalModels: null,
        defaultModel: null,
      },
    },
    autoAnswer: "allow",
    headless: true,
  },
);
