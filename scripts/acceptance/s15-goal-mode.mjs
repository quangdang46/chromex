// S15 — Goal Mode honesty through the REAL gateway IPC, deterministic
// provider: a fake ACP agent (fixtures/fake-acp-agent.mjs) has no
// goalMode capability, so this proves the P0 contract end-to-end:
//
//   1. task.send with ctx.metadata.useGoal → turn.failed
//      proto.unsupported — NOT a silent plain-chat turn.
//   2. A normal send on the same task still completes (provider works;
//      only the goal path is gated).
//   3. provider.feature.<id>.goal.clear → proto.unsupported — goal RPCs
//      fail honestly on providers without goal support.
//   4. provider.catalog reports capabilities.goalMode !== true, which is
//      what the extension UI gates its Goal Mode toggle on.
//
// Codex-side goal lifecycle (set/get/clear → thread/goal/* → goal.updated
// → auto-continuation) needs a live codex app-server and is covered by
// bridge unit tests (codex-features/codex-plane), not this scenario.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { runScenario, sleep, TERMINAL_TURN } from "./lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const FAKE_AGENT = join(here, "fixtures", "fake-acp-agent.mjs");

await runScenario(
  "s15-goal-mode",
  async ({ runner, evidence }) => {
    const taskId = await runner.createTask({
      providerId: "fakeacp",
      title: "s15 goal mode honesty e2e",
      cwd: "/tmp",
    });
    evidence.note(`task ${taskId} (provider=fakeacp, goalMode unsupported)`);

    const send = (text, cmid, ctx) =>
      runner.conn.request("task.send", {
        taskId,
        clientMessageId: cmid,
        content: [{ type: "text", text }],
        ...(ctx ? { ctx } : {}),
      });

    // ---- 1. useGoal on unsupported provider must fail honestly ----
    let goalSendErr = null;
    let goalTurnId = null;
    try {
      const res = await send("achieve the objective", `s15-goal-${Date.now()}`, {
        metadata: { useGoal: true, goalObjective: "achieve the objective" },
      });
      goalTurnId = res.turnId ?? res.turn?.turnId;
    } catch (err) {
      goalSendErr = err;
    }
    evidence.note(`useGoal send → err=${goalSendErr?.message ?? "none"} turnId=${goalTurnId}`);

    // the RPC may reject OR return a turnId that then fails — wait for
    // the durable terminal event either way.
    const goalTerm = await runner.waitTerminal(taskId, goalTurnId, 30_000);
    evidence.note(`goal turn terminal → ${goalTerm?.type ?? "none"}`);

    const sync = await runner.syncEvents(taskId);
    const failed = sync.find(
      (e) => e.type === "turn.failed" || e.payload?.type === "turn.failed",
    );
    const failedPayload = failed?.payload ?? failed ?? {};
    const errCode =
      failedPayload.error?.code ??
      failedPayload.payload?.error?.code ??
      goalSendErr?.code;
    evidence.note(`turn.failed error.code=${errCode}`);

    if (errCode !== "proto.unsupported") {
      return {
        status: "FAIL",
        summary: `useGoal on unsupported provider did not fail with proto.unsupported (got ${errCode ?? goalTerm?.type ?? "no terminal"})`,
        details: { goalSendErr: String(goalSendErr), goalTerm, failed: failedPayload },
      };
    }

    // ---- 2. plain turn on the same task still works ----
    const s2 = await send("plain chat turn", `s15-plain-${Date.now()}`);
    const turnId2 = s2.turnId ?? s2.turn?.turnId;
    if (!turnId2 || s2.queued) {
      return { status: "FAIL", summary: "plain send did not start a turn", details: { s2 } };
    }
    const term2 = await runner.waitTerminal(taskId, turnId2, 90_000);
    if (!term2 || !TERMINAL_TURN.includes(term2.type)) {
      return { status: "FAIL", summary: `plain turn never reached terminal (got ${term2?.type ?? "none"})`, details: { term2 } };
    }
    evidence.note(`plain turn → ${term2.type}`);

    // ---- 3. goal.clear feature RPC fails honestly ----
    let clearErr = null;
    try {
      await runner.conn.request("provider.feature.fakeacp.goal.clear", {
        threadId: "whatever",
      });
    } catch (err) {
      clearErr = err;
    }
    evidence.note(`goal.clear → ${clearErr ? `err ${clearErr.code ?? ""} ${clearErr.message}` : "UNEXPECTED SUCCESS"}`);
    if (!clearErr) {
      return { status: "FAIL", summary: "provider.feature.fakeacp.goal.clear succeeded on a provider with no goal support" };
    }

    // ---- 4. catalog advertises goalMode capability honestly ----
    const catalog = await runner.conn.request("provider.catalog", {}).catch((e) => ({ err: String(e) }));
    const fakeEntry = (catalog?.catalogs ?? []).find((c) => c.providerId === "fakeacp");
    const goalCap = fakeEntry?.capabilities?.goalMode;
    evidence.note(`catalog fakeacp.capabilities.goalMode=${JSON.stringify(goalCap)}`);
    if (goalCap === true) {
      return { status: "FAIL", summary: "fakeacp catalog claims goalMode support it does not have" };
    }

    // ---- 5. declared goalMode capability flows config → catalog → gate ----
    // fakegoal is the same fake ACP agent but its gateway config declares
    // capabilities.goalMode=true — the catalog must advertise it and the
    // useGoal gate must let the turn dispatch (the fake has no goal
    // semantics; this proves the plumbing, not provider goal behavior).
    const goalTaskId = await runner.createTask({
      providerId: "fakegoal",
      title: "s15 goal-capable provider e2e",
      cwd: "/tmp",
    });
    evidence.note(`task ${goalTaskId} (provider=fakegoal, goalMode declared)`);
    const goalCapEntry = (catalog?.catalogs ?? []).find((c) => c.providerId === "fakegoal");
    const declaredCap = goalCapEntry?.capabilities?.goalMode;
    evidence.note(`catalog fakegoal.capabilities.goalMode=${JSON.stringify(declaredCap)}`);
    if (declaredCap !== true) {
      return { status: "FAIL", summary: "fakegoal catalog did not advertise declared goalMode capability", details: { declaredCap } };
    }
    const gSend = await runner.conn.request("task.send", {
      taskId: goalTaskId,
      clientMessageId: `s15-goalcap-${Date.now()}`,
      content: [{ type: "text", text: "goal-capable turn" }],
      ctx: { metadata: { useGoal: true, goalObjective: "goal-capable turn" } },
    });
    const gTurnId = gSend.turnId ?? gSend.turn?.turnId;
    const gTerm = await runner.waitTerminal(goalTaskId, gTurnId, 60_000);
    evidence.note(`fakegoal useGoal turn → ${gTerm?.type ?? "timeout"}`);
    if (gTerm?.type !== "turn.completed") {
      return { status: "FAIL", summary: `useGoal on declared-goalMode provider did not complete (got ${gTerm?.type ?? "none"})`, details: { gTerm } };
    }

    // ---- 6. diagnostics attribute the completed turn's wall-time ----
    const diag = await runner.conn.request("diagnostics.snapshot", {}).catch(() => null);
    const turnStats = diag?.diagnostics?.turns;
    evidence.note(
      `diagnostics.turns total=${turnStats?.total ?? "?"} byStatus=${JSON.stringify(turnStats?.byStatus ?? {})} lastMs=${turnStats?.durationMs?.last ?? "?"}`,
    );
    const turnTimed =
      typeof turnStats?.durationMs?.last === "number" && turnStats.durationMs.last >= 0 && (turnStats.byStatus?.completed ?? 0) >= 1;
    if (!turnTimed) {
      return { status: "FAIL", summary: "diagnostics.turns did not record the completed turn's duration", details: { turnStats } };
    }

    return {
      status: "PASS",
      summary:
        "useGoal on unsupported provider → turn.failed proto.unsupported (no silent chat turn); plain turn unaffected; goal.clear → honest error; catalog goalMode flag absent; declared goalMode capability flows config→catalog→gate→turn.completed; diagnostics.turns records turn wall-time",
      details: {
        taskId,
        goalErrorCode: errCode,
        plainTerminal: term2.type,
        clearError: clearErr ? String(clearErr.message ?? clearErr) : null,
        catalogGoalMode: goalCap ?? null,
        declaredGoalMode: declaredCap ?? null,
        goalCapableTerminal: gTerm?.type ?? null,
        turns: turnStats ?? null,
      },
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
        env: { FAKE_ACP_TURN_MS: "5000" },
        models: null,
        additionalModels: null,
        defaultModel: null,
      },
      // same agent, but the gateway config declares goalMode — proves
      // providers.acp.<id>.capabilities reaches the catalog + gate.
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
    headless: true,
  },
);
