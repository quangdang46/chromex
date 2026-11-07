/**
 * Task controller — plan §11 / P1-08.
 *
 * Owns gateway-side task state for the UI: seeds from `hello`, replays
 * durable events via `task.sync` (snapshot fallback when the range was
 * pruned), tracks per-task cursors + attention, and sends `ack` when
 * the UI reports a task rendered up to a seq.
 *
 * Cursor persistence: `chrome.storage.local["chromex.gateway.cursors.v1"]`
 * survives SW restarts (installation lifetime — same as identity).
 */

import type {
  DurableTaskEventEnvelope,
  HelloResponse,
  HelloTaskSummary,
  InlineTaskSnapshot,
  TaskSnapshot,
  TaskStatus,
} from "@codex-sidepanel/shared";

import type { GatewayClient } from "./gateway-client.js";

const CURSOR_KEY = "chromex.gateway.cursors.v1";
const MAX_SYNC_EVENTS = 500;

export interface TaskView {
  taskId: string;
  status: TaskStatus;
  lastSeq: number;
  /** seq the UI has rendered up to (lastReadSeq) */
  lastReadSeq: number;
  attention: string | null;
  title: string | null;
  updatedAt: number;
}

interface CursorState {
  lastSeqByTask: Record<string, number>;
  lastSeqByGateway: number;
  lastReadSeqByTask: Record<string, number>;
}

export interface TaskControllerOptions {
  client: GatewayClient;
  storage: Pick<typeof chrome.storage.local, "get" | "set">;
  /** UI-facing event hook — durable envelopes only */
  onTaskEvent?: (taskId: string, env: DurableTaskEventEnvelope) => void;
  /** snapshot rebuilt after prune — UI must re-render from scratch */
  onSnapshotRebuilt?: (taskId: string, snapshot: InlineTaskSnapshot) => void;
  /** replayed/live gateway-stream envelopes (notices, purged tombstones…) */
  onGatewayEvent?: (env: { seq?: number; [k: string]: unknown }) => void;
  onTasksChanged?: () => void;
}

export class TaskController {
  #tasks = new Map<string, TaskView>();
  #cursors: CursorState = { lastSeqByTask: {}, lastSeqByGateway: 0, lastReadSeqByTask: {} };
  #loaded = false;
  readonly #opts: TaskControllerOptions;

  constructor(opts: TaskControllerOptions) {
    this.#opts = opts;
  }

