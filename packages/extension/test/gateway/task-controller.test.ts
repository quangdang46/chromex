import { describe, expect, test, vi } from "vitest";

import { TaskController } from "../../src/background/gateway/task-controller.js";
import type { GatewayClient } from "../../src/background/gateway/gateway-client.js";
import type {
  DurableTaskEventEnvelope,
  HelloResponse,
  InlineTaskSnapshot,
} from "@codex-sidepanel/shared";

function memStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string | string[]) => {
      const keys = Array.isArray(k) ? k : [k];
      const out: Record<string, unknown> = {};
      for (const key of keys) if (m.has(key)) out[key] = m.get(key);
      return out;
    },
    set: async (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) m.set(k, v);
    },
    _map: m,
  };
}

function fakeClient(handler: (method: string, payload: unknown) => unknown) {
  const acks: Array<{ stream: string; seq: number; taskId?: string }> = [];
  return {
    client: {
      request: vi.fn(async (method: string, payload?: unknown) => {
        if (method === "gateway.sync") return { mode: "head", lastSeq: 0 };
        return handler(method, payload);
      }),
      ack: vi.fn((stream: "task" | "gateway", seq: number, taskId?: string) => {
        acks.push({ stream, seq, taskId });
      }),
    } as unknown as GatewayClient,
    acks,
  };
}

function hello(tasks: Array<{ taskId: string; lastSeq: number; status?: string }>): HelloResponse {
  return {
    gatewayVersion: "test",
    protocolVersion: 1,
    providers: [],
    backends: [],
    tasks: tasks.map((t) => ({
      taskId: t.taskId,
      profileId: "p",
      status: (t.status ?? "active") as never,
      lastSeq: t.lastSeq,
      browserBinding: "none",
    })),
    features: {},
    gatewayLastSeq: 0,
  };
}

function taskEvent(taskId: string, seq: number, type: string, payload: Record<string, unknown> = {}): DurableTaskEventEnvelope {
  return {
    v: 1,
    kind: "event",
    reliability: "durable",
    stream: "task",
    taskId,
    seq,
    ts: Date.now(),
    type,
    payload: { type, ...payload },
  } as unknown as DurableTaskEventEnvelope;
}

