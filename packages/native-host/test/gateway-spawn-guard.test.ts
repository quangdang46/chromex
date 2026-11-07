/**
 * ensureGateway spawn-guard tests — chromex-1pj / plan §3.3.1.
 *
 * Covers the three client-side gaps left by chromex-ec1:
 *  1. Client start lock (`run/gateway.start.lock`, OS flock): a second
 *     native host must NOT spawn while another holds it — it waits for
 *     the in-flight spawn's endpoint instead.
 *  2. PID-reuse guard: an endpoint whose gatewayPid is alive but whose
 *     startedAt predates the process start is a recycled PID →
 *     endpoint_stale → spawn-eligible, never "live owner".
 *  3. Spawn budget (`run/gateway.spawns.json`): spawn_in_flight
 *     suppression + rate_limited cap stop respawn loops when the gateway
 *     keeps dying.
 */

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import * as fsExt from "fs-ext";

import { endpointPidAlive, ensureGateway, GatewayConnection } from "../src/index.js";
import {
  gatewaySpawnBudget,
  recordGatewaySpawn,
  SPAWN_IN_FLIGHT_MS,
  SPAWN_RATE_MAX,
  SPAWN_RATE_WINDOW_MS,
} from "../src/start-lock.js";

const HELLO = {
  protocolVersion: 1 as const,
  clientId: "guard-test",
  profileId: "guard-profile",
  browserInstanceId: null,
  hostInstanceId: "host-guard",
};

/** Records a spawn attempt then exits — proves ensureGateway spawned
 *  without needing a working gateway. */
const RECORD_ONLY_BIN = `
import fs from "node:fs";
import path from "node:path";
const home = process.env.CHROMEX_GATEWAY_HOME;
if (!home) process.exit(2);
fs.appendFileSync(path.join(home, "spawns.log"), "x\\n");
`;

async function spawnAttempts(dir: string): Promise<number> {
  try {
    const raw = await fs.readFile(path.join(dir, "spawns.log"), "utf8");
    return raw.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

function flockExclusive(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsExt.flock(fd, fsExt.constants.LOCK_EX | fsExt.constants.LOCK_NB, (err) =>
      err ? reject(err) : resolve(),
    );
  });
}

function funlock(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsExt.flock(fd, fsExt.constants.LOCK_UN, (err) => (err ? reject(err) : resolve()));
  });
}

