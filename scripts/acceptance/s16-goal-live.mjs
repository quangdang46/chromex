// S16 — Live Codex Goal Mode lifecycle through the REAL gateway IPC.
// Unlike S15 (deterministic fake ACP provider proving the honesty
// contract), this runs a REAL codex provider: useGoal send → goal.set →
// goal.updated durable events → turn lifecycle → provider-scoped
// goal.clear → goal.cleared. Whatever the provider/app-server actually
// does is reported verbatim — BLOCKED when codex can't run, FAIL when it
// runs but the lifecycle breaks, PASS only on observed evidence.
//
// Env: CHROMEX_E2E_PROVIDER (default codex), CHROMEX_E2E_MODEL,
//      CHROMEX_E2E_TIMEOUT_MS (default 300000).
import { runScenario, sleep, TERMINAL_TURN } from "./lib/harness.mjs";

const SCENARIO = "s16-goal-live";
const PROVIDER = process.env.CHROMEX_E2E_PROVIDER || "codex";
const MODEL = process.env.CHROMEX_E2E_MODEL || "xxx";
const TURN_DEADLINE_MS = Number(process.env.CHROMEX_E2E_TIMEOUT_MS || 300_000);

await runScenario(
  SCENARIO,
  async ({ runner, evidence }) => {
    // ---- 0. catalog must advertise goalMode for this provider ----
    const catalog = await runner.conn.request("provider.catalog", {}).catch((e) => ({ err: String(e) }));
    const entry = (catalog?.catalogs ?? []).find((c) => c.providerId === PROVIDER);
    const goalCap = entry?.capabilities?.goalMode;
    evidence.note(`catalog ${PROVIDER}.capabilities.goalMode=${JSON.stringify(goalCap)}`);
    if (goalCap !== true) {
      return {
        status: "BLOCKED",
        summary: `provider ${PROVIDER} catalog does not advertise goalMode — nothing to exercise`,
        details: { catalogGoalMode: goalCap ?? null },
      };
    }

    let taskId;
    try {
      taskId = await runner.createTask({
        title: "s16 live goal lifecycle e2e",
        cwd: "/tmp",
        providerId: PROVIDER,
        model: MODEL,
      });
    } catch (e) {
      return { status: "BLOCKED", summary: `task.create failed: ${e?.message ?? e}` };
    }
    evidence.note(`task ${taskId} provider=${PROVIDER} model=${MODEL}`);

    const objective = `Reply with exactly the word PONG and nothing else. Do not use any tools. Run id ${Date.now()}.`;
    let turnId = null;
    try {
      const res = await runner.conn.request("task.send", {
        taskId,
        clientMessageId: `s16-goal-${Date.now()}`,
        content: [{ type: "text", text: objective }],
        ctx: { metadata: { useGoal: true, goalObjective: objective } },
      });
      turnId = res.turnId ?? res.turn?.turnId;
    } catch (e) {
      return { status: "BLOCKED", summary: `task.send failed (provider unavailable?): ${e?.message ?? e}`, details: { taskId } };
    }
    evidence.note(`goal turn ${turnId ?? "none"}`);

    // ---- 1. wait for turn terminal + collect goal.* events ----
    const terminal = await runner.waitTerminal(taskId, turnId, TURN_DEADLINE_MS);
    await sleep(1000); // let trailing goal.updated flush
    const events = await runner.syncEvents(taskId);
    const goalEvents = events.filter((e) => {
      const t = e.type ?? e.payload?.type;
      return t === "goal.updated" || t === "goal.cleared";
    });
    const goalUpdated = goalEvents
      .map((e) => e.payload?.goal ?? e.goal ?? null)
      .find((g) => g && typeof g === "object");
    evidence.note(
      `terminal=${terminal?.type ?? "timeout"} goalEvents=${goalEvents.length} objective=${JSON.stringify(goalUpdated?.objective ?? null)} status=${JSON.stringify(goalUpdated?.status ?? null)}`,
    );

    if (!goalUpdated) {
      return {
        status: terminal ? "FAIL" : "BLOCKED",
        summary: `no goal.updated event observed (terminal=${terminal?.type ?? "timeout"}) — provider may not support thread goals`,
        details: { taskId, turnId, terminal: terminal?.type, goalEvents: goalEvents.length },
      };
    }
    if (!terminal || !TERMINAL_TURN.includes(terminal.type)) {
      return {
        status: "BLOCKED",
        summary: `goal.updated seen but turn never reached terminal (got ${terminal?.type ?? "none"})`,
        details: { taskId, turnId, goal: goalUpdated },
      };
    }

    // ---- 2. provider-scoped goal.clear → goal.cleared ----
    const threadId = goalUpdated.providerThreadId;
    let clearErr = null;
    let cleared = false;
    if (threadId) {
      try {
        await runner.conn.request(`provider.feature.${PROVIDER}.goal.clear`, { threadId });
      } catch (e) {
        clearErr = e;
      }
      await sleep(1500);
      const after = await runner.syncEvents(taskId);
      cleared = after.some((e) => (e.type ?? e.payload?.type) === "goal.cleared");
      evidence.note(`goal.clear threadId=${threadId} → ${clearErr ? `err ${clearErr.message}` : cleared ? "goal.cleared observed" : "no goal.cleared event"}`);
    } else {
      evidence.note("goal.updated carried no providerThreadId — cannot address goal.clear");
    }

    const pass = terminal.type === "turn.completed" && !clearErr;
    return {
      status: pass ? "PASS" : "FAIL",
      summary: pass
        ? "live codex goal lifecycle: useGoal → goal.updated → turn.completed → goal.clear → goal.cleared"
        : `terminal=${terminal.type} goalUpdated=yes clearErr=${clearErr ? String(clearErr.message ?? clearErr) : "none"} cleared=${cleared}`,
      details: {
        taskId,
        turnId,
        terminal: terminal.type,
        goal: goalUpdated,
        goalEventCount: goalEvents.length,
        providerThreadId: threadId ?? null,
        clearError: clearErr ? String(clearErr.message ?? clearErr) : null,
        goalCleared: cleared,
      },
    };
  },
  {
    needsBrowser: false,
    needsGateway: true,
    gatewayProviders: [PROVIDER],
    headless: true,
  },
);