  listTasks(): TaskView[] {
    return [...this.#tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getTask(taskId: string): TaskView | undefined {
    return this.#tasks.get(taskId);
  }

  /** Seed task views from HelloResponse + load persisted cursors. */
  async onHello(hello: HelloResponse): Promise<void> {
    await this.#loadCursors();
    for (const t of hello.tasks) this.#seedFromHello(t);
    this.#opts.onTasksChanged?.();
  }

  #seedFromHello(t: HelloTaskSummary): void {
    const existing = this.#tasks.get(t.taskId);
    const lastSeq = this.#cursors.lastSeqByTask[t.taskId] ?? t.lastSeq;
    this.#tasks.set(t.taskId, {
      taskId: t.taskId,
      status: t.status,
      lastSeq: Math.max(lastSeq, existing?.lastSeq ?? 0),
      lastReadSeq: this.#cursors.lastReadSeqByTask[t.taskId] ?? existing?.lastReadSeq ?? 0,
      attention: null,
      title: existing?.title ?? null,
      updatedAt: Date.now(),
    });
  }

  /**
   * §11 reconnect flow: hello cursors → task.sync per task → apply;
   * `mode:"snapshot"` → fetch + rebuild via task.snapshot (+chunks);
   * gateway.sync catches up the gateway stream (notices/tombstones).
   */
  async syncAll(): Promise<void> {
    await this.syncGateway();
    for (const task of this.#tasks.values()) {
      await this.syncTask(task.taskId);
    }
  }

  /** Replay durable gateway-stream events missed while disconnected. */
  async syncGateway(): Promise<void> {
    let fromSeq = this.#cursors.lastSeqByGateway;
    for (;;) {
      const res = (await this.#opts.client.request("gateway.sync", {
        fromSeq,
        maxEvents: MAX_SYNC_EVENTS,
      })) as
        | { mode: "replay"; events: Array<{ seq?: number } & Record<string, unknown>>; nextSeq: number; hasMore: boolean }
        | { mode: "head"; lastSeq: number };
      if (res.mode === "head") {
        this.#cursors.lastSeqByGateway = Math.max(this.#cursors.lastSeqByGateway, res.lastSeq);
        await this.#saveCursors();
        return;
      }
      for (const env of res.events) {
        if (typeof env.seq === "number") {
          this.#cursors.lastSeqByGateway = Math.max(this.#cursors.lastSeqByGateway, env.seq);
        }
        this.#opts.onGatewayEvent?.(env);
      }
      fromSeq = res.nextSeq;
      if (!res.hasMore) break;
    }
    await this.#saveCursors();
  }

  async syncTask(taskId: string): Promise<void> {
    const view = this.#tasks.get(taskId);
    if (!view) return;
    let fromSeq = view.lastSeq;
    for (;;) {
      const res = (await this.#opts.client.request("task.sync", {
        taskId,
        fromSeq,
        maxEvents: MAX_SYNC_EVENTS,
      })) as
        | { mode: "replay"; events: DurableTaskEventEnvelope[]; nextSeq: number; hasMore: boolean }
        | { mode: "snapshot"; snapshot: TaskSnapshot; lastSeq: number };

      if (res.mode === "snapshot") {
        await this.#applySnapshot(taskId, res.snapshot, res.lastSeq);
        return;
      }
      for (const env of res.events) {
        if (env.stream === "task" && env.taskId === taskId) {
          this.#applyEvent(env);
        }
      }
      fromSeq = res.nextSeq;
      if (!res.hasMore) return;
    }
  }

  async #applySnapshot(taskId: string, snap: TaskSnapshot, lastSeq: number): Promise<void> {
    let full: InlineTaskSnapshot | null = null;
    if (snap.storage.kind === "inline") {
      full = snap as InlineTaskSnapshot;
    } else if (snap.storage.kind === "chunked") {
      full = await this.#fetchChunked(taskId, snap.storage);
    }
    // rebuild: reset view + emit a synthetic rebuild marker so UI re-renders
    const view = this.#tasks.get(taskId);
    if (view) {
      view.lastSeq = lastSeq;
      view.updatedAt = Date.now();
    }
    if (full) {
      this.#opts.onSnapshotRebuilt?.(taskId, full);
    }
    await this.#saveCursors();
    this.#opts.onTasksChanged?.();
  }

  async #fetchChunked(
    taskId: string,
    storage: { snapshotRef: string; chunkCount: number; snapshotSha256: string },
  ): Promise<InlineTaskSnapshot | null> {
    const parts: Uint8Array[] = [];
    let total = 0;
    for (let i = 0; i < storage.chunkCount; i++) {
      const chunk = (await this.#opts.client.request("task.snapshot.chunk", {
        taskId,
        snapshotRef: storage.snapshotRef,
        chunkIndex: i,
      })) as { data: string; sha256: string };
      const bin = atob(chunk.data);
      const bytes = new Uint8Array(bin.length);
      for (let j = 0; j < bin.length; j++) bytes[j] = bin.charCodeAt(j);
      parts.push(bytes);
      total += bytes.length;
    }
    const merged = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      merged.set(p, off);
      off += p.length;
    }
    return JSON.parse(new TextDecoder().decode(merged)) as InlineTaskSnapshot;
  }

  /** Apply one durable task event envelope; updates cursors + view.
   *  Duplicate/out-of-order replay (seq ≤ lastSeq) is dropped — replay
   *  and live push can overlap after reconnect. */
  #applyEvent(env: DurableTaskEventEnvelope): void {
    const view = this.#tasks.get(env.taskId);
    if (view) {
      if (env.seq <= view.lastSeq && view.lastSeq > 0) return;
      view.lastSeq = Math.max(view.lastSeq, env.seq);
      view.updatedAt = Date.now();
      const t = env.payload as { type?: string; to?: TaskStatus; attention?: string | null };
      if (t.type === "task.status_changed" && t.to) view.status = t.to;
      if (t.type === "task.attention_changed") view.attention = t.attention ?? null;
      if (t.type === "task.created") {
        // title may arrive later via task.get; keep null
      }
      this.#cursors.lastSeqByTask[env.taskId] = view.lastSeq;
      void this.#saveCursors();
    }
    this.#opts.onTaskEvent?.(env.taskId, env);
    this.#opts.onTasksChanged?.();
  }

  /** Live event entry point (gateway push). */
  handleEvent(env: DurableTaskEventEnvelope | { stream?: string; seq?: number }): void {
    if (!("stream" in env) || typeof env.stream !== "string") return;
    if (env.stream === "gateway" && typeof env.seq === "number") {
      this.#cursors.lastSeqByGateway = Math.max(this.#cursors.lastSeqByGateway, env.seq);
      void this.#saveCursors();
      return;
    }
    if (env.stream === "task" && "taskId" in env) {
      this.#applyEvent(env as DurableTaskEventEnvelope);
    }
  }

  /** UI rendered up to seq → ack + advance lastReadSeq. */
  markRendered(taskId: string, seq: number): void {
    const view = this.#tasks.get(taskId);
    if (!view) return;
    view.lastReadSeq = Math.max(view.lastReadSeq, seq);
    this.#cursors.lastReadSeqByTask[taskId] = view.lastReadSeq;
    void this.#saveCursors();
    this.#opts.client.ack("task", seq, taskId);
  }

  async #loadCursors(): Promise<void> {
    if (this.#loaded) return;
    this.#loaded = true;
    try {
      const got = await this.#opts.storage.get(CURSOR_KEY);
      const c = got[CURSOR_KEY] as CursorState | undefined;
      if (c && typeof c === "object") {
        this.#cursors = {
          lastSeqByTask: c.lastSeqByTask ?? {},
          lastSeqByGateway: c.lastSeqByGateway ?? 0,
          lastReadSeqByTask: c.lastReadSeqByTask ?? {},
        };
      }
    } catch {
      // corrupted cursor state → start fresh (replay from 0 is safe)
    }
  }

  async #saveCursors(): Promise<void> {
    try {
      await this.#opts.storage.set({ [CURSOR_KEY]: this.#cursors });
    } catch {
      // storage full/denied — cursors are best-effort; hello resends lastSeq=task.lastSeq
    }
  }

  /** hello cursors for the NEXT connect (lastSeqByTask + lastSeqByGateway). */
  helloCursors(): { lastSeqByTask: Record<string, number>; lastSeqByGateway: number } {
    return {
      lastSeqByTask: { ...this.#cursors.lastSeqByTask },
      lastSeqByGateway: this.#cursors.lastSeqByGateway,
    };
  }
}
