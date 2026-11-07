/**
 * Fingerprint salt — plan §6.2.
 *
 * One HMAC salt per extension install, stored in chrome.storage.local
 * alongside profileId. Access level is tightened to TRUSTED_CONTEXTS
 * when the API supports it so content scripts cannot read it directly;
 * content scripts receive the salt per-request over the extension
 * message channel instead.
 *
 * saltEpoch increments only when the salt itself is (re)generated
 * (fresh install / storage reset). stateFingerprint comparisons are
 * valid only within one epoch — the registry stores the epoch with
 * every snapshot so cross-epoch comparisons degrade to "unknown".
 */

import { FINGERPRINT_SALT_STORAGE_KEY } from "@codex-sidepanel/shared";

export interface FingerprintContext {
  salt: string;
  epoch: number;
}

interface StoredFingerprintSalt {
  salt: string;
  epoch: number;
}

const SALT_BYTES = 32;

function generateSalt(): string {
  const bytes = new Uint8Array(SALT_BYTES);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function readStored(): Promise<StoredFingerprintSalt | null> {
  const result = (await chrome.storage.local.get(FINGERPRINT_SALT_STORAGE_KEY))[
    FINGERPRINT_SALT_STORAGE_KEY
  ] as StoredFingerprintSalt | undefined;
  if (result && typeof result.salt === "string" && result.salt.length >= 32) {
    return { salt: result.salt, epoch: typeof result.epoch === "number" ? result.epoch : 1 };
  }
  return null;
}

/** Best-effort: hide the salt from content-script direct reads. */
async function tightenAccessLevel(): Promise<void> {
  try {
    const storage = chrome.storage.local as unknown as {
      setAccessLevel?: (opts: { accessLevel: string }) => Promise<void>;
    };
    await storage.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch {
    // older Chrome / unsupported — salt still only reachable via messages
  }
}

let cached: Promise<FingerprintContext> | null = null;

export function getFingerprintContext(): Promise<FingerprintContext> {
  cached ??= (async () => {
    await tightenAccessLevel();
    const stored = await readStored();
    if (stored) return { salt: stored.salt, epoch: stored.epoch };
    const fresh: StoredFingerprintSalt = { salt: generateSalt(), epoch: 1 };
    await chrome.storage.local.set({ [FINGERPRINT_SALT_STORAGE_KEY]: fresh });
    return { salt: fresh.salt, epoch: fresh.epoch };
  })();
  return cached;
}

/** Test/reset hook — clears the memoized context (not the stored salt). */
export function resetFingerprintContextCache(): void {
  cached = null;
}
