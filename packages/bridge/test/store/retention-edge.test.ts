import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { openGatewayDb } from "../../src/store/db.js";
import { SQLiteStore } from "../../src/store/sqlite-store.js";
import { InMemoryStore } from "../../src/gateway/store-memory.js";
import { SnapshotChunkStore } from "../../src/gateway/chunks.js";
import { runPruneSweep, type PruneStore } from "../../src/gateway/prune.js";
import {
  MAX_EVENTS_PER_TASK,
  planCapPrune,
  planEventPrune,
} from "../../src/store/retention.js";
import type {
  DurableTaskEvent,
  InlineTaskSnapshot,
  TaskRecord,
  TurnRecord,
} from "@codex-sidepanel/shared";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "chromex-retention-edge-"));
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

// "usage" / "provider.notice" are durable but NOT in PROTECTED_TASK_EVENT_TYPES
const usageEvent = (n: number): DurableTaskEvent =>
  ({
    type: "usage",
    turnId: "g1",
    usage: { inputTokens: n, outputTokens: n },
  }) as unknown as DurableTaskEvent;

async function sqliteStore(): Promise<{ store: SQLiteStore; close: () => void }> {
  const db = await openGatewayDb(dir);
  return { store: new SQLiteStore(db), close: () => db.close() };
}

function sha256(buf: Buffer | string): string {
  return createHash("sha256").update(buf).digest("hex");
}

// ---------- planEventPrune / planCapPrune boundary ----------

describe("retention boundary — planEventPrune", () => {
  test("unprotected event exactly AT snapshotThroughSeq is prunable; one past is not", () => {
    const events = [
      { seq: 2, type: "usage" }, // below checkpoint
      { seq: 3, type: "usage" }, // exactly at checkpoint — boundary
      { seq: 4, type: "usage" }, // past checkpoint
    ];
    const plan = planEventPrune(events, 3);
    expect(plan.deleteSeqs).toEqual([2, 3]);
    expect(plan.requiresSnapshotThroughSeq).toBe(3);
  });

  test("protected user/assistant events at the boundary seq survive", () => {
    const events = [
      { seq: 1, type: "user.message.created" },
      { seq: 2, type: "assistant.message" },
      { seq: 3, type: "usage" },
    ];
    const plan = planEventPrune(events, 3);
    expect(plan.deleteSeqs).toEqual([3]);
  });

  test("checkpoint covering only the first seq leaves later unprotected events", () => {
    const events = [
      { seq: 1, type: "provider.notice" },
      { seq: 2, type: "provider.notice" },
    ];
    expect(planEventPrune(events, 1).deleteSeqs).toEqual([1]);
  });
});

describe("retention boundary — planCapPrune", () => {
  test("exactly at maxEvents → nothing pruned; one over → oldest unprotected only", () => {
    const atCap = Array.from({ length: MAX_EVENTS_PER_TASK }, (_, i) => ({
      seq: i + 1,
      type: "usage",
    }));
    expect(planCapPrune(atCap)).toEqual([]);

    const over = [...atCap, { seq: MAX_EVENTS_PER_TASK + 1, type: "usage" }];
    const del = planCapPrune(over);
    expect(del).toEqual([1]); // only the single excess event
  });
});

// ---------- store-level prune: boundary seq + protected survival ----------

describe.each([
  ["sqlite", async () => (await sqliteStore()).store],
  ["memory", async () => new InMemoryStore() as unknown as PruneStore],
])("prune boundary — %s store", (_name, make) => {
  test("unprotected event exactly at checkpoint seq is deleted; user+assistant survive; post-prune snapshot intact", async () => {
    const store = (await make()) as PruneStore;
    store.createTask(makeTask("t1"));
    store.upsertTurn(makeTurn("g1", "t1"));

    // seq order: 1 user, 2 usage, 3 usage (boundary), 4 assistant, 5 usage
    store.appendTaskEvent("t1", userMsg);
    store.appendTaskEvent("t1", usageEvent(1));
    store.appendTaskEvent("t1", usageEvent(2));
    store.appendTaskEvent("t1", assistantMsg);
    store.appendTaskEvent("t1", usageEvent(3));

    // checkpoint covers through seq 3 — seq 3 sits exactly at the boundary
    const snap = store.buildTaskSnapshot("t1");
    expect(snap).not.toBeNull();
    store.putTaskSnapshotCheckpoint!("t1", 3, snap!);

    const res = runPruneSweep(store);
    expect(res.eventsDeleted).toBe(2); // seqs 2 and 3 (≤ checkpoint, unprotected)

    const retained = store.allTaskEvents!("t1");
    expect(retained.map((e) => e.seq)).toEqual([1, 4, 5]);
    const types = retained.map((e) => e.type);
    expect(types).toContain("user.message.created");
    expect(types).toContain("assistant.message");
    // seqs 2,3 (≤ checkpoint) pruned; seq 5 is past the checkpoint — survives
    expect(retained.filter((e) => e.type === "usage").map((e) => e.seq)).toEqual([5]);

    // milestone marks the earliest retained event (seq 1)
    expect(res.milestones).toContain("t1");

    // post-prune snapshot still carries user + assistant content
    const after = store.buildTaskSnapshot("t1") as {
      userMessages: unknown[];
      assistantMessages: { text: string }[];
    };
    expect(after.userMessages).toHaveLength(1);
    expect(after.assistantMessages[0]!.text).toBe("hi there");
  });
});

