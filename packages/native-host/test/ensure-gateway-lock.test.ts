/**
 * ensureGateway startup-lock contention tests — plan §7.3 cases #10–#12
 * and §3.3.2 crash/reclaim table, host side.
 *
 * Scope note: the two-lock ownership protocol (gateway.startup.lock +
 * gateway.lock, OS flock + fencing) lives in the GATEWAY process
 * (packages/bridge/src/gateway/lock.ts) and is covered by
 * packages/bridge/test/gateway.test.ts. The native host deliberately
 * holds NO client-side startup lock (see gateway-client.ts comment):
 * concurrent spawners are safe because the gateway's lifetime flock
 * admits exactly one process and losers exit during boot.
 *
 * These tests therefore exercise the HOST-side contract around spawn:
 *  - concurrent cold start → both hosts attach, one gateway survives
 *  - host gives up mid-boot → next host attaches, no second spawn
 *  - live owner + unreachable/unresponsive IPC → `unresponsive`,
 *    NO spawn attempt, lock files untouched
 *  - spawned gateway dies during boot → typed error at deadline
 *
 * The fake gateway bin simulates the lifetime lock with a lockfile +
 * PID-liveness check (same reclaim rule as the real flock: dead owner
 * → reclaim, live owner → exit 0 "already running"). It appends every
 * spawn attempt to <home>/spawns.log so tests can count spawn storms.
 */

import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureGateway } from "../src/index.js";

const TOKEN = "d".repeat(64);

/**
 * Fake gateway with lifetime-lock simulation. Env knobs:
 *  - CHROMEX_GATEWAY_HOME   data dir (set by ensureGateway spawn)
 *  - FAKE_GW_DELAY_MS       delay before listen+endpoint publish
 * Records spawn attempts to <home>/spawns.log BEFORE the lock check so
 * losing spawns are counted too.
 */
const FAKE_GATEWAY_BIN = `
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const home = process.env.CHROMEX_GATEWAY_HOME;
if (!home) process.exit(2);
fs.mkdirSync(path.join(home, "run"), { recursive: true });
fs.mkdirSync(path.join(home, "auth"), { recursive: true });
const token = "${TOKEN}";

fs.appendFileSync(path.join(home, "spawns.log"), String(process.pid) + "\\n");

// ---- lifetime lock (§3.3.2): one gateway per dataDir ----
// lockfile + owner-pid liveness ≈ the real flock semantics for tests:
// live owner → exit during boot; verified-dead owner → reclaim.
const lockPath = path.join(home, "gateway.lock");
let locked = false;
for (let attempt = 0; attempt < 3 && !locked; attempt++) {
  try {
    const fd = fs.openSync(lockPath, "wx", 0o600);
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, fence: "f" + process.pid }));
    fs.closeSync(fd);
    locked = true;
  } catch (e) {
    if (!e || e.code !== "EEXIST") throw e;
    let ownerPid = 0;
    try { ownerPid = JSON.parse(fs.readFileSync(lockPath, "utf8")).pid || 0; } catch {}
    let ownerAlive = false;
    if (ownerPid) { try { process.kill(ownerPid, 0); ownerAlive = true; } catch {} }
    if (ownerAlive) process.exit(0);            // "already running" — loser exits during boot
    try { fs.unlinkSync(lockPath); } catch {}   // verified dead owner → reclaim
  }
}
if (!locked) process.exit(3);

fs.writeFileSync(path.join(home, "auth", "token"), token, { mode: 0o600 });

const delayMs = Number(process.env.FAKE_GW_DELAY_MS || "0");
const sockPath = path.join(home, "run", "gw.sock");
const server = net.createServer((socket) => {
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      const env = JSON.parse(body.toString("utf8"));
      if (env.kind !== "request") continue;
      const respond = (result, error = null) => {
        const res = error
          ? { v: 1, kind: "response", id: env.id, error }
          : { v: 1, kind: "response", id: env.id, result };
        const b = Buffer.from(JSON.stringify(res), "utf8");
        const h = Buffer.allocUnsafe(4);
        h.writeUInt32LE(b.length, 0);
        socket.write(Buffer.concat([h, b]));
      };
      if (env.method === "hello") {
        if (env.payload && env.payload.token === token) {
          respond({
            gatewayVersion: "fake-lock", protocolVersion: 1,
            providers: [], backends: [], tasks: [], features: {},
            gatewayLastSeq: 0,
          });
        } else {
          respond(null, { code: "proto.auth_failed", message: "bad token", retryable: false, requiresUserAction: false, sideEffectState: "none" });
          socket.destroy();
        }
        continue;
      }
      respond({ ok: true });
    }
  });
});
setTimeout(() => {
  server.listen(sockPath, () => {
    const ep = {
      transport: "unix", path: sockPath, gatewayPid: process.pid,
      startedAt: Date.now(), gatewayVersion: "fake-lock", tokenRef: "auth/token",
    };
    const tmp = path.join(home, "run", "gateway.json.tmp");
    fs.writeFileSync(tmp, JSON.stringify(ep));
    fs.renameSync(tmp, path.join(home, "run", "gateway.json"));
  });
}, delayMs);

// Self-terminate once the test removes the data dir.
setInterval(() => {
  try { fs.accessSync(home); } catch { process.exit(0); }
}, 250).unref();
`;

