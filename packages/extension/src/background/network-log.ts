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
 * query strings routinely carry tokens). The buffer is in-memory and
 * dies with the service worker; onCompleted ordering is not guaranteed
 * across SW restarts — callers must treat it as a recent-activity log,
 * not an authoritative transaction record.
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
  /** epoch ms */
  ts: number;
}

const MAX_ENTRIES_PER_TAB = 300;
const MAX_TABS = 50;

const buffers = new Map<number, NetworkLogEntry[]>();
/** requestId sets per tab — drives the network-idle wait. Entries are
 *  removed on completion/error/tab-close; a missed removal only delays
 *  idle detection until the next event, never fakes it. */
const inFlight = new Map<number, Set<string>>();
let installed = false;

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
}

/** Install the webRequest listeners once. No-op where the API or the
 *  permission is absent (tests, older builds) — the tool reports
 *  proto.unsupported via the missing dep instead of faking data. */
export function installNetworkLog(): void {
  if (installed || typeof chrome === "undefined" || !chrome.webRequest) return;
  try {
    installNetworkLogInner();
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

/** Drop all state for a closed tab (called from tabs.onRemoved). */
export function resetNetworkTab(tabId: number): void {
  buffers.delete(tabId);
  inFlight.delete(tabId);
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
    if (query.status === "error" && !e.error) continue;
    if (/^[245]xx$/.test(query.status ?? "")) {
      const cls = `${Math.floor((e.status ?? 0) / 100)}xx`;
      if (cls !== query.status) continue;
    }
    out.push(e);
  }
  return out;
}

/** Test hook — drop all buffered state. */
export function resetNetworkLogForTests(): void {
  buffers.clear();
}
