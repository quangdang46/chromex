/**
 * S8 deliverable-evidence tests — what survives snapshot rebuild and
 * event-log pruning:
 *  - tool.completed `output` lands in TaskSnapshotToolCall.outputSummary
 *    (bounded ~4KB) instead of being dropped
 *  - turn.diff.updated keeps the latest diff per turn in the snapshot
 *  - browser.tool.* events persist source:"browser" + verified honestly
 *  - appendTaskEvent enforces MAX_EVENT_PAYLOAD_BYTES on oversized input
 */

import { describe, expect, test } from "vitest";

import { MAX_EVENT_PAYLOAD_BYTES } from "@codex-sidepanel/shared";
import type { DurableTaskEvent, TaskRecord, TurnRecord } from "@codex-sidepanel/shared";

import { InMemoryStore } from "../../src/gateway/store-memory.js";
import { boundTaskEventPayload } from "../../src/store/event-payload.js";

function makeTask(id: string): TaskRecord {
  const now = Date.now();
  return {
    taskId: id,
    createdAt: now,
    updatedAt: now,
    status: "active",
    profileId: "p1",
    providerId: "codex",
    conversationKey: `conv-${id}`,
    cwd: "/tmp",
    backend: { backendId: "chrome-extension", pinnedBy: "default" },
    tabIntent: { scope: "untitled" },
    binding: { browserInstanceId: null, state: "none" },
    lastSeq: 0,
    lastReadSeq: 0,
  } as TaskRecord;
}

function makeTurn(id: string, taskId: string): TurnRecord {
  const now = Date.now();
  return {
    turnId: id,
    taskId,
    status: "running",
    clientMessageId: `cm-${id}`,
    createdAt: now,
    startedAt: now,
  } as TurnRecord;
}

function setup() {
  const store = new InMemoryStore();
  store.createTask(makeTask("t1"));
  store.putTurn(makeTurn("g1", "t1"));
  return store;
}

describe("snapshot evidence (S8)", () => {
  test("tool.completed output → bounded outputSummary in snapshot", () => {
    const store = setup();
    store.appendTaskEvent("t1", {
      type: "tool.started",
      turnId: "g1",
      toolCallId: "tc-1",
      tool: "commandExecution",
      source: "provider",
      input: { command: "npm test" },
    } as DurableTaskEvent);
    const bigOutput = "x".repeat(10 * 1024);
    store.appendTaskEvent("t1", {
      type: "tool.completed",
      turnId: "g1",
      toolCallId: "tc-1",
      tool: "commandExecution",
      outcome: "succeeded",
      output: { aggregatedOutput: bigOutput, exitCode: 0 },
    } as DurableTaskEvent);

    const snap = store.buildTaskSnapshot("t1");
    expect(snap?.storage.kind).toBe("inline");
    if (snap?.storage.kind !== "inline") return;
    const call = snap.toolCalls.find((c) => c.toolCallId === "tc-1");
    expect(call?.outcome).toBe("succeeded");
    expect(call?.source).toBe("provider");
    const summary = call?.outputSummary as { truncated?: boolean; bytes?: number };
    expect(summary.truncated).toBe(true);
    expect(summary.bytes).toBeGreaterThan(4096);
  });

  test("small tool output stays verbatim in outputSummary", () => {
    const store = setup();
    store.appendTaskEvent("t1", {
      type: "tool.completed",
      turnId: "g1",
      toolCallId: "tc-2",
      tool: "commandExecution",
      outcome: "failed",
      output: { exitCode: 1, aggregatedOutput: "boom" },
    } as DurableTaskEvent);
    const snap = store.buildTaskSnapshot("t1");
    if (snap?.storage.kind !== "inline") throw new Error("expected inline");
    const call = snap.toolCalls.find((c) => c.toolCallId === "tc-2");
    expect(call?.outputSummary).toEqual({ exitCode: 1, aggregatedOutput: "boom" });
  });

  test("turn.diff.updated keeps latest diff per turn in snapshot", () => {
    const store = setup();
    store.appendTaskEvent("t1", {
      type: "turn.diff.updated",
      turnId: "g1",
      diff: "diff v1",
    } as DurableTaskEvent);
    store.appendTaskEvent("t1", {
      type: "turn.diff.updated",
      turnId: "g1",
      diff: "diff v2-final",
    } as DurableTaskEvent);
    store.appendTaskEvent("t1", {
      type: "turn.diff.updated",
      turnId: "g2",
      diff: "other turn",
    } as DurableTaskEvent);
    const snap = store.buildTaskSnapshot("t1");
    if (snap?.storage.kind !== "inline") throw new Error("expected inline");
    expect(snap.turnDiffs).toEqual([
      { turnId: "g1", diff: "diff v2-final" },
      { turnId: "g2", diff: "other turn" },
    ]);
  });

  test("browser tool.started/completed keep source:browser + verified", () => {
    const store = setup();
    store.appendTaskEvent("t1", {
      type: "tool.started",
      turnId: "g1",
      toolCallId: "bt-1",
      tool: "browser.page.click",
      source: "browser",
      input: { selector: "#go" },
    } as DurableTaskEvent);
    store.appendTaskEvent("t1", {
      type: "tool.completed",
      turnId: "g1",
      toolCallId: "bt-1",
      tool: "browser.page.click",
      source: "browser",
      outcome: "succeeded",
      output: { result: { clicked: true } },
      verified: true,
    } as DurableTaskEvent);
    const snap = store.buildTaskSnapshot("t1");
    if (snap?.storage.kind !== "inline") throw new Error("expected inline");
    const call = snap.toolCalls.find((c) => c.toolCallId === "bt-1");
    expect(call?.source).toBe("browser");
    expect(call?.verified).toBe(true);
    expect(call?.outcome).toBe("succeeded");
  });
});

describe("appendTaskEvent payload bound (S8)", () => {
  test("oversized event payload is truncated under MAX_EVENT_PAYLOAD_BYTES", () => {
    const store = setup();
    const huge = "y".repeat(MAX_EVENT_PAYLOAD_BYTES + 1000);
    const env = store.appendTaskEvent("t1", {
      type: "tool.completed",
      turnId: "g1",
      toolCallId: "big-1",
      tool: "commandExecution",
      outcome: "succeeded",
      output: { aggregatedOutput: huge },
    } as DurableTaskEvent);
    const persisted = JSON.stringify(env.payload);
    expect(Buffer.byteLength(persisted, "utf8")).toBeLessThanOrEqual(MAX_EVENT_PAYLOAD_BYTES);
    expect(persisted).toContain("[truncated]");
    // replay path returns the same bounded payload
    const replayed = store.taskEventsAfter("t1", 0).events.at(-1);
    expect(Buffer.byteLength(JSON.stringify(replayed?.payload), "utf8")).toBeLessThanOrEqual(
      MAX_EVENT_PAYLOAD_BYTES,
    );
  });

  test("boundTaskEventPayload returns small events untouched (same ref)", () => {
    const event = {
      type: "turn.completed",
      turnId: "g1",
    } as DurableTaskEvent;
    expect(boundTaskEventPayload(event)).toBe(event);
  });
});
