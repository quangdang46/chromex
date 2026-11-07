import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  acquireOwnershipLock,
  LockHeldError,
  readLockMetadata,
  type OwnershipLock,
} from "../src/gateway/lock.js";
import { GatewayIpcServer } from "../src/gateway/ipc-server.js";
import { resolveGatewayConfig, DEFAULT_GATEWAY_CONFIG } from "../src/gateway/config.js";
import { ulid } from "../src/gateway/ulid.js";
import { InMemoryStore } from "../src/gateway/store-memory.js";
import { parseHelloRequest, buildHelloResponse, GATEWAY_VERSION } from "../src/gateway/hello.js";

let dir: string;
const locks: OwnershipLock[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "chromex-gw-"));
});

afterEach(async () => {
  for (const l of locks.splice(0)) await l.release().catch(() => {});
  await fs.rm(dir, { recursive: true, force: true });
});

async function acquire(kind: "startup" | "lifetime" = "lifetime"): Promise<OwnershipLock> {
  const lock = await acquireOwnershipLock(dir, kind);
  locks.push(lock);
  return lock;
}

/** Child process that flocks gateway.lock and sleeps — plain JS, no TS. */
function spawnLockHolder(): { pid: number; kill: () => void } {
  const script = `
    const fs = require("fs");
    const fse = require("fs-ext");
    const fd = fs.openSync(${JSON.stringify(path.join("{DIR}", "gateway.lock"))}, "a+");
    fse.flock(fd, fse.constants.LOCK_EX, () => {
      fs.writeFileSync(${JSON.stringify(path.join("{DIR}", "holder.ready"))}, "ready");
      setInterval(() => {}, 1000);
    });
  `.replaceAll("{DIR}", dir);
  const child = spawn(process.execPath, ["-e", script], {
    stdio: "ignore",
    cwd: path.resolve(__dirname, ".."),
  });
  return { pid: child.pid!, kill: () => child.kill("SIGKILL") };
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    try {
      await fs.access(file);
      return;
    } catch {
      if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${file}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

describe("gateway ownership lock", () => {
  test("second acquisition of same lock fails with LockHeldError + metadata", async () => {
    const first = await acquire();
    expect(first.isHeld()).toBe(true);
    expect(first.fence).toBeTruthy();

    const meta = await readLockMetadata(path.join(dir, "gateway.lock"));
    expect(meta?.pid).toBe(process.pid);
    expect(meta?.fence).toBe(first.fence);

    await expect(acquireOwnershipLock(dir, "lifetime")).rejects.toBeInstanceOf(LockHeldError);
    await expect(acquireOwnershipLock(dir, "lifetime")).rejects.toMatchObject({
      heldBy: { pid: process.pid },
    });
  });

  test("startup and lifetime locks are independent files", async () => {
    const lifetime = await acquire("lifetime");
    const startup = await acquire("startup");
    expect(lifetime.fence).not.toBe(startup.fence);
    expect(lifetime.kind).toBe("lifetime");
    expect(startup.kind).toBe("startup");
  });

  test("release allows reacquire with a NEW fence (new ownership generation)", async () => {
    const first = await acquire();
    const fence1 = first.fence;
    await first.release();
    locks.splice(locks.indexOf(first), 1);

    const second = await acquire();
    expect(second.fence).not.toBe(fence1);
    const meta = await readLockMetadata(path.join(dir, "gateway.lock"));
    expect(meta?.fence).toBe(second.fence);
  });

  test("SIGSTOPped holder still owns the lock — no mtime reclaim", async () => {
    const holder = spawnLockHolder();
    try {
      await waitForFile(path.join(dir, "holder.ready"));
      process.kill(holder.pid, "SIGSTOP");
      // even stopped >0ms, OS lock is held — acquisition must fail
      await expect(acquireOwnershipLock(dir, "lifetime")).rejects.toBeInstanceOf(
        LockHeldError,
      );
      process.kill(holder.pid, "SIGCONT");
    } finally {
      holder.kill();
    }
  });

  test("kill → OS releases lock → reacquire bumps fence", async () => {
    const holder = spawnLockHolder();
    await waitForFile(path.join(dir, "holder.ready"));
    const before = await readLockMetadata(path.join(dir, "gateway.lock"));
    holder.kill();
    // wait for OS to reap
    await new Promise((r) => setTimeout(r, 150));

    const lock = await acquire();
    const after = await readLockMetadata(path.join(dir, "gateway.lock"));
    expect(after?.fence).toBe(lock.fence);
    expect(after?.fence).not.toBe(before?.fence ?? "");
  });
});

describe("gateway config (§5.8)", () => {
  test("defaults are sane and maxEnvelopeBytes at hard cap", () => {
    expect(DEFAULT_GATEWAY_CONFIG.gateway.maxEnvelopeBytes).toBe(768 * 1024);
    expect(DEFAULT_GATEWAY_CONFIG.gateway.autoStart).toBe(true);
    expect(DEFAULT_GATEWAY_CONFIG.browser.policy.allowEvaluate).toBe(false);
    expect(DEFAULT_GATEWAY_CONFIG.providers.claude.enabled).toBe(false);
  });

  test("rejects unknown keys and bad version", () => {
    expect(() => resolveGatewayConfig({ bogus: 1 })).toThrow(/unknown key/);
    expect(() => resolveGatewayConfig({ version: 2 })).toThrow(/version/);
  });

  test("clamps maxEnvelopeBytes to hard cap", () => {
    const cfg = resolveGatewayConfig({ gateway: { maxEnvelopeBytes: 5 * 1024 * 1024 } });
    expect(cfg.gateway.maxEnvelopeBytes).toBeLessThanOrEqual(768 * 1024);
  });
});

describe("gateway IPC + hello", () => {
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

  test("wrong/missing token → auth_failed + socket closed", async () => {
    const server = new GatewayIpcServer(dir, 768 * 1024, async () => ({}));
    const ep = await server.listen();
    try {
      const s = await connect(ep.path);
      await expect(
        rpc(s, "r1", "hello", { token: "0".repeat(64), protocolVersion: 1 }),
      ).rejects.toMatchObject({ code: "proto.auth_failed" });
      await new Promise((r) => s.on("close", r));
    } finally {
      await server.close();
    }
  });

  test("hello returns providers/backends/tasks + gatewayLastSeq", async () => {
    const store = new InMemoryStore();
    store.appendGatewayEvent({ type: "gateway.started", version: GATEWAY_VERSION, recoveredTurns: 0, recoveredTasks: 0 });
    const server = new GatewayIpcServer(dir, 768 * 1024, async (req) => {
      if (req.method === "hello") {
        const parsed = parseHelloRequest(req.payload);
        if ("error" in parsed) throw new Error(parsed.error);
        return buildHelloResponse(parsed, {
          store,
          config: resolveGatewayConfig(null),
          providers: [
            { id: "codex", available: true, capabilities: {} as never },
            { id: "claude", available: false, capabilities: {} as never },
          ],
        });
      }
      throw new Error("unexpected");
    });
    const ep = await server.listen();
    server.markReady();
    try {
      const s = await connect(ep.path);
      const token = (await GatewayIpcServer.readToken(dir))!;
      void token;
      const helloPayload = {
        token: server.tokenBytes.toString("hex"),
        clientVersion: "test",
        protocolVersion: 1,
        clientId: "c1",
        profileId: "p1",
        browserInstanceId: null,
        hostInstanceId: "h1",
      };
      const res = (await rpc(s, "h1", "hello", helloPayload)) as {
        gatewayVersion: string;
        gatewayLastSeq: number;
        backends: Array<{ id: string; available: boolean }>;
      };
      expect(res.gatewayVersion).toBe(GATEWAY_VERSION);
      expect(res.gatewayLastSeq).toBe(1);
      expect(res.backends.map((b) => b.id)).toContain("chrome-extension");
      s.destroy();
    } finally {
      await server.close();
    }
  });

  test("endpoint publish is atomic (gateway.json exists, no .tmp)", async () => {
    const server = new GatewayIpcServer(dir, 768 * 1024, async () => ({}));
    const ep = await server.listen();
    try {
      const raw = JSON.parse(
        await fs.readFile(path.join(dir, "run", "gateway.json"), "utf8"),
      );
      expect(raw.gatewayPid).toBe(process.pid);
      expect(raw.tokenRef).toBe("auth/token");
      expect(raw.path).toBe(ep.path);
      // token never appears in endpoint file
      expect(JSON.stringify(raw)).not.toContain(server.tokenBytes.toString("hex"));
      await expect(fs.access(path.join(dir, "run", "gateway.json.tmp"))).rejects.toThrow();
    } finally {
      await server.close();
    }
  });
});

describe("ulid", () => {
  test("generates 26-char sortable ids", () => {
    const a = ulid(1000);
    const b = ulid(2000);
    expect(a).toHaveLength(26);
    expect(b.length).toBe(26);
    expect(a < b).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe("gateway boot with store=sqlite", () => {
  test("boots, serves hello, persists gateway.started across reopen", async () => {
    const { startGateway } = await import("../src/gateway/main.js");
    await fs.writeFile(
      path.join(dir, "gateway.json"),
      JSON.stringify({ store: "sqlite" }),
    );
    const gw = await startGateway({ dataDir: dir, log: () => {} });
    try {
      expect(gw.db).not.toBeNull();
      expect(gw.config.store).toBe("sqlite");
      // gateway.started durable event persisted
      const seq = gw.store.lastGatewaySeq();
      expect(seq).toBe(1);
    } finally {
      await gw.shutdown("test");
    }
    // reopen: seq continues (durable), not reset
    const gw2 = await startGateway({ dataDir: dir, log: () => {} });
    try {
      expect(gw2.store.lastGatewaySeq()).toBe(2);
    } finally {
      await gw2.shutdown("test");
    }
  });
});

describe("stale-fence write refusal (§3.3.2)", () => {
  test("lock file replaced → checkFence false → store guard throws", async () => {
    const { acquireOwnershipLock, StaleFenceError } = await import(
      "../src/gateway/lock.js"
    );
    const lock = await acquireOwnershipLock(dir, "lifetime");
    try {
      expect(lock.checkFence()).toBe(true);
      // simulate file replaced by a new generation (new inode scenario):
      // overwrite metadata with a different fence
      const metaPath = path.join(dir, "gateway.lock");
      const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
      meta.fence = "01JFAKEFENCE0000000000000";
      await fs.writeFile(metaPath, JSON.stringify(meta));
      expect(lock.checkFence()).toBe(false);

      const { SQLiteStore } = await import("../src/store/sqlite-store.js");
      const { openGatewayDb } = await import("../src/store/db.js");
      const db = await openGatewayDb(dir);
      const store = new SQLiteStore(db, {
        assertOwnership: () => {
          if (!lock.checkFence()) throw new StaleFenceError("lifetime");
        },
      });
      // any durable write must refuse
      expect(() =>
        store.appendGatewayEvent({ type: "gateway.started", version: "test" } as never),
      ).toThrow(StaleFenceError);
      db.close();
    } finally {
      await lock.release();
    }
  });
});
