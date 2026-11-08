// S9 — Interrupt + queued-turn drain through the REAL gateway, deterministic
// provider: a fake ACP agent (fixtures/fake-acp-agent.mjs) holds the first
// session/prompt open until session/cancel, then finishes quickly for the
// queued follow-up. No codex/claude cost, no browser needed.
//
// Proves: task.send during a running turn → queued:true; turn.interrupt
// without turnId resolves the active turn; provider cancel →
// turn.cancelled{interrupted} (never turn.unknown); the queued turn
// auto-dispatches and completes.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runScenario, sleep } from "./lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "fixtures", "fake-acp-agent.mjs");

const TERMINAL = ["turn.completed", "turn.failed", "turn.cancelled", "turn.unknown"];

await runScenario(
  "s9-interrupt-queue",
  async ({ runner, evidence }) => {
    const taskId = await runner.createTask({
      providerId: "fakeacp",
      title: "s9 interrupt + queue e2e",
      cwd: "/tmp",
    });
    evidence.note(`task ${taskId}`);

    const send = (text, cmid) =>
      runner.conn.request("task.send", {
        taskId,
        clientMessageId: cmid,
        content: [{ type: "text", text }],
      });

    const s1 = await send("first long turn", `s9-t1-${Date.now()}`);
    const turnId1 = s1.turnId ?? s1.turn?.turnId;
    evidence.note(`send1 → turnId=${turnId1} queued=${s1.queued}`);
    if (!turnId1 || s1.queued) {
      return { status: "FAIL", summary: "first send did not start a running turn", details: { s1 } };
    }

    // let the provider session open + first prompt reach the fake agent
    await sleep(3_000);

    const s2 = await send("queued follow-up", `s9-t2-${Date.now()}`);
    const turnId2 = s2.turnId ?? s2.turn?.turnId;
    evidence.note(`send2 → turnId=${turnId2} queued=${s2.queued}`);
    if (s2.queued !== true || !turnId2) {
      const evs = runner.eventsFor(taskId).map((e) => `${e.seq}:${e.type}${e.payload?.error?.message ? `(${String(e.payload.error.message).slice(0, 80)})` : ""}`);
      return { status: "FAIL", summary: "second send was not queued behind the running turn", details: { s2, events: evs } };
    }

    // Stop path exactly as the sidepanel issues it: taskId only, no turnId.
    const interrupt = await runner.conn.request("turn.interrupt", { taskId }, 60_000);
    evidence.note(`turn.interrupt → ${JSON.stringify(interrupt)}`);

    // wait for both turns to reach terminal states (turn2 drains after t1)
    const deadline = Date.now() + 90_000;
    let term1 = null;
    let term2 = null;
    while (Date.now() < deadline && !(term1 && term2)) {
      await sleep(400);
      for (const e of runner.eventsFor(taskId)) {
        if (e.payload?.turnId !== turnId1 && e.turnId !== turnId1) continue;
        if (!term1 && TERMINAL.includes(e.type)) term1 = e;
      }
      for (const e of runner.eventsFor(taskId)) {
        if (e.payload?.turnId !== turnId2 && e.turnId !== turnId2) continue;
        if (!term2 && TERMINAL.includes(e.type)) term2 = e;
      }
    }

    const unknowns = runner
      .eventsFor(taskId)
      .filter((e) => e.type === "turn.unknown");
    evidence.note(`term1=${term1?.type} term2=${term2?.type} unknowns=${unknowns.length}`);

    const sync = await runner.taskSync(taskId);
    await evidence.writeTaskSync(taskId, sync);

    if (term1?.type !== "turn.cancelled") {
      return {
        status: "FAIL",
        summary: `interrupted turn did not end as turn.cancelled (got ${term1?.type ?? "none"})`,
        details: { term1, term2, unknowns: unknowns.length },
      };
    }
    if (unknowns.length > 0) {
      return {
        status: "FAIL",
        summary: "turn.unknown recorded despite confirmed provider cancel",
        details: { unknowns },
      };
    }
    if (term2?.type !== "turn.completed") {
      return {
        status: "FAIL",
        summary: `queued turn did not auto-dispatch and complete (got ${term2?.type ?? "none"})`,
        details: { term2 },
      };
    }
    return {
      status: "PASS",
      summary:
        "interrupt without turnId → turn.cancelled{interrupted}; queued turn auto-dispatched → turn.completed; no turn.unknown",
      details: { turnId1, turnId2, term1: term1.type, term2: term2.type },
    };
  },
  {
    needsBrowser: false,
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
    headless: true,
  },
);
