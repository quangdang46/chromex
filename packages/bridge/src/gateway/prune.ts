/**
 * Event pruning sweep — plan §5.5 / P1-11.
 *
 * Invariant: durable events are deleted ONLY when a snapshot checkpoint
 * covers them (planEventPrune requires snapshotThroughSeq > 0). The
 * checkpoint itself is persisted per task so task.sync can serve the
 * snapshot when a client asks for a pruned range.
 *
 * Protected event types (user/assistant final/tool summary/permission)
 * are never deleted — planEventPrune enforces; the cap prune is a soft
 * target for unprotected volume only.
 */

import type { TaskSnapshot, DurableTaskEventEnvelope } from "@codex-sidepanel/shared";
import {
  MAX_EVENTS_PER_TASK,
  planCapPrune,
  planEventPrune,
} from "../store/retention.js";
import type { SessionStore } from "./session-manager.js";

export interface PruneStore extends SessionStore {
  buildTaskSnapshot(taskId: string): TaskSnapshot | null;
  allTaskEvents?(taskId: string): DurableTaskEventEnvelope[];
  getTaskSnapshotCheckpoint?(taskId: string): { throughSeq: number } | null;
  putTaskSnapshotCheckpoint?(taskId: string, throughSeq: number, snapshot: TaskSnapshot): void;
  deleteTaskEvents?(taskId: string, seqs: number[]): number;
  markTaskEventMilestone?(taskId: string, seq: number): void;
  listTasks?(): import("@codex-sidepanel/shared").TaskRecord[];
}

export interface PruneSweepResult {
  tasksChecked: number;
  checkpointsWritten: number;
  eventsDeleted: number;
  /** taskIds whose earliest retained event was marked milestone=1 */
  milestones: string[];
}

/**
 * Checkpoint + prune every task that has unprotected events beyond its
 * snapshot checkpoint. Idempotent — a second sweep with no new events
 * deletes nothing.
 */
export function runPruneSweep(
  store: PruneStore,
  opts: { maxEventsPerTask?: number } = {},
): PruneSweepResult {
  const result: PruneSweepResult = {
    tasksChecked: 0,
    checkpointsWritten: 0,
    eventsDeleted: 0,
    milestones: [],
  };
  if (!store.listTasks || !store.buildTaskSnapshot || !store.deleteTaskEvents) return result;

  for (const task of store.listTasks()) {
    result.tasksChecked += 1;
    const events =
      store.allTaskEvents?.(task.taskId) ??
      collectAll(store, task.taskId);
    if (events.length === 0) continue;

    const prunable = events.map((e) => ({ seq: e.seq, type: e.type }));
    const maxEvents = opts.maxEventsPerTask ?? MAX_EVENTS_PER_TASK;
    let checkpoint = store.getTaskSnapshotCheckpoint?.(task.taskId) ?? null;

    // 1) Ensure a checkpoint exists; advance it only when the log
    //    materially exceeds the cap — the snapshot only needs to cover
    //    DELETED seqs, so a stale checkpoint stays valid.
    const needsCheckpoint =
      !checkpoint ||
      events.length > maxEvents * 2 ||
      events[events.length - 1]!.seq - checkpoint.throughSeq > maxEvents;
    if (needsCheckpoint) {
      // never prune against an unpersisted checkpoint — a restart would
      // lose it and task.sync could not serve the pruned range.
      if (!store.putTaskSnapshotCheckpoint) continue;
      const snapshot = store.buildTaskSnapshot(task.taskId);
      if (!snapshot) continue;
      const throughSeq = snapshot.lastSeq;
      if (throughSeq > (checkpoint?.throughSeq ?? 0) && store.putTaskSnapshotCheckpoint) {
        store.putTaskSnapshotCheckpoint(task.taskId, throughSeq, snapshot);
        result.checkpointsWritten += 1;
      }
      checkpoint = { throughSeq };
    }
    if (!checkpoint) continue;
    const throughSeq = checkpoint.throughSeq;

    // 2) plan deletions — only seqs ≤ checkpoint are eligible.
    const plan = planEventPrune(prunable, throughSeq);
    const capSeqs = planCapPrune(prunable, maxEvents).filter((seq) => seq <= throughSeq);
    const deleteSeqs = [...new Set([...plan.deleteSeqs, ...capSeqs])].sort((a, b) => a - b);
    if (deleteSeqs.length === 0) continue;

    const removed = store.deleteTaskEvents(task.taskId, deleteSeqs);
    result.eventsDeleted += removed;
    if (removed === 0) continue;

    // 3) mark earliest retained event as the milestone boundary.
    const retained = events.filter((e) => !deleteSeqs.includes(e.seq));
    const firstRetained = retained[0];
    if (firstRetained && store.markTaskEventMilestone) {
      store.markTaskEventMilestone(task.taskId, firstRetained.seq);
      result.milestones.push(task.taskId);
    }
  }
  return result;
}

function collectAll(store: SessionStore, taskId: string): DurableTaskEventEnvelope[] {
  const out: DurableTaskEventEnvelope[] = [];
  let fromSeq = 0;
  for (;;) {
    const page = store.taskEventsAfter(taskId, fromSeq, 1000);
    out.push(...page.events);
    if (!page.hasMore) break;
    fromSeq = page.nextSeq;
  }
  return out;
}
