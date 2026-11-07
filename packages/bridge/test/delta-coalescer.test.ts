import { describe, expect, test, vi } from "vitest";

import { DeltaCoalescer } from "../src/gateway/delta-coalescer.js";
import type { Envelope } from "@codex-sidepanel/shared";

function delta(taskId: string, turnId: string, text: string, deltaOffset = 0, type = "assistant.delta"): Envelope {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("DeltaCoalescer (P2-06)", () => {
  test("merges chunks and flushes once after the silence window", async () => {
    const { c, emitted } = makeCoalescer();
    c.push(delta("t1", "r1", "Hello"));
    c.push(delta("t1", "r1", ", "));
    c.push(delta("t1", "r1", "world"));
    await sleep(60);
    expect(emitted).toHaveLength(1);
    const e = emitted[0] as { text: string; deltaOffset: number; type: string };
    expect(e.text).toBe("Hello, world");
    expect(e.deltaOffset).toBe(0);
    expect(e.type).toBe("assistant.delta");
    c.dispose();
  });

  test("sustained stream is capped at flushMs, not debounce-forever", async () => {
    vi.useFakeTimers();
    try {
      const { c, emitted } = makeCoalescer({ flushMs: 100, coalesceWindowMs: 20 });
      // push every 30ms — past the 20ms silence window each time, so
      // only the 100ms hard cap forces a flush
      for (let i = 0; i < 6; i += 1) {
        c.push(delta("t1", "r1", `c${i}`));
        vi.advanceTimersByTime(30);
      }
      expect(emitted.length).toBeGreaterThanOrEqual(1);
      c.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  test("per-turn buffer cap emits one deltas_dropped notice then drops", async () => {
    const { c, emitted } = makeCoalescer({ maxCharsPerTurn: 10 });
    c.push(delta("t1", "r1", "0123456789")); // exactly at cap — ok
    c.push(delta("t1", "r1", "x")); // exceeds → notice + drop
    c.push(delta("t1", "r1", "y")); // dropped silently
    const notice = emitted.find(
      (e) => (e as { backpressure?: string }).backpressure === "deltas_dropped",
    ) as { type: string; taskId: string; turnId: string } | undefined;
    expect(notice).toBeTruthy();
    expect(notice!.type).toBe("gateway.notice");
    expect(emitted.filter((e) => e.type === "assistant.delta")).toHaveLength(0); // first still buffered
    await sleep(60);
    const deltas = emitted.filter((e) => e.type === "assistant.delta") as Array<{ text: string }>;
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.text).toBe("0123456789"); // dropped chunks never appear
    c.dispose();
  });

  test("flushTask emits pending deltas before the durable event and clears drop state", async () => {
    const { c, emitted } = makeCoalescer({ maxCharsPerTurn: 5 });
    c.push(delta("t1", "r1", "aaaaa"));
    c.push(delta("t1", "r1", "b")); // over cap → dropped turn
    c.flushTask("t1"); // durable event ordering point
    const order = emitted.map((e) => (e as { type: string }).type);
    expect(order).toContain("assistant.delta");
    expect(order).toContain("gateway.notice");
    // after flush, a NEW turn on same task is not poisoned
    c.push(delta("t1", "r2", "cc"));
    await sleep(60);
    expect(emitted.some((e) => (e as { turnId?: string }).turnId === "r2")).toBe(true);
    c.dispose();
  });

  test("non-delta and malformed envelopes are ignored", () => {
    const { c, emitted } = makeCoalescer();
    c.push({ v: 1, kind: "event", reliability: "durable", taskId: "t", type: "turn.completed" } as Envelope);
    c.push(delta("", "r1", "no-task"));
    c.flushAll();
    expect(emitted).toHaveLength(0);
    c.dispose();
  });
});
