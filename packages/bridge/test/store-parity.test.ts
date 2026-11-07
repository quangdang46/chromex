/**
 * Store parity — chromex-7ee.
 *
 * Runs ONE deterministic operation sequence against InMemoryStore and
 * SQLiteStore and asserts the observable SessionStore surface is
 * identical: task CRUD, turn lifecycle persistence, durable event
 * append + taskEventsAfter pagination, lastTaskSeq, gateway events,
 * findTurnByClientMessageId, activeTurn, and approvals
 * insert/resolve/status.
 *
 * All timestamps are fixed constants so snapshots are deterministic;
 * envelope `ts` (wall-clock) is stripped before comparison.
 *
 * Documented divergences live in the last describe block — they are
 * asserted as `test.fails` parity checks so fixing the gap turns them
 * red and prompts removal of `.fails`.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type {
  DurableGatewayEvent,
  DurableGatewayEventEnvelope,
  DurableTaskEvent,
  DurableTaskEventEnvelope,
  TaskRecord,
  TurnRecord,
} from "@codex-sidepanel/shared";

import { InMemoryStore } from "../src/gateway/store-memory.js";
import type { SessionStore } from "../src/gateway/session-manager.js";
import { openGatewayDb } from "../src/store/db.js";
import { SQLiteStore } from "../src/store/sqlite-store.js";

// ---------- fixtures (same shape as store-sqlite.test.ts, fixed clock) ----------

const T0 = 1_760_000_000_000;

function makeTask(id: string, createdAt: number, over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    taskId: id,
    createdAt,
    updatedAt: createdAt,
    status: "active",
    pauseReason: null,
    title: null,
    profileId: "p1",
    providerId: "codex",
    conversationKey: `conv-${id}`,
    cwd: "/tmp",
    model: null,
    modeId: null,
    thinkingOptionId: null,
    providerOptions: null,
    backend: { backendId: "chrome-extension", pinnedBy: "default" },
    tabIntent: { scope: "untitled" },
    originBrowserInstanceId: null,
    binding: { browserInstanceId: null, state: "none" },
    lastSeq: 0,
    lastReadSeq: 0,
    error: null,
    ...over,
  };
}

function makeTurn(
  id: string,
  taskId: string,
  over: Partial<TurnRecord> = {},
): TurnRecord {
  const now = T0 + 10;
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

// ---------- store surface under test ----------

interface ParityStore extends SessionStore {
  listTasks(): TaskRecord[];
  listTurns(taskId?: string): TurnRecord[];
  getTurn(turnId: string): TurnRecord | undefined;
  appendGatewayEvent(event: DurableGatewayEvent): DurableGatewayEventEnvelope;
  gatewayEventsAfter(
    fromSeq: number,
    maxEvents?: number,
  ): { events: DurableGatewayEventEnvelope[]; nextSeq: number; hasMore: boolean };
  lastGatewaySeq(): number;
  countPendingApprovals(taskId: string): number;
  listPendingApprovals(taskId: string): unknown[];
  approvalStatus(
    approvalId: string,
  ): "pending" | "allowed" | "denied" | "expired" | null;
  approvalRequest(approvalId: string): unknown;
  approvalDecision(
    approvalId: string,
  ): { optionId: string; kind: string; decidedAt: number; scope?: string } | null;
  resolveApproval(
    approvalId: string,
    status: "allowed" | "denied" | "expired",
    decision?: { optionId: string; kind: string; decidedAt: number; scope?: string },
  ): void;
  close?(): void;
}

// ---------- canonicalization ----------

/** Deep-canonicalize: sort object keys, drop undefined. */
function canon(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canon);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v === undefined) continue;
      out[key] = canon(v);
    }
    return out;
  }
  return value;
}

/**
 * TaskRecord minus fields that legitimately diverge today:
 * - `updatedAt`: SQLite bumps tasks.updated_at inside appendTaskEvent;
 *   InMemoryStore leaves the record untouched (wall-clock anyway).
 * - `lastSeq`: SQLite keeps tasks.last_seq in sync with the event log;
 *   InMemoryStore tracks seq in a side map. Covered by the
 *   `test.fails` parity check below.
 */
function canonTask(task: TaskRecord | undefined): unknown {
  if (!task) return task;
  const { updatedAt: _u, lastSeq: _l, ...rest } = task;
  return canon(rest);
}