describe("TaskController (P1-08)", () => {
  test("hello seeds tasks; sync replays events and advances cursor", async () => {
    const storage = memStorage();
    const events: DurableTaskEventEnvelope[] = [
      taskEvent("t1", 1, "user.message.created", {}),
      taskEvent("t1", 2, "turn.started", {}),
    ];
    const { client } = fakeClient((method) => {
      if (method === "task.sync") {
        return { mode: "replay", events, nextSeq: 2, hasMore: false };
      }
      return {};
    });
    const seen: string[] = [];
    const ctl = new TaskController({
      client,
      storage: storage as never,
      onTaskEvent: (_id, env) => seen.push(env.type),
    });
    await ctl.onHello(hello([{ taskId: "t1", lastSeq: 0 }]));
    await ctl.syncAll();
    expect(ctl.getTask("t1")?.lastSeq).toBe(2);
    expect(seen).toEqual(["user.message.created", "turn.started"]);
    // cursors persisted
    const cursors = storage._map.get("chromex.gateway.cursors.v1") as {
      lastSeqByTask: Record<string, number>;
    };
    expect(cursors.lastSeqByTask.t1).toBe(2);
  });

  test("markRendered advances lastReadSeq + sends ack", async () => {
    const storage = memStorage();
    const { client, acks } = fakeClient(() => ({ mode: "replay", events: [], nextSeq: 0, hasMore: false }));
    const ctl = new TaskController({ client, storage: storage as never });
    await ctl.onHello(hello([{ taskId: "t1", lastSeq: 5 }]));
    ctl.markRendered("t1", 3);
    expect(ctl.getTask("t1")?.lastReadSeq).toBe(3);
    expect(acks).toEqual([{ stream: "task", seq: 3, taskId: "t1" }]);
    // never regresses
    ctl.markRendered("t1", 1);
    expect(ctl.getTask("t1")?.lastReadSeq).toBe(3);
  });

  test("snapshot mode rebuilds via onSnapshotRebuilt", async () => {
    const storage = memStorage();
    const snap = {
      storage: { kind: "inline" },
      task: { taskId: "t1" },
      turns: [],
      userMessages: [],
      assistantMessages: [],
      toolCalls: [],
      permissions: [],
      lastSeq: 9,
      rebuiltFrom: "event_log",
    } as unknown as InlineTaskSnapshot;
    const { client } = fakeClient((method) => {
      if (method === "task.sync") return { mode: "snapshot", snapshot: snap, lastSeq: 9 };
      return {};
    });
    let rebuilt: InlineTaskSnapshot | null = null;
    const ctl = new TaskController({
      client,
      storage: storage as never,
      onSnapshotRebuilt: (_id, s) => {
        rebuilt = s;
      },
    });
    await ctl.onHello(hello([{ taskId: "t1", lastSeq: 4 }]));
    await ctl.syncTask("t1");
    expect(rebuilt).toBe(snap);
    expect(ctl.getTask("t1")?.lastSeq).toBe(9);
  });

  test("cursors survive controller re-creation (SW restart)", async () => {
    const storage = memStorage();
    const { client } = fakeClient(() => ({ mode: "replay", events: [taskEvent("t1", 7, "turn.completed", {})], nextSeq: 7, hasMore: false }));
    const c1 = new TaskController({ client, storage: storage as never });
    await c1.onHello(hello([{ taskId: "t1", lastSeq: 0 }]));
    await c1.syncAll();

    // new controller = SW restart; same storage
    const { client: client2 } = fakeClient(() => ({ mode: "replay", events: [], nextSeq: 0, hasMore: false }));
    const c2 = new TaskController({ client: client2, storage: storage as never });
    await c2.onHello(hello([{ taskId: "t1", lastSeq: 7 }]));
    // cursor loaded → view.lastSeq seeded from cursor not hello
    expect(c2.getTask("t1")?.lastSeq).toBe(7);
    expect(c2.helloCursors().lastSeqByTask.t1).toBe(7);
  });

  test("duplicate/out-of-order replay events are dropped", async () => {
    const storage = memStorage();
    const { client } = fakeClient(() => ({
      mode: "replay",
      events: [
        taskEvent("t1", 5, "turn.completed", {}),
        taskEvent("t1", 3, "turn.started", {}), // stale — already covered
        taskEvent("t1", 5, "turn.completed", {}), // exact dup
        taskEvent("t1", 6, "task.attention_changed", { attention: "needs_input" }),
      ],
      nextSeq: 6,
      hasMore: false,
    }));
    const seen: string[] = [];
    const ctl = new TaskController({ client, storage: storage as never, onTaskEvent: (_id, e) => seen.push(`${e.seq}:${e.type}`) });
    await ctl.onHello(hello([{ taskId: "t1", lastSeq: 4 }])); // cursor at 4
    await ctl.syncTask("t1");
    // seq 5 applies once; seq 3 and dup-5 dropped; seq 6 applies
    expect(seen).toEqual(["5:turn.completed", "6:task.attention_changed"]);
    expect(ctl.getTask("t1")?.lastSeq).toBe(6);
    expect(ctl.getTask("t1")?.attention).toBe("needs_input");
  });

  test("live push overlapping replay does not double-apply", async () => {
    const storage = memStorage();
    const { client } = fakeClient(() => ({ mode: "replay", events: [], nextSeq: 0, hasMore: false }));
    const seen: string[] = [];
    const ctl = new TaskController({ client, storage: storage as never, onTaskEvent: (_id, e) => seen.push(e.type) });
    await ctl.onHello(hello([{ taskId: "t1", lastSeq: 0 }]));
    ctl.handleEvent(taskEvent("t1", 10, "turn.started", {}));
    ctl.handleEvent(taskEvent("t1", 10, "turn.started", {})); // dup push
    ctl.handleEvent(taskEvent("t1", 9, "user.message.created", {})); // out of order
    expect(seen).toEqual(["turn.started"]);
    expect(ctl.getTask("t1")?.lastSeq).toBe(10);
  });

  test("gateway-stream events advance lastSeqByGateway cursor", async () => {
    const storage = memStorage();
    const { client } = fakeClient(() => ({}));
    const ctl = new TaskController({ client, storage: storage as never });
    await ctl.onHello(hello([{ taskId: "t1", lastSeq: 0 }]));
    ctl.handleEvent({ stream: "gateway", seq: 42 } as never);
    ctl.handleEvent({ stream: "gateway", seq: 17 } as never);
    expect(ctl.helloCursors().lastSeqByGateway).toBe(42);
  });
});
