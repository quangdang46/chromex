/**
 * In-memory store — P1-01 placeholder proving process/lock/IPC/handshake
 * before SQLite lands (P1-02 / chromex-55x). Same surface the durable
 * store will implement; nothing here survives restart by design.
 *
 * Sequence allocation: per-stream monotonic counters. Durable events get
 * seq; ephemeral deltas never touch these counters (plan §4.4).
 */

import type {
  DurableGatewayEvent,
  DurableGatewayEventEnvelope,
  DurableTaskEvent,
  DurableTaskEventEnvelope,
  TaskSnapshot,
} from "@codex-sidepanel/shared";

import type { TaskRecord, TurnRecord } from "@codex-sidepanel/shared";

export interface MemoryStoreStats {
  tasks: number;
  turns: number;
  taskEvents: number;
  gatewayEvents: number;
}

export class InMemoryStore {
  constructor(private readonly opts: { assertOwnership?: () => void } = {}) {}

  #guard(): void {
    this.opts.assertOwnership?.();
  }

  private tasks = new Map<string, TaskRecord>();
  private turns = new Map<string, TurnRecord>();
  private taskEvents = new Map<string, DurableTaskEventEnvelope[]>();
  private gatewayEvents: DurableGatewayEventEnvelope[] = [];
  private taskSeq = new Map<string, number>();
  private gatewaySeq = 0;

  // ---- records ----

  putTask(task: TaskRecord): void {
    this.tasks.set(task.taskId, task);
  }

  getTask(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId);
  }

  listTasks(): TaskRecord[] {
    return [...this.tasks.values()];
  }

  putTurn(turn: TurnRecord): void {
    this.turns.set(turn.turnId, turn);
  }

  getTurn(turnId: string): TurnRecord | undefined {
    return this.turns.get(turnId);
  }

  listTurns(taskId?: string): TurnRecord[] {
    const all = [...this.turns.values()];
    return taskId ? all.filter((t) => t.taskId === taskId) : all;
  }

  // ---- durable event log ----

  /** Allocate next durable seq for a task stream and append. */
  appendTaskEvent(taskId: string, event: DurableTaskEvent): DurableTaskEventEnvelope {
    this.#guard();
    const seq = (this.taskSeq.get(taskId) ?? 0) + 1;
    this.taskSeq.set(taskId, seq);
    const envelope = {
      v: 1,
      kind: "event",
      reliability: "durable",
      stream: "task",
      taskId,
      seq,
      ts: Date.now(),
      type: event.type,
      payload: event,
    } as DurableTaskEventEnvelope;
    const log = this.taskEvents.get(taskId) ?? [];
    log.push(envelope);
    this.taskEvents.set(taskId, log);
    return envelope;
  }

  taskEventsAfter(taskId: string, fromSeq: number, maxEvents = 500): {
    events: DurableTaskEventEnvelope[];
    nextSeq: number;
    hasMore: boolean;
  } {
    const log = this.taskEvents.get(taskId) ?? [];
    const events = log.filter((e) => e.seq > fromSeq).slice(0, maxEvents);
    const last = events[events.length - 1];
    const nextSeq = last ? last.seq : fromSeq;
    const hasMore = log.some((e) => e.seq > nextSeq);
    return { events, nextSeq, hasMore };
  }

  /** Append durable gateway event; returns envelope with allocated seq. */
  appendGatewayEvent(event: DurableGatewayEvent): DurableGatewayEventEnvelope {
    this.#guard();
    this.gatewaySeq += 1;
    const envelope = {
      v: 1,
      kind: "event",
      reliability: "durable",
      stream: "gateway",
      seq: this.gatewaySeq,
      ts: Date.now(),
      type: event.type,
      payload: event,
    } as DurableGatewayEventEnvelope;
    this.gatewayEvents.push(envelope);
    return envelope;
  }

  gatewayEventsAfter(fromSeq: number, maxEvents = 500): {
    events: DurableGatewayEventEnvelope[];
    nextSeq: number;
    hasMore: boolean;
  } {
    const events = this.gatewayEvents.filter((e) => e.seq > fromSeq).slice(0, maxEvents);
    const last = events[events.length - 1];
    const nextSeq = last ? last.seq : fromSeq;
    const hasMore = this.gatewayEvents.some((e) => e.seq > nextSeq);
    return { events, nextSeq, hasMore };
  }

  lastTaskSeq(taskId: string): number {
    return this.taskSeq.get(taskId) ?? 0;
  }

  lastGatewaySeq(): number {
    return this.gatewaySeq;
  }

  /** Minimal inline snapshot — P1-02 fills conversation/messages/toolCalls. */
  buildTaskSnapshot(taskId: string): TaskSnapshot | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    return {
      storage: { kind: "inline" },
      task,
      conversation: {
        sessionKey: task.conversationKey,
        provider: task.providerId,
        persistence: null,
        state: "closed",
      },
      turns: this.listTurns(taskId).map((t) => ({
        turnId: t.turnId,
        status: t.status,
        clientMessageId: t.clientMessageId,
        createdAt: t.createdAt,
        ...(t.queuedAt !== undefined ? { queuedAt: t.queuedAt } : {}),
        startedAt: t.startedAt,
        ...(t.endedAt !== undefined && t.endedAt !== null ? { endedAt: t.endedAt } : {}),
        ...(t.stopReason ? { stopReason: t.stopReason } : {}),
      })),
      userMessages: [],
      assistantMessages: [],
      toolCalls: [],
      permissions: [],
      lastSeq: this.lastTaskSeq(taskId),
      rebuiltFrom: "event_log",
    };
  }

  stats(): MemoryStoreStats {
    return {
      tasks: this.tasks.size,
      turns: this.turns.size,
      taskEvents: [...this.taskEvents.values()].reduce((n, l) => n + l.length, 0),
      gatewayEvents: this.gatewayEvents.length,
    };
  }
}
