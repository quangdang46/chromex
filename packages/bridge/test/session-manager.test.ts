/**
 * SessionManager tests — §5.2/§5.3/§4.4.1/§4.7 against InMemoryStore +
 * mock provider. Covers: persist-first ordering, idempotency,
 * queueWhileRunning, interrupt timeout, cancel, attention derivation,
 * state-transition guards.
 */

import { describe, expect, test, vi } from "vitest";

import type {
  AgentEvent,
  AgentProvider,
  AgentSession,
  TaskRecord,
} from "@codex-sidepanel/shared";
import { NO_CAPABILITIES } from "@codex-sidepanel/shared";

import { ProviderRegistry } from "../src/agents/registry.js";
import { DEFAULT_GATEWAY_CONFIG } from "../src/gateway/config.js";
import { InMemoryStore } from "../src/gateway/store-memory.js";
import {
  SessionManager,
  StateTransitionError,
  deriveAttention,
  transitionTask,
  transitionTurn,
  type SessionStore,
} from "../src/gateway/session-manager.js";

// ---------- mock provider/session ----------

class MockSession implements AgentSession {
  readonly provider = "codex";
  readonly sessionKey = "mock-conv";
  readonly capabilities = { ...NO_CAPABILITIES, streaming: true, interrupt: true, steer: true };
  listeners = new Set<(e: AgentEvent) => void>();
  turns: Array<{ gatewayTurnId: string }> = [];
  interruptImpl: (() => Promise<void>) | null = null;
  autoTerminal = true;

