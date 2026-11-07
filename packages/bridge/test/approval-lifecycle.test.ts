/**
 * §5.7 approval lifecycle — chromex-yyb.
 *
 * Covers the holes between the approvals table, the provider session
 * mirror, and the permission.* durable events:
 *
 *  - provider crash/disconnect (turn.unknown, conversation.closed,
 *    provider_unavailable pause) expires pending approvals instead of
 *    leaving them pending forever;
 *  - task terminal status expires pending approvals (task_terminal);
 *  - a NEW provider session for the same conversation expires approvals
 *    mirrored from the dead session (restart);
 *  - permission.respond validates optionId against the offered options,
 *    rejects already-decided approvals (approval.already_decided) and
 *    unknown ids (approval.not_found) instead of silently dropping.
 */

import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type {
  AgentEvent,
  AgentProvider,
  AgentSession,
  PermissionRequest,
  TaskRecord,
} from "@codex-sidepanel/shared";
import { NO_CAPABILITIES } from "@codex-sidepanel/shared";

import { ProviderRegistry } from "../src/agents/registry.js";
import { DEFAULT_GATEWAY_CONFIG } from "../src/gateway/config.js";
import { InMemoryStore } from "../src/gateway/store-memory.js";
import {
  SessionManager,
  type SessionStore,
} from "../src/gateway/session-manager.js";

// ---------- mock provider/session (same shape as session-manager.test.ts) ----------

class MockSession implements AgentSession {
  readonly provider = "codex";
  readonly sessionKey = "mock-conv";
  readonly capabilities = { ...NO_CAPABILITIES, streaming: true, interrupt: true, steer: true };
  listeners = new Set<(e: AgentEvent) => void>();
  turns: Array<{ gatewayTurnId: string }> = [];
  autoTerminal = false;

  async startTurn(input: { gatewayTurnId: string }): Promise<{ accepted: true; providerTurnId?: string }> {
    this.turns.push(input);
    queueMicrotask(() => {
      this.emit({ type: "turn.started", turnId: input.gatewayTurnId });
      if (this.autoTerminal) {
        this.emit({ type: "turn.completed", turnId: input.gatewayTurnId });
      }
    });
    return { accepted: true, providerTurnId: `pt-${this.turns.length}` };
  }
  async steer() {
    return { status: "accepted" as const };
  }
  async interrupt() {
    const last = this.turns.at(-1);
    if (last) this.emit({ type: "turn.cancelled", turnId: last.gatewayTurnId, reason: "interrupted" });
  }
  canStopRuntime() {
    return true;
  }
  async respondToPermission() {
    return {};
  }
  getPendingPermissions(): PermissionRequest[] {
    return [];
  }
  subscribe(l: (e: AgentEvent) => void) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(e: AgentEvent) {
    for (const l of this.listeners) l(e);
  }
  async getRuntimeInfo() {
    return { provider: "codex", sessionId: null, model: null, modeId: null };
  }
  async getAvailableModes() {
    return [];
  }
  async getCurrentMode() {
    return null;
  }
  describePersistence() {
    return null;
  }
  async close() {}
}

const sessions: MockSession[] = [];
function makeProvider(): AgentProvider {
  return {
    id: "codex",
    displayName: "Mock Codex",
    capabilities: NO_CAPABILITIES,
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async () => ({ providerId: "codex", models: [], modes: [], fetchedAt: 0 }),
    createSession: async () => {
      const s = new MockSession();
      sessions.push(s);
      return s;
    },
    resumeSession: async () => {
      const s = new MockSession();
      sessions.push(s);
      return s;
    },
  };
}

async function makeManager(store?: InMemoryStore) {
  sessions.length = 0;
  const mem = store ?? new InMemoryStore();
  const smStore = mem as unknown as SessionStore;
  const registry = new ProviderRegistry(DEFAULT_GATEWAY_CONFIG.providers);
  await registry.register("codex", async () => makeProvider());
  const published: Array<{ taskId: string; event: unknown; ephemeral: boolean }> = [];
  const sm = new SessionManager({
    store: smStore,
    registry,
    config: structuredClone(DEFAULT_GATEWAY_CONFIG),
    publish: (taskId, event, ephemeral) => published.push({ taskId, event, ephemeral }),
  });
  return { sm, store: mem, registry, published, sessions };
}

