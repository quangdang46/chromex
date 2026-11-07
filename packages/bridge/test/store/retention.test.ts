import { describe, expect, it } from "vitest";

import {
  approvalPrunable,
  artifactExpired,
  ARTIFACT_TTL_MS,
  APPROVAL_POST_TERMINAL_MS,
  MAX_EVENTS_PER_TASK,
  planCapPrune,
  planEventPrune,
  PROTECTED_TASK_EVENT_TYPES,
} from "../../src/store/retention.js";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("retention policy (P1-11 / §5.5)", () => {
  it("never prunes protected types even with snapshot coverage", () => {
    const events = [
      { seq: 1, type: "user.message.created" },
      { seq: 2, type: "assistant.message" },
      { seq: 3, type: "tool.completed" },
      { seq: 4, type: "permission.resolved" },
      { seq: 5, type: "provider.notice" }, // unprotected milestone
    ];
    const plan = planEventPrune(events, 10);
    expect(plan.deleteSeqs).toEqual([5]);
    for (const t of PROTECTED_TASK_EVENT_TYPES) expect(PROTECTED_TASK_EVENT_TYPES.has(t)).toBe(true);
  });

  it("prunes nothing without a snapshot checkpoint", () => {
    const events = [{ seq: 1, type: "provider.notice" }];
    expect(planEventPrune(events, 0).deleteSeqs).toEqual([]);
  });

  it("unprotected milestones prunable once checkpoint covers them (alive or terminal — caller gates)", () => {
    const events = [{ seq: 1, type: "provider.notice" }];
    expect(planEventPrune(events, 5).deleteSeqs).toEqual([1]);
  });

  it("never deletes events past the snapshot checkpoint", () => {
    const events = [
      { seq: 3, type: "provider.notice" },
      { seq: 7, type: "provider.notice" }, // past checkpoint=5
    ];
    expect(planEventPrune(events, 5).deleteSeqs).toEqual([3]);
  });

  it("cap prune removes only unprotected overflow", () => {
    const events = Array.from({ length: MAX_EVENTS_PER_TASK + 10 }, (_, i) => ({
      seq: i + 1,
      type: i % 2 === 0 ? "provider.notice" : "assistant.message",
    }));
    const del = planCapPrune(events);
    expect(del.length).toBe(10);
    expect(del.every((s) => events[s - 1].type === "provider.notice")).toBe(true);
  });

  it("approvals: pending never pruned; resolved pruned only after terminal+7d", () => {
    const base = { resolvedAt: NOW - 30 * DAY, taskTerminalAt: NOW - 30 * DAY, now: NOW };
    expect(approvalPrunable({ ...base, status: "pending" })).toBe(false);
    expect(approvalPrunable({ ...base, status: "allowed" })).toBe(true);
    // terminal only 3d ago → keep
    expect(
      approvalPrunable({ status: "denied", resolvedAt: NOW - 3 * DAY, taskTerminalAt: NOW - 3 * DAY, now: NOW }),
    ).toBe(false);
    expect(APPROVAL_POST_TERMINAL_MS).toBe(7 * DAY);
  });

  it("artifact TTL counts from terminal/release only — active never expires", () => {
    const old = NOW - ARTIFACT_TTL_MS - DAY;
    expect(artifactExpired({ taskTerminalAt: null, releasedAt: null, createdAt: old, now: NOW })).toBe(false);
    expect(artifactExpired({ taskTerminalAt: NOW - ARTIFACT_TTL_MS - 1, releasedAt: null, createdAt: old, now: NOW })).toBe(true);
    expect(artifactExpired({ taskTerminalAt: NOW - 1000, releasedAt: NOW - ARTIFACT_TTL_MS - 1, createdAt: old, now: NOW })).toBe(true);
    // terminal recently → not yet
    expect(artifactExpired({ taskTerminalAt: NOW - DAY, releasedAt: null, createdAt: old, now: NOW })).toBe(false);
  });
});