// ---------- chunked snapshot transport ----------

function inlineSnapshot(text: string): InlineTaskSnapshot {
  return {
    storage: { kind: "inline" },
    task: makeTask("t1"),
    conversation: {
      sessionKey: "conv-t1",
      provider: "codex",
      persistence: null,
      state: "open",
    },
    turns: [],
    userMessages: [],
    assistantMessages: [
      { turnId: "g1", createdAt: Date.now(), text },
    ],
    toolCalls: [],
    permissions: [],
    lastSeq: 1,
    rebuiltFrom: "event_log",
  } as InlineTaskSnapshot;
}

describe("SnapshotChunkStore — chunked transport", () => {
  test("small snapshot stays inline — no chunk allocation", () => {
    const chunks = new SnapshotChunkStore();
    const snap = chunks.put("t1", inlineSnapshot("short"));
    expect(snap.storage.kind).toBe("inline");
    expect(chunks.get("t1", "snap_missing", 0)).toBeNull();
  });

  test("multi-chunk snapshot reassembles byte-exact; per-chunk + whole sha256 verify", () => {
    const chunks = new SnapshotChunkStore();
    // >512KiB inline threshold → forced into ≥3 × 256KiB chunks
    const big = "x".repeat(600 * 1024);
    const snap = chunks.put("t1", inlineSnapshot(big));
    expect(snap.storage.kind).toBe("chunked");
    const storage = (snap as { storage: { kind: "chunked"; snapshotRef: string; chunkCount: number; totalBytes: number; snapshotSha256: string } }).storage;
    expect(storage.chunkCount).toBe(3);
    expect(storage.totalBytes).toBeGreaterThan(512 * 1024);

    // fetch + verify every chunk, reassemble
    const parts: Buffer[] = [];
    for (let i = 0; i < storage.chunkCount; i++) {
      const res = chunks.get("t1", storage.snapshotRef, i);
      expect(res).not.toBeNull();
      expect(res!.chunkCount).toBe(storage.chunkCount);
      expect(res!.snapshotSha256).toBe(storage.snapshotSha256);
      const data = Buffer.from(res!.data, "base64");
      // per-chunk integrity: sha256 field must match the payload
      expect(sha256(data)).toBe(res!.sha256);
      parts.push(data);
    }
    const merged = Buffer.concat(parts);
    expect(merged.length).toBe(storage.totalBytes);
    // whole-snapshot integrity after reassembly
    expect(sha256(merged)).toBe(storage.snapshotSha256);

    const parsed = JSON.parse(merged.toString("utf8")) as InlineTaskSnapshot;
    expect(parsed.assistantMessages[0]!.text).toHaveLength(big.length);
    expect(parsed.task.taskId).toBe("t1");
  });

  test("sha256 mismatch detection: tampered chunk and truncated reassembly both fail verification", () => {
    const chunks = new SnapshotChunkStore();
    const big = "y".repeat(600 * 1024);
    const snap = chunks.put("t1", inlineSnapshot(big));
    const storage = (snap as { storage: { kind: "chunked"; snapshotRef: string; chunkCount: number; snapshotSha256: string } }).storage;

    // tamper with chunk 1 in transit — its declared sha256 no longer matches
    const res = chunks.get("t1", storage.snapshotRef, 1)!;
    const data = Buffer.from(res.data, "base64");
    data[0] = data[0]! ^ 0xff;
    expect(sha256(data)).not.toBe(res.sha256);

    // drop the last chunk — reassembled payload fails whole-snapshot sha256
    const parts: Buffer[] = [];
    for (let i = 0; i < storage.chunkCount - 1; i++) {
      parts.push(Buffer.from(chunks.get("t1", storage.snapshotRef, i)!.data, "base64"));
    }
    expect(sha256(Buffer.concat(parts))).not.toBe(storage.snapshotSha256);
  });

  test("unknown ref, wrong taskId, and out-of-range index all return null", () => {
    const chunks = new SnapshotChunkStore();
    const snap = chunks.put("t1", inlineSnapshot("z".repeat(600 * 1024)));
    const ref = (snap as { storage: { snapshotRef: string } }).storage.snapshotRef;
    expect(chunks.get("t1", "snap_bogus", 0)).toBeNull();
    expect(chunks.get("t2", ref, 0)).toBeNull(); // ref exists but belongs to t1
    expect(chunks.get("t1", ref, 99)).toBeNull();
    expect(chunks.get("t1", ref, -1)).toBeNull();
  });
});

