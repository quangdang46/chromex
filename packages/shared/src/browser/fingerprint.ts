/**
 * Snapshot fingerprints — plan §6.2.
 *
 * Two fingerprints, never conflated:
 * - structuralFingerprint ("sfp1:"): ref validity. Changes on DOM
 *   structure (elements added/removed/relabeled/moved). NEVER changes
 *   when the user types — typing must not stale refs.
 * - stateFingerprint ("tfp1:"): verify/observation. Changes on
 *   values/checked/scroll/url. Field values contribute ONLY as
 *   HMAC hashes; password/payment fields are "[redacted]" and do not
 *   contribute at all.
 *
 * Salt is per-install (chrome.storage.local, TRUSTED_CONTEXTS), stable
 * across snapshots; saltEpoch increments when the salt is regenerated.
 * stateFingerprint comparisons are only valid within one epoch.
 *
 * All hashing is async (WebCrypto subtle) — works in content scripts
 * and Node ≥20. No plaintext field value is ever hashed into a
 * persisted artifact or sent off-device; hashes stay inside the
 * snapshot/verify pipeline.
 */

export interface StructuralElementInput {
  role: string;
  name?: string;
  tag: string;
  type?: string;
  boundsBucket: [number, number, number, number];
}

export interface StructuralInputs {
  version: 1;
  elementCount: number;
  interactiveCount: number;
  elements: StructuralElementInput[];
  framePathSignature?: string;
}

export interface FieldValueHashEntry {
  /** stable per-field identity — sha256(structuralPath|role|name|type|formIndex) */
  fieldIdentity: string;
  ref: string;
  /** base64url(HMAC-SHA256(salt, canonical({tabOrigin,ref,value}))) truncated 16B; "[redacted]" for sensitive */
  valueHash: string;
  sensitive: boolean;
}

export interface CheckedRoleEntry {
  ref: string;
  checked: boolean;
}

export interface StateInputs {
  version: 1;
  /** structuralFingerprint this state was captured under */
  structural: string;
  /** origin+path only — query stripped (may carry sensitive params) */
  urlOriginPath: string;
  readyState: string;
  scrollBucket: [number, number];
  /** non-sensitive entries only — sensitive fields never contribute */
  fieldValueHashes: Array<{ fieldIdentity: string; valueHash: string }>;
  checkedRoles?: CheckedRoleEntry[];
}

export const FINGERPRINT_SALT_STORAGE_KEY = "chromex.fingerprint";
export const SNAPSHOT_TTL_MS = 5 * 60 * 1000;
export const SNAPSHOT_LRU_PER_TASK = 32;

/** Deterministic JSON: object keys sorted recursively, no whitespace. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

async function sha256Bytes(data: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
  return new Uint8Array(digest);
}

export async function sha256Hex(data: string): Promise<string> {
  const bytes = await sha256Bytes(data);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function hmacSha256(keyText: string, message: string): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(keyText),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return new Uint8Array(sig);
}

export async function structuralFingerprint(inputs: StructuralInputs): Promise<string> {
  return `sfp1:${await sha256Hex(canonicalJson(inputs))}`;
}

export async function stateFingerprint(inputs: StateInputs): Promise<string> {
  return `tfp1:${await sha256Hex(canonicalJson(inputs))}`;
}

/** §6.2: valueHash = base64url(HMAC-SHA256(salt, canonical({tabOrigin,ref,value}))) cut to 16 bytes. */
export async function fieldValueHash(
  salt: string,
  tabOrigin: string,
  ref: string,
  value: string,
): Promise<string> {
  const mac = await hmacSha256(salt, canonicalJson({ tabOrigin, ref, value }));
  return bytesToBase64Url(mac.slice(0, 16));
}

/** §6.2 fieldIdentity = sha256(structuralPath | role | name | type | formIndex). */
export async function fieldIdentity(parts: {
  structuralPath: string;
  role: string;
  name?: string;
  type?: string;
  formIndex: number;
}): Promise<string> {
  return sha256Hex(
    [
      parts.structuralPath,
      parts.role,
      parts.name ?? "",
      parts.type ?? "",
      String(parts.formIndex),
    ].join("|"),
  );
}

/** origin + pathname only — query/hash stripped. */
export function urlOriginPath(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    return `${u.origin}${u.pathname}`;
  } catch {
    return rawUrl.split(/[?#]/)[0] ?? rawUrl;
  }
}

/** 20px-ish bucket so sub-pixel jitter does not churn fingerprints. */
export function bucketCoord(n: number, size = 32): number {
  return Math.round(n / size) * size;
}

export function boundsBucket(rect: {
  left: number;
  top: number;
  width: number;
  height: number;
}): [number, number, number, number] {
  return [
    bucketCoord(rect.left),
    bucketCoord(rect.top),
    bucketCoord(rect.width),
    bucketCoord(rect.height),
  ];
}

export function scrollBucket(scrollX: number, scrollY: number): [number, number] {
  return [bucketCoord(scrollX, 64), bucketCoord(scrollY, 64)];
}

// ---------------------------------------------------------------------------
// Snapshot registry — §6.2 metadata TTL 5min, LRU 32/task.
// ---------------------------------------------------------------------------

export interface SnapshotMeta {
  snapshotId: string;
  taskId?: string;
  tabId?: number;
  structuralFingerprint: string;
  stateFingerprint: string;
  saltEpoch: number;
  /** origin+path of the page at capture — navigation detection (§6.3) */
  urlOriginPath?: string;
  capturedAt: number;
}

export class SnapshotRegistry {
  private readonly entries = new Map<string, SnapshotMeta>();

  put(meta: SnapshotMeta): void {
    this.entries.delete(meta.snapshotId);
    this.entries.set(meta.snapshotId, meta);
    this.#evict();
  }

  get(snapshotId: string, now = Date.now()): SnapshotMeta | null {
    const meta = this.entries.get(snapshotId);
    if (!meta) return null;
    if (now - meta.capturedAt > SNAPSHOT_TTL_MS) {
      this.entries.delete(snapshotId);
      return null;
    }
    return meta;
  }

  /** LRU per task: keep newest SNAPSHOT_LRU_PER_TASK per taskId. */
  #evict(now = Date.now()): void {
    const byTask = new Map<string, SnapshotMeta[]>();
    for (const meta of this.entries.values()) {
      if (now - meta.capturedAt > SNAPSHOT_TTL_MS) {
        this.entries.delete(meta.snapshotId);
        continue;
      }
      const key = meta.taskId ?? "";
      const list = byTask.get(key) ?? [];
      list.push(meta);
      byTask.set(key, list);
    }
    for (const list of byTask.values()) {
      if (list.length <= SNAPSHOT_LRU_PER_TASK) continue;
      list.sort((a, b) => a.capturedAt - b.capturedAt);
      for (const stale of list.slice(0, list.length - SNAPSHOT_LRU_PER_TASK)) {
        this.entries.delete(stale.snapshotId);
      }
    }
  }

  /** Drop every snapshot bound to a tab (close / navigation / structural change). */
  invalidateTab(tabId: number): void {
    for (const [id, meta] of this.entries) {
      if (meta.tabId === tabId) this.entries.delete(id);
    }
  }

  latestForTab(tabId: number, now = Date.now()): SnapshotMeta | null {
    let best: SnapshotMeta | null = null;
    for (const meta of this.entries.values()) {
      if (meta.tabId !== tabId) continue;
      if (now - meta.capturedAt > SNAPSHOT_TTL_MS) continue;
      if (!best || meta.capturedAt > best.capturedAt) best = meta;
    }
    return best;
  }

  get size(): number {
    return this.entries.size;
  }
}
