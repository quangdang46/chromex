import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { openGatewayDb, runIntegrityChecks, CorruptDatabaseError } from "../src/store/db.js";
import { SQLiteStore } from "../src/store/sqlite-store.js";
import { runRecoveryScan } from "../src/store/recovery.js";
import { SCHEMA_VERSION } from "../src/store/schema.js";
import type { TaskRecord, TurnRecord } from "@codex-sidepanel/shared";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "chromex-store-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function makeTask(id: string, over: Partial<TaskRecord> = {}): TaskRecord {
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
    ...over,
  };
}

function makeTurn(id: string, taskId: string, over: Partial<TurnRecord> = {}): TurnRecord {
  const now = Date.now();
  return {
    turnId: id,
    taskId,
    status: "queued",
    clientMessageId: `cm-${id}`,
    createdAt: now,
    queuedAt: now,
    startedAt: null,
    endedAt: null,
    ...over,
  };
}

describe("SQLite store — schema & migrations", () => {
  test("DDL executes; schema_migrations seeded; integrity checks pass on empty DB", async () => {
    const db = await openGatewayDb(dir);
    const store = new SQLiteStore(db);
    expect(runIntegrityChecks(db)).toEqual([]);
    const v = db.prepare("SELECT MAX(version) v FROM schema_migrations").get() as { v: number };
    expect(v.v).toBe(SCHEMA_VERSION);
    store.close();
  });

  test("migrations idempotent — second open is a no-op", async () => {
    const db1 = await openGatewayDb(dir);
    db1.close();
    const db2 = await openGatewayDb(dir);
    const count = db2.prepare("SELECT COUNT(*) n FROM schema_migrations").get() as { n: number };
    expect(count.n).toBe(1);
    db2.close();
  });

  test("corrupt DB → .corrupt-<ts> backup + typed error", async () => {
    const dbPath = path.join(dir, "gateway.db");
    await fs.writeFile(dbPath, "this is not sqlite at all".repeat(100));
    await expect(openGatewayDb(dir)).rejects.toBeInstanceOf(CorruptDatabaseError);
    const files = await fs.readdir(dir);
    expect(files.some((f) => f.includes(".corrupt-"))).toBe(true);
  });
});

describe("SQLite store — CHECK constraints", () => {
  test("queued turn with started_at is rejected", async () => {
    const db = await openGatewayDb(dir);
    const store = new SQLiteStore(db);
    store.createTask(makeTask("t1"));
    expect(() =>
      store.upsertTurn(makeTurn("bad", "t1", { status: "queued", startedAt: Date.now() })),
    ).toThrow(/CHECK/);
    store.close();
  });

  test("paused task without pause_reason is rejected", async () => {
    const db = await openGatewayDb(dir);
    const store = new SQLiteStore(db);
    expect(() =>
      store.createTask(makeTask("t1", { status: "paused", pauseReason: null })),
    ).toThrow(/CHECK/);
    store.close();
  });

  test("paused task WITH reason is accepted; active without reason too", async () => {
    const db = await openGatewayDb(dir);
    const store = new SQLiteStore(db);
    store.createTask(makeTask("t1", { status: "paused", pauseReason: "user_requested" }));
    expect(store.getTask("t1")?.status).toBe("paused");
    store.close();
  });

  test("turn terminal-before-start (cancelled, no started_at) is allowed", async () => {
    const db = await openGatewayDb(dir);
    const store = new SQLiteStore(db);
    store.createTask(makeTask("t1"));
    store.upsertTurn(
      makeTurn("t1u", "t1", {
        status: "cancelled",
        startedAt: null,
        endedAt: Date.now(),
      }),
    );
    expect(store.getTurn("t1u")?.status).toBe("cancelled");
    store.close();
  });
});