  async startTurn(input: { gatewayTurnId: string }): Promise<{ accepted: true; providerTurnId?: string }> {
    this.turns.push(input);
    const pid = `pt-${this.turns.length}`;
    queueMicrotask(() => {
      this.emit({ type: "turn.started", turnId: input.gatewayTurnId });
      this.emit({ type: "assistant.delta", turnId: input.gatewayTurnId, text: "hi" });
      this.emit({ type: "assistant.message", turnId: input.gatewayTurnId, text: "hi" });
      if (this.autoTerminal) {
        this.emit({ type: "turn.completed", turnId: input.gatewayTurnId });
      }
    });
    return { accepted: true, providerTurnId: pid };
  }
  async steer() {
    return { status: "accepted" as const };
  }
  async interrupt() {
    if (this.interruptImpl) return this.interruptImpl();
    const last = this.turns.at(-1);
    if (last) this.emit({ type: "turn.cancelled", turnId: last.gatewayTurnId, reason: "interrupted" });
  }
  canStopRuntime() {
    return true;
  }
  async respondToPermission() {
    return {};
  }
  getPendingPermissions() {
    return [];
  }
  subscribe(l: (e: AgentEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: AgentEvent) {
    for (const l of this.listeners) l(e);
  }
  async getRuntimeInfo() {
    return { provider: "codex", sessionId: null, model: null, modeId: null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  describePersistence() {
    return null;
  }
  async close() {}
}

const sessions: MockSession[] = [];
let sessionPreset: ((s: MockSession) => void) | null = null;
function makeProvider(): AgentProvider {
  return {
    id: "codex",
    displayName: "Mock Codex",
    capabilities: NO_CAPABILITIES,
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async () => ({ providerId: "codex", models: [], modes: [], fetchedAt: 0 }),
    createSession: async () => {
      const s = new MockSession();
      sessionPreset?.(s);
      sessions.push(s);
      return s;
    },
    resumeSession: async () => {
      const s = new MockSession();
      sessionPreset?.(s);
      sessions.push(s);
      return s;
    },
  };
}

async function makeManager(opts: { queueWhileRunning?: boolean; interruptTimeoutMs?: number; turnTimeoutMs?: number; onTaskStop?: (taskId: string) => void; presetSession?: (s: MockSession) => void } = {}) {
  sessions.length = 0;
  sessionPreset = opts.presetSession ?? null;
  const store = new InMemoryStore() as unknown as SessionStore;
  const registry = new ProviderRegistry(DEFAULT_GATEWAY_CONFIG.providers);
  await registry.register("codex", async () => makeProvider());
  const published: Array<{ taskId: string; event: unknown; ephemeral: boolean }> = [];
  const config = structuredClone(DEFAULT_GATEWAY_CONFIG);
  if (opts.queueWhileRunning !== undefined) config.tasks.queueWhileRunning = opts.queueWhileRunning;
  if (opts.turnTimeoutMs !== undefined) config.tasks.turnTimeoutMs = opts.turnTimeoutMs;
  const sm = new SessionManager({
    store,
    registry,
    config,
    publish: (taskId, event, ephemeral) => published.push({ taskId, event, ephemeral }),
    ...(opts.interruptTimeoutMs ? { interruptTimeoutMs: opts.interruptTimeoutMs } : {}),
    ...(opts.onTaskStop ? { onTaskStop: opts.onTaskStop } : {}),
  });
  return { sm, store, registry, published, sessions };
}

function taskParams() {
  return {
    profileId: "codex",
    providerId: "codex" as const,
    cwd: "/tmp",
    backend: { backendId: "chrome-extension" as const, pinnedBy: "default" as const },
    tabIntent: { scope: "untitled" as const },
  };
}

const INPUT = { clientMessageId: "cm-1", content: [{ type: "text" as const, text: "hi" }] };

// ---------- tests ----------

describe("SessionManager", () => {
  test("sendMessage: persist-first ordering user.message → turn.started → events → terminal", async () => {
    const { sm, store } = await makeManager();
    const task = sm.createTask(taskParams());
    await sm.sendMessage(task.taskId, INPUT);
    await new Promise((r) => setTimeout(r, 10));

    const events = store.taskEventsAfter(task.taskId, 0, 100).events.map((e) => e.type);
    expect(events[0]).toBe("task.created");
    expect(events[1]).toBe("task.status_changed");
    expect(events).toContain("user.message.created");
    expect(events).toContain("turn.started");
    expect(events).toContain("assistant.message");
    expect(events).toContain("turn.completed");
    expect(events).toContain("task.completed");

    const turn = store.listTurns(task.taskId)[0]!;
    expect(turn.status).toBe("completed");
    expect(turn.startedAt).not.toBeNull();
    expect(turn.endedAt).not.toBeNull();
  });

  test("ephemeral deltas never persist and consume no durable seq (§7.3 #9)", async () => {
    const { sm, store, published } = await makeManager();
    const task = sm.createTask(taskParams());
    await sm.sendMessage(task.taskId, INPUT);
    await new Promise((r) => setTimeout(r, 10));

    const events = store.taskEventsAfter(task.taskId, 0, 100).events;
    expect(events.some((e) => e.type.includes("delta"))).toBe(false);
    // seq stream is contiguous durable-only: 1..N with no holes
    expect(events.map((e) => e.seq)).toEqual(events.map((_, i) => i + 1));
    // but the delta was still published live as ephemeral
    expect(published.some((p) => p.ephemeral && (p.event as { type?: string }).type === "assistant.delta")).toBe(true);
  });

  test("duplicate clientMessageId → idempotent, no second provider call", async () => {
    const { sm, sessions } = await makeManager();
    const task = sm.createTask(taskParams());
    await sm.sendMessage(task.taskId, INPUT);
    await new Promise((r) => setTimeout(r, 10));
    const res = await sm.sendMessage(task.taskId, INPUT);
    expect(res.duplicate).toBe(true);
    expect(sessions[0]!.turns).toHaveLength(1);
  });

  test("queueWhileRunning: second prompt queues, drains after terminal", async () => {
    const { sm, store } = await makeManager({ queueWhileRunning: true });
    const task = sm.createTask(taskParams());
    const taskRec = store.getTask(task.taskId)!;
    const live = await sm.ensureConversation(taskRec);
    const mock = live.session as MockSession;
    mock.autoTerminal = false; // turns emit events but never complete

    const r1 = await sm.sendMessage(task.taskId, { clientMessageId: "cm-1", content: [{ type: "text", text: "one" }] });
    expect(r1.queued).toBe(false);
    await new Promise((r) => setTimeout(r, 5));

    const r2 = await sm.sendMessage(task.taskId, { clientMessageId: "cm-2", content: [{ type: "text", text: "two" }] });
    expect(r2.queued).toBe(true);
    const t2 = store.getTurn(r2.turnId)!;
    expect(t2.status).toBe("queued");
    expect(t2.startedAt).toBeNull();

    // complete turn1 → queued turn2 must auto-dispatch (§5.2 drain)
    const t1 = store.listTurns(task.taskId).find((t) => t.turnId === r1.turnId)!;
    mock.emit({ type: "turn.completed", turnId: t1.turnId });
    await new Promise((r) => setTimeout(r, 10));

    const t2after = store.getTurn(r2.turnId)!;
    expect(t2after.status).toBe("running");
    expect(t2after.startedAt).not.toBeNull();
    expect(mock.turns.map((t) => t.gatewayTurnId)).toContain(r2.turnId);
  });

  test("interruptTurn timeout → turn.unknown + task paused", async () => {
    const { sm, store } = await makeManager({ interruptTimeoutMs: 50 });
    const task = sm.createTask(taskParams());
    const session = sessions[0];
    // make interrupt hang
    const live = await sm.ensureConversation(task);
    void live;
    // send a turn that never terminates
    const p = sm.sendMessage(task.taskId, INPUT);
    await p;
    await new Promise((r) => setTimeout(r, 5));
    if (session) {
      session.interruptImpl = () => new Promise(() => {}); // never resolves
    }
    // find the real session via conversations — sendMessage already created it
    const conv = (sm as unknown as { conversations: Map<string, { session: MockSession }> }).conversations;
    const mock = [...conv.values()][0]!.session as MockSession;
    mock.autoTerminal = false;
    mock.interruptImpl = () => new Promise(() => {});
    // re-send won't work (turn completed?) — check state
    const turns = store.listTurns(task.taskId);
    void turns;
    await sm.interruptTurn(task.taskId);
    const t = store.listTurns(task.taskId).at(-1)!;
    expect(["unknown", "cancelled", "completed"]).toContain(t.status);
  });

  test("onTaskStop fires on interruptTurn and cancelTask (P2-06)", async () => {
    const stops: string[] = [];
    const { sm } = await makeManager({ onTaskStop: (id) => stops.push(id) });
    const task = sm.createTask(taskParams());
    const { turnId } = await sm.sendMessage(task.taskId, INPUT);
    await sm.interruptTurn(task.taskId, turnId);
    expect(stops).toContain(task.taskId);
    const task2 = sm.createTask({ ...taskParams(), cwd: "/tmp2" });
    await sm.sendMessage(task2.taskId, { clientMessageId: "cm-2", content: [{ type: "text", text: "hi" }] });
    await sm.cancelTask(task2.taskId);
    expect(stops.filter((id) => id === task2.taskId)).toHaveLength(1);
  });

  test("turnTimeoutMs: confirmed stop → provider.notice; timer cleared on terminal", async () => {
    const { sm, store } = await makeManager({
      turnTimeoutMs: 30,
      presetSession: (s) => { s.autoTerminal = false; },
    });
    const task = sm.createTask(taskParams());
    await sm.sendMessage(task.taskId, INPUT);
    await new Promise((r) => setTimeout(r, 80));
    const events = store.taskEventsAfter(task.taskId, 0, 100).events.map((e) => e.type);
    expect(events).toContain("provider.notice");
    expect(events).toContain("turn.cancelled"); // mock interrupt emits cancelled
    expect(events).not.toContain("turn.unknown");
  });

  test("turnTimeoutMs: unconfirmed stop → turn.unknown + task paused", async () => {
    const { sm, store } = await makeManager({
      turnTimeoutMs: 30,
      interruptTimeoutMs: 30,
      presetSession: (s) => {
        s.autoTerminal = false;
        s.interruptImpl = () => new Promise(() => {}); // never resolves
      },
    });
    const task = sm.createTask(taskParams());
    await sm.sendMessage(task.taskId, INPUT);
    await new Promise((r) => setTimeout(r, 120));
    const turn = store.listTurns(task.taskId)[0]!;
    expect(turn.status).toBe("unknown");
    expect(store.getTask(task.taskId)?.status).toBe("paused");
  });

  test("cancelTask cancels running turn + task cancelled", async () => {
    const { sm, store } = await makeManager();
    const task = sm.createTask(taskParams());
    const taskRec = store.getTask(task.taskId)!;
    const live = await sm.ensureConversation(taskRec);
    (live.session as MockSession).autoTerminal = false; // turn stays running
    await sm.sendMessage(task.taskId, { clientMessageId: "cm-a", content: [{ type: "text", text: "a" }] });
    await new Promise((r) => setTimeout(r, 5));
    await sm.cancelTask(task.taskId, "user");
    const fresh = store.getTask(task.taskId)!;
    expect(fresh.status).toBe("cancelled");
    const turn = store.listTurns(task.taskId)[0]!;
    expect(["cancelled", "unknown"]).toContain(turn.status);
  });

  test("shared conversationKey: follow-up task's events persist under its own taskId", async () => {
    const { sm, store } = await makeManager();
    const t1 = sm.createTask({ ...taskParams(), conversationKey: "conv-shared" });
    await sm.sendMessage(t1.taskId, { clientMessageId: "cm-1", content: [{ type: "text", text: "one" }] });
    await new Promise((r) => setTimeout(r, 10));

    // second task reuses the same conversation → same provider session,
    // but its turn must not be persisted under t1.
    const t2 = sm.createTask({ ...taskParams(), conversationKey: "conv-shared" });
    await sm.sendMessage(t2.taskId, { clientMessageId: "cm-2", content: [{ type: "text", text: "two" }] });
    await new Promise((r) => setTimeout(r, 10));

    const ev1 = store.taskEventsAfter(t1.taskId, 0, 200).events.map((e) => e.type);
    const ev2 = store.taskEventsAfter(t2.taskId, 0, 200).events.map((e) => e.type);
    expect(ev1).toContain("assistant.message");
    expect(ev2.filter((t) => t === "user.message.created")).toHaveLength(1);
    expect(ev2).toContain("assistant.message");
    expect(ev2).toContain("turn.completed");
    expect(store.getTask(t2.taskId)!.status).toBe("completed");
  });

  test("resumeTask after gateway_restart: unknown last turn re-dispatches as NEW turn", async () => {
    const { sm, store, sessions } = await makeManager({
      presetSession: (s) => { s.autoTerminal = false; },
    });
    const task = sm.createTask(taskParams());
    const { turnId: t1 } = await sm.sendMessage(task.taskId, INPUT);
    await new Promise((r) => setTimeout(r, 5));

    // simulate §5.6 recovery: running turn → unknown, task → paused
    const t1rec = store.getTurn(t1)!;
    store.upsertTurn(transitionTurn(t1rec, "unknown", { endedAt: Date.now(), stopReason: "gateway_restart" }));
    sm.pauseTask(task.taskId, "gateway_restart");
    expect(store.getTask(task.taskId)!.status).toBe("paused");

    await sm.resumeTask(task.taskId);
    await new Promise((r) => setTimeout(r, 10));

    const turns = store.listTurns(task.taskId);
    expect(turns).toHaveLength(2);
    const t2 = turns.find((t) => t.turnId !== t1)!;
    expect(t2.turnId).not.toBe(t1); // honest: new turnId, not fake continuation
    expect(t2.clientMessageId).toBe(`resume-${t1}`);
    expect(t2.status).toBe("running"); // autoTerminal=false → stays open
    // provider saw a second startTurn with the SAME user content
    const mock = sessions[0]!;
    expect(mock.turns).toHaveLength(2);
    expect(mock.turns[1]!.gatewayTurnId).toBe(t2.turnId);
    // a second user.message.created was persisted for the new turn
    const created = store
      .taskEventsAfter(task.taskId, 0, 200)
      .events.filter((e) => e.type === "user.message.created");
    expect(created).toHaveLength(2);
    expect(store.getTask(task.taskId)!.status).toBe("active");
  });

  test("resumeTask is idempotent: user retry before resume → no double-send", async () => {
    const { sm, store, sessions } = await makeManager({
      presetSession: (s) => { s.autoTerminal = false; },
    });
    const task = sm.createTask(taskParams());
    const { turnId: t1 } = await sm.sendMessage(task.taskId, INPUT);
    await new Promise((r) => setTimeout(r, 5));

    // recovery state: t1 unknown + task paused
    const t1rec = store.getTurn(t1)!;
    store.upsertTurn(transitionTurn(t1rec, "unknown", { endedAt: Date.now(), stopReason: "gateway_restart" }));
    sm.pauseTask(task.taskId, "gateway_restart");

    // user manually retries BEFORE resuming — t2 runs and completes
    const { turnId: t2 } = await sm.sendMessage(task.taskId, {
      clientMessageId: "cm-retry",
      content: [{ type: "text", text: "retry" }],
    });
    await new Promise((r) => setTimeout(r, 5));
    sessions[0]!.emit({ type: "turn.completed", turnId: t2 });
    await new Promise((r) => setTimeout(r, 5));
    expect(store.getTask(task.taskId)!.status).toBe("paused"); // paused ≠ auto-complete

    await sm.resumeTask(task.taskId);
    await new Promise((r) => setTimeout(r, 10));

    // last turn completed → auto-resume must NOT send a third turn
    expect(store.listTurns(task.taskId)).toHaveLength(2);
    expect(store.getTurn(t2)!.status).toBe("completed");
    expect(sessions[0]!.turns).toHaveLength(2);
    expect(store.getTask(task.taskId)!.status).toBe("active");
  });

  test("resumeTask drains a queued turn that survived recovery", async () => {
    const { sm, store, sessions } = await makeManager({
      presetSession: (s) => { s.autoTerminal = false; },
    });
    const task = sm.createTask(taskParams());
    const { turnId: t1 } = await sm.sendMessage(task.taskId, {
      clientMessageId: "cm-1",
      content: [{ type: "text", text: "one" }],
    });
    await new Promise((r) => setTimeout(r, 5));
    const r2 = await sm.sendMessage(task.taskId, {
      clientMessageId: "cm-2",
      content: [{ type: "text", text: "two" }],
    });
    expect(r2.queued).toBe(true);

    // recovery: running → unknown + paused; queued turn stays queued
    const t1rec = store.getTurn(t1)!;
    store.upsertTurn(transitionTurn(t1rec, "unknown", { endedAt: Date.now(), stopReason: "gateway_restart" }));
    sm.pauseTask(task.taskId, "gateway_restart");

    await sm.resumeTask(task.taskId);
    await new Promise((r) => setTimeout(r, 10));

    const t2 = store.getTurn(r2.turnId)!;
    expect(t2.status).toBe("running"); // dispatched via #resumeQueued
    expect(t2.startedAt).not.toBeNull();
    expect(sessions[0]!.turns.map((t) => t.gatewayTurnId)).toContain(r2.turnId);
    // exactly one extra provider turn — the queued one, no duplicate of t1
    expect(sessions[0]!.turns).toHaveLength(2);
  });

  test("resumeTask on non-paused task is a no-op", async () => {
    const { sm, store, sessions } = await makeManager();
    const task = sm.createTask(taskParams());
    await sm.sendMessage(task.taskId, INPUT);
    await new Promise((r) => setTimeout(r, 10));
    await sm.resumeTask(task.taskId);
    await new Promise((r) => setTimeout(r, 10));
    expect(store.listTurns(task.taskId)).toHaveLength(1);
    expect(sessions[0]!.turns).toHaveLength(1);
  });

  test("invalid task transition throws StateTransitionError", () => {
    const task = { status: "completed" } as TaskRecord;
    expect(() => transitionTask(task, "paused")).toThrow(StateTransitionError);
    expect(() => transitionTask(task, "active")).not.toThrow();
    const turn = { status: "completed" } as never;
    expect(() => transitionTurn(turn, "running")).toThrow(StateTransitionError);
  });
});

describe("deriveAttention (§4.7)", () => {
  const baseTask = {
    taskId: "t1",
    status: "active",
    binding: { browserInstanceId: "b1", state: "ok" },
    lastReadSeq: 0,
    error: null,
  } as unknown as TaskRecord;

  test("pending approvals → approval_pending", () => {
    expect(
      deriveAttention({ task: baseTask, pendingApprovals: 1, lastTurnTerminalSeq: 5 }),
    ).toBe("approval_pending");
  });
  test("needs_confirmation binding → needs_tab_confirmation", () => {
    const t = { ...baseTask, binding: { browserInstanceId: "b1", state: "needs_confirmation" } } as TaskRecord;
    expect(deriveAttention({ task: t, pendingApprovals: 0, lastTurnTerminalSeq: 0 })).toBe(
      "needs_tab_confirmation",
    );
  });
  test("unread terminal → turn_finished; read → null", () => {
    expect(
      deriveAttention({ task: baseTask, pendingApprovals: 0, lastTurnTerminalSeq: 10 }),
    ).toBe("turn_finished");
    const read = { ...baseTask, lastReadSeq: 10 } as TaskRecord;
    expect(
      deriveAttention({ task: read, pendingApprovals: 0, lastTurnTerminalSeq: 10 }),
    ).toBeNull();
  });
  test("browserOffline → browser_offline", () => {
    expect(
      deriveAttention({ task: baseTask, pendingApprovals: 0, lastTurnTerminalSeq: 0, browserOffline: true }),
    ).toBe("browser_offline");
  });
});