describe("gateway spawn guard", () => {
  let dir: string;
  let binPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-guard-"));
    binPath = path.join(dir, "record-gateway.mjs");
    await fs.writeFile(binPath, RECORD_ONLY_BIN);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("held start lock → no spawn; released → spawn proceeds", async () => {
    // Hold run/gateway.start.lock ourselves = another host mid-spawn.
    await fs.mkdir(path.join(dir, "run"), { recursive: true });
    const lockPath = path.join(dir, "run", "gateway.start.lock");
    const handle = await fs.open(lockPath, fsConstants.O_RDWR | fsConstants.O_CREAT, 0o600);
    await flockExclusive(handle.fd);

    const logs: string[] = [];
    try {
      await expect(
        ensureGateway(dir, {
          hello: HELLO,
          gatewayBin: binPath,
          startupTimeoutMs: 900,
          log: (m) => logs.push(m),
        }),
      ).rejects.toMatchObject({ code: "endpoint_missing" });
    } finally {
      await funlock(handle.fd);
      await handle.close();
    }

    // Lock held the whole call → spawn was never attempted.
    expect(logs.some((m) => m.includes("spawning gateway"))).toBe(false);
    expect(await spawnAttempts(dir)).toBe(0);
    await expect(fs.access(path.join(dir, "gateway.log"))).rejects.toThrow();

    // Lock released → next call spawns (record-only bin exits instantly,
    // so chromex-1kz surfaces `spawn_exited` as soon as the exit lands —
    // still proves the spawn happened exactly once).
    await expect(
      ensureGateway(dir, {
        hello: HELLO,
        gatewayBin: binPath,
        startupTimeoutMs: 900,
      }),
    ).rejects.toMatchObject({ code: "spawn_exited", retryable: false });
    expect(await spawnAttempts(dir)).toBe(1);
    const log = await fs.readFile(path.join(dir, "gateway.log"), "utf8");
    expect(log.match(/--- spawn/g)).toHaveLength(1);
  });

  test("PID-reuse guard: live pid + predating startedAt → endpoint_stale → spawn", async () => {
    // Endpoint claims gatewayPid = this test process (definitely alive)
    // but startedAt = epoch — impossible for the real owner, so the pid
    // must have been recycled. Without the guard this is "live owner,
    // IPC unreachable" → unresponsive, NO spawn.
    await fs.mkdir(path.join(dir, "run"), { recursive: true });
    await fs.writeFile(
      path.join(dir, "run", "gateway.json"),
      JSON.stringify({
        transport: "unix",
        path: path.join(dir, "run", "nobody.sock"),
        gatewayPid: process.pid,
        startedAt: 1,
        gatewayVersion: "stale",
        tokenRef: "auth/token",
      }),
    );

    await expect(GatewayConnection.connect(dir, { hello: HELLO })).rejects.toMatchObject({
      code: "endpoint_stale",
    });

    // ensureGateway treats it as no-live-owner → spawns once; the
    // record-only bin exits instantly, so chromex-1kz surfaces
    // `spawn_exited` rather than endpoint_stale at the deadline.
    // Generous deadline: the child's 'exit' event is async and can lag
    // a few hundred ms under parallel test load.
    await expect(
      ensureGateway(dir, {
        hello: HELLO,
        gatewayBin: binPath,
        startupTimeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: "spawn_exited", retryable: false });
    expect(await spawnAttempts(dir)).toBe(1);
  });

  test("endpointPidAlive: pid alive + fresh startedAt → true; recycled → false", async () => {
    expect(
      await endpointPidAlive({ gatewayPid: process.pid, startedAt: Date.now() } as never),
    ).toBe(true);
    // Process started long after startedAt=1 → recycled PID.
    expect(await endpointPidAlive({ gatewayPid: process.pid, startedAt: 1 } as never)).toBe(false);
    expect(await endpointPidAlive({ gatewayPid: 2 ** 30, startedAt: Date.now() } as never)).toBe(false);
  });

  test("spawn_in_flight suppression: recent spawn → no respawn", async () => {
    // A spawn 5s ago may still be booting; endpoint_missing is not proof
    // of death. ensureGateway must wait, not spawn again.
    await recordGatewaySpawn(dir, Date.now() - 5_000);

    const logs: string[] = [];
    await expect(
      ensureGateway(dir, {
        hello: HELLO,
        gatewayBin: binPath,
        startupTimeoutMs: 900,
        log: (m) => logs.push(m),
      }),
    ).rejects.toMatchObject({ code: "endpoint_missing" });

    expect(logs.some((m) => m.includes("spawn suppressed: spawn_in_flight"))).toBe(true);
    expect(logs.some((m) => m.includes("spawning gateway"))).toBe(false);
    expect(await spawnAttempts(dir)).toBe(0);
  });

  test("rate_limited: spawn storm ledger → suppressed until window slides", async () => {
    // SPAWN_RATE_MAX attempts inside the window, ALL older than
    // SPAWN_IN_FLIGHT_MS so the reason is specifically rate_limited.
    const now = Date.now();
    for (let i = 0; i < SPAWN_RATE_MAX; i++) {
      await recordGatewaySpawn(dir, now - SPAWN_IN_FLIGHT_MS - 1_000 - i * 5_000);
    }
    const budget = await gatewaySpawnBudget(dir, now);
    expect(budget).toEqual({ allowed: false, reason: "rate_limited" });

    const logs: string[] = [];
    await expect(
      ensureGateway(dir, {
        hello: HELLO,
        gatewayBin: binPath,
        startupTimeoutMs: 900,
        log: (m) => logs.push(m),
      }),
    ).rejects.toMatchObject({ code: "endpoint_missing" });

    expect(logs.some((m) => m.includes("spawn suppressed: rate_limited"))).toBe(true);
    expect(await spawnAttempts(dir)).toBe(0);
    await expect(fs.access(path.join(dir, "gateway.log"))).rejects.toThrow();
  });
});

describe("spawn budget ledger", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "spawn-budget-"));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("empty ledger → allowed; attempts age out of both windows", async () => {
    const now = Date.now();
    expect(await gatewaySpawnBudget(dir, now)).toEqual({ allowed: true });

    await recordGatewaySpawn(dir, now - SPAWN_IN_FLIGHT_MS - 1);
    // Older than in-flight window but inside rate window → allowed.
    expect(await gatewaySpawnBudget(dir, now)).toEqual({ allowed: true });

    // Past the rate window the attempt is pruned entirely.
    expect(await gatewaySpawnBudget(dir, now + SPAWN_RATE_WINDOW_MS + 1)).toEqual({
      allowed: true,
    });
  });

  test("in_flight then rate_limited boundaries", async () => {
    const t0 = Date.now();
    await recordGatewaySpawn(dir, t0);
    expect(await gatewaySpawnBudget(dir, t0 + SPAWN_IN_FLIGHT_MS - 1)).toEqual({
      allowed: false,
      reason: "spawn_in_flight",
    });

    // Age that attempt out of the in-flight window, then fill the rate
    // window: MAX+1 attempts inside SPAWN_RATE_WINDOW_MS → rate_limited
    // (checked before in_flight, so the just-recorded newest doesn't mask it).
    const fill = t0 + SPAWN_IN_FLIGHT_MS + 1;
    for (let i = 0; i < SPAWN_RATE_MAX; i++) {
      await recordGatewaySpawn(dir, fill - i * 1_000);
    }
    expect(await gatewaySpawnBudget(dir, fill)).toEqual({
      allowed: false,
      reason: "rate_limited",
    });
  });
});
