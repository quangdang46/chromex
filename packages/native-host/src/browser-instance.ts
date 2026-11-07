/**
 * browserInstanceId mechanism — spike-B6 / chromex-ov8 decision.
 *
 * DECISION: native-host-derived, Chrome-run-scoped ID.
 *
 * Rationale vs candidates:
 *  - `chrome.storage.session` loses the ID on extension reload/update/
 *    disable→enable even though the Chrome RUN continues — too lossy.
 *  - Extension-generated UUID in storage.local survives everything,
 *    including Chrome quit — cannot express "per Chrome run".
 *  - `profileId + chromePid`: Chrome PID is the parent of the NM host
 *    process; it lives exactly as long as the Chrome run.
 *
 * Mechanism: the FIRST native host of a Chrome run mints a random ID and
 * persists {id, chromePpid, chromePpidStartedAt} in the gateway dataDir
 * (`browser-instance.json`, 0600). Later hosts verify the parent PID AND
 * its start time still match; on mismatch (Chrome restarted, PID reused)
 * a new ID is minted. Extension reload/update/disable→enable does not
 * change the parent PID → ID stable → binding stays `ok` (correct: same
 * Chrome run). Chrome quit/restart → new ppid/start → new ID →
 * `needs_confirmation`/`stale` per §3.2.
 *
 * `browserInstanceId` remains Chrome-RUN identity, never a security
 * principal; `null` is always valid (degraded mode).
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface BrowserInstanceRecord {
  browserInstanceId: string;
  /** parent PID of the native host = Chrome process */
  chromePpid: number;
  /** parent process start time (ISO) — guards PID reuse */
  chromePpidStartedAt: string;
  createdAt: number;
}

export interface BrowserInstanceEnv {
  /** override parent pid (tests) */
  ppid?: number;
  /** override data dir */
  dataDir?: string;
}

async function parentStartTime(ppid: number): Promise<string> {
  if (process.platform === "win32") {
    // Windows: CIM creation date; fall back to empty (PID reuse window
    // accepted — documented limitation).
    try {
      const { stdout } = await execFileP("powershell", [
        "-NoProfile",
        "-Command",
        `(Get-Process -Id ${ppid}).StartTime.ToString('o')`,
      ]);
      return stdout.trim();
    } catch {
      return "";
    }
  }
  try {
    const { stdout } = await execFileP("ps", ["-o", "lstart=", "-p", String(ppid)]);
    return stdout.trim();
  } catch {
    return "";
  }
}

function recordPath(dataDir: string): string {
  return path.join(dataDir, "browser-instance.json");
}

/**
 * Resolve the browserInstanceId for this Chrome run. Idempotent across
 * native-host restarts within the same Chrome run; changes when Chrome
 * restarts (new parent PID or different parent start time).
 */
export async function resolveBrowserInstanceId(env: BrowserInstanceEnv = {}): Promise<string | null> {
  const dataDir = env.dataDir;
  if (!dataDir) return null; // no gateway home → degraded identity

  const ppid = env.ppid ?? process.ppid;
  if (!ppid || ppid <= 1) return null; // not spawned by Chrome → degraded

  const startedAt = await parentStartTime(ppid);
  const file = recordPath(dataDir);

  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as BrowserInstanceRecord;
    if (raw.chromePpid === ppid && raw.chromePpidStartedAt === startedAt && typeof raw.browserInstanceId === "string") {
      return raw.browserInstanceId;
    }
    // parent changed → Chrome restarted (or PID reused) → new run
  } catch {
    // no record yet
  }

  const id = createHash("sha256")
    .update(`chromex-bi:${ppid}:${startedAt}:${randomBytes(8).toString("hex")}`)
    .digest("hex")
    .slice(0, 32);
  const record: BrowserInstanceRecord = {
    browserInstanceId: id,
    chromePpid: ppid,
    chromePpidStartedAt: startedAt,
    createdAt: Date.now(),
  };
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(record), { mode: 0o600 });
  await fs.rename(tmp, file);
  return id;
}