describe("SQLite store — seq allocation", () => {
  test("task events get monotonic seq; last_seq tracks; MAX(seq)<=last_seq", async () => {
    const db = await openGatewayDb(dir);
    const store = new SQLiteStore(db);
    store.createTask(makeTask("t1"));
    for (let i = 0; i < 5; i += 1) {
      store.appendTaskEvent("t1", { type: "task.status_changed", from: "active", to: "active" });
    }
    expect(store.lastTaskSeq("t1")).toBe(5);
    const page = store.taskEventsAfter("t1", 0, 10);
    expect(page.events.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(runIntegrityChecks(db)).toEqual([]);
    store.close();
  });

  test("gateway events get independent monotonic seq via gateway_state", async () => {
    const db = await openGatewayDb(dir);
    const store = new SQLiteStore(db);
    store.appendGatewayEvent({ type: "gateway.started", version: "t", recoveredTurns: 0, recoveredTasks: 0 });
    store.appendGatewayEvent({ type: "gateway.provider.changed", providerId: "codex", available: true });
    expect(store.lastGatewaySeq()).toBe(2);
    const page = store.gatewayEventsAfter(0);
    expect(page.events.map((e) => e.seq)).toEqual([1, 2]);
    store.close();
  });

  test("task seq survives 'prune' — allocation uses last_seq not MAX(seq)", async () => {
    const db = await openGatewayDb(dir);
    const store = new SQLiteStore(db);
    store.createTask(makeTask("t1"));
    for (let i = 0; i < 3; i += 1) {
      store.appendTaskEvent("t1", { type: "task.status_changed", from: "active", to: "active" });
    }
    // simulate prune of old events (keep last_seq intact)
    db.prepare("DELETE FROM events WHERE stream='task' AND task_id='t1' AND seq < 3").run();
    store.appendTaskEvent("t1", { type: "task.status_changed", from: "active", to: "active" });
    expect(store.lastTaskSeq("t1")).toBe(4); // not MAX(seq)+1 = 2
    store.close();
  });
});

describe("SQLite store — recovery scan (§5.6)", () => {
  test("running turn → unknown + open tools closed unknown + task paused(gateway_restart)", async () => {
    const db = await openGatewayDb(dir);
    const store = new SQLiteStore(db);
    const now = Date.now();
    store.createTask(makeTask("t1"));
    store.upsertTurn(
      makeTurn("r1", "t1", { status: "running", startedAt: now, endedAt: null }),
    );
    // open tool.started without completed
    store.appendTaskEvent("t1", {
      type: "tool.started",
      turnId: "r1",
      toolCallId: "tc1",
      tool: "browser.click",
      source: "browser",
    });

    const result = runRecoveryScan(store, db);
    expect(result.unknownTurns).toEqual(["r1"]);
    expect(result.pausedTasks).toEqual(["t1"]);

    const turn = store.getTurn("r1");
    expect(turn?.status).toBe("unknown");
    const task = store.getTask("t1");
    expect(task?.status).toBe("paused");
    expect(task?.pauseReason).toBe("gateway_restart");

    // tool.completed{unknown} event emitted
    const page = store.taskEventsAfter("t1", 0, 50);
    const completed = page.events.find(
      (e) => e.type === "tool.completed" && (e.payload as { outcome?: string }).outcome === "unknown",
    );
    expect(completed).toBeTruthy();
    const unknown = page.events.find((e) => e.type === "turn.unknown");
    expect(unknown).toBeTruthy();
    store.close();
  });

  test("queued turn stays queued; task paused; nothing auto-runs", async () => {
    const db = await openGatewayDb(dir);
    const store = new SQLiteStore(db);
    store.createTask(makeTask("t1"));
    store.upsertTurn(makeTurn("q1", "t1", { status: "queued" }));
    const result = runRecoveryScan(store, db);
    expect(result.unknownTurns).toEqual([]);
    expect(store.getTurn("q1")?.status).toBe("queued");
    expect(store.getTask("t1")?.status).toBe("paused");
    store.close();
  });

  test("pending approvals untouched by recovery", async () => {
    const db = await openGatewayDb(dir);
    const store = new SQLiteStore(db);
    store.createTask(makeTask("t1"));
    store.insertApproval({
      approvalId: "a1",
      taskId: "t1",
      request: { kind: "browser_action" },
      actionDigest: "d1",
      status: "pending",
      createdAt: Date.now(),
    });
    runRecoveryScan(store, db);
    const pending = store.listPendingApprovals("t1");
    expect(pending).toHaveLength(1);
    store.close();
  });
});
