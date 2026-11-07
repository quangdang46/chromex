/**
 * Retention policy — plan §5.5 / P1-11 (chromex-rdg).
 *
 * Rules implemented here (pure, store-agnostic):
 * - PROTECTED event types are NEVER pruned while the task is alive:
 *   user messages, assistant finals, reasoning summaries, tool
 *   started/completed, permission history, and all task/turn milestones.
 * - Non-protected (milestone-only) events may be pruned ONLY after a
 *   snapshot checkpoint covers them, and the log stays under
 *   maxEventsPerTask.
 * - Approvals: pending NEVER pruned; resolved kept until task terminal
 *   + 7d (handled by caller via task age, not event seq).
 * - Artifact TTL (7d) counts only from task terminal — caller decides.
 * - NO delta rows exist — deltas are ephemeral by design (§4.1).
 */

export const RETENTION_DAYS = 14;
export const MAX_EVENTS_PER_TASK = 20_000;
export const APPROVAL_POST_TERMINAL_MS = 7 * 24 * 60 * 60 * 1000;
export const ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Event types that must survive any prune while the task is alive.
 * Everything durable in the current union is protected — the prunable
 * set exists for future high-volume durable types and for events older
 * than the snapshot checkpoint that are pure milestones.
 */
export const PROTECTED_TASK_EVENT_TYPES: ReadonlySet<string> = new Set([
  "task.created",
  "task.status_changed",
  "task.backend_changed",
  "task.attention_changed",
  "task.tab_binding",
  "task.completed",
  "task.failed",
  "task.cancelled",
  "user.message.created",
  "turn.started",
  "assistant.message",
  "reasoning.summary",
  "tool.started",
  "tool.completed",
  "permission.requested",
  "permission.resolved",
  "permission.expired",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.unknown",
]);

export interface PrunableEvent {
  seq: number;
  type: string;
}

export interface PrunePlan {
  /** seqs safe to delete */
  deleteSeqs: number[];
  /** seq up to which a snapshot checkpoint must exist before pruning */
  requiresSnapshotThroughSeq: number;
}

/**
 * Compute which task events may be pruned.
 *
 * @param events      durable events for the task, ascending seq
 * @param snapshotThroughSeq  highest seq covered by the latest snapshot
 *                    checkpoint (0 = none — then NOTHING may be pruned).
 *                    The caller only supplies a checkpoint when pruning
 *                    is allowed (post-compaction / retention window).
 */
export function planEventPrune(
  events: PrunableEvent[],
  snapshotThroughSeq: number,
): PrunePlan {
  const deleteSeqs: number[] = [];
  if (snapshotThroughSeq <= 0) {
    return { deleteSeqs, requiresSnapshotThroughSeq: snapshotThroughSeq };
  }
  for (const e of events) {
    if (e.seq > snapshotThroughSeq) break; // events after checkpoint stay
    if (PROTECTED_TASK_EVENT_TYPES.has(e.type)) continue;
    deleteSeqs.push(e.seq);
  }
  return { deleteSeqs, requiresSnapshotThroughSeq: snapshotThroughSeq };
}

/** maxEventsPerTask cap: prune oldest NON-protected first; protected
 *  events are kept — the cap is a soft target for unprotected volume. */
export function planCapPrune(
  events: PrunableEvent[],
  maxEvents = MAX_EVENTS_PER_TASK,
): number[] {
  if (events.length <= maxEvents) return [];
  const excess = events.length - maxEvents;
  const deleteSeqs: number[] = [];
  for (const e of events) {
    if (deleteSeqs.length >= excess) break;
    if (!PROTECTED_TASK_EVENT_TYPES.has(e.type)) deleteSeqs.push(e.seq);
  }
  return deleteSeqs;
}

/** Approval rows: pending never pruned; resolved kept until
 *  terminal + 7d. Caller supplies resolvedAt + taskTerminalAt. */
export function approvalPrunable(input: {
  status: "pending" | "allowed" | "denied" | "expired";
  resolvedAt: number | null;
  taskTerminalAt: number | null;
  now: number;
}): boolean {
  if (input.status === "pending") return false;
  if (input.taskTerminalAt === null || input.resolvedAt === null) return false;
  return input.now - Math.max(input.taskTerminalAt, input.resolvedAt) > APPROVAL_POST_TERMINAL_MS;
}

/** Artifact TTL: 7d counted ONLY from task terminal (or explicit
 *  release). Active/paused/resumable tasks → never expires. */
export function artifactExpired(input: {
  taskTerminalAt: number | null;
  releasedAt: number | null;
  createdAt: number;
  now: number;
}): boolean {
  const start = input.releasedAt ?? input.taskTerminalAt;
  if (start === null) return false;
  return input.now - start > ARTIFACT_TTL_MS;
}

export { DAY_MS, RETENTION_DAYS as RETENTION_WINDOW_MS };

export interface RetentionStoreView {
  tasksForRetention(): Array<{
    taskId: string;
    status: string;
    updatedAt: number;
    archived: boolean;
  }>;
  setTaskArchived(taskId: string, archived: boolean): void;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);

/**
 * §5.5 archive sweep: terminal tasks older than retentionDays get
 * archived=1 (compact marker — events/user messages are NEVER deleted;
 * §4.6 prune rules still apply separately). Idempotent; safe to run at
 * every gateway start. Returns the ids newly archived.
 */
export function runRetentionSweep(
  store: RetentionStoreView,
  opts: { now?: number; retentionDays?: number } = {},
): string[] {
  const now = opts.now ?? Date.now();
  const cutoff = now - (opts.retentionDays ?? RETENTION_DAYS) * DAY_MS;
  const archived: string[] = [];
  for (const t of store.tasksForRetention()) {
    if (t.archived) continue;
    if (!TERMINAL_STATUSES.has(t.status)) continue;
    if (t.updatedAt > cutoff) continue;
    store.setTaskArchived(t.taskId, true);
    archived.push(t.taskId);
  }
  return archived;
}
