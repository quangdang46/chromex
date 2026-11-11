import { describe, expect, test } from "vitest";
import { GatewayDiagnostics } from "../src/gateway/diagnostics.js";

const storeView = {
  listTasks: () => [{ taskId: "t1" }],
  lastTaskSeq: () => 7,
  lastGatewaySeq: () => 42,
};

const snap = (d: GatewayDiagnostics) =>
  d.snapshot({ store: storeView, lifetime: { held: true }, endpoint: null });

describe("GatewayDiagnostics.turns", () => {
  test("recordTurnTerminal aggregates count/byStatus/durationMs", () => {
    const d = new GatewayDiagnostics();
    d.recordTurnTerminal({ status: "completed", durationMs: 1200 });
    d.recordTurnTerminal({ status: "completed", durationMs: 3400 });
    d.recordTurnTerminal({ status: "failed", durationMs: 200 });
    d.recordTurnTerminal({ status: "completed", durationMs: Number.NaN });

    const s = snap(d);
    expect(s.turns.total).toBe(4);
    expect(s.turns.byStatus).toEqual({ completed: 3, failed: 1 });
    // NaN duration is counted in total/byStatus but not in durationMs
    expect(s.turns.durationMs.count).toBe(3);
    expect(s.turns.durationMs.total).toBe(4800);
    expect(s.turns.durationMs.max).toBe(3400);
    expect(s.turns.durationMs.last).toBe(200);
  });

  test("turns block is present and zeroed on a fresh diagnostics", () => {
    const s = snap(new GatewayDiagnostics());
    expect(s.turns).toEqual({
      total: 0,
      byStatus: {},
      durationMs: { count: 0, total: 0, max: 0, last: null },
    });
  });
});
