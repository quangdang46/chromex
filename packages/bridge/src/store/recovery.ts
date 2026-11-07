/**
 * Startup recovery scan — plan §5.6.
 *
 * Runs BEFORE gateway becomes ready, inside the store's transaction
 * discipline. Rules:
 *  - turn running  → tool.completed{outcome:"unknown"} for every
 *    tool.started lacking tool.completed; turn → unknown
 *    (turn.unknown event); owning task → paused(gateway_restart)
 *  - turn queued   → stays queued; owning task → paused(gateway_restart);
 *    never auto-runs
 *  - approval pending → untouched (UI re-shows; user decides)
 *  - active tasks with no running turn → paused(gateway_restart)
 *
 * Never replays side effects; unknown tools are observe-first.
 */

import type { GatewayDb } from "./db.js";
import type { SQLiteStore } from "./sqlite-store.js";
import type { TaskRecord, TurnRecord } from "@codex-sidepanel/shared";

export interface RecoveryResult {
  recoveredTurns: number;
  recoveredTasks: number;
  /** turnIds transitioned running→unknown */
  unknownTurns: string[];
  /** taskIds transitioned →paused(gateway_restart) */
  pausedTasks: string[];
}

interface EventTypeRow {
  type: string;
  turn_id: string | null;
}

interface OpenToolCall {
  toolCallId: string;
  tool: string;
}

/** toolCallIds with tool.started but no tool.completed, per turn. */
function openToolCalls(db: GatewayDb, turnId: string): OpenToolCall[] {
  const rows = db
    .prepare(
      `SELECT payload_json FROM events
       WHERE stream='task' AND type IN ('tool.started','tool.completed')
         AND json_extract(payload_json, '$.turnId') = ?
       ORDER BY seq`,
    )
    .all(turnId) as Array<{ payload_json: string }>;
  const open = new Map<string, string>();
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload_json) as {
        type?: string;
        toolCallId?: string;
        tool?: string;
      };
      if (p.type === "tool.started" && p.toolCallId) {
        open.set(p.toolCallId, p.tool ?? "unknown");
      }
      if (p.type === "tool.completed" && p.toolCallId) open.delete(p.toolCallId);
    } catch {
      /* skip malformed */
    }
  }
  return [...open.entries()].map(([toolCallId, tool]) => ({ toolCallId, tool }));
}

function taskEventsForTurn(db: GatewayDb, taskId: string): EventTypeRow[] {
  return db
    .prepare(
      `SELECT type, turn_id FROM events
       WHERE stream='task' AND task_id=? AND turn_id IS NOT NULL ORDER BY seq`,
    )
    .all(taskId) as unknown as EventTypeRow[];
}

export function runRecoveryScan(store: SQLiteStore, db: GatewayDb): RecoveryResult {
  const now = Date.now();
  const result: RecoveryResult = {
    recoveredTurns: 0,
    recoveredTasks: 0,
    unknownTurns: [],
    pausedTasks: [],
  };
  const pausedTaskIds = new Set<string>();

  const pauseTask = (taskId: string) => {
    const task = store.getTask(taskId);
    if (!task) return;
    if (task.status === "active" || task.status === "queued") {
      store.putTask({
        ...task,
        status: "paused",
        pauseReason: "gateway_restart",
        updatedAt: now,
      });
      pausedTaskIds.add(taskId);
      store.appendTaskEvent(taskId, {
        type: "task.status_changed",
        from: task.status,
        to: "paused",
        pauseReason: "gateway_restart",
      });
    }
  };

  for (const turn of store.listTurns()) {
    const task = store.getTask(turn.taskId);
    if (!task) continue;

    if (turn.status === "running") {
      // close open tool calls as unknown, then mark turn unknown
      for (const { toolCallId, tool } of openToolCalls(db, turn.turnId)) {
        store.appendTaskEvent(
          turn.taskId,
          {
            type: "tool.completed",
            turnId: turn.turnId,
            toolCallId,
            tool,
            outcome: "unknown",
          },
          { turnId: turn.turnId },
        );
      }
      const updated: TurnRecord = {
        ...turn,
        status: "unknown",
        endedAt: now,
        stopReason: "gateway_restart",
      };
      store.upsertTurn(updated);
      store.appendTaskEvent(
        turn.taskId,
        { type: "turn.unknown", turnId: turn.turnId, reason: "gateway_restart" },
        { turn: updated, turnId: turn.turnId },
      );
      result.recoveredTurns += 1;
      result.unknownTurns.push(turn.turnId);
      pauseTask(turn.taskId);
    } else if (turn.status === "queued") {
      // keep queued; pause owning task so it can't auto-run
      pauseTask(turn.taskId);
    }
  }

  // active tasks with no running turn also pause (e.g. crash mid-idle)
  for (const task of store.listTasks()) {
    if (task.status === "active") {
      const hasRunning = store
        .listTurns(task.taskId)
        .some((t) => t.status === "running");
      if (!hasRunning) pauseTask(task.taskId);
    }
  }

  result.pausedTasks = [...pausedTaskIds];
  result.recoveredTasks = pausedTaskIds.size;
  void taskEventsForTurn; // reserved for milestone checks in later beads
  return result;
}

export interface DurableBrowserToolCall {
  toolCallId: string;
  tool: string;
  taskId: string;
  /** "started" = tool.started with no completion; otherwise the last
   *  tool.completed outcome ("completed" | "failed" | "cancelled" |
   *  "unknown"). */
  last: "started" | "completed" | "failed" | "cancelled" | "unknown";
}

/** Every browser toolCallId present in the durable event stream, with
 *  its LAST record — the in-memory dedup map in BrowserToolServer is
 *  empty after a gateway restart, so without seeding these a retried
 *  call would silently re-dispatch and could duplicate a side effect
 *  (S5 / §9.1). Last event wins: a later real completion supersedes an
 *  earlier interrupted record. */
export function durableBrowserToolCalls(db: GatewayDb): DurableBrowserToolCall[] {
  const rows = db
    .prepare(
      `SELECT task_id, payload_json FROM events
       WHERE stream='task' AND type IN ('tool.started','tool.completed')
       ORDER BY seq`,
    )
    .all() as Array<{ task_id: string; payload_json: string }>;
  const last = new Map<
    string,
    { kind: "started" | "done"; outcome: string | undefined; tool: string; taskId: string }
  >();
  for (const r of rows) {
    try {
      const p = JSON.parse(r.payload_json) as {
        type?: string;
        toolCallId?: string;
        tool?: string;
        source?: string;
        outcome?: string;
      };
      if (p.source !== "browser" || !p.toolCallId) continue;
      const tool = p.tool ?? "unknown";
      if (p.type === "tool.started") {
        last.set(p.toolCallId, { kind: "started", outcome: undefined, tool, taskId: r.task_id });
      } else if (p.type === "tool.completed") {
        last.set(p.toolCallId, { kind: "done", outcome: p.outcome, tool, taskId: r.task_id });
      }
    } catch {
      /* skip malformed */
    }
  }
  return [...last.entries()].map(([toolCallId, v]) => ({
    toolCallId,
    tool: v.tool,
    taskId: v.taskId,
    last:
      v.kind === "started"
        ? "started"
        : v.outcome === "completed" || v.outcome === "failed" || v.outcome === "cancelled"
          ? v.outcome
          : "unknown",
  }));
}
