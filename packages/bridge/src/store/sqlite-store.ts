/**
 * SQLite-backed store — plan §7.2 + P1-02.
 *
 * Same surface as InMemoryStore so callers can swap via config.store.
 * Sequence allocation happens INSIDE BEGIN IMMEDIATE (never MAX(seq));
 * turn lifecycle uses UPSERT (ON CONFLICT DO UPDATE), never REPLACE.
 */

import fs from "node:fs";
import type {
  PauseReason,
  DurableGatewayEvent,
  DurableGatewayEventEnvelope,
  DurableTaskEvent,
  DurableTaskEventEnvelope,
  TaskRecord,
  TaskSnapshot,
  TurnRecord,
} from "@codex-sidepanel/shared";

import type { GatewayDb } from "./db.js";
import { buildSnapshotFromSource } from "./snapshot-builder.js";
import { boundTaskEventPayload } from "./event-payload.js";

// ---------- row mapping ----------

interface TaskRow {
  task_id: string;
  created_at: number;
  updated_at: number;
  status: TaskRecord["status"];
  pause_reason: PauseReason | null;
  title: string | null;
  profile_id: string;
  origin_browser_instance_id: string | null;
  binding_json: string;
  provider_id: TaskRecord["providerId"];
  conversation_key: string;
  cwd: string;
  model: string | null;
  mode_id: string | null;
  thinking_option_id: string | null;
  provider_options_json: string | null;
  backend_json: string;
  tab_intent_json: string;
  last_seq: number;
  last_read_seq: number;
  error_json: string | null;
  archived: number;
}

interface TurnRow {
  turn_id: string;
  task_id: string;
  status: TurnRecord["status"];
  client_message_id: string;
  created_at: number;
  queued_at: number | null;
  started_at: number | null;
  ended_at: number | null;
  stop_reason: string | null;
  error_json: string | null;
}

interface EventRow {
  stream: "task" | "gateway";
  task_id: string;
  seq: number;
  ts: number;
  type: string;
  turn_id: string | null;
  payload_json: string;
  milestone: number;
  redacted: number;
}

function parseJson<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function taskFromRow(r: TaskRow): TaskRecord {
  return {
    taskId: r.task_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    status: r.status,
    pauseReason: r.pause_reason,
    title: r.title,
    profileId: r.profile_id,
    originBrowserInstanceId: r.origin_browser_instance_id,
    binding: parseJson(r.binding_json) ?? {
      browserInstanceId: null,
      state: "none",
    },
    providerId: r.provider_id,
    conversationKey: r.conversation_key,
    cwd: r.cwd,
    model: r.model,
    modeId: r.mode_id,
    thinkingOptionId: r.thinking_option_id,
    providerOptions: parseJson(r.provider_options_json),
    backend: parseJson(r.backend_json) ?? {
      backendId: "chrome-extension",
      pinnedBy: "default",
    },
    tabIntent: parseJson(r.tab_intent_json) ?? { scope: "untitled" },
    lastSeq: r.last_seq,
    lastReadSeq: r.last_read_seq,
    error: parseJson(r.error_json),
  };
}

function taskToRow(t: TaskRecord): unknown[] {
  return [
    t.taskId,
    t.createdAt,
    t.updatedAt,
    t.status,
    t.pauseReason ?? null,
    t.title ?? null,
    t.profileId,
    t.originBrowserInstanceId ?? null,
    JSON.stringify(t.binding),
    t.providerId,
    t.conversationKey,
    t.cwd,
    t.model ?? null,
    t.modeId ?? null,
    t.thinkingOptionId ?? null,
    t.providerOptions ? JSON.stringify(t.providerOptions) : null,
    JSON.stringify(t.backend),
    JSON.stringify(t.tabIntent),
    t.lastSeq,
    t.lastReadSeq,
    t.error ? JSON.stringify(t.error) : null,
  ];
}

const TASK_COLS = `task_id, created_at, updated_at, status, pause_reason, title,
  profile_id, origin_browser_instance_id, binding_json, provider_id,
  conversation_key, cwd, model, mode_id, thinking_option_id,
  provider_options_json, backend_json, tab_intent_json, last_seq,
  last_read_seq, error_json`;