// ---------- seq continuity after prune + new appends ----------

describe("seq continuity after prune", () => {
  test("sqlite: appends after deleteTaskEvents continue from last_seq — no gap, no reuse; survives reopen", async () => {
    const { store, close } = await sqliteStore();
    store.createTask(makeTask("t1"));
    for (let i = 0; i < 4; i++) store.appendTaskEvent("t1", usageEvent(i));
    expect(store.lastTaskSeq("t1")).toBe(4);

    // prune seqs 1-2 (checkpoint precondition is the caller's concern here)
    store.putTaskSnapshotCheckpoint("t1", 4, store.buildTaskSnapshot("t1")!);
    expect(store.deleteTaskEvents("t1", [1, 2])).toBe(2);

    // new appends must NOT reuse pruned seqs
    const e5 = store.appendTaskEvent("t1", usageEvent(5));
    const e6 = store.appendTaskEvent("t1", usageEvent(6));
    expect(e5.seq).toBe(5);
    expect(e6.seq).toBe(6);
    expect(store.lastTaskSeq("t1")).toBe(6);

    const seqs = store.allTaskEvents("t1").map((e) => e.seq);
    expect(seqs).toEqual([3, 4, 5, 6]); // pruned head gap is expected; tail contiguous
    expect(new Set(seqs).size).toBe(seqs.length);

    // durability: seq allocation survives close/reopen
    close();
    const db2 = await openGatewayDb(dir);
    const store2 = new SQLiteStore(db2);
    const e7 = store2.appendTaskEvent("t1", usageEvent(7));
    expect(e7.seq).toBe(7);
    expect(store2.lastTaskSeq("t1")).toBe(7);
    expect(store2.allTaskEvents("t1").map((e) => e.seq)).toEqual([3, 4, 5, 6, 7]);
    db2.close();
  });

  test("memory: same no-reuse guarantee via internal seq counter", () => {
    const store = new InMemoryStore();
    store.createTask(makeTask("t1"));
    for (let i = 0; i < 4; i++) store.appendTaskEvent("t1", usageEvent(i));
    store.deleteTaskEvents("t1", [1, 2, 3, 4]);
    const e = store.appendTaskEvent("t1", usageEvent(5));
    expect(e.seq).toBe(5); // not 1 — counter survives deleteTaskEvents
    expect(store.lastTaskSeq("t1")).toBe(5);
  });
});

// ---------- concurrent/interleaved appendTaskEvent ordering ----------

describe("appendTaskEvent ordering", () => {
  test("sqlite: interleaved appends across tasks keep per-stream seq contiguous and payload order", async () => {
    const { store, close } = await sqliteStore();
    store.createTask(makeTask("a"));
    store.createTask(makeTask("b"));

    // interleave 200 appends across two streams
    for (let i = 0; i < 100; i++) {
      store.appendTaskEvent("a", usageEvent(i));
      store.appendTaskEvent("b", usageEvent(i));
    }

    for (const taskId of ["a", "b"] as const) {
      const events = store.allTaskEvents(taskId);
      expect(events).toHaveLength(100);
      expect(events.map((e) => e.seq)).toEqual(
        Array.from({ length: 100 }, (_, i) => i + 1),
      );
      // insertion order preserved — payload i landed at seq i+1
      const usages = events.map(
        (e) => (e.payload as { usage: { inputTokens: number } }).usage.inputTokens,
      );
      expect(usages).toEqual(Array.from({ length: 100 }, (_, i) => i));
    }
    close();
  });

  test("sqlite: burst appends on one stream produce unique monotonic seqs (BEGIN IMMEDIATE serialization)", async () => {
    const { store, close } = await sqliteStore();
    store.createTask(makeTask("t1"));
    const envelopes = Array.from({ length: 50 }, (_, i) =>
      store.appendTaskEvent("t1", usageEvent(i)),
    );
    const seqs = envelopes.map((e) => e.seq);
    expect(new Set(seqs).size).toBe(50);
    expect([...seqs].sort((x, y) => x - y)).toEqual(
      Array.from({ length: 50 }, (_, i) => i + 1),
    );
    // paged replay sees the same order with no duplicates
    const page = store.taskEventsAfter("t1", 0, 500);
    expect(page.events.map((e) => e.seq)).toEqual(seqs);
    expect(page.hasMore).toBe(false);
    close();
  });
});