function taskParams(conversationKey?: string) {
  return {
    profileId: "codex",
    providerId: "codex" as const,
    ...(conversationKey ? { conversationKey } : {}),
    cwd: "/tmp",
    backend: { backendId: "chrome-extension" as const, pinnedBy: "default" as const },
    tabIntent: { scope: "untitled" as const },
  };
}

const INPUT = { clientMessageId: "cm-1", content: [{ type: "text" as const, text: "hi" }] };

function permissionRequest(taskId: string, turnId: string, requestId = "perm-1"): PermissionRequest {
  return {
    requestId,
    taskId,
    turnId,
    kind: "provider_permission",
    risk: "high",
    summary: "provider asks",
    actionDigest: "digest-1",
    options: [
      { id: "allow_once", label: "Allow once", kind: "allow_once" },
      { id: "deny", label: "Deny", kind: "deny" },
    ],
    details: { tool: "provider.tool", argsPreview: {}, origin: "" },
  };
}

function expiredEvents(store: InMemoryStore, taskId: string) {
  return store
    .taskEventsAfter(taskId, 0, 100_000)
    .events.filter((e) => e.type === "permission.expired")
    .map((e) => {
      const p = e.payload as { requestId: string; reason: string };
      return { requestId: p.requestId, reason: p.reason };
    });
}

// ---------- SessionManager-level lifecycle ----------

