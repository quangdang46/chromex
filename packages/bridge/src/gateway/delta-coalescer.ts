/**
 * Delta coalescer — plan §4.1/P2-06.
 *
 * Ephemeral assistant/reasoning deltas are RAM-only: buffered per
 * (taskId, turnId, type) and flushed as one envelope. Flush timing is
 * `min(firstPush + flushMs, lastPush + coalesceWindowMs)` — sparse
 * deltas emit after a 50ms silence window, sustained streams are
 * capped at `flushMs` (750ms) so live tokens still flow.
 *
 * They never touch the durable event log or its seq counters.
 *
 * Backpressure: when a turn's buffered chars exceed
 * `deltaBufferMaxPerTurn`, one ephemeral `gateway.notice` with
 * `backpressure: "deltas_dropped"` is emitted and further deltas for
 * that turn are dropped until the task's next durable event
 * (`flushTask`). A dropped delta shows up client-side as a
 * `deltaOffset` gap; the durable `assistant.message` stays truth.
 */

import type { Envelope } from "@codex-sidepanel/shared";

export interface DeltaCoalescerOptions {
  flushMs: number;
  coalesceWindowMs: number;
  maxCharsPerTurn: number;
  /** deliver a flushed (or notice) envelope to the broadcast layer */
  emit: (envelope: Envelope) => void;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

interface BufferEntry {
  taskId: string;
  turnId: string;
  type: string;
  text: string;
  /** deltaOffset of the FIRST buffered chunk — offset is cumulative */
  deltaOffset: number;
  firstPushAt: number;
  lastPushAt: number;
  timer: NodeJS.Timeout;
}

const DELTA_TYPES = new Set(["assistant.delta", "reasoning.delta"]);

export class DeltaCoalescer {
  private readonly opts: DeltaCoalescerOptions;
  private readonly now: () => number;
  private readonly buffers = new Map<string, BufferEntry>();
  /** turns that already emitted deltas_dropped — notice once per turn */
  private readonly droppedTurns = new Set<string>();

  constructor(opts: DeltaCoalescerOptions) {
    this.opts = opts;
    this.now = opts.now ?? (() => Date.now());
  }

  static isDelta(envelope: Envelope): boolean {
    const e = envelope as { reliability?: string; type?: string };
    return e.reliability === "ephemeral" && typeof e.type === "string" && DELTA_TYPES.has(e.type);
  }

  /** Buffer an ephemeral delta envelope. Returns false when dropped. */
  push(envelope: Envelope): boolean {
    const e = envelope as {
      taskId?: string;
      turnId?: string;
      type?: string;
      text?: string;
      deltaOffset?: number;
    };
    if (!e.taskId || !e.turnId || !e.type || typeof e.text !== "string") return false;

    const turnKey = `${e.taskId}${e.turnId}`;
    if (this.droppedTurns.has(turnKey)) return false;

    const key = `${turnKey}${e.type}`;
    const bufferedForTurn = this.#turnChars(e.taskId, e.turnId);
    if (bufferedForTurn + e.text.length > this.opts.maxCharsPerTurn) {
      this.droppedTurns.add(turnKey);
      this.#emitNotice(e.taskId, e.turnId);
      return false;
    }

    const now = this.now();
    const existing = this.buffers.get(key);
    if (existing) {
      existing.text += e.text;
      existing.lastPushAt = now;
      this.#reschedule(key, existing);
      return true;
    }

    const timer = this.#schedule(() => this.#flushKey(key), this.opts.coalesceWindowMs);
    this.buffers.set(key, {
      taskId: e.taskId,
      turnId: e.turnId,
      type: e.type,
      text: e.text,
      deltaOffset: typeof e.deltaOffset === "number" ? e.deltaOffset : 0,
      firstPushAt: now,
      lastPushAt: now,
      timer,
    });
    return true;
  }

  /** Flush all buffered deltas for a task — call before broadcasting a
   *  durable event so ordering stays causal, and on turn terminal. */
  flushTask(taskId: string): void {
    const prefix = `${taskId}`;
    for (const [key, entry] of [...this.buffers]) {
      if (entry.taskId === taskId) this.#flushKey(key);
    }
    for (const turnKey of [...this.droppedTurns]) {
      if (turnKey.startsWith(prefix)) this.droppedTurns.delete(turnKey);
    }
  }

  flushAll(): void {
    for (const key of [...this.buffers.keys()]) this.#flushKey(key);
  }

  dispose(): void {
    this.flushAll();
    this.buffers.clear();
    this.droppedTurns.clear();
  }

  #turnChars(taskId: string, turnId: string): number {
    let n = 0;
    const prefix = `${taskId}${turnId}`;
    for (const [key, entry] of this.buffers) {
      if (key.startsWith(prefix)) n += entry.text.length;
    }
    return n;
  }

  /** Recompute the flush deadline: silence window vs hard cap. */
  #reschedule(key: string, entry: BufferEntry): void {
    const silenceDeadline = entry.lastPushAt + this.opts.coalesceWindowMs;
    const capDeadline = entry.firstPushAt + this.opts.flushMs;
    const delay = Math.max(0, Math.min(silenceDeadline, capDeadline) - this.now());
    (this.opts.clearTimeoutFn ?? clearTimeout)(entry.timer);
    entry.timer = this.#schedule(() => this.#flushKey(key), delay);
  }

  #schedule(fn: () => void, ms: number): NodeJS.Timeout {
    const t = (this.opts.setTimeoutFn ?? setTimeout)(fn, ms);
    t.unref?.();
    return t;
  }

  #flushKey(key: string): void {
    const entry = this.buffers.get(key);
    if (!entry) return;
    this.buffers.delete(key);
    (this.opts.clearTimeoutFn ?? clearTimeout)(entry.timer);
    if (!entry.text) return;
    this.opts.emit({
      v: 1,
      kind: "event",
      reliability: "ephemeral",
      taskId: entry.taskId,
      turnId: entry.turnId,
      type: entry.type,
      deltaOffset: entry.deltaOffset,
      text: entry.text,
      ts: this.now(),
    } as Envelope);
  }

  #emitNotice(taskId: string, turnId: string): void {
    this.opts.emit({
      v: 1,
      kind: "event",
      reliability: "ephemeral",
      taskId,
      turnId,
      type: "gateway.notice",
      level: "warn",
      message: "delta buffer exceeded; dropping deltas for this turn",
      backpressure: "deltas_dropped",
      ts: this.now(),
    } as unknown as Envelope);
  }
}
