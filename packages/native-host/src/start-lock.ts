/**
 * Client-side gateway start lock + spawn budget — chromex-1pj / plan §3.3.1.
 *
 * The gateway's own LIFETIME flock (`gateway.lock`, held by the gateway
 * process) is the hard guarantee that only one gateway survives. These
 * host-side mechanisms keep NATIVE HOST processes from racing to spawn in
 * the first place:
 *
 *  - START lock (`run/gateway.start.lock`): an OS flock (fs-ext, same
 *    mechanism as packages/bridge/src/gateway/lock.ts) held by a host for
 *    the duration of its ensureGateway spawn decision. Contention means
 *    "another host is mid-spawn" → wait for its endpoint, never spawn.
 *    Deliberately NOT `gateway.startup.lock`: that file belongs to the
 *    gateway's own boot sequence and holding it across the connect wait
 *    would deadlock the gateway's boot.
 *
 *  - Spawn budget (`run/gateway.spawns.json`): a small ledger of recent
 *    spawn timestamps. Two suppressions, both fail-safe toward NOT
 *    spawning (the lifetime lock remains the correctness backstop):
 *      · spawn_in_flight — a spawn < SPAWN_IN_FLIGHT_MS ago may still be
 *        booting; endpoint_missing does not prove it died.
 *      · rate_limited — more than SPAWN_RATE_MAX spawns inside
 *        SPAWN_RATE_WINDOW_MS means the gateway keeps dying; stop
 *        respawning until the window slides.
 *
 * Both files live under run/ so `rm -rf run/` (the documented stale-state
 * reset) clears them too.
 */

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import * as fsExt from "fs-ext";

export interface GatewayStartLock {
  readonly filePath: string;
  release(): Promise<void>;
}

function startLockPath(dataDir: string): string {
  return path.join(dataDir, "run", "gateway.start.lock");
}

function spawnLedgerPath(dataDir: string): string {
  return path.join(dataDir, "run", "gateway.spawns.json");
}

function tryFlockExclusive(fd: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    fsExt.flock(fd, fsExt.constants.LOCK_EX | fsExt.constants.LOCK_NB, (err) => {
      if (!err) {
        resolve(true);
        return;
      }
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EWOULDBLOCK" || code === "EAGAIN") {
        resolve(false);
        return;
      }
      reject(err);
    });
  });
}

function unlockFlock(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsExt.flock(fd, fsExt.constants.LOCK_UN, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Try to take the client start lock. Returns null when another host holds
 * it (LOCK_NB → EWOULDBLOCK); throws on real fs/flock errors — the caller
 * decides whether to fail open. The OS releases the lock on process death,
 * so there is never a stale lock to reclaim.
 */
export async function tryAcquireGatewayStartLock(dataDir: string): Promise<GatewayStartLock | null> {
  const filePath = startLockPath(dataDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const handle = await fs.open(filePath, fsConstants.O_RDWR | fsConstants.O_CREAT, 0o600);

  let acquired = false;
  try {
    acquired = await tryFlockExclusive(handle.fd);
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
  if (!acquired) {
    await handle.close().catch(() => {});
    return null;
  }

  // Best-effort holder metadata for diagnostics ("who is mid-spawn").
  // Same write-through-fd shape as the gateway's own lock metadata.
  try {
    const payload = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
    await handle.writeFile(payload, { encoding: "utf8" });
    await handle.truncate(Buffer.byteLength(payload));
  } catch {
    /* diagnostics only — never block the spawn path */
  }

  let held = true;
  return {
    filePath,
    release: async () => {
      if (!held) return;
      held = false;
      try {
        await unlockFlock(handle.fd);
      } finally {
        await handle.close().catch(() => {});
      }
    },
  };
}

// ---------- spawn budget ----------

/** A spawn younger than this may still be booting — don't spawn again. */
export const SPAWN_IN_FLIGHT_MS = 20_000;
/** Max spawns inside SPAWN_RATE_WINDOW_MS before suppression kicks in. */
export const SPAWN_RATE_WINDOW_MS = 60_000;
export const SPAWN_RATE_MAX = 5;
/** Ledger hygiene: never keep more than this many timestamps. */
const LEDGER_KEEP = 50;

export type SpawnBudget = { allowed: true } | { allowed: false; reason: "rate_limited" | "spawn_in_flight" };

interface SpawnLedger {
  attempts: number[];
}

async function readSpawnLedger(dataDir: string): Promise<number[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(spawnLedgerPath(dataDir), "utf8")) as SpawnLedger;
    if (!Array.isArray(parsed.attempts)) return [];
    return parsed.attempts.filter((t): t is number => typeof t === "number" && Number.isFinite(t));
  } catch {
    return [];
  }
}

function pruneAttempts(attempts: number[], now: number): number[] {
  const cutoff = now - SPAWN_RATE_WINDOW_MS;
  return attempts.filter((t) => t > cutoff).slice(-LEDGER_KEEP);
}

/**
 * May this host spawn the gateway right now? Pure read — the caller must
 * hold the start lock (or have bypassed it) so check+record is serialized
 * across hosts in practice.
 */
export async function gatewaySpawnBudget(dataDir: string, now = Date.now()): Promise<SpawnBudget> {
  const attempts = pruneAttempts(await readSpawnLedger(dataDir), now);
  if (attempts.length >= SPAWN_RATE_MAX) return { allowed: false, reason: "rate_limited" };
  const newest = attempts[attempts.length - 1];
  if (newest !== undefined && now - newest < SPAWN_IN_FLIGHT_MS) {
    return { allowed: false, reason: "spawn_in_flight" };
  }
  return { allowed: true };
}

/** Record a spawn attempt (call BEFORE spawning so a crash still counts). */
export async function recordGatewaySpawn(dataDir: string, now = Date.now()): Promise<void> {
  const attempts = pruneAttempts(await readSpawnLedger(dataDir), now);
  attempts.push(now);
  const filePath = spawnLedgerPath(dataDir);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, JSON.stringify({ attempts } satisfies SpawnLedger), { mode: 0o600 });
  await fs.rename(tmp, filePath);
}