/** Envelope minus wall-clock `ts`. */
function stripTs<E extends { ts: number }>(e: E): Omit<E, "ts"> {
  const { ts: _ts, ...rest } = e;
  return rest;
}

// ---------- the shared scenario ----------

type Observation = { label: string; value: unknown };

function taskEventSeq(taskId: string, n: number): DurableTaskEvent {
  // Deterministic mix of durable task-stream event types.
  const kinds: DurableTaskEvent[] = [
    { type: "task.status_changed", from: "active", to: "paused", pauseReason: "user_requested" },
    { type: "task.status_changed", from: "paused", to: "active" },
    {
      type: "tool.started",
      turnId: "turn-a",
      toolCallId: `tc-${n}`,
      tool: "browser.click",
      source: "browser",
    },
    { type: "turn.completed", turnId: "turn-a", stopReason: "end_turn" },
    { type: "provider.notice", level: "info", message: `note-${n}` },
  ];
  return kinds[n % kinds.length]!;
}

function runScenario(store: ParityStore): Observation[] {
  const obs: Observation[] = [];
  const note = (label: string, value: unknown) => obs.push({ label, value: canon(value) });

  // ---- task CRUD ----
  const task1 = makeTask("par-1", T0);
  const task2 = makeTask("par-2", T0 + 1_000);
  store.createTask(task1);
  store.createTask(task2);
  note("getTask(par-1) after create", canonTask(store.getTask("par-1")));
  note("getTask(missing)", store.getTask("nope"));
  note("listTasks() ids", store.listTasks().map((t) => t.taskId));

  store.putTask({
    ...task1,
    title: "renamed",
    lastReadSeq: 7,
    status: "paused",
    pauseReason: "user_requested",
  });
  note("getTask(par-1) after putTask", canonTask(store.getTask("par-1")));
  store.putTask({ ...task1, title: "renamed", lastReadSeq: 7 }); // back to active

  // ---- turn lifecycle persistence ----
  const turnA = makeTurn("turn-a", "par-1", {
    clientMessageId: "cm-a",
    createdAt: T0 + 10,
    queuedAt: T0 + 10,
  });
  const turnB = makeTurn("turn-b", "par-1", {
    clientMessageId: "cm-b",
    createdAt: T0 + 20,
    queuedAt: T0 + 20,
  });
  const turnC = makeTurn("turn-c", "par-2", {
    clientMessageId: "cm-c",
    createdAt: T0 + 30,
    queuedAt: T0 + 30,
  });
  store.upsertTurn(turnA);
  store.upsertTurn(turnB);
  store.upsertTurn(turnC);

  note("activeTurn(par-1) first non-terminal", store.activeTurn("par-1"));
  note("activeTurn(par-2)", store.activeTurn("par-2"));

  // queued → running → completed, spreading the fetched record like
  // real callers (transitionTurn preserves untouched fields).
  const aRunning = store.getTurn("turn-a")!;
  store.upsertTurn({ ...aRunning, status: "running", startedAt: T0 + 11 });
  note("turn-a after queued→running", store.getTurn("turn-a"));
  const aRunning2 = store.getTurn("turn-a")!;
  store.upsertTurn({
    ...aRunning2,
    status: "completed",
    endedAt: T0 + 12,
    stopReason: "end_turn",
  });
  note("turn-a after running→completed", store.getTurn("turn-a"));
  note("activeTurn(par-1) after turn-a terminal → turn-b", store.activeTurn("par-1"));

  // idempotency lookup + cross-task isolation
  note("findTurnByClientMessageId(par-1, cm-b)", store.findTurnByClientMessageId("par-1", "cm-b"));
  note("findTurnByClientMessageId(par-1, missing)", store.findTurnByClientMessageId("par-1", "nope"));
  note("findTurnByClientMessageId(par-2, cm-b) [other task]", store.findTurnByClientMessageId("par-2", "cm-b"));
  note("findTurnByClientMessageId(par-1, cm-c) [other task's cmid]", store.findTurnByClientMessageId("par-1", "cm-c"));

  note("getTurn(turn-c)", store.getTurn("turn-c"));
  note("getTurn(missing)", store.getTurn("nope"));
  note("listTurns(par-1)", store.listTurns("par-1"));
  note("listTurns(par-2)", store.listTurns("par-2"));
  note("listTurns() all", store.listTurns());

  // ---- durable task events: append + pagination + lastTaskSeq ----
  const appended: DurableTaskEventEnvelope[] = [];
  for (let i = 0; i < 5; i += 1) {
    appended.push(store.appendTaskEvent("par-1", taskEventSeq("par-1", i)));
  }
  note("appendTaskEvent envelopes (seq 1..5)", appended.map(stripTs));
  note("lastTaskSeq(par-1)", store.lastTaskSeq("par-1"));

  store.appendTaskEvent("par-2", { type: "task.status_changed", from: "active", to: "active" });
  note("lastTaskSeq(par-2) independent", store.lastTaskSeq("par-2"));
  note("lastTaskSeq(missing task)", store.lastTaskSeq("nope"));

  const page = (fromSeq: number, max?: number) => {
    const p = store.taskEventsAfter("par-1", fromSeq, max);
    return { events: p.events.map(stripTs), nextSeq: p.nextSeq, hasMore: p.hasMore };
  };
  note("taskEventsAfter(par-1, 0, 2) page1", page(0, 2));
  note("taskEventsAfter(par-1, 2, 2) page2", page(2, 2));
  note("taskEventsAfter(par-1, 4, 2) page3", page(4, 2));
  note("taskEventsAfter(par-1, 0, 100) all", page(0, 100));
  note("taskEventsAfter(par-1, 5, 10) past end", page(5, 10));
  note("taskEventsAfter(par-1, 0) default max", page(0));
  const p2 = store.taskEventsAfter("par-2", 0, 10);
  note("taskEventsAfter(par-2, 0, 10)", {
    events: p2.events.map(stripTs),
    nextSeq: p2.nextSeq,
    hasMore: p2.hasMore,
  });
  const pMissing = store.taskEventsAfter("nope", 0, 10);
  note("taskEventsAfter(missing, 0, 10)", {
    events: pMissing.events,
    nextSeq: pMissing.nextSeq,
    hasMore: pMissing.hasMore,
  });

  // ---- gateway stream ----
  store.appendGatewayEvent({
    type: "gateway.started",
    version: "test",
    recoveredTurns: 0,
    recoveredTasks: 0,
  });
  store.appendGatewayEvent({ type: "gateway.provider.changed", providerId: "codex", available: true });
  note("lastGatewaySeq", store.lastGatewaySeq());
  const gw = store.gatewayEventsAfter(0);
  note("gatewayEventsAfter(0)", {
    events: gw.events.map(stripTs),
    nextSeq: gw.nextSeq,
    hasMore: gw.hasMore,
  });
  const gwPage = store.gatewayEventsAfter(1, 1);
  note("gatewayEventsAfter(1, 1) paginated", {
    events: gwPage.events.map(stripTs),
    nextSeq: gwPage.nextSeq,
    hasMore: gwPage.hasMore,
  });

  // ---- approvals: insert / resolve / status ----
  store.insertApproval({
    approvalId: "ap-1",
    taskId: "par-1",
    turnId: "turn-a",
    request: { kind: "browser_action", target: "#btn" },
    actionDigest: "d1",
    status: "pending",
    createdAt: T0,
  });
  store.insertApproval({
    approvalId: "ap-2",
    taskId: "par-1",
    request: { kind: "file_write", path: "/tmp/x" },
    actionDigest: "d2",
    status: "pending",
    createdAt: T0 + 1,
  });
  store.insertApproval({
    approvalId: "ap-3",
    taskId: "par-2",
    request: { kind: "other" },
    actionDigest: "d3",
    status: "allowed",
    createdAt: T0 + 2,
  });
  store.insertApproval({
    approvalId: "ap-5",
    taskId: "par-1",
    request: { kind: "with_decision" },
    actionDigest: "d5",
    status: "pending",
    createdAt: T0 + 5,
  });

  store.resolveApproval("ap-1", "allowed");
  store.resolveApproval("ap-2", "denied");
  store.resolveApproval("ap-1", "expired"); // idempotent: already resolved → no-op
  store.resolveApproval("ap-404", "allowed"); // unknown id → no-op
  store.resolveApproval("ap-5", "allowed", {
    optionId: "opt-1",
    kind: "allow",
    decidedAt: T0 + 6,
    scope: "once",
  });

  note("approvalStatus ap-1", store.approvalStatus("ap-1"));
  note("approvalStatus ap-2", store.approvalStatus("ap-2"));
  note("approvalStatus ap-3", store.approvalStatus("ap-3"));
  note("approvalStatus ap-5", store.approvalStatus("ap-5"));
  note("approvalStatus ap-404", store.approvalStatus("ap-404"));
  note("countPendingApprovals(par-1)", store.countPendingApprovals("par-1"));
  note("countPendingApprovals(par-2)", store.countPendingApprovals("par-2"));
  note("listPendingApprovals(par-1) count", store.listPendingApprovals("par-1").length);
  note("approvalRequest(ap-1)", store.approvalRequest("ap-1"));
  note("approvalRequest(ap-404)", store.approvalRequest("ap-404"));
  note("approvalDecision(ap-1) none", store.approvalDecision("ap-1"));
  note("approvalDecision(ap-5) with decision", store.approvalDecision("ap-5"));

  return obs;
}

