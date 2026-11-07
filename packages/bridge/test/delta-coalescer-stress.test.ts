import { describe, expect, test, vi } from "vitest";

import { DeltaCoalescer } from "../src/gateway/delta-coalescer.js";
import type { Envelope } from "@codex-sidepanel/shared";

function delta(
  taskId: string,
  turnId: string,
  text: string,
  deltaOffset = 0,
  type = "assistant.delta",
): Envelope {
  return {
    v: 1,
    kind: "event",
    reliability: "ephemeral",
    taskId,
    turnId,
    type,
    deltaOffset,
    text,
    ts: 0,
  } as Envelope;
}

function makeCoalescer(over: Partial<ConstructorParameters<typeof DeltaCoalescer>[0]> = {}) {
  const emitted: Envelope[] = [];
  const c = new DeltaCoalescer({
    flushMs: 100,
    coalesceWindowMs: 20,
    maxCharsPerTurn: 1000,
    emit: (e) => emitted.push(e),
    ...over,
  });
  return { c, emitted };
}

const types = (emitted: Envelope[]) => emitted.map((e) => (e as { type: string }).type);
const turnKey = (e: Envelope) => `${(e as { taskId?: string }).taskId}/${(e as { turnId?: string }).turnId}`;

describe("DeltaCoalescer stress invariants", () => {
  test("burst across turns and tasks stays isolated per turnId", () => {
    const { c, emitted } = makeCoalescer();
    // Interleave same task/different turns and different task/same turnId.
    // turnKey includes taskId, so t1/r1 and t2/r1 must never merge.
    c.push(delta("t1", "r1", "a1"));
    c.push(delta("t2", "r1", "b1"));
    c.push(delta("t1", "r2", "a2"));
    c.push(delta("t1", "r1", "a1b"));
    c.push(delta("t2", "r1", "b1b"));
    c.push(delta("t1", "r2", "a2b"));
    c.flushAll();

    expect(emitted).toHaveLength(3);
    const byTurn = new Map(emitted.map((e) => [turnKey(e), e as { text: string; deltaOffset: number }]));
    expect(byTurn.get("t1/r1")!.text).toBe("a1a1b");
    expect(byTurn.get("t2/r1")!.text).toBe("b1b1b");
    expect(byTurn.get("t1/r2")!.text).toBe("a2a2b");
    // every emitted envelope reports its own task/turn, nothing cross-contaminated
    for (const e of emitted) {
      expect(["t1/r1", "t2/r1", "t1/r2"]).toContain(turnKey(e));
    }
    c.dispose();
  });

  test("assistant.delta and reasoning.delta share the per-turn budget", () => {
    const { c, emitted } = makeCoalescer({ maxCharsPerTurn: 10 });
    expect(c.push(delta("t1", "r1", "01234", 0, "assistant.delta"))).toBe(true);
    expect(c.push(delta("t1", "r1", "5678", 5, "reasoning.delta"))).toBe(true); // 9 chars total
    const notices = () =>
      emitted.filter((e) => (e as { backpressure?: string }).backpressure === "deltas_dropped");
    expect(c.push(delta("t1", "r1", "xy", 9, "assistant.delta"))).toBe(false); // 9+2 exceeds 10
    expect(notices()).toHaveLength(1);
    // many more pushes — still exactly one notice for this turn
    for (let i = 0; i < 20; i += 1) c.push(delta("t1", "r1", "dropme", i, "reasoning.delta"));
    expect(notices()).toHaveLength(1);
    expect(c.push(delta("t1", "r1", "still dropped", 0, "assistant.delta"))).toBe(false);
    expect(notices()).toHaveLength(1);
    // a different turn on the same task is unaffected and can still push
    expect(c.push(delta("t1", "r2", "ok", 0))).toBe(true);
    c.dispose();
  });

  test("char budget exhaustion emits exactly one deltas_dropped notice per turn", () => {
    const { c, emitted } = makeCoalescer({ maxCharsPerTurn: 4 });
    const notices = () =>
      emitted.filter((e) => (e as { backpressure?: string }).backpressure === "deltas_dropped");
    // turn r1: first push fits exactly, everything after is dropped
    c.push(delta("t1", "r1", "aaaa"));
    for (let i = 0; i < 10; i += 1) {
      expect(c.push(delta("t1", "r1", "b", i))).toBe(false);
    }
    // turn r2 on the same task gets its own independent budget + notice
    c.push(delta("t1", "r2", "cc"));
    c.push(delta("t1", "r2", "ddd"));
    // turn on another task is independent too — stays under its own budget
    c.push(delta("t2", "r1", "zz"));

    const n = notices();
    expect(n).toHaveLength(2);
    const noticeTurns = n.map(turnKey).sort();
    expect(noticeTurns).toEqual(["t1/r1", "t1/r2"]);
    for (const e of n) {
      expect((e as { type: string }).type).toBe("gateway.notice");
      expect((e as { level?: string }).level).toBe("warn");
      expect((e as { taskId?: string }).taskId).toBeTruthy();
    }
    c.dispose();
  });

  test("notice is emitted immediately while the accepted buffer stays pending", () => {
    const { c, emitted } = makeCoalescer({ maxCharsPerTurn: 3 });
    c.push(delta("t1", "r1", "abc"));
    c.push(delta("t1", "r1", "d")); // over → notice now, buffer not yet flushed
    const idxNotice = emitted.findIndex(
      (e) => (e as { backpressure?: string }).backpressure === "deltas_dropped",
    );
    expect(idxNotice).toBe(0);
    expect(emitted.filter((e) => (e as { type: string }).type === "assistant.delta")).toHaveLength(0);
    c.flushTask("t1");
    const idxDelta = emitted.findIndex((e) => (e as { type: string }).type === "assistant.delta");
    expect(idxDelta).toBeGreaterThan(idxNotice); // notice precedes the surviving delta
    expect((emitted[idxDelta] as { text: string }).text).toBe("abc");
    c.dispose();
  });

  test("flushTask emits pending deltas before durable events in causal order", () => {
    const { c, emitted } = makeCoalescer();
    c.push(delta("t1", "r1", "part1-"));
    c.push(delta("t1", "r1", "part2", 6));
    c.push(delta("t2", "r9", "other-task", 0));

    // durable event for t1 lands after flushTask — deltas must precede it
    c.flushTask("t1");
    const durable: Envelope = {
      v: 1,
      kind: "event",
      reliability: "durable",
      taskId: "t1",
      type: "assistant.message",
      text: "part1-part2",
      ts: 0,
    } as Envelope;
    emitted.push(durable);

    const t1DeltaIdx = emitted
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => turnKey(e) === "t1/r1" && (e as { type: string }).type === "assistant.delta")
      .map(({ i }) => i);
    expect(t1DeltaIdx).toHaveLength(1);
    expect(t1DeltaIdx[0]).toBeLessThan(emitted.indexOf(durable));
    // t2's delta is untouched by t1's flushTask — still buffered, not yet emitted
    expect(emitted.some((e) => turnKey(e) === "t2/r9")).toBe(false);
    c.flushAll();
    expect(emitted.some((e) => turnKey(e) === "t2/r9")).toBe(true);
    c.dispose();
  });

  test("flushTask flushes every buffered type for the task in push order", () => {
    const { c, emitted } = makeCoalescer();
    c.push(delta("t1", "r1", "reason", 0, "reasoning.delta"));
    c.push(delta("t1", "r1", "answer", 6, "assistant.delta"));
    c.flushTask("t1");
    expect(types(emitted)).toEqual(["reasoning.delta", "assistant.delta"]);
    // each type keeps its own first-chunk deltaOffset
    expect((emitted[0] as { deltaOffset: number }).deltaOffset).toBe(0);
    expect((emitted[1] as { deltaOffset: number }).deltaOffset).toBe(6);
    c.dispose();
  });

  test("interleaved push/flushTask/dispose preserves causal order", () => {
    const { c, emitted } = makeCoalescer();
    c.push(delta("t1", "r1", "a1"));
    c.push(delta("t2", "r1", "b1"));
    c.flushTask("t1"); // emits a1 only
    expect(types(emitted)).toEqual(["assistant.delta"]);
    expect(turnKey(emitted[0]!)).toBe("t1/r1");

    // deltas pushed after the flush start a fresh buffer for the same turn;
    // t2 was never flushed so its buffer still holds b1 and merges b2 into it
    c.push(delta("t1", "r1", "a2"));
    c.push(delta("t2", "r1", "b2"));
    c.flushTask("t2");
    c.dispose(); // flushAll → remaining emitted before dispose returns

    const seq = emitted.map((e) => `${turnKey(e)}:${(e as { text: string }).text}`);
    expect(seq).toEqual(["t1/r1:a1", "t2/r1:b1b2", "t1/r1:a2"]);
    // every emitted delta is a prefix-consistent slice; offsets stay monotonic per turn
    const t1Offsets = emitted
      .filter((e) => turnKey(e) === "t1/r1")
      .map((e) => (e as { deltaOffset: number }).deltaOffset);
    expect(t1Offsets).toEqual([0, 0]); // both batches start at offset 0 in this fixture
  });

  test("dispose flushes all pending buffers exactly once", () => {
    const { c, emitted } = makeCoalescer();
    c.push(delta("t1", "r1", "x"));
    c.push(delta("t1", "r2", "y"));
    c.push(delta("t2", "r1", "z"));
    c.dispose();
    expect(emitted).toHaveLength(3);
    c.dispose(); // idempotent — no double emit
    expect(emitted).toHaveLength(3);
  });

  test("deltaOffset of the first buffered chunk survives coalescing; later offsets ignored", () => {
    const { c, emitted } = makeCoalescer();
    // offsets 0, 5, 12 arrive as chunks merge into one envelope
    c.push(delta("t1", "r1", "aaaaa", 0));
    c.push(delta("t1", "r1", "bbbbb", 5));
    c.push(delta("t1", "r1", "ccccc", 10));
    c.flushAll();
    expect(emitted).toHaveLength(1);
    const e = emitted[0] as { deltaOffset: number; text: string };
    expect(e.deltaOffset).toBe(0);
    expect(e.text).toBe("aaaaabbbbbccccc");

    // after a flush, the next buffer starts a new monotonic segment
    c.push(delta("t1", "r1", "ddddd", 15));
    c.push(delta("t1", "r1", "eeeee", 20));
    c.flushAll();
    expect(emitted).toHaveLength(2);
    expect((emitted[1] as { deltaOffset: number }).deltaOffset).toBe(15);
    expect((emitted[1] as { text: string }).text).toBe("dddddeeeee");
    c.dispose();
  });

  test("deltaOffset stays monotonic across a timer flush boundary", () => {
    vi.useFakeTimers();
    try {
      const { c, emitted } = makeCoalescer({ maxCharsPerTurn: 5, coalesceWindowMs: 50 });
      c.push(delta("t1", "r1", "abc", 0));
      c.push(delta("t1", "r1", "de", 3));
      vi.advanceTimersByTime(60); // silence flush
      c.push(delta("t1", "r1", "fg", 5)); // over budget? turn dropped? budget is per-turn cumulative of buffered chars — buffer empty now
      c.flushTask("t1");
      const deltas = emitted.filter(
        (e) => (e as { type: string }).type === "assistant.delta",
      ) as Array<{ deltaOffset: number; text: string }>;
      // first envelope offset 0, second starts at the offset of its first chunk
      expect(deltas[0]!.deltaOffset).toBe(0);
      expect(deltas[0]!.text).toBe("abcde");
      expect(deltas[deltas.length - 1]!.deltaOffset).toBe(5);
      c.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
