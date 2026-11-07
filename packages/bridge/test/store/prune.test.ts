import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { openGatewayDb } from "../../src/store/db.js";
import { SQLiteStore } from "../../src/store/sqlite-store.js";
import { InMemoryStore } from "../../src/gateway/store-memory.js";
import { runPruneSweep, type PruneStore } from "../../src/gateway/prune.js";
import { PROTECTED_TASK_EVENT_TYPES } from "../../src/store/retention.js";
import type { TaskRecord, TurnRecord, DurableTaskEvent } from "@codex-sidepanel/shared";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "chromex-prune-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

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
    status: "completed",
    clientMessageId: `cm-${id}`,
    createdAt: now,
    startedAt: now,
    endedAt: now,
  } as TurnRecord;
}

const userMsg: DurableTaskEvent = {
  type: "user.message.created",
  turnId: "g1",
  clientMessageId: "cm-g1",
  message: {
    gatewayTurnId: "g1",
    clientMessageId: "cm-g1",
    content: [{ type: "text", text: "hello" }],
  },
} as DurableTaskEvent;

const assistantMsg: DurableTaskEvent = {
  type: "assistant.message",
  turnId: "g1",
  text: "hi there",
} as DurableTaskEvent;

// unprotected per §5.5 — usage/provider.notice are the prunable volume
const usageEvent: DurableTaskEvent = {
  type: "usage",
  turnId: "g1",
  usage: { inputTokens: 1, outputTokens: 1 },
} as unknown as DurableTaskEvent;

async function sqliteStore(): Promise<{ store: SQLiteStore; close: () => void }> {
  const db = await openGatewayDb(dir);
  return { store: new SQLiteStore(db), close: () => db.close() };
}

function seed(store: PruneStore, taskId = "t1"): void {
  store.createTask(makeTask(taskId));
  store.upsertTurn(makeTurn("g1", taskId));
  store.appendTaskEvent(taskId, userMsg);
  store.appendTaskEvent(taskId, usageEvent);
  store.appendTaskEvent(taskId, assistantMsg);
}

describe.each([
  ["sqlite", async () => (await sqliteStore()).store],
  ["memory", async () => new InMemoryStore() as unknown as PruneStore],
])("prune sweep — %s", (_name, make) => {
  test("snapshot contains user/assistant/tool/permission; unprotected events pruned only after checkpoint", async () => {
    const store = (await make()) as PruneStore;
    seed(store, "t1");

    // add tool + permission events
    store.appendTaskEvent("t1", {
      type: "tool.started",
      turnId: "g1",
      toolCallId: "tc1",
      tool: "browser.page.click",
      source: "browser",
    } as DurableTaskEvent);
    store.appendTaskEvent("t1", {
      type: "tool.completed",
      turnId: "g1",
      toolCallId: "tc1",
      tool: "browser.page.click",
      outcome: "succeeded",
    } as DurableTaskEvent);
    store.appendTaskEvent("t1", {
      type: "permission.requested",
      turnId: "g1",
      request: { requestId: "r1", taskId: "t1", kind: "provider_permission", risk: "low", summary: "q", actionDigest: "", details: { tool: "t", argsPreview: {}, origin: "provider" }, options: [] },
    } as DurableTaskEvent);

    const snap = store.buildTaskSnapshot("t1");
    expect(snap).not.toBeNull();
    const s = snap as { userMessages: unknown[]; assistantMessages: { text: string }[]; toolCalls: { outcome: string }[]; permissions: unknown[] };
    expect(s.userMessages).toHaveLength(1);
    expect(s.assistantMessages[0]!.text).toBe("hi there");
    expect(s.toolCalls).toHaveLength(1);
    expect(s.toolCalls[0]!.outcome).toBe("succeeded");
    expect(s.permissions).toHaveLength(1);

    const before = store.allTaskEvents!("t1").length; // 3 seeded + 4 added = 7
    const res = runPruneSweep(store);
    expect(res.checkpointsWritten).toBe(1);
    const after = store.allTaskEvents!("t1");
    // protected events survive; unprotected (task.status_changed) gone
    const types = after.map((e) => e.type);
    expect(types).not.toContain("usage");
    expect(types).toContain("user.message.created");
    expect(types).toContain("assistant.message");
    expect(types).toContain("tool.completed");
    expect(types).toContain("permission.requested");
    expect(after.length).toBeLessThan(before);
    expect(res.milestones).toContain("t1");

    // checkpoint serves the pruned range — snapshot still complete
    const cp = store.getTaskSnapshotCheckpoint!("t1");
    expect(cp).not.toBeNull();
    expect((cp!.snapshot as typeof snap).userMessages).toHaveLength(1);

    // idempotent: second sweep deletes nothing new
    const res2 = runPruneSweep(store);
    expect(res2.eventsDeleted).toBe(0);

    // CRITICAL: post-prune snapshot must still contain the deleted
    // range — merged from checkpoint + retained events.
    const snapAfter = store.buildTaskSnapshot("t1") as {
      userMessages: unknown[];
      assistantMessages: { text: string }[];
      permissions: unknown[];
    };
    expect(snapAfter.userMessages).toHaveLength(1);
    expect(snapAfter.assistantMessages[0]!.text).toBe("hi there");
    expect(snapAfter.permissions).toHaveLength(1);
  });

  test("no checkpoint capability → nothing deleted", async () => {
    const store = (await make()) as PruneStore;
    seed(store, "t1");
    const crippled = {
      ...store,
      putTaskSnapshotCheckpoint: undefined,
      deleteTaskEvents: undefined,
    } as unknown as PruneStore;
    // deleteTaskEvents missing → sweep bails entirely
    const res = runPruneSweep(crippled);
    expect(res.eventsDeleted).toBe(0);
    expect(store.allTaskEvents!("t1")).toHaveLength(3);
  });
});

test("PROTECTED_TASK_EVENT_TYPES covers the §5.5 never-prune set", () => {
  for (const t of [
    "user.message.created",
    "assistant.message",
    "tool.started",
    "tool.completed",
    "permission.requested",
    "permission.resolved",
  ]) {
    expect(PROTECTED_TASK_EVENT_TYPES.has(t)).toBe(true);
  }
});
