import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { GatewayIpcServer } from "../src/gateway/ipc-server.js";

let dir: string;
let gw: { ipc: GatewayIpcServer; shutdown: (r?: string) => Promise<void>; store: { getTask: (id: string) => { taskId: string; status: string } | undefined }; dataDir: string } | null = null;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-rpc-"));
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
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      socket.off("data", onData);
      const env = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      if (env.kind === "response" && env.error) reject(env.error);
      else resolve(env.result ?? env);
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
    hostInstanceId: "h1",
  });
  return s;
}

async function start() {
  const { startGateway } = await import("../src/gateway/main.js");
  gw = (await startGateway({ dataDir: dir, log: () => {} })) as typeof gw;
  return gw!;
}

describe("gateway RPC surface (P1-07)", () => {
  test("proto.invalid on schema violation; proto.unknown_method on unknown", async () => {
    await start();
    const s = await authedConn();
    await expect(rpc(s, "b1", "task.send", { taskId: "x" })).rejects.toMatchObject({
      code: "proto.invalid",
    });
    await expect(rpc(s, "b2", "no.such.method", {})).rejects.toMatchObject({
      code: "proto.unknown_method",
    });
    s.destroy();
  });

  test("task.get / task.reopen / task.setBackend / task.snapshot.chunk", async () => {
    await start();
    const s = await authedConn();
    const created = (await rpc(s, "c1", "task.create", { cwd: "/tmp", title: "t" })) as {
      taskId: string;
    };

    const got = (await rpc(s, "g1", "task.get", { taskId: created.taskId })) as {
      task: { taskId: string; status: string };
      attention: unknown;
    };
    expect(got.task.taskId).toBe(created.taskId);

    // setBackend persists + emits backend_changed
    const sb = (await rpc(s, "sb", "task.setBackend", {
      taskId: created.taskId,
      backend: { backendId: "playwright-isolated", pinnedBy: "user" },
    })) as { backend: { backendId: string } };
    expect(sb.backend.backendId).toBe("playwright-isolated");

    // snapshot: inline (small) → has storage.kind inline
    const snap = (await rpc(s, "sn", "task.snapshot", { taskId: created.taskId })) as {
      storage: { kind: string };
    };
    expect(snap.storage.kind).toBe("inline");

    // bogus chunk ref → task.not_found
    await expect(
      rpc(s, "ch", "task.snapshot.chunk", { taskId: created.taskId, snapshotRef: "nope", chunkIndex: 0 }),
    ).rejects.toMatchObject({ code: "task.not_found" });

    // cancel → reopen → active
    await rpc(s, "x1", "task.cancel", { taskId: created.taskId });
    const re = (await rpc(s, "ro", "task.reopen", { taskId: created.taskId })) as { status: string };
    expect(re.status).toBe("active");
    s.destroy();
  });

  test("config.read redacts env; config.update persists + validates", async () => {
    await fs.writeFile(
      path.join(dir, "gateway.json"),
      JSON.stringify({ providers: { codex: { env: { SECRET_KEY: "abc" } } } }),
    );
    await start();
    const s = await authedConn();
    const rd = (await rpc(s, "cr", "config.read", {})) as {
      config: { providers: { codex: { env: Record<string, string> } } };
    };
    expect(rd.config.providers.codex.env.SECRET_KEY).toBe("•••");

    const up = (await rpc(s, "cu", "config.update", {
      patch: { tasks: { queueWhileRunning: false } },
    })) as { config: { tasks: { queueWhileRunning: boolean } } };
    expect(up.config.tasks.queueWhileRunning).toBe(false);

    // unknown top-level key rejected
    await expect(rpc(s, "cu2", "config.update", { patch: { bogus: 1 } })).rejects.toThrow();
    s.destroy();
  });

  test("provider.catalog + browser.backend.status respond", async () => {
    await start();
    const s = await authedConn();
    const cat = (await rpc(s, "pc", "provider.catalog", {})) as { catalogs: unknown[] };
    expect(Array.isArray(cat.catalogs)).toBe(true);
    const bs = (await rpc(s, "bb", "browser.backend.status", {})) as {
      playwrightIsolated: { available: boolean };
    };
    expect(typeof bs.playwrightIsolated.available).toBe("boolean");
    s.destroy();
  });

  test("compat: session.open → {threadId}; prompt.send without threadId → proto.invalid", async () => {
    await start();
    const s = await authedConn();
    const opened = (await rpc(s, "so", "session.open", { cwd: "/tmp" })) as { threadId: string };
    expect(opened.threadId).toBeTruthy();
    expect(gw!.store.getTask(opened.threadId)?.status).toBe("active");

    await expect(rpc(s, "ps", "prompt.send", { message: "hi" })).rejects.toMatchObject({
      code: "proto.invalid",
    });
    // sidecar domain → proto.unsupported
    await expect(rpc(s, "im", "image.asset.folder", {})).rejects.toMatchObject({
      code: "proto.unsupported",
    });
    s.destroy();
  });

  test("task.purge cascades + emits gateway.task_purged tombstone", async () => {
    await start();
    const s = await authedConn();
    const created = (await rpc(s, "c1", "task.create", { cwd: "/tmp", title: "purge me" })) as {
      taskId: string;
    };
    const tid = created.taskId;
    expect(gw!.store.getTask(tid)).toBeTruthy();

    const res = (await rpc(s, "p1", "task.purge", { taskId: tid })) as { purged: boolean };
    expect(res.purged).toBe(true);
    expect(gw!.store.getTask(tid)).toBeUndefined();

    // tombstone on gateway stream — replayable via gateway.sync
    const sync = (await rpc(s, "gs", "gateway.sync", { fromSeq: 0 })) as {
      mode: string;
      events: Array<{ type: string; payload?: { taskId?: string; reason?: string } }>;
    };
    const tomb = sync.events.find(
      (e) => e.type === "gateway.task_purged" && e.payload?.taskId === tid,
    );
    expect(tomb).toBeTruthy();
    expect(tomb!.payload?.reason).toBe("user");

    // second purge → task.not_found
    await expect(rpc(s, "p2", "task.purge", { taskId: tid })).rejects.toMatchObject({
      code: "task.not_found",
    });
    s.destroy();
  });
});
