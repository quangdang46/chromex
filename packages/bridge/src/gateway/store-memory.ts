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
import { buildSnapshotFromSource } from "../store/snapshot-builder.js";

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

  /** Same surface as SQLiteStore.createTask (conversation row is a
   *  SQLite concern; memory store keeps tasks+turns only). */
  createTask(task: TaskRecord): void {
    this.putTask(task);
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

  /** Same surface as SQLiteStore.upsertTurn. */
  upsertTurn(turn: TurnRecord): void {
    this.putTurn(turn);
  }

  /** §4.4.1 idempotency: clientMessageId → existing turn. */
  findTurnByClientMessageId(taskId: string, clientMessageId: string): TurnRecord | undefined {
    for (const t of this.turns.values()) {
      if (t.taskId === taskId && t.clientMessageId === clientMessageId) return t;
    }
    return undefined;
  }

  /** First non-terminal turn for a task (queued or running). */
  activeTurn(taskId: string): TurnRecord | undefined {
    return [...this.turns.values()].find(
      (t) => t.taskId === taskId && (t.status === "queued" || t.status === "running"),
    );
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

  // ---- approvals (in-memory mirror of the SQLite DAO) ----

  private approvals = new Map<
    string,
    {
      taskId: string;
      status: string;
      request?: unknown;
      decision?: { optionId: string; kind: string; decidedAt: number } | null;
      createdAt?: number;
    }
  >();

  insertApproval(row: {
    approvalId: string;
    taskId: string;
    turnId?: string;
    request?: unknown;
    actionDigest?: string;
    status: "pending" | "allowed" | "denied" | "expired";
    createdAt?: number;
  }): void {
    this.approvals.set(row.approvalId, {
      taskId: row.taskId,
      status: row.status,
      ...(row.request !== undefined ? { request: row.request } : {}),
      decision: null,
      ...(row.createdAt !== undefined ? { createdAt: row.createdAt } : {}),
    });
  }

  /** Approval rows for snapshot rebuild (mirror of SQLiteStore.listApprovals). */
  listApprovals(taskId: string): Array<{
    request: unknown;
    decision: { optionId: string; kind: string; decidedAt: number } | null;
    status: string;
    createdAt: number;
  }> {
    return [...this.approvals.entries()]
      .filter(([, a]) => a.taskId === taskId)
      .map(([approvalId, a]) => ({
        request: a.request ?? { requestId: approvalId },
        decision: a.decision ?? null,
        status: a.status,
        createdAt: a.createdAt ?? 0,
      }));
  }

  listPendingApprovals(taskId: string): unknown[] {
    return [...this.approvals.entries()]
      .filter(([, a]) => a.taskId === taskId && a.status === "pending")
      .map(([approvalId]) => ({ approval_id: approvalId }));
  }

  countPendingApprovals(taskId: string): number {
    return [...this.approvals.values()].filter((a) => a.taskId === taskId && a.status === "pending").length;
  }

  approvalStatus(
    approvalId: string,
  ): "pending" | "allowed" | "denied" | "expired" | null {
    const a = this.approvals.get(approvalId);
    return a ? (a.status as never) : null;
  }

  resolveApproval(approvalId: string, status: "allowed" | "denied" | "expired"): void {
    const a = this.approvals.get(approvalId);
    if (a && a.status === "pending") a.status = status;
  }

  /** §4.6 self-sufficient snapshot rebuilt from the durable event
   *  stream — same builder as SQLiteStore for identical output. */
  buildTaskSnapshot(taskId: string): TaskSnapshot | null {
    const task = this.tasks.get(taskId);
    if (!task) return null;
    const checkpoint = this.getTaskSnapshotCheckpoint(taskId);
    return buildSnapshotFromSource({
      task,
      turns: this.listTurns(taskId),
      events: this.allTaskEvents(taskId),
      approvals: this.listApprovals(taskId),
      rebuiltFrom: task.archived === true ? "archived_snapshot" : "event_log",
      ...(checkpoint && checkpoint.snapshot.storage.kind === "inline"
        ? {
            checkpointThroughSeq: checkpoint.throughSeq,
            base: checkpoint.snapshot as import("@codex-sidepanel/shared").InlineTaskSnapshot,
          }
        : {}),
    });
  }

  /** All durable task-stream envelopes, ascending seq. */
  allTaskEvents(taskId: string): DurableTaskEventEnvelope[] {
    return this.taskEvents.get(taskId) ?? [];
  }

  // ---- snapshot checkpoints + event pruning (mirror of SQLite) ----

  private snapshotCheckpoints = new Map<string, { throughSeq: number; snapshot: TaskSnapshot }>();

  getTaskSnapshotCheckpoint(taskId: string): { throughSeq: number; snapshot: TaskSnapshot } | null {
    return this.snapshotCheckpoints.get(taskId) ?? null;
  }

  putTaskSnapshotCheckpoint(taskId: string, throughSeq: number, snapshot: TaskSnapshot): void {
    this.snapshotCheckpoints.set(taskId, { throughSeq, snapshot });
  }

  deleteTaskEvents(taskId: string, seqs: number[]): number {
    const drop = new Set(seqs);
    const log = this.taskEvents.get(taskId) ?? [];
    const kept = log.filter((e) => !drop.has(e.seq));
    const removed = log.length - kept.length;
    this.taskEvents.set(taskId, kept);
    return removed;
  }

  markTaskEventMilestone(taskId: string, seq: number): void {
    const log = this.taskEvents.get(taskId) ?? [];
    for (const e of log) {
      if (e.seq === seq) {
        (e as { milestone?: number }).milestone = 1;
        break;
      }
    }
  }

  setTaskArchived(taskId: string, archived: boolean): void {
    const t = this.tasks.get(taskId);
    if (t) {
      t.archived = archived;
      t.updatedAt = Date.now();
    }
  }

  tasksForRetention(): Array<{ taskId: string; status: TaskRecord["status"]; updatedAt: number; archived: boolean }> {
    return [...this.tasks.values()].map((t) => ({
      taskId: t.taskId,
      status: t.status,
      updatedAt: t.updatedAt,
      archived: t.archived === true,
    }));
  }

  /** Explicit task purge — mirrors SQLiteStore.purgeTask cascade. */
  purgeTask(taskId: string): void {
    this.#guard();
    this.tasks.delete(taskId);
    for (const [id, t] of this.turns) if (t.taskId === taskId) this.turns.delete(id);
    this.taskEvents.delete(taskId);
    this.taskSeq.delete(taskId);
    this.snapshotCheckpoints.delete(taskId);
    for (const [id, a] of this.approvals) if (a.taskId === taskId) this.approvals.delete(id);
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