function turnFromRow(r: TurnRow): TurnRecord {
  return {
    turnId: r.turn_id,
    taskId: r.task_id,
    status: r.status,
    clientMessageId: r.client_message_id,
    createdAt: r.created_at,
    ...(r.queued_at !== null ? { queuedAt: r.queued_at } : {}),
    startedAt: r.started_at,
    endedAt: r.ended_at,
    ...(r.stop_reason !== null ? { stopReason: r.stop_reason } : {}),
    ...(r.error_json !== null ? { error: parseJson(r.error_json) } : {}),
  };
}

function eventEnvelopeFromRow(r: EventRow, taskIdOverride?: string): unknown {
  const payload = parseJson(r.payload_json);
  if (r.stream === "gateway") {
    return {
      v: 1,
      kind: "event",
      reliability: "durable",
      stream: "gateway",
      seq: r.seq,
      ts: r.ts,
      type: r.type,
      payload,
    };
  }
  return {
    v: 1,
    kind: "event",
    reliability: "durable",
    stream: "task",
    taskId: taskIdOverride ?? r.task_id,
    seq: r.seq,
    ts: r.ts,
    type: r.type,
    payload,
  };
}

// ---------- store ----------

export class SQLiteStore {
  /**
   * Optional ownership guard (§3.3.2 stale-fence): invoked synchronously
   * before every BEGIN IMMEDIATE. Throwing aborts the write — the
   * gateway wires this to OwnershipLock.checkFence + self-shutdown.
   */
  constructor(
    private readonly db: GatewayDb,
    private readonly opts: { assertOwnership?: () => void } = {},
  ) {}