// ---------- harness ----------

let dir: string;
let sqliteStore: SQLiteStore | null = null;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "chromex-parity-"));
});

afterEach(async () => {
  sqliteStore?.close();
  sqliteStore = null;
  await fs.rm(dir, { recursive: true, force: true });
});

async function makeSqliteStore(): Promise<SQLiteStore> {
  const db = await openGatewayDb(dir);
  sqliteStore = new SQLiteStore(db);
  return sqliteStore;
}

// ---------- tests ----------

describe("store parity: identical op sequence → identical observable state", () => {
  test("InMemoryStore and SQLiteStore agree on the full scenario", async () => {
    const memory = new InMemoryStore() as unknown as ParityStore;
    const sqlite = (await makeSqliteStore()) as unknown as ParityStore;

    const memObs = runScenario(memory);
    const liteObs = runScenario(sqlite);

    // Labels must match 1:1 — a missing/extra observation is itself a divergence.
    expect(memObs.map((o) => o.label)).toEqual(liteObs.map((o) => o.label));
    expect(memObs).toEqual(liteObs);
  });
});

describe("known divergences (documented, expected to fail until fixed)", () => {
  test.fails("parity: getTask().lastSeq tracks appended events", async () => {
    const memory = new InMemoryStore() as unknown as ParityStore;
    const sqlite = (await makeSqliteStore()) as unknown as ParityStore;

    for (const store of [memory, sqlite]) {
      store.createTask(makeTask("t-seq", T0));
      store.appendTaskEvent("t-seq", { type: "task.status_changed", from: "active", to: "active" });
      store.appendTaskEvent("t-seq", { type: "task.status_changed", from: "active", to: "active" });
      // putTask with a stale lastSeq must not rewind the counter (§7.2);
      // SQLite ignores last_seq on conflict-update, memory overwrites it.
      store.putTask({ ...makeTask("t-seq", T0), title: "x", lastSeq: 0 });
      store.appendTaskEvent("t-seq", { type: "task.status_changed", from: "active", to: "active" });
    }

    // lastTaskSeq() agrees (both allocate from their own counters)…
    expect(memory.lastTaskSeq("t-seq")).toBe(sqlite.lastTaskSeq("t-seq"));
    // …but the TaskRecord projection does not: SQLite keeps
    // tasks.last_seq in sync, InMemoryStore leaves it stale.
    expect(memory.getTask("t-seq")!.lastSeq).toBe(sqlite.getTask("t-seq")!.lastSeq);
  });

  test.fails("parity: appendTaskEvent on an unknown task", async () => {
    const memory = new InMemoryStore() as unknown as ParityStore;
    const sqlite = (await makeSqliteStore()) as unknown as ParityStore;

    const attempt = (store: ParityStore) => {
      try {
        store.appendTaskEvent("ghost", { type: "task.status_changed", from: "active", to: "active" });
        return "ok";
      } catch {
        return "threw";
      }
    };
    const memResult = attempt(memory);
    const liteResult = attempt(sqlite);

    // SQLite enforces the tasks FK-by-convention (throws "task not
    // found"); InMemoryStore appends happily and lastTaskSeq becomes 1.
    expect(memResult).toBe(liteResult);
  });
});