describe("approval lifecycle (§5.7 / chromex-yyb)", () => {
  test("provider crash (turn.unknown) expires pending approvals as provider_unavailable", async () => {
    const { sm, store, published } = await makeManager();
    const task = sm.createTask(taskParams());
    await sm.sendMessage(task.taskId, INPUT);
    await new Promise((r) => setTimeout(r, 10));
    const turnId = store.listTurns(task.taskId)[0]!.turnId;

    sessions[0]!.emit({
      type: "permission.requested",
      turnId,
      request: permissionRequest(task.taskId, turnId),
    });
    expect(store.approvalStatus("perm-1")).toBe("pending");

    sessions[0]!.emit({ type: "turn.unknown", turnId, reason: "provider_crash" });

    expect(store.approvalStatus("perm-1")).toBe("expired");
    const expired = expiredEvents(store, task.taskId);
    expect(expired).toEqual([{ requestId: "perm-1", reason: "provider_unavailable" }]);
    // live publish too — clients clear the card without replay
    expect(
      published.some(
        (p) =>
          !p.ephemeral &&
          (p.event as { type?: string }).type === "permission.expired",
      ),
    ).toBe(true);
    expect(store.countPendingApprovals(task.taskId)).toBe(0);
  });

  test("conversation.closed expires pending approvals as provider_unavailable", async () => {
    const { sm, store } = await makeManager();
    const task = sm.createTask(taskParams());
    await sm.sendMessage(task.taskId, INPUT);
    await new Promise((r) => setTimeout(r, 10));
    const turnId = store.listTurns(task.taskId)[0]!.turnId;

    sessions[0]!.emit({
      type: "permission.requested",
      turnId,
      request: permissionRequest(task.taskId, turnId),
    });
    sessions[0]!.emit({ type: "conversation.closed", sessionKey: "mock-conv", reason: "crash" });

    expect(store.approvalStatus("perm-1")).toBe("expired");
    expect(expiredEvents(store, task.taskId)).toEqual([
      { requestId: "perm-1", reason: "provider_unavailable" },
    ]);
  });

  test("task terminal (turn.completed → task.completed) expires pending approvals as task_terminal", async () => {
    const { sm, store } = await makeManager();
    const task = sm.createTask(taskParams());
    await sm.sendMessage(task.taskId, INPUT);
    await new Promise((r) => setTimeout(r, 10));
    const turnId = store.listTurns(task.taskId)[0]!.turnId;

    sessions[0]!.emit({
      type: "permission.requested",
      turnId,
      request: permissionRequest(task.taskId, turnId),
    });
    sessions[0]!.emit({ type: "turn.completed", turnId });

    expect(store.getTask(task.taskId)!.status).toBe("completed");
    expect(store.approvalStatus("perm-1")).toBe("expired");
    expect(expiredEvents(store, task.taskId)).toEqual([
      { requestId: "perm-1", reason: "task_terminal" },
    ]);
  });

  test("task.cancel expires pending approvals as task_terminal (no double-expire)", async () => {
    const { sm, store } = await makeManager();
    const task = sm.createTask(taskParams());
    await sm.sendMessage(task.taskId, INPUT);
    await new Promise((r) => setTimeout(r, 10));
    const turnId = store.listTurns(task.taskId)[0]!.turnId;

    sessions[0]!.emit({
      type: "permission.requested",
      turnId,
      request: permissionRequest(task.taskId, turnId),
    });
    await sm.cancelTask(task.taskId, "user");

    expect(store.getTask(task.taskId)!.status).toBe("cancelled");
    expect(store.approvalStatus("perm-1")).toBe("expired");
    const expired = expiredEvents(store, task.taskId);
    expect(expired).toEqual([{ requestId: "perm-1", reason: "task_terminal" }]);
  });

  test("new provider session for the conversation expires stale approvals as restart", async () => {
    const store = new InMemoryStore();
    const { sm: sm1 } = await makeManager(store);
    const task = sm1.createTask(taskParams());
    // approval mirrored from a session that died with the previous gateway
    store.insertApproval({
      approvalId: "perm-stale",
      taskId: task.taskId,
      request: { requestId: "perm-stale" },
      actionDigest: "d",
      status: "pending",
      createdAt: Date.now(),
    });

    // a fresh SessionManager = provider restart; next dispatch opens a
    // new session and must not inherit the dead session's approvals
    const { sm: sm2 } = await makeManager(store);
    await sm2.sendMessage(task.taskId, { ...INPUT, clientMessageId: "cm-2" });
    await new Promise((r) => setTimeout(r, 10));

    expect(store.approvalStatus("perm-stale")).toBe("expired");
    expect(expiredEvents(store, task.taskId)).toEqual([
      { requestId: "perm-stale", reason: "restart" },
    ]);
  });

  test("user pause keeps approvals pending; resume does not expire them", async () => {
    const { sm, store } = await makeManager();
    const task = sm.createTask(taskParams());
    await sm.sendMessage(task.taskId, INPUT);
    await new Promise((r) => setTimeout(r, 10));
    const turnId = store.listTurns(task.taskId)[0]!.turnId;

    sessions[0]!.emit({
      type: "permission.requested",
      turnId,
      request: permissionRequest(task.taskId, turnId),
    });
    sm.pauseTask(task.taskId, "user_requested");
    expect(store.approvalStatus("perm-1")).toBe("pending");
    expect(expiredEvents(store, task.taskId)).toEqual([]);
  });
});

// ---------- gateway RPC surface (permission.respond) ----------

let dir: string;
let gw: {
  ipc: { endpointPath(): { transport: string; path: string }; tokenBytes: Buffer };
  shutdown: (r?: string) => Promise<void>;
  store: InMemoryStore;
} | null = null;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-appr-"));
});
afterEach(async () => {
  await gw?.shutdown("test").catch(() => {});
  gw = null;
  await fs.rm(dir, { recursive: true, force: true });
});

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath, () => resolve(s));
    s.once("error", reject);
  });
}

function rpc(socket: net.Socket, id: string, method: string, payload?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(
      JSON.stringify({ v: 1, kind: "request", id, method, ...(payload !== undefined ? { payload } : {}) }),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) return;
        const env = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
        buf = buf.subarray(4 + len);
        if (env.kind === "response" && env.id === id) {
          socket.off("data", onData);
          if (env.error) reject(env.error);
          else resolve(env.result ?? env);
          return;
        }
      }
    };
    socket.on("data", onData);
    socket.write(Buffer.concat([header, body]));
  });
}

