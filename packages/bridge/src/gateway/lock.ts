/**
 * Gateway ownership lock — plan §3.3.
 *
 * Two OS advisory locks, never mtime-based reclaim:
 *  - STARTUP lock (`gateway.startup.lock`): short-lived, serializes
 *    config load / endpoint negotiation / recovery handoff.
 *  - LIFETIME lock (`gateway.lock`): held for the whole process life.
 *
 * POSIX: flock(2) via fs-ext. Windows: fs-ext implements the same call
 * over LockFile/LockFileEx — one code path, OS-released on process death
 * (including SIGKILL), so there is never a stale lock file to reclaim.
 *
 * Ownership metadata {pid, startedAt, execPath, fence} is written through
 * the locked fd + fdatasync. A new owner only exists after lock
 * acquisition succeeds, and each acquisition bumps the fence (ULID) —
 * stale owners detect their old fence and must refuse writes/self-shutdown.
 */

import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import * as fsExt from "fs-ext";

import { ulid } from "./ulid.js";

export interface OwnershipMetadata {
  pid: number;
  startedAt: number;
  execPath: string;
  /** fencing token — bumped on every ownership generation */
  fence: string;
  lockKind: "startup" | "lifetime";
}

export interface OwnershipLock {
  readonly kind: "startup" | "lifetime";
  readonly fence: string;
  readonly metadata: OwnershipMetadata;
  /** true while this process still holds the OS lock */
  isHeld(): boolean;
  release(): Promise<void>;
}

export class LockHeldError extends Error {
  readonly heldBy: OwnershipMetadata | undefined;
  constructor(message: string, heldBy?: OwnershipMetadata) {
    super(message);
    this.name = "LockHeldError";
    this.heldBy = heldBy;
  }
}

async function openLockFile(filePath: string): Promise<FileHandle> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  return fs.open(filePath, fsConstants.O_RDWR | fsConstants.O_CREAT, 0o600);
}

function unlockFlock(fd: number): Promise<void> {
  return new Promise((resolve, reject) => {
    fsExt.flock(fd, fsExt.constants.LOCK_UN, (err) => (err ? reject(err) : resolve()));
  });
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

async function writeMetadataThroughFd(handle: FileHandle, meta: OwnershipMetadata): Promise<void> {
  const payload = JSON.stringify(meta);
  await handle.writeFile(payload, { encoding: "utf8" });
  await handle.truncate(Buffer.byteLength(payload));
  // fs-ext has no fdatasync; FileHandle.sync() (fsync) is the durability
  // floor — adequate until P1-02 tunes WAL/fsync policy per spike-B7.
  await handle.sync();
}

export async function readLockMetadata(filePath: string): Promise<OwnershipMetadata | null> {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as OwnershipMetadata;
    if (typeof parsed.pid !== "number" || typeof parsed.fence !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Acquire an OS advisory lock. Throws LockHeldError (with last-known
 * metadata) when another live process holds it. Never reclaims by mtime —
 * the OS releases the lock when the holder dies, so acquisition itself is
 * the only reclaim path, and it always bumps the fence.
 */
export async function acquireOwnershipLock(
  dataDir: string,
  kind: OwnershipLock["kind"],
): Promise<OwnershipLock> {
  const filePath = path.join(dataDir, kind === "lifetime" ? "gateway.lock" : "gateway.startup.lock");
  const handle = await openLockFile(filePath);

  let acquired = false;
  try {
    acquired = await tryFlockExclusive(handle.fd);
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }

  if (!acquired) {
    const heldBy = await readLockMetadata(filePath);
    await handle.close().catch(() => {});
    throw new LockHeldError(
      `${kind} lock held by pid ${heldBy?.pid ?? "unknown"} (fence ${heldBy?.fence ?? "?"})`,
      heldBy ?? undefined,
    );
  }

  const fence = ulid();
  const metadata: OwnershipMetadata = {
    pid: process.pid,
    startedAt: Date.now(),
    execPath: process.execPath,
    fence,
    lockKind: kind,
  };
  try {
    await writeMetadataThroughFd(handle, metadata);
  } catch (err) {
    try {
      await unlockFlock(handle.fd);
    } catch {
      /* ignore */
    }
    await handle.close().catch(() => {});
    throw err;
  }

  let held = true;
  return {
    kind,
    fence,
    metadata,
    isHeld: () => held,
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