const HELLO = {
  protocolVersion: 1 as const,
  clientId: "lock-test",
  profileId: "lock-profile",
  browserInstanceId: null,
  hostInstanceId: "host-lock",
};

async function writeEndpoint(
  dir: string,
  socketPath: string,
  gatewayPid = process.pid,
): Promise<void> {
  await fs.mkdir(path.join(dir, "run"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "run", "gateway.json"),
    JSON.stringify({
      transport: "unix",
      path: socketPath,
      gatewayPid,
      startedAt: Date.now(),
      gatewayVersion: "stale",
      tokenRef: "auth/token",
    }),
  );
}

async function writeToken(dir: string): Promise<void> {
  await fs.mkdir(path.join(dir, "auth"), { recursive: true });
  await fs.writeFile(path.join(dir, "auth", "token"), TOKEN, { mode: 0o600 });
}

async function spawnAttempts(dir: string): Promise<number[]> {
  try {
    const raw = await fs.readFile(path.join(dir, "spawns.log"), "utf8");
    return raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map(Number);
  } catch {
    return [];
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("ensureGateway startup-lock contention", () => {
  let dir: string;
  let binPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ensure-lock-"));
    binPath = path.join(dir, "fake-gateway.mjs");
    await fs.writeFile(binPath, FAKE_GATEWAY_BIN);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("concurrent cold start: two hosts race, both attach, exactly one gateway survives", async () => {
    // §7.3 #11 / §3.3.2 #6 analog: no client-side startup lock exists —
    // safety comes from the gateway lifetime lock. Both hosts may spawn;
    // losers must exit during boot and both hosts must end up on the
    // same published endpoint.
    const [c1, c2] = await Promise.all([
      ensureGateway(dir, { hello: HELLO, gatewayBin: binPath, startupTimeoutMs: 15_000 }),
      ensureGateway(dir, { hello: HELLO, gatewayBin: binPath, startupTimeoutMs: 15_000 }),
    ]);

    expect(c1.hello.gatewayVersion).toBe("fake-lock");
    expect(c2.hello.gatewayVersion).toBe("fake-lock");
    await expect(c1.request("task.list", {})).resolves.toEqual({ ok: true });
    await expect(c2.request("task.list", {})).resolves.toEqual({ ok: true });

    const spawns = await spawnAttempts(dir);
    expect(spawns.length).toBeGreaterThanOrEqual(1);

    // Let boot losers finish exiting, then exactly one spawned gateway
    // may still be alive.
    await new Promise((r) => setTimeout(r, 600));
    const survivors = spawns.filter(pidAlive);
    expect(survivors).toHaveLength(1);

    // The published endpoint belongs to the survivor.
    const ep = JSON.parse(await fs.readFile(path.join(dir, "run", "gateway.json"), "utf8"));
    expect(ep.gatewayPid).toBe(survivors[0]);

    c1.close();
    c2.close();
  });

  test("host gives up mid-boot: next host attaches to the still-booting gateway, no duplicate survives", async () => {
    // §3.3.2 #2 analog: first host spawns then hits its deadline before
    // the gateway publishes; a second host arrives while the gateway is
    // still booting.
    //
    // KNOWN GAP vs plan: the host has no client-side startup lock and no
    // in-flight-boot marker, so it cannot distinguish "no gateway" from
    // "gateway mid-boot" — it spawns a duplicate on the first
    // endpoint_missing. Safety comes from the gateway lifetime lock:
    // the duplicate exits during boot and exactly one gateway survives.
    // (Client-side startup-lock serialization is the documented later
    // refinement in gateway-client.ts.)
    await expect(
      ensureGateway(dir, {
        hello: HELLO,
        gatewayBin: binPath,
        startupTimeoutMs: 600,
        env: { FAKE_GW_DELAY_MS: "1200" },
      }),
    ).rejects.toMatchObject({ code: "endpoint_missing" });

    const conn = await ensureGateway(dir, {
      hello: HELLO,
      gatewayBin: binPath,
      startupTimeoutMs: 10_000,
    });
    expect(conn.hello.gatewayVersion).toBe("fake-lock");
    await expect(conn.request("task.list", {})).resolves.toEqual({ ok: true });

    // Both hosts may have spawned (no startup lock), but the lifetime
    // lock admits exactly one survivor and both attach to its endpoint.
    const spawns = await spawnAttempts(dir);
    expect(spawns.length).toBeGreaterThanOrEqual(1);
    expect(spawns.length).toBeLessThanOrEqual(2);
    await new Promise((r) => setTimeout(r, 600));
    const survivors = spawns.filter(pidAlive);
    expect(survivors).toHaveLength(1);
    const ep = JSON.parse(await fs.readFile(path.join(dir, "run", "gateway.json"), "utf8"));
    expect(ep.gatewayPid).toBe(survivors[0]);
    conn.close();
  });

  test("healthy gateway already running: ensureGateway attaches without spawning", async () => {
    // §3.3.2 #1/#5 attach path: endpoint + live pid + working hello →
    // no spawn, gateway.log never created.
    const c1 = await ensureGateway(dir, {
      hello: HELLO,
      gatewayBin: binPath,
      startupTimeoutMs: 10_000,
    });
    c1.close();

    const c2 = await ensureGateway(dir, {
      hello: HELLO,
      gatewayBin: binPath,
      startupTimeoutMs: 10_000,
    });
    expect(c2.hello.gatewayVersion).toBe("fake-lock");
    c2.close();

    expect(await spawnAttempts(dir)).toHaveLength(1);
    const log = await fs.readFile(path.join(dir, "gateway.log"), "utf8");
    expect(log.match(/--- spawn/g)).toHaveLength(1);
  });

  test("live owner, IPC accepts but never responds → unresponsive, NO spawn, locks untouched", async () => {
    // §3.3.2 5b / §7.3 #12 analog: gateway process alive (pid = self),
    // socket bound, but hello is never answered → `unresponsive` after
    // the deadline. Host must not spawn and must not delete lock files
    // (it never manages them — assert sentinels survive).
    const sockPath = path.join(dir, "run", "silent.sock");
    await fs.mkdir(path.dirname(sockPath), { recursive: true });
    // Track sockets: a silent server never reads, so client destroy()
    // leaves its side half-open and server.close() would hang.
    const silentConns = new Set<net.Socket>();
    const silent = net.createServer((s) => {
      silentConns.add(s);
      s.on("close", () => silentConns.delete(s));
      /* accept and hold — never respond */
    });
    await new Promise<void>((r) => silent.listen(sockPath, r));
    await writeEndpoint(dir, sockPath);
    await writeToken(dir);
    await fs.writeFile(path.join(dir, "gateway.lock"), "SENTINEL-LIFETIME");
    await fs.writeFile(path.join(dir, "gateway.startup.lock"), "SENTINEL-STARTUP");

    const logs: string[] = [];
    const started = Date.now();
    await expect(
      ensureGateway(dir, {
        hello: HELLO,
        gatewayBin: binPath,
        startupTimeoutMs: 1_200,
        log: (m) => logs.push(m),
      }),
    ).rejects.toMatchObject({ code: "unresponsive" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_000);

    expect(logs.some((m) => m.includes("spawning gateway"))).toBe(false);
    await expect(fs.access(path.join(dir, "gateway.log"))).rejects.toThrow();
    expect(await spawnAttempts(dir)).toHaveLength(0);
    expect(await fs.readFile(path.join(dir, "gateway.lock"), "utf8")).toBe("SENTINEL-LIFETIME");
    expect(await fs.readFile(path.join(dir, "gateway.startup.lock"), "utf8")).toBe(
      "SENTINEL-STARTUP",
    );

    for (const s of silentConns) s.destroy();
    await new Promise<void>((r) => silent.close(() => r()));
  });

  test("live owner, IPC refused → unresponsive + backoff, NO spawn", async () => {
    // §3.3.2 5b: endpoint + live pid but nothing listens on the socket.
    // connect_failed is only reachable after the pid check passed, so it
    // means "owner alive, IPC down" → retried inside the deadline and
    // surfaced as `unresponsive`; spawning is reserved for dead/absent
    // owners (endpoint_stale / endpoint_missing).
    await writeEndpoint(dir, path.join(dir, "run", "nobody.sock"));
    await writeToken(dir);

    const logs: string[] = [];
    await expect(
      ensureGateway(dir, {
        hello: HELLO,
        gatewayBin: binPath,
        startupTimeoutMs: 1_200,
        log: (m) => logs.push(m),
      }),
    ).rejects.toMatchObject({ code: "unresponsive" });

    expect(logs.some((m) => m.includes("spawning gateway"))).toBe(false);
    await expect(fs.access(path.join(dir, "gateway.log"))).rejects.toThrow();
    expect(await spawnAttempts(dir)).toHaveLength(0);
  });

  test("live owner answers hello with gateway.unresponsive → backoff retry, NO spawn", async () => {
    // §3.3.2 5b / §7.3 #12: owner alive and IPC bound, but the gateway
    // itself reports unresponsive (e.g. mid-recovery). Host retries with
    // backoff inside the deadline — multiple hello attempts prove the
    // retry loop ran — and never spawns.
    const sockPath = path.join(dir, "run", "gw-unresp.sock");
    await fs.mkdir(path.dirname(sockPath), { recursive: true });
    let hellos = 0;
    const unrespConns = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      unrespConns.add(socket);
      socket.on("close", () => unrespConns.delete(socket));
      let buf = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        if (buf.length < 4) return;
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) return;
        const env = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
        buf = Buffer.alloc(0);
        if (env.kind !== "request" || env.method !== "hello") return;
        hellos++;
        const res = {
          v: 1,
          kind: "response",
          id: env.id,
          error: {
            code: "gateway.unresponsive",
            message: "gateway still recovering",
            retryable: true,
            requiresUserAction: false,
            sideEffectState: "none",
          },
        };
        const b = Buffer.from(JSON.stringify(res), "utf8");
        const h = Buffer.allocUnsafe(4);
        h.writeUInt32LE(b.length, 0);
        socket.write(Buffer.concat([h, b]));
      });
    });
    await new Promise<void>((r) => server.listen(sockPath, r));
    await writeEndpoint(dir, sockPath);
    await writeToken(dir);

    const logs: string[] = [];
    await expect(
      ensureGateway(dir, {
        hello: HELLO,
        gatewayBin: binPath,
        startupTimeoutMs: 2_000,
        log: (m) => logs.push(m),
      }),
    ).rejects.toMatchObject({ code: "unresponsive" });

    // Backoff 250ms→5s jittered inside the 2s deadline → several attempts.
    expect(hellos).toBeGreaterThanOrEqual(2);
    expect(logs.some((m) => m.includes("spawning gateway"))).toBe(false);
    await expect(fs.access(path.join(dir, "gateway.log"))).rejects.toThrow();
    expect(await spawnAttempts(dir)).toHaveLength(0);

    for (const s of unrespConns) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });

  test("spawned gateway dies during boot (bind-fail analog) → typed error at deadline, spawn logged", async () => {
    // §3.3.2 #7 host side: the gateway fails to come up (here: exits
    // immediately, e.g. IPC bind failure). Host surfaces a typed error
    // after the deadline and the child's stderr lands in gateway.log.
    const dyingBin = path.join(dir, "dying-gateway.mjs");
    await fs.writeFile(
      dyingBin,
      `console.error("bind failed: address already in use");\nprocess.exit(3);\n`,
    );

    await expect(
      ensureGateway(dir, {
        hello: HELLO,
        gatewayBin: dyingBin,
        startupTimeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "endpoint_missing" });

    const log = await fs.readFile(path.join(dir, "gateway.log"), "utf8");
    expect(log).toContain("--- spawn");
    expect(log).toContain("bind failed");
    // Host spawned at most once per ensureGateway call.
    expect(log.match(/--- spawn/g)).toHaveLength(1);
  });
});