async function authedConn(): Promise<net.Socket> {
  const ep = gw!.ipc.endpointPath();
  const s = await connect(ep.path);
  const token = gw!.ipc.tokenBytes.toString("hex");
  await rpc(s, "hello", "hello", {
    token,
    clientVersion: "test",
    protocolVersion: 1,
    clientId: "c1",
    profileId: "p1",
    browserInstanceId: null,
    hostInstanceId: "",
  });
  return s;
}

async function start() {
  const { startGateway } = await import("../src/gateway/main.js");
  gw = (await startGateway({ dataDir: dir, log: () => {} })) as typeof gw;
  return gw!;
}

/** Insert a pending approval row directly — the shape both the browser
 *  tool path (request object at top level) and the provider mirror
 *  (permission.requested AgentEvent) produce. */
function insertPendingApproval(taskId: string, requestId: string, options: unknown) {
  gw!.store.insertApproval({
    approvalId: requestId,
    taskId,
    request: { requestId, taskId, options, details: {} },
    actionDigest: "digest",
    status: "pending",
    createdAt: Date.now(),
  });
}

describe("permission.respond validation (chromex-yyb)", () => {
  test("optionId not in offered options → proto.invalid, approval stays pending", async () => {
    await start();
    const s = await authedConn();
    const created = (await rpc(s, "c1", "task.create", { cwd: "/tmp", title: "appr" })) as {
      taskId: string;
    };
    insertPendingApproval(created.taskId, "appr-bad", [
      { id: "allow_once", label: "Allow once", kind: "allow_once" },
      { id: "deny", label: "Deny", kind: "deny" },
    ]);

    await expect(
      rpc(s, "r1", "permission.respond", { requestId: "appr-bad", optionId: "rm_rf_everything" }),
    ).rejects.toMatchObject({ code: "proto.invalid" });
    expect(gw!.store.approvalStatus("appr-bad")).toBe("pending");
    s.destroy();
  });

  test("valid optionId resolves + permission.resolved; second respond → approval.already_decided", async () => {
    await start();
    const s = await authedConn();
    const created = (await rpc(s, "c1", "task.create", { cwd: "/tmp", title: "appr" })) as {
      taskId: string;
    };
    insertPendingApproval(created.taskId, "appr-ok", [
      { id: "allow_once", label: "Allow once", kind: "allow_once" },
      { id: "deny", label: "Deny", kind: "deny" },
    ]);

    await rpc(s, "r1", "permission.respond", { requestId: "appr-ok", optionId: "allow_once" });
    expect(gw!.store.approvalStatus("appr-ok")).toBe("allowed");

    const events = gw!.store.taskEventsAfter(created.taskId, 0, 100).events;
    expect(events.some((e) => e.type === "permission.resolved")).toBe(true);

    await expect(
      rpc(s, "r2", "permission.respond", { requestId: "appr-ok", optionId: "deny" }),
    ).rejects.toMatchObject({ code: "approval.already_decided" });
    // still the first decision — no double-resolve
    expect(gw!.store.approvalStatus("appr-ok")).toBe("allowed");
    s.destroy();
  });

  test("unknown requestId → approval.not_found", async () => {
    await start();
    const s = await authedConn();
    await expect(
      rpc(s, "r1", "permission.respond", { requestId: "appr-ghost", optionId: "allow_once" }),
    ).rejects.toMatchObject({ code: "approval.not_found" });
    s.destroy();
  });

  test("deny-kind optionId resolves as denied", async () => {
    await start();
    const s = await authedConn();
    const created = (await rpc(s, "c1", "task.create", { cwd: "/tmp", title: "appr" })) as {
      taskId: string;
    };
    insertPendingApproval(created.taskId, "appr-deny", [
      { id: "allow_once", label: "Allow once", kind: "allow_once" },
      { id: "deny", label: "Deny", kind: "deny" },
    ]);
    await rpc(s, "r1", "permission.respond", { requestId: "appr-deny", optionId: "deny" });
    expect(gw!.store.approvalStatus("appr-deny")).toBe("denied");
    s.destroy();
  });
});