  #guard(): void {
    this.opts.assertOwnership?.();
  }

  // ---- tasks ----

  /**
   * Create task + its current conversation row in ONE transaction
   * (§7.2 ordering: tasks INSERT → conversations INSERT is_current=1).
   */
  createTask(task: TaskRecord): void {
    this.#guard();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO tasks (${TASK_COLS})
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(...(taskToRow(task) as never[]));
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO conversations
             (conversation_key, task_id, is_current, provider_id, state,
              persistence_json, created_at, updated_at)
           VALUES (?, ?, 1, ?, 'opening', NULL, ?, ?)`,
        )
        .run(task.conversationKey, task.taskId, task.providerId, now, now);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  putTask(task: TaskRecord): void {
    this.db
      .prepare(
        `INSERT INTO tasks (${TASK_COLS})
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(task_id) DO UPDATE SET
           updated_at=excluded.updated_at, status=excluded.status,
           pause_reason=excluded.pause_reason, title=excluded.title,
           binding_json=excluded.binding_json, model=excluded.model,
           mode_id=excluded.mode_id, thinking_option_id=excluded.thinking_option_id,
           provider_options_json=excluded.provider_options_json,
           backend_json=excluded.backend_json, tab_intent_json=excluded.tab_intent_json,
           last_read_seq=excluded.last_read_seq,
           error_json=excluded.error_json`,
      )
      .run(...(taskToRow(task) as never[]));
  }

  getTask(taskId: string): TaskRecord | undefined {
    const row = this.db
      .prepare(`SELECT ${TASK_COLS} FROM tasks WHERE task_id = ?`)
      .get(taskId) as TaskRow | undefined;
    return row ? taskFromRow(row) : undefined;
  }

  listTasks(): TaskRecord[] {
    const rows = this.db
      .prepare(`SELECT ${TASK_COLS} FROM tasks ORDER BY created_at`)
      .all() as unknown as TaskRow[];
    return rows.map(taskFromRow);
  }

  // ---- turns ----

  /** UPSERT per §7.2 template — never INSERT OR REPLACE. */
  upsertTurn(turn: TurnRecord): void {
    this.db
      .prepare(
        `INSERT INTO turns
           (turn_id, task_id, status, client_message_id, created_at,
            queued_at, started_at, ended_at, stop_reason, error_json)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(turn_id) DO UPDATE SET
           status = excluded.status,
           queued_at = COALESCE(turns.queued_at, excluded.queued_at),
           started_at = excluded.started_at,
           ended_at = excluded.ended_at,
           stop_reason = excluded.stop_reason,
           error_json = excluded.error_json`,
      )
      .run(
        turn.turnId,
        turn.taskId,
        turn.status,
        turn.clientMessageId,
        turn.createdAt,
        turn.queuedAt ?? null,
        turn.startedAt,
        turn.endedAt ?? null,
        turn.stopReason ?? null,
        turn.error ? JSON.stringify(turn.error) : null,
      );
  }

  /** §4.4.1 idempotency: clientMessageId → existing turn. */
  findTurnByClientMessageId(taskId: string, clientMessageId: string): TurnRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM turns WHERE task_id = ? AND client_message_id = ?")
      .get(taskId, clientMessageId) as TurnRow | undefined;
    return row ? turnFromRow(row) : undefined;
  }

  /** First non-terminal turn for a task (queued or running). */
  activeTurn(taskId: string): TurnRecord | undefined {
    const row = this.db
      .prepare(
        "SELECT * FROM turns WHERE task_id = ? AND status IN ('queued','running') ORDER BY created_at LIMIT 1",
      )
      .get(taskId) as TurnRow | undefined;
    return row ? turnFromRow(row) : undefined;
  }

  getTurn(turnId: string): TurnRecord | undefined {
    const row = this.db
      .prepare("SELECT * FROM turns WHERE turn_id = ?")
      .get(turnId) as TurnRow | undefined;
    return row ? turnFromRow(row) : undefined;
  }

  listTurns(taskId?: string): TurnRecord[] {
    const rows = (
      taskId
        ? this.db.prepare("SELECT * FROM turns WHERE task_id = ? ORDER BY created_at").all(taskId)
        : this.db.prepare("SELECT * FROM turns ORDER BY created_at").all()
    ) as unknown as TurnRow[];
    return rows.map(turnFromRow);
  }

  // ---- durable events (seq inside BEGIN IMMEDIATE) ----

  appendTaskEvent(
    taskId: string,
    event: DurableTaskEvent,
    opts?: { turn?: TurnRecord; milestone?: number; turnId?: string },
  ): DurableTaskEventEnvelope {
    const ts = Date.now();
    this.#guard();
    // §4.1: bound BEFORE the transaction — oversized provider payloads
    // degrade to truncated strings instead of bloating the event log.
    const bounded = boundTaskEventPayload(event);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const taskRow = this.db
        .prepare("SELECT last_seq FROM tasks WHERE task_id = ?")
        .get(taskId) as { last_seq: number } | undefined;
      if (!taskRow) throw new Error(`task ${taskId} not found`);
      const seq = taskRow.last_seq + 1;

      this.db
        .prepare(
          `INSERT INTO events (stream, task_id, seq, ts, type, turn_id, payload_json, milestone)
           VALUES ('task', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(taskId, seq, ts, bounded.type, opts?.turnId ?? null, JSON.stringify(bounded), opts?.milestone ?? 0);

      this.db
        .prepare("UPDATE tasks SET last_seq = ?, updated_at = ? WHERE task_id = ?")
        .run(seq, ts, taskId);

      if (opts?.turn) this.upsertTurn(opts.turn);

      this.db.exec("COMMIT");

      return {
        v: 1,
        kind: "event",
        reliability: "durable",
        stream: "task",
        taskId,
        seq,
        ts,
        type: bounded.type,
        payload: bounded,
      } as DurableTaskEventEnvelope;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  taskEventsAfter(
    taskId: string,
    fromSeq: number,
    maxEvents = 500,
  ): {
    events: DurableTaskEventEnvelope[];
    nextSeq: number;
    hasMore: boolean;
  } {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE stream='task' AND task_id=? AND seq>? ORDER BY seq LIMIT ?`,
      )
      .all(taskId, fromSeq, maxEvents + 1) as unknown as EventRow[];
    const hasMore = rows.length > maxEvents;
    const page = hasMore ? rows.slice(0, maxEvents) : rows;
    const events = page.map((r) => eventEnvelopeFromRow(r, taskId)) as DurableTaskEventEnvelope[];
    const last = page[page.length - 1];
    return { events, nextSeq: last ? last.seq : fromSeq, hasMore };
  }

  appendGatewayEvent(event: DurableGatewayEvent): DurableGatewayEventEnvelope {
    const ts = Date.now();
    this.#guard();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT value FROM gateway_state WHERE key = 'gateway.last_seq'")
        .get() as { value: string } | undefined;
      const seq = (row ? parseInt(row.value, 10) : 0) + 1;

      this.db
        .prepare(
          `INSERT INTO events (stream, task_id, seq, ts, type, payload_json, milestone)
           VALUES ('gateway', '', ?, ?, ?, ?, 0)`,
        )
        .run(seq, ts, event.type, JSON.stringify(event));

      this.db
        .prepare(
          `INSERT INTO gateway_state (key, value, updated_at) VALUES ('gateway.last_seq', ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .run(String(seq), ts);

      this.db.exec("COMMIT");

      return {
        v: 1,
        kind: "event",
        reliability: "durable",
        stream: "gateway",
        seq,
        ts,
        type: event.type,
        payload: event,
      } as DurableGatewayEventEnvelope;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  gatewayEventsAfter(
    fromSeq: number,
    maxEvents = 500,
  ): {
    events: DurableGatewayEventEnvelope[];
    nextSeq: number;
    hasMore: boolean;
  } {
    const rows = this.db
      .prepare(
        `SELECT * FROM events WHERE stream='gateway' AND seq>? ORDER BY seq LIMIT ?`,
      )
      .all(fromSeq, maxEvents + 1) as unknown as EventRow[];
    const hasMore = rows.length > maxEvents;
    const page = hasMore ? rows.slice(0, maxEvents) : rows;
    const events = page.map((r) => eventEnvelopeFromRow(r)) as DurableGatewayEventEnvelope[];
    const last = page[page.length - 1];
    return { events, nextSeq: last ? last.seq : fromSeq, hasMore };
  }

  lastTaskSeq(taskId: string): number {
    const row = this.db
      .prepare("SELECT last_seq FROM tasks WHERE task_id = ?")
      .get(taskId) as { last_seq: number } | undefined;
    return row?.last_seq ?? 0;
  }

  lastGatewaySeq(): number {
    const row = this.db
      .prepare("SELECT value FROM gateway_state WHERE key = 'gateway.last_seq'")
      .get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  }

  /** §4.6 self-sufficient snapshot rebuilt from the durable event
   *  stream — user prompts, assistant finals, tool calls, permissions. */
  buildTaskSnapshot(taskId: string): TaskSnapshot | null {
    const task = this.getTask(taskId);
    if (!task) return null;
    const events = this.allTaskEvents(taskId);
    const approvals = this.listApprovals(taskId);
    const archived = this.tasksForRetention().find((t) => t.taskId === taskId)?.archived === true;
    // §5.5: when events were pruned, the checkpoint snapshot carries the
    // deleted range — merge it with retained events or the snapshot
    // would silently lose user/assistant history.
    const checkpoint = this.getTaskSnapshotCheckpoint(taskId);
    return buildSnapshotFromSource({
      task,
      turns: this.listTurns(taskId),
      events,
      approvals,
      rebuiltFrom: archived ? "archived_snapshot" : "event_log",
      ...(checkpoint && checkpoint.snapshot.storage.kind === "inline"
        ? {
            checkpointThroughSeq: checkpoint.throughSeq,
            base: checkpoint.snapshot as import("@codex-sidepanel/shared").InlineTaskSnapshot,
          }
        : {}),
    });
  }

  /** All durable task-stream envelopes, ascending seq (snapshot/prune). */
  allTaskEvents(taskId: string): DurableTaskEventEnvelope[] {
    const out: DurableTaskEventEnvelope[] = [];
    let fromSeq = 0;
    for (;;) {
      const page = this.taskEventsAfter(taskId, fromSeq, 1000);
      out.push(...page.events);
      if (!page.hasMore) break;
      fromSeq = page.nextSeq;
    }
    return out;
  }

  /** Approval rows for snapshot rebuild — request + decision + status. */
  listApprovals(taskId: string): Array<{
    request: unknown;
    decision: { optionId: string; kind: string; decidedAt: number; scope?: string } | null;
    status: string;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare(
        "SELECT request_json, decision_json, status, created_at FROM approvals WHERE task_id = ? ORDER BY created_at",
      )
      .all(taskId) as Array<{
        request_json: string;
        decision_json: string | null;
        status: string;
        created_at: number;
      }>;
    return rows.map((r) => ({
      request: JSON.parse(r.request_json),
      decision: r.decision_json ? JSON.parse(r.decision_json) : null,
      status: r.status,
      createdAt: r.created_at,
    }));
  }

  // ---- snapshot checkpoints + event pruning (§5.5, P1-11) ----

  getTaskSnapshotCheckpoint(taskId: string): { throughSeq: number; snapshot: TaskSnapshot } | null {
    const row = this.db
      .prepare("SELECT value FROM gateway_state WHERE key = ?")
      .get(`task.snapshot.${taskId}`) as { value: string } | undefined;
    if (!row) return null;
    try {
      const parsed = JSON.parse(row.value) as { throughSeq?: number; snapshot?: TaskSnapshot };
      if (typeof parsed.throughSeq !== "number" || !parsed.snapshot) return null;
      return { throughSeq: parsed.throughSeq, snapshot: parsed.snapshot };
    } catch {
      return null;
    }
  }

  putTaskSnapshotCheckpoint(taskId: string, throughSeq: number, snapshot: TaskSnapshot): void {
    this.#guard();
    this.db
      .prepare(
        `INSERT INTO gateway_state (key, value, updated_at) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`,
      )
      .run(`task.snapshot.${taskId}`, JSON.stringify({ throughSeq, snapshot }), Date.now());
  }

  /** Delete specific task-stream seqs — caller MUST have a snapshot
   *  checkpoint covering them first (planEventPrune enforces). */
  deleteTaskEvents(taskId: string, seqs: number[]): number {
    if (seqs.length === 0) return 0;
    this.#guard();
    const stmt = this.db.prepare(
      "DELETE FROM events WHERE stream='task' AND task_id=? AND seq=?",
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let n = 0;
      for (const seq of seqs) n += Number(stmt.run(taskId, seq).changes);
      this.db.exec("COMMIT");
      return n;
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  /** Mark the earliest retained event as a milestone — the seq at which
   *  replay + snapshot checkpoint reconstruct full state (§5.5). */
  markTaskEventMilestone(taskId: string, seq: number): void {
    this.db
      .prepare("UPDATE events SET milestone=1 WHERE stream='task' AND task_id=? AND seq=?")
      .run(taskId, seq);
  }

  // ---- approvals / artifacts / provider_state (minimal DAO) ----

  insertApproval(row: {
    approvalId: string;
    taskId: string;
    turnId?: string;
    request: unknown;
    actionDigest: string;
    status: "pending" | "allowed" | "denied" | "expired";
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO approvals (approval_id, task_id, turn_id, request_json, action_digest, status, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        row.approvalId,
        row.taskId,
        row.turnId ?? null,
        JSON.stringify(row.request),
        row.actionDigest,
        row.status,
        row.createdAt,
      );
  }

  listPendingApprovals(taskId: string): unknown[] {
    return this.db
      .prepare("SELECT * FROM approvals WHERE task_id = ? AND status = 'pending'")
      .all(taskId) as unknown[];
  }

  countPendingApprovals(taskId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM approvals WHERE task_id = ? AND status = 'pending'")
      .get(taskId) as { n: number };
    return row.n;
  }

  /** §5.5 archive flag — separate from TaskRecord mapping (not in
   *  TASK_COLS to keep putTask's ON CONFLICT surface unchanged). */
  setTaskArchived(taskId: string, archived: boolean): void {
    this.#guard();
    this.db.prepare("UPDATE tasks SET archived = ? WHERE task_id = ?").run(archived ? 1 : 0, taskId);
  }

  /** Sweep view: id/status/updatedAt/archived for retention decisions. */
  tasksForRetention(): Array<{
    taskId: string;
    status: TaskRecord["status"];
    updatedAt: number;
    archived: boolean;
  }> {
    const rows = this.db
      .prepare("SELECT task_id, status, updated_at, archived FROM tasks")
      .all() as Array<{
        task_id: string;
        status: TaskRecord["status"];
        updated_at: number;
        archived: number;
      }>;
    return rows.map((r) => ({
      taskId: r.task_id,
      status: r.status,
      updatedAt: r.updated_at,
      archived: r.archived === 1,
    }));
  }

  approvalStatus(
    approvalId: string,
  ): "pending" | "allowed" | "denied" | "expired" | null {
    const row = this.db
      .prepare("SELECT status FROM approvals WHERE approval_id = ?")
      .get(approvalId) as { status: string } | undefined;
    return (row?.status as never) ?? null;
  }

  /** Resolve a pending approval; idempotent — already-resolved is a no-op. */
  resolveApproval(
    approvalId: string,
    status: "allowed" | "denied" | "expired",
    decision?: { optionId: string; kind: string; decidedAt: number; scope?: string },
  ): void {
    this.db
      .prepare(
        "UPDATE approvals SET status = ?, decision_json = ?, decided_at = ? WHERE approval_id = ? AND status = 'pending'",
      )
      .run(status, decision ? JSON.stringify(decision) : null, decision?.decidedAt ?? null, approvalId);
  }

  approvalRequest(approvalId: string): unknown {
    const row = this.db
      .prepare("SELECT request_json FROM approvals WHERE approval_id = ?")
      .get(approvalId) as { request_json: string } | undefined;
    return row ? JSON.parse(row.request_json) : null;
  }

  approvalDecision(
    approvalId: string,
  ): { optionId: string; kind: string; decidedAt: number; scope?: string } | null {
    const row = this.db
      .prepare("SELECT decision_json FROM approvals WHERE approval_id = ?")
      .get(approvalId) as { decision_json: string | null } | undefined;
    return row?.decision_json ? JSON.parse(row.decision_json) : null;
  }

  insertArtifact(row: {
    artifactId: string;
    taskId: string;
    kind: string;
    sha256: string;
    path: string;
    mime?: string;
    bytes?: number;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO artifacts (artifact_id, task_id, kind, sha256, path, mime, bytes, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        row.artifactId,
        row.taskId,
        row.kind,
        row.sha256,
        row.path,
        row.mime ?? null,
        row.bytes ?? null,
        row.createdAt,
      );
  }

  setProviderState(
    providerId: string,
    state: { catalog?: unknown; authState?: unknown },
  ): void {
    this.db
      .prepare(
        `INSERT INTO provider_state (provider_id, catalog_json, fetched_at, auth_state_json)
         VALUES (?,?,?,?)
         ON CONFLICT(provider_id) DO UPDATE SET
           catalog_json=excluded.catalog_json,
           fetched_at=excluded.fetched_at,
           auth_state_json=excluded.auth_state_json`,
      )
      .run(
        providerId,
        state.catalog !== undefined ? JSON.stringify(state.catalog) : null,
        state.catalog !== undefined ? Date.now() : null,
        state.authState !== undefined ? JSON.stringify(state.authState) : null,
      );
  }

  /** Explicit task purge — §7.2 delete policy: explicit cascade in txn,
   *  plus best-effort artifact file deletion (failures logged, not fatal). */
  purgeTask(taskId: string): void {
    this.#guard();
    const artifactPaths = (
      this.db.prepare("SELECT path FROM artifacts WHERE task_id = ?").all(taskId) as Array<{ path: string | null }>
    )
      .map((r) => r.path)
      .filter((p): p is string => typeof p === "string" && p.length > 0);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      // events have no FK — delete explicitly per §7.2
      this.db.prepare("DELETE FROM events WHERE stream='task' AND task_id = ?").run(taskId);
      this.db.prepare("DELETE FROM tasks WHERE task_id = ?").run(taskId);
      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
    for (const p of artifactPaths) {
      fs.promises.unlink(p).catch(() => {
        /* best-effort: orphaned artifact file is logged by caller sweep */
      });
    }
  }

  /** §5.5 approval retention: resolved approvals deleted once the task
   *  has been terminal > APPROVAL_POST_TERMINAL_MS (updated_at is the
   *  terminal timestamp proxy — tasks are not updated post-terminal
   *  except by archive marking, which only makes them older). */
  sweepResolvedApprovals(olderThanMs: number): number {
    this.#guard();
    const res = this.db
      .prepare(
        `DELETE FROM approvals WHERE status != 'pending' AND task_id IN (
           SELECT task_id FROM tasks
           WHERE status IN ('completed','failed','cancelled') AND updated_at < ?
         )`,
      )
      .run(olderThanMs);
    return Number(res.changes);
  }

  /** §5.5 artifact TTL: delete artifact rows + files for tasks terminal
   *  > ARTIFACT_TTL_MS. File deletion is best-effort. */
  async sweepExpiredArtifacts(olderThanMs: number): Promise<{ rows: number; filesDeleted: number }> {
    this.#guard();
    const rows = this.db
      .prepare(
        `SELECT artifact_id, path FROM artifacts WHERE task_id IN (
           SELECT task_id FROM tasks
           WHERE status IN ('completed','failed','cancelled') AND updated_at < ?
         )`,
      )
      .all(olderThanMs) as Array<{ artifact_id: string; path: string | null }>;
    let filesDeleted = 0;
    for (const r of rows) {
      if (r.path) {
        try {
          await fs.promises.unlink(r.path);
          filesDeleted += 1;
        } catch {
          /* best-effort — logged by caller via counts */
        }
      }
    }
    const res = this.db
      .prepare(
        `DELETE FROM artifacts WHERE task_id IN (
           SELECT task_id FROM tasks
           WHERE status IN ('completed','failed','cancelled') AND updated_at < ?
         )`,
      )
      .run(olderThanMs);
    return { rows: Number(res.changes), filesDeleted };
  }

  close(): void {
    this.db.close();
  }
}
