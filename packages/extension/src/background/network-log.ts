/**
 * background/network-log.ts — per-tab network request log for
 * browser.page.network.
 *
 * chrome.webRequest gives metadata only (method, url, status, mime,
 * size, error) — response BODIES are not observable at this permission
 * tier (that needs chrome.debugger / CDP). Entries are honest metadata,
 * not content.
 *
 * URLs are sanitized origin+path (same §6.1.1 rule as tabs.list —
 * query strings routinely carry tokens). The buffer is in-memory but
 * a bounded tail (100 entries/tab) persists to chrome.storage.session
 * via setNetworkLogStore, so an MV3 service-worker restart restores
 * recent history instead of silently emptying it; the store dies with
 * the browser session. onCompleted ordering is not guaranteed —
 * callers must treat it as a recent-activity log, not an authoritative
 * transaction record.
 */

export interface NetworkLogEntry {
  id?: number;
  method: string;
  /** sanitized: origin + path only — query/hash stripped */
  url: string;
  /** chrome.webRequest resource type: main_frame, xhr, fetch, ... */
  type: string;
  /** HTTP status on completion; absent on error */
  status?: number;
  /** chrome.webRequest error string on failure (e.g. net::ERR_*) */
  error?: string;
  /** response Content-Type header when present */
  mimeType?: string;
  /** frame that initiated the request (webRequest details.frameId);
   *  absent for non-frame requests */
  frameId?: number;
  /** epoch ms */
  ts: number;
}

const MAX_ENTRIES_PER_TAB = 300;
const MAX_TABS = 50;
/** Persisted tail per tab — enough for responseUrl lookback and recent
 *  page.network history across an MV3 service-worker restart without
 *  writing the full 300-entry buffer on every flush. */
const PERSIST_MAX_ENTRIES = 100;
const PERSIST_DEBOUNCE_MS = 3_000;

const buffers = new Map<number, NetworkLogEntry[]>();
/** requestId sets per tab — drives the network-idle wait. Entries are
 *  removed on completion/error/tab-close; a missed removal only delays
 *  idle detection until the next event, never fakes it. */
const inFlight = new Map<number, Set<string>>();
let installed = false;

/** Optional chrome.storage.session backing — survives an MV3
 *  service-worker restart so page.network history and responseUrl
 *  wait lookback don't silently reset to empty. Entries are already
 *  origin+path sanitized at capture time, so persisting them leaks
 *  nothing extra. Absent store → memory-only (tests). */
export interface NetworkLogStore {
  load(): Promise<Record<string, NetworkLogEntry[]>>;
  save(snapshot: Record<string, NetworkLogEntry[]>): Promise<void>;
}
let logStore: NetworkLogStore | undefined;
export function setNetworkLogStore(store: NetworkLogStore | undefined): void {
  logStore = store;
}
let persistTimer: ReturnType<typeof setTimeout> | undefined;
let persistDirty = false;

function persistSnapshot(): Record<string, NetworkLogEntry[]> {
  const out: Record<string, NetworkLogEntry[]> = {};
  for (const [tabId, buf] of buffers) {
    if (buf.length === 0) continue;
    out[String(tabId)] = buf.slice(-PERSIST_MAX_ENTRIES);
  }
  return out;
}

function schedulePersist(): void {
  if (!logStore) return;
  persistDirty = true;
  if (persistTimer !== undefined) return;
  persistTimer = setTimeout(() => {
    persistTimer = undefined;
    if (!persistDirty || !logStore) return;
    persistDirty = false;
    void logStore.save(persistSnapshot()).catch(() => {});
  }, PERSIST_DEBOUNCE_MS);
}

/** Immediate persist — used on tab close so a reused tabId cannot
 *  inherit the closed tab's tail. */
function persistNow(): void {
  if (!logStore) return;
  persistDirty = false;
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  void logStore.save(persistSnapshot()).catch(() => {});
}

function isLogEntry(v: unknown): v is NetworkLogEntry {
  return typeof v === "object" && v !== null &&
    typeof (v as NetworkLogEntry).method === "string" &&
    typeof (v as NetworkLogEntry).url === "string" &&
    typeof (v as NetworkLogEntry).type === "string" &&
    typeof (v as NetworkLogEntry).ts === "number";
}

/** Rehydrate buffers from the store after an SW restart. Runs once
 *  per install; malformed entries are skipped rather than crashing
 *  the log. */
async function restoreNetworkLog(): Promise<void> {
  if (!logStore) return;
  try {
    const saved = await logStore.load();
    for (const [key, entries] of Object.entries(saved ?? {})) {
      const tabId = Number(key);
      if (!Number.isInteger(tabId) || tabId < 0 || !Array.isArray(entries)) continue;
      const clean = entries.filter(isLogEntry).slice(-MAX_ENTRIES_PER_TAB);
      if (clean.length > 0 && !buffers.has(tabId)) buffers.set(tabId, clean);
    }
  } catch {
    // corrupt/absent store — start with an empty log, honestly
  }
}

function safeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}`;
  } catch {
    return "";
  }
}

function push(tabId: number, entry: NetworkLogEntry): void {
  let buf = buffers.get(tabId);
  if (!buf) {
    if (buffers.size >= MAX_TABS) {
      // evict the oldest-touched tab — Map iteration is insertion order
      const oldest = buffers.keys().next().value;
      if (oldest !== undefined) buffers.delete(oldest);
    }
    buf = [];
    buffers.set(tabId, buf);
  }
  buf.push(entry);
  if (buf.length > MAX_ENTRIES_PER_TAB) buf.splice(0, buf.length - MAX_ENTRIES_PER_TAB);
  schedulePersist();
}

/** Install the webRequest listeners once. No-op where the API or the
 *  permission is absent (tests, older builds) — the tool reports
 *  proto.unsupported via the missing dep instead of faking data. */
export function installNetworkLog(): void {
  if (installed || typeof chrome === "undefined" || !chrome.webRequest) return;
  try {
    installNetworkLogInner();
    void restoreNetworkLog();
  } catch {
    // permission absent or API shape changed — the tool reports
    // proto.unsupported via the missing dep instead of faking data.
  }
}

function trackStart(tabId: number, requestId: string): void {
  let set = inFlight.get(tabId);
  if (!set) {
    set = new Set();
    inFlight.set(tabId, set);
  }
  set.add(requestId);
}

function trackEnd(tabId: number, requestId: string): void {
  inFlight.get(tabId)?.delete(requestId);
}

/** In-flight request count for a tab — browser.page.wait networkIdle. */
export function getNetworkInflightCount(tabId: number): number {
  return inFlight.get(tabId)?.size ?? 0;
}

/** Drop all state for a closed tab (called from tabs.onRemoved) and
 *  persist immediately so a reused tabId cannot inherit the tail. */
export function resetNetworkTab(tabId: number): void {
  buffers.delete(tabId);
  inFlight.delete(tabId);
  persistNow();
}

function installNetworkLogInner(): void {
  const onCompleted = chrome.webRequest!.onCompleted;
  const onError = chrome.webRequest.onErrorOccurred;
  const onBefore = chrome.webRequest.onBeforeRequest;
  const filters = { urls: ["<all_urls>"] };
  onBefore.addListener((details) => {
    if (typeof details.tabId === "number" && details.tabId >= 0 && details.requestId) {
      trackStart(details.tabId, details.requestId);
    }
    return undefined;
  }, filters);
  onCompleted.addListener((details) => {
    if (typeof details.tabId === "number" && details.tabId >= 0 && details.requestId) {
      trackEnd(details.tabId, details.requestId);
    }
    if (typeof details.tabId !== "number" || details.tabId < 0) return;
    const mime = details.responseHeaders
      ?.find((h) => h.name.toLowerCase() === "content-type")
      ?.value?.split(";")[0]
      ?.trim();
    push(details.tabId, {
      method: details.method,
      url: safeUrl(details.url),
      type: details.type,
      status: details.statusCode,
      ...(mime ? { mimeType: mime } : {}),
      ...(typeof details.frameId === "number" && details.frameId >= 0 ? { frameId: details.frameId } : {}),
      ts: Date.now(),
    });
  }, filters);
  onError.addListener((details) => {
    if (typeof details.tabId === "number" && details.tabId >= 0 && details.requestId) {
      trackEnd(details.tabId, details.requestId);
    }
    if (typeof details.tabId !== "number" || details.tabId < 0) return;
    push(details.tabId, {
      method: details.method,
      url: safeUrl(details.url),
      type: details.type,
      ...(details.error ? { error: details.error } : {}),
      ...(typeof details.frameId === "number" && details.frameId >= 0 ? { frameId: details.frameId } : {}),
      ts: Date.now(),
    });
  }, filters);
  installed = true;
}

export interface NetworkQuery {
  limit: number;
  /** substring match against the sanitized url */
  urlContains?: string;
  /** chrome.webRequest type filter, e.g. "xhr", "fetch", "main_frame" */
  type?: string;
  /** "error" → only failed requests; "2xx"/"4xx"/"5xx" → status class */
  status?: string;
  /** restrict to requests initiated by this frame (0 = top frame) */
  frameId?: number;
}

/** Newest-first bounded slice of a tab's network log. */
export function listNetworkRequests(tabId: number, query: NetworkQuery): NetworkLogEntry[] {
  const buf = buffers.get(tabId) ?? [];
  const needle = query.urlContains?.toLowerCase();
  const out: NetworkLogEntry[] = [];
  for (let i = buf.length - 1; i >= 0 && out.length < query.limit; i--) {
    const e = buf[i]!;
    if (needle && !e.url.toLowerCase().includes(needle)) continue;
    if (query.type && e.type !== query.type) continue;
    if (query.frameId !== undefined && e.frameId !== query.frameId) continue;
    if (query.status === "error" && !e.error) continue;
    if (/^[245]xx$/.test(query.status ?? "")) {
      const cls = `${Math.floor((e.status ?? 0) / 100)}xx`;
      if (cls !== query.status) continue;
    }
    out.push(e);
  }
  return out;
}

/** Test hook — drop all buffered state, pending persists, the install
 *  latch, and the store so a test can simulate an SW restart by
 *  re-calling installNetworkLog with a fresh store. */
export function resetNetworkLogForTests(): void {
  buffers.clear();
  inFlight.clear();
  installed = false;
  persistDirty = false;
  if (persistTimer !== undefined) {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  }
  logStore = undefined;
}
