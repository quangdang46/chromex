/**
 * Browser tool host — executes `browser.tool.request` envelopes that
 * the Gateway pushes to this extension (P1-09 §9.2 step 4).
 *
 * Maps the §9 tool surface onto existing primitives:
 *  - tabs / windows / downloads tools → chrome.tabs/windows/downloads
 *  - page.snapshot/get/extract/find/console/network/history
 *                → page.dom.* content-script messages + webRequest log
 *  - page.click/focus/fill/select/submit/type/scroll/navigate/hover/
 *    press/drag/wait → page.dom.perform steps (same engine as planner)
 *  - args.trusted variants → CDP Input.dispatchMouseEvent/KeyEvent
 *    (isTrusted=true) via background/cdp.ts
 *  - page.snapshot mode:"aria", page.dialog, page.setInputFiles,
 *    page.responseBody, page.webSocket, page.route/unroute,
 *    page.screenshot element clips, page.emulate, page.pdf →
 *    chrome.debugger CDP tier (docs/adr/debugger-tier.md)
 *  - page.evaluate → chrome.scripting world:"MAIN" (always approval)
 *  - page.upload → in-memory DataTransfer path (content script)
 *
 * CDP sessions are per-tab refcounted; emulate holds its attach until
 * reset/tab close (overrides are session-scoped). Subframe targeting
 * uses args.frameId; OOPIF pointer/file ops resolve through the
 * content-script geometry chain or the frame's own debugger target.
 *
 * Args convention: `tabId` optional → active tab of current window;
 * element targeting uses `ref` (from a prior page.snapshot) or
 * `selector`/`label`.
 */

import { SnapshotRegistry, summarizeCoverage, summarizeMetrics, urlOriginPath } from "@codex-sidepanel/shared";
import type {
  BrowserDomActionResult,
  BrowserDomSnapshot,
  BrowserExpectCondition,
} from "@codex-sidepanel/shared";

import { chromexConsoleCollect } from "../../content/console-capture.js";
import { chromexEvaluate } from "../../content/evaluate.js";
import { chromexStorageOp } from "../../content/storage.js";
import { chromexIdbOp } from "../../content/idb.js";
import { chromexCacheOp } from "../../content/caches.js";
import { chromexSwOp } from "../../content/sw.js";
import type { CdpSession } from "../cdp.js";

/** Sanitized single-window chrome state — same fields windows.list
 *  surfaces (no tab payloads → no page-text egress). */
export interface WindowInfo {
  id?: number | undefined;
  focused?: boolean | undefined;
  type?: string | undefined;
  state?: string | undefined;
  incognito?: boolean | undefined;
  left?: number | undefined;
  top?: number | undefined;
  width?: number | undefined;
  height?: number | undefined;
  tabCount?: number | undefined;
}

export interface ToolHostDeps {
  /** chrome.tabs.captureVisibleTab → data:image/...;base64 URL.
   *  `opts.quality` (jpeg only) lets the screenshot path retry at lower
   *  quality when the first capture exceeds the artifact byte cap. */
  captureVisibleTab?(windowId: number, opts?: { quality?: number }): Promise<string>;
  /** chrome.tabs.create — open a new tab (browser.tab.create, chromex-he2) */
  createTab?(opts: { url?: string; active?: boolean; windowId?: number; pinned?: boolean; muted?: boolean; autoDiscardable?: boolean }): Promise<chrome.tabs.Tab>;
  /** chrome.tabs.update — tab.update tool (pinned/muted). */
  updateTab?(tabId: number, opts: { pinned?: boolean; muted?: boolean; autoDiscardable?: boolean }): Promise<unknown>;
  /** chrome.tabs.discard — tab.discard tool (memory hygiene). */
  discardTab?(tabId: number): Promise<unknown>;
  /** chrome.tabs.move — tab.update index (strip reorder); windowId moves
   *  the tab into another window (cross-window relocate). */
  moveTab?(tabId: number, index: number, windowId?: number): Promise<unknown>;
  /** chrome.tabs.setZoom — tab.update zoomFactor (0.25–5). */
  setTabZoom?(tabId: number, zoomFactor: number): Promise<unknown>;
  /** chrome.tabs.duplicate — clone a tab preserving its session
   *  (browser.tab.duplicate); absent dep → proto.unsupported. */
  duplicateTab?(tabId: number): Promise<chrome.tabs.Tab>;
  /** chrome.scripting.executeScript world:"MAIN" — runs `func` in the
   *  page's main world and resolves its return value (browser.page.console,
   *  chromex-nr8). `func` must be self-contained (serialized source). */
  runInMainWorld?(
    tabId: number,
    func: (...fnArgs: unknown[]) => unknown,
    args?: unknown[],
    frameIds?: number[],
  ): Promise<unknown>;
  /** chrome.tabs.goBack/goForward/reload (browser.page.history);
   *  bypassCache maps to chrome.tabs.reload {bypassCache:true} /
   *  CDP Page.reload {ignoreCache:true} on isolated. */
  navigateHistory?(
    tabId: number,
    action: "back" | "forward" | "reload",
    opts?: { bypassCache?: boolean },
  ): Promise<unknown>;
  /** chrome.downloads.search (browser.downloads.list) — requires the
   *  "downloads" permission; absent dep → proto.unsupported. */
  listDownloads?(query: {
    state?: string;
    limit: number;
    startTime?: number;
  }): Promise<
    Array<{
      id?: number;
      state?: string;
      filename?: string;
      bytesReceived?: number;
      totalBytes?: number;
      error?: string;
      startTime?: string;
      mime?: string;
      fileExists?: boolean;
      /** Full download URL — internal match input only; wait echoes a
       *  sanitized origin+path, never the query (signed-URL tokens). */
      url?: string;
      suggestedFilename?: string;
    }>
  >;
  /** chrome.webRequest metadata log (browser.page.network) — absent dep
   *  → proto.unsupported (permission missing or listeners not installed). */
  listNetworkRequests?(
    tabId: number,
    query: { limit: number; urlContains?: string; type?: string; status?: string; frameId?: number },
  ): Array<{
    method?: string;
    url?: string;
    type?: string;
    status?: number;
    error?: string;
    mimeType?: string;
    frameId?: number;
    ts?: number;
  }>;
  /** in-flight request count for a tab (browser.page.wait args.networkIdle)
   *  — absent dep → proto.unsupported. */
  networkInflightCount?(tabId: number): number;
  /** chrome.downloads.download (browser.downloads.save) — starts a
   *  download into the profile's download dir; absent dep →
   *  proto.unsupported. */
  downloadFile?(input: { url: string; filename?: string }): Promise<{
    id?: number;
    filename?: string;
  }>;
  /** chrome.downloads.cancel (browser.downloads.cancel) — stops an
   *  in-progress download; absent dep → proto.unsupported. */
  cancelDownload?(downloadId: number): Promise<unknown>;
  /** chrome.downloads.open/show (browser.downloads.open) — hands a
   *  completed download to the OS handler or file manager; absent dep
   *  → proto.unsupported. */
  openDownload?(downloadId: number, opts?: { reveal?: boolean }): Promise<unknown>;
  /** chrome.downloads.pause/resume/erase (browser.downloads.pause/
   *  resume/erase) — queue management; absent dep → proto.unsupported. */
  manageDownload?(downloadId: number, op: "pause" | "resume" | "erase"): Promise<unknown>;
  /** chrome.windows.getAll/create/update (browser.windows.*) — absent
   *  deps → proto.unsupported. */
  listWindows?(): Promise<Array<{
    id?: number | undefined;
    focused?: boolean | undefined;
    type?: string | undefined;
    state?: string | undefined;
    incognito?: boolean | undefined;
    left?: number | undefined;
    top?: number | undefined;
    width?: number | undefined;
    height?: number | undefined;
    tabCount?: number | undefined;
  }>>;
  createWindow?(opts: {
    url?: string | undefined;
    type?: string | undefined;
    focused?: boolean | undefined;
    width?: number | undefined;
    height?: number | undefined;
    left?: number | undefined;
    top?: number | undefined;
    state?: string | undefined;
  }): Promise<{
    id?: number | undefined;
    focused?: boolean | undefined;
    state?: string | undefined;
    type?: string | undefined;
    tabs?: Array<{ id?: number | undefined; url?: string | undefined; title?: string | undefined; active?: boolean | undefined }> | undefined;
  }>;
  updateWindow?(windowId: number, opts: {
    focused?: boolean;
    state?: string;
    left?: number;
    top?: number;
    width?: number;
    height?: number;
    drawAttention?: boolean;
  }): Promise<unknown>;
  /** chrome.windows.remove — closes the window and every tab in it.
   *  Absent on headless Chromium (window teardown crashes the browser
   *  process there — the dep is not registered, so the tool refuses
   *  with proto.unsupported). Returns {removed, tabsClosed} or throws
   *  for an unknown windowId. */
  removeWindow?(windowId: number): Promise<unknown>;
  /** chrome.windows.get / getLastFocused (browser.windows.get) —
   *  single-window chrome state, same sanitized shape as listWindows;
   *  absent deps → proto.unsupported. */
  getWindow?(windowId: number): Promise<WindowInfo | null>;
  getLastFocusedWindow?(): Promise<WindowInfo | null>;

  /** chrome.tabGroups + chrome.tabs.group/ungroup (browser.tabGroups) —
   *  absent → proto.unsupported. */
  tabGroups?: {
    list(): Promise<Array<{
      id?: number | undefined;
      windowId?: number | undefined;
      title?: string | undefined;
      color?: string | undefined;
      collapsed?: boolean | undefined;
    }>>;
    tabsInGroup(groupId: number): Promise<number[]>;
    create(tabIds: number[], groupId?: number): Promise<{ id?: number | undefined }>;
    ungroup(tabIds: number[]): Promise<unknown>;
    update(
      groupId: number,
      opts: { title?: string; color?: string; collapsed?: boolean },
    ): Promise<unknown>;
  };
  /** chrome.contentSettings (browser.siteSettings) — per-origin
   *  permission state for types like notifications/camera/microphone.
   *  null → content type unavailable → proto.unsupported;
   *  "permission" → optional contentSettings permission not granted. */
  siteSettings?: {
    get(
      contentType: string,
      primaryPattern: string,
      scope?: string,
    ): Promise<{ setting?: string | undefined; scope?: string | undefined } | "permission" | null>;
    set(
      contentType: string,
      primaryPattern: string,
      setting: string,
      scope?: string,
    ): Promise<unknown | "permission" | null>;
    clear(contentType: string, primaryPattern: string): Promise<unknown | "permission" | null>;
  } | undefined;
  /** chrome.sessions (browser.sessions) — recently-closed tabs and
   *  windows. "permission" → optional sessions permission not granted;
   *  null → API unavailable → proto.unsupported. */
  sessions?: {
    list(maxResults: number): Promise<unknown[] | "permission" | null>;
    restore(sessionId?: string): Promise<Record<string, unknown> | "permission" | null>;
  } | undefined;
  /** chrome.proxy.settings (browser.proxy) — profile-wide proxy config.
   *  "permission" → optional proxy permission not granted;
   *  null → API unavailable → proto.unsupported. */
  proxy?: {
    get(scope?: string): Promise<{ value?: unknown; levelOfControl?: string } | "permission" | null>;
    set(value: Record<string, unknown>, scope?: string): Promise<Record<string, unknown> | "permission" | null>;
    clear(scope?: string): Promise<Record<string, unknown> | "permission" | null>;
  } | undefined;
  /** chrome.privacy (browser.privacy) — profile-wide privacy settings.
   *  "permission" → optional privacy permission not granted;
   *  null → setting/API unavailable → proto.unsupported. */
  privacy?: {
    get(setting?: string, scope?: string): Promise<Record<string, unknown> | "permission" | null>;
    set(setting: string, value: unknown, scope?: string): Promise<Record<string, unknown> | "permission" | null>;
    clear(setting?: string, scope?: string): Promise<Record<string, unknown> | "permission" | null>;
  } | undefined;
  /** chrome.management (browser.management) — installed extension
   *  inventory + enable/uninstall. "permission" → optional management
   *  permission not granted; null → API unavailable → proto.unsupported. */
  management?: {
    list(maxResults: number): Promise<Array<Record<string, unknown>> | "permission" | null>;
    get(id: string): Promise<Record<string, unknown> | "permission" | null>;
    setEnabled(id: string, enabled: boolean): Promise<Record<string, unknown> | "permission" | null>;
    uninstall(id: string): Promise<Record<string, unknown> | "permission" | null>;
  } | undefined;
  /** This extension's own id — browser.management refuses to disable or
   *  uninstall it (would kill the agent's host). */
  selfExtensionId?: string;
  /** chrome.notifications (browser.notifications) — OS desktop
   *  notifications. "permission" → optional notifications permission
   *  not granted; null → API unavailable → proto.unsupported. */
  notifications?: {
    permission(): Promise<string | "permission" | null>;
    send(options: Record<string, unknown>): Promise<Record<string, unknown> | "permission" | null>;
    update(id: string, options: Record<string, unknown>): Promise<Record<string, unknown> | "permission" | null>;
    clear(id?: string): Promise<Record<string, unknown> | "permission" | null>;
    list(): Promise<Record<string, unknown> | "permission" | null>;
  } | undefined;
  /** chrome.declarativeNetRequest (browser.dnr) — session network rules.
   *  "permission" → optional declarativeNetRequest permission not
   *  granted; null → API unavailable → proto.unsupported. Rules arrive
   *  pre-validated; this layer only marshals to the Chrome API. */
  dnr?: {
    permission(): Promise<string | "permission" | null>;
    list(): Promise<unknown[] | "permission" | null>;
    update(options: Record<string, unknown>): Promise<Record<string, unknown> | "permission" | null>;
    matched(filter: Record<string, unknown>): Promise<unknown[] | "permission" | null>;
    test(request: Record<string, unknown>): Promise<unknown[] | "permission" | null>;
  } | undefined;
  /** chrome.userScripts (browser.userScripts) — persistent page
   *  injections + one-shot execution. "permission" → optional
   *  userScripts permission not granted; null → API unavailable →
   *  proto.unsupported. Scripts/injections arrive pre-validated; this
   *  layer only marshals to the Chrome API. */
  userScripts?: {
    permission(): Promise<string | "permission" | null>;
    list(ids?: string[]): Promise<unknown[] | "permission" | null>;
    register(scripts: Array<Record<string, unknown>>): Promise<unknown | "permission" | null>;
    unregister(ids?: string[]): Promise<unknown | "permission" | null>;
    update(scripts: Array<Record<string, unknown>>): Promise<unknown | "permission" | null>;
    execute(injection: Record<string, unknown>): Promise<unknown[] | "permission" | null>;
    worlds(): Promise<unknown | "permission" | null>;
    configureWorld(properties: Record<string, unknown>): Promise<unknown | "permission" | null>;
    resetWorld(worldId?: string): Promise<unknown | "permission" | null>;
  } | undefined;
  /** chrome.system (browser.system) — machine resource stats.
   *  "permission" → the op's optional system.* permission not granted;
   *  null → API unavailable → proto.unsupported. */
  system?: {
    memory(): Promise<unknown | "permission" | null>;
    cpu(): Promise<unknown | "permission" | null>;
    permissions(): Promise<Record<string, boolean> | null>;
  } | undefined;
  /** chrome.processes (browser.processes) — process inventory.
   *  "permission" → optional processes permission not granted; null →
   *  API unavailable → proto.unsupported. */
  processes?: {
    permission(): Promise<string | "permission" | null>;
    list(): Promise<unknown[] | "permission" | null>;
    /** Single-process lookup for the terminate pre-flight type check.
     *  null → process not found; "permission" → ungranted;
     *  "unavailable" → chrome.processes missing on this build. */
    info?(processId: number): Promise<{ id: number | null; type: string } | "permission" | "unavailable" | null>;
    terminate?(processId: number): Promise<unknown | "permission" | "unavailable" | null>;
  } | undefined;
  /** chrome.dns (browser.dns) — hostname resolution.
   *  "permission" → optional dns permission not granted; null → API
   *  unavailable → proto.unsupported. */
  dns?: {
    permission(): Promise<string | "permission" | null>;
    resolve(hostname: string): Promise<unknown | "permission" | null>;
  } | undefined;
  /** chrome.power (browser.power) — keep-awake assertions.
   *  "permission" → optional power permission not granted; null → API
   *  unavailable → proto.unsupported. */
  power?: {
    permission(): Promise<string | "permission" | null>;
    request(level: "system" | "display"): Promise<unknown | "permission" | null>;
    release(): Promise<unknown | "permission" | null>;
  } | undefined;
  /** chrome.runtime (browser.runtime) — host introspection. No
   *  permission required; absent dep → proto.unsupported. */
  runtime?: {
    info(): Promise<unknown>;
  } | undefined;
  /** chrome.permissions (browser.permissions) — optional-permission
   *  lifecycle. optionalPermissions is the manifest's requestable set —
   *  used to validate request/remove args BEFORE any Chrome call.
   *  null results → API unavailable → proto.unsupported. */
  permissions?: {
    optionalPermissions(): string[];
    getAll(): Promise<{ permissions?: string[]; origins?: string[] } | null>;
    contains(permissions: string[]): Promise<boolean | null>;
    request(permissions: string[]): Promise<boolean | null>;
    remove(permissions: string[]): Promise<boolean | null>;
  } | undefined;
  /** chrome.action badge/title (browser.action) — the agent's status
   *  channel on the toolbar icon. set(null) clears the agent badge;
   *  the host merges it with the attention count so a pending
   *  approval can never be hidden by agent text. */
  actionBadge?: {
    get(): Promise<{ text: string; title: string }>;
    /** ownerTaskId ties the badge to the calling task — auto-clears
     *  when that task reaches a terminal status. */
    set(state: { text: string; color?: string; title?: string } | null, ownerTaskId?: string): Promise<void>;
  } | undefined;
  /** System clipboard (browser.clipboard.get/set) — implemented via
   *  the shared offscreen document; both ops require their optional
   *  permission (clipboardRead/clipboardWrite) which the dep checks
   *  before touching Chrome. Browser-global, not tab-scoped. */
  clipboard?: {
    /** null → permission/API unavailable → proto.unsupported */
    get(): Promise<{ text: string } | null>;
    /** false → permission/API unavailable → proto.unsupported;
     *  throws on operational failure. */
    set(text: string): Promise<boolean>;
  } | undefined;
  /** gateway artifact.upload — returns {artifactRef, sha256, bytes} */
  uploadArtifact?(input: {
    taskId: string;
    kind: string;
    mimeType: string;
    dataBase64: string;
  }): Promise<{ artifactRef: string; sha256: string; bytes: number }>;
  /** chrome.tabs.sendMessage with content-script ensure (index.ts helper).
   *  options.frameId targets one frame; omitted/0 = top frame. */
  sendToTab(
    tabId: number,
    message: Record<string, unknown>,
    options?: { frameId?: number },
  ): Promise<unknown>;
  getTab(tabId: number): Promise<chrome.tabs.Tab | undefined>;
  /** chrome.webNavigation.getAllFrames — frame discovery for args.frameId.
   *  Absent → page.get omits the frames list. */
  listFrames?(
    tabId: number,
  ): Promise<Array<{ frameId: number; url: string; parentFrameId?: number }>>;
  queryTabs(): Promise<chrome.tabs.Tab[]>;
  /** Recent chrome.tabs.onCreated entries (index.ts ring buffer).
   *  Page actions can open popups (target=_blank, window.open) that the
   *  task's tab scope would otherwise never see — reporting them lets
   *  the gateway acquire the new tab into scope. */
  recentTabCreations?(): Array<{
    tabId: number;
    openerTabId?: number;
    url?: string;
    title?: string;
    at: number;
  }>;
  activateTab(tabId: number): Promise<void>;
  /** chrome.tabs.highlight — select a tab in its window's strip WITHOUT
   *  activating it or focusing the window (agent marks its working set
   *  quietly). Chrome's `tabs` arg is a list of tab INDICES within the
   *  window, not tab ids. Absent dep → proto.unsupported. */
  highlightTab?(windowId: number, index: number): Promise<void>;
  closeTab(tabId: number): Promise<void>;
  /** True on headless Chromium builds (UA contains "HeadlessChrome").
   *  Window teardown crashes those builds outright — tab.close refuses
   *  to close a window's last tab and windows.remove is unavailable. */
  headlessChrome?: boolean;
  activeTabId(): Promise<number | null>;
  /** chrome.debugger CDP tier (docs/adr/debugger-tier.md). Absent dep →
   *  every CDP-backed path (click args.trusted, page.dialog,
   *  page.setInputFiles, page.responseBody, snapshot mode:"aria")
   *  fails proto.unsupported — never silently degrades to untrusted. */
  acquireCdp?(tabId: number): Promise<CdpSession>;
  releaseCdp?(tabId: number): Promise<void>;
  /** Out-of-process iframe targets (chrome.debugger.getTargets). */
  acquireCdpTarget?(targetId: string): Promise<CdpSession>;
  releaseCdpTarget?(targetId: string): Promise<void>;
  listCdpTargets?(): Promise<Array<{ id: string; type: string; url: string }>>;
  /** chrome.history.search — needs the OPTIONAL "history" permission.
   *  Return null when the permission is not granted → the tool reports
   *  proto.unsupported honestly instead of an empty fake result. */
  searchHistory?(q: {
    text?: string;
    url?: string;
    startTime?: number;
    endTime?: number;
    limit: number;
  }): Promise<
    Array<{ url: string; title?: string; visitCount?: number; lastVisitTime?: number }> | null
  >;
  /** chrome.history.deleteUrl/deleteRange — same optional 'history'
   *  permission as searchHistory; null → proto.unsupported. */
  deleteHistory?(q: {
    url?: string;
    startTime?: number;
    endTime?: number;
  }): Promise<unknown | null>;
  /** chrome.browsingData.remove — needs the OPTIONAL "browsingData"
   *  permission. sinceMs is epoch ms (0/undefined = all time);
   *  origins restricts the wipe. null → proto.unsupported. */
  browsingDataClear?(q: {
    dataTypes: string[];
    sinceMs?: number;
    origins?: string[];
  }): Promise<unknown | null>;
  /** chrome.bookmarks — needs the OPTIONAL "bookmarks" permission.
   *  Return null when the permission is not granted → proto.unsupported. */
  bookmarkOp?(op: {
    action: "list" | "search" | "get" | "create" | "update" | "remove";
    id?: string;
    parentId?: string;
    query?: string;
    title?: string;
    url?: string;
    limit: number;
  }): Promise<unknown | null>;
  /** chrome.storage.session route-rule persistence (browser.page.route)
   *  — survives an MV3 service-worker restart so mocks re-arm on the
   *  next route call instead of silently vanishing. Absent dep →
   *  rules stay memory-only (previous behavior). */
  routeRulesStore?: {
    get(tabId: number): Promise<Array<Record<string, unknown>> | undefined>;
    set(tabId: number, rules: Array<Record<string, unknown>>): Promise<void>;
    delete(tabId: number): Promise<void>;
  };
  /** chrome.storage.session emulation persistence (browser.page.emulate)
   *  — merged override args survive an MV3 service-worker restart so
   *  the next CDP-touching call re-applies them instead of silently
   *  rendering the page un-emulated. Absent dep → memory-only. */
  emulationStore?: {
    get(tabId: number): Promise<Record<string, unknown> | undefined>;
    set(tabId: number, state: Record<string, unknown>): Promise<void>;
    delete(tabId: number): Promise<void>;
  };
}

function toolError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e;
}

/** Tools whose work happens inside one frame's DOM — these accept
 *  args.frameId. Tab-level tools (tabs.*, page.get/history,
 *  downloads) reject it. page.screenshot accepts it only together
 *  with an element target (element clip); whole-tab capture rejects
 *  frameId in the case body. */
const FRAME_SCOPED_TOOLS = new Set([
  "browser.page.snapshot",
  "browser.page.extract",
  "browser.page.console",
  "browser.page.evaluate",
  "browser.page.emulate",
  "browser.page.pdf",
  "browser.page.mhtml",
  "browser.page.click",
  "browser.page.focus",
  "browser.page.type",
  "browser.page.fill",
  "browser.page.select",
  "browser.page.submit",
  "browser.page.scroll",
  "browser.page.navigate",
  "browser.page.wait",
  "browser.page.hover",
  "browser.page.press",
  "browser.page.upload",
  "browser.page.drag",
  "browser.page.find",
  "browser.page.network",
  "browser.page.setInputFiles",
  "browser.page.screenshot",
  "browser.page.cdp",
  "browser.page.pierce",
  // Per-origin page-context APIs — frameId selects that frame's origin
  // store (an OOPIF's localStorage/IDB/caches/SW registrations are a
  // distinct origin context).
  "browser.page.localStorage",
  "browser.page.indexedDB",
  "browser.page.caches",
  "browser.page.serviceWorker",
  // frameId here is a RULE scope (which frame's requests the rule
  // intercepts), validated inside addPageRoute — not a dispatch target.
  "browser.page.route",
]);

const SUPPORTED = new Set([
  "browser.tabs.list",
  "browser.tabs.wait",
  "browser.tab.activate",
  "browser.tab.highlight",
  "browser.tab.close",
  "browser.tab.create",
  "browser.tab.duplicate",
  "browser.tab.update",
  "browser.tab.discard",
  "browser.page.snapshot",
  "browser.page.get",
  "browser.page.console",
  "browser.page.evaluate",
  "browser.page.emulate",
  "browser.page.pdf",
  "browser.page.mhtml",
  "browser.page.click",
  "browser.page.focus",
  "browser.page.type",
  "browser.page.fill",
  "browser.page.select",
  "browser.page.submit",
  "browser.page.scroll",
  "browser.page.navigate",
  "browser.page.wait",
  "browser.page.hover",
  "browser.page.press",
  "browser.page.screenshot",
  "browser.page.extract",
  "browser.page.upload",
  "browser.page.drag",
  "browser.page.find",
  "browser.page.pierce",
  "browser.page.history",
  "browser.page.cookies",
  "browser.page.localStorage",
  "browser.page.indexedDB",
  "browser.page.caches",
  "browser.page.serviceWorker",
  "browser.page.cdp",
  "browser.page.coverage",
  "browser.page.metrics",
  "browser.page.screencast",
  "browser.history.search",
  "browser.history.delete",
  "browser.bookmarks",
  "browser.browsingData.clear",
  "browser.tabGroups",
  "browser.siteSettings",
  "browser.sessions",
  "browser.proxy",
  "browser.privacy",
  "browser.management",
  "browser.notifications",
  "browser.dnr",
  "browser.userScripts",
  "browser.system",
  "browser.processes",
  "browser.dns",
  "browser.power",
  "browser.runtime",
  "browser.permissions",
  "browser.action",
  "browser.clipboard.get",
  "browser.clipboard.set",
  "browser.downloads.list",
  "browser.downloads.wait",
  "browser.downloads.save",
  "browser.downloads.cancel",
  "browser.downloads.open",
  "browser.downloads.pause",
  "browser.downloads.resume",
  "browser.downloads.erase",
  "browser.windows.list",
  "browser.windows.get",
  "browser.windows.create",
  "browser.windows.update",
  "browser.windows.remove",
  "browser.page.network",
  "browser.page.dialog",
  "browser.page.setInputFiles",
  "browser.page.responseBody",
  "browser.page.webSocket",
  "browser.page.route",
  "browser.page.unroute",
]);

/** chromex-9e3: per-request tab scope snapshot computed by the Gateway
 *  tool server (authoritative TaskTabScope). The host re-checks the
 *  RESOLVED tabId — including bound-tab default and active-tab
 *  fallback — because only the host sees chrome.tabs reality. */
interface TabScopePayload {
  boundTabId: number | null;
  allowedTabIds: number[];
  foreignTabIds: number[];
}

/** Scope membership for multi-tab tools (tabGroups): mirrors
 *  resolveScopedTabId's rule — explicit allowlist wins, otherwise only
 *  foreign-tab exclusion applies. */
function tabInScope(scope: TabScopePayload | null, tabId: number): boolean {
  if (!scope) return true;
  const allowed = new Set(scope.allowedTabIds);
  if (scope.boundTabId != null) allowed.add(scope.boundTabId);
  if (allowed.size > 0) return allowed.has(tabId);
  return !scope.foreignTabIds.includes(tabId);
}

function parseTabScope(payload: unknown): TabScopePayload | null {
  const raw = (payload as { tabScope?: unknown } | null)?.tabScope;
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const nums = (v: unknown): number[] =>
    Array.isArray(v) ? v.filter((n): n is number => typeof n === "number" && Number.isInteger(n)) : [];
  return {
    boundTabId: typeof o.boundTabId === "number" ? o.boundTabId : null,
    allowedTabIds: nums(o.allowedTabIds),
    foreignTabIds: nums(o.foreignTabIds),
  };
}

async function resolveTabId(deps: ToolHostDeps, args: Record<string, unknown>): Promise<number> {
  if (typeof args.tabId === "number") return args.tabId;
  const active = await deps.activeTabId();
  if (active === null) throw toolError("browser.no_tab", "no active tab to run the tool against");
  return active;
}

/** Resolve the effective tabId for a tab-targeting tool and enforce the
 *  task's tab scope (chromex-9e3). Default order: explicit args.tabId →
 *  the task's bound tab → active tab (first bind). Out-of-scope →
 *  browser.not_in_scope, never a silent fallback to another tab. */
async function resolveScopedTabId(
  deps: ToolHostDeps,
  args: Record<string, unknown>,
  scope: TabScopePayload | null,
): Promise<number> {
  const explicit = typeof args.tabId === "number" ? args.tabId : null;
  // chromex-ykj: an implicit target with several in-scope tabs and no
  // bound default is ambiguous — never silently fall through to the
  // active tab. The caller must pass args.tabId.
  if (scope && explicit === null && scope.boundTabId == null) {
    const inScope = new Set(scope.allowedTabIds);
    if (inScope.size > 1) {
      throw toolError(
        "browser.ambiguous_target",
        `${inScope.size} tabs are in this task's scope; pass args.tabId to disambiguate`,
      );
    }
  }
  let candidate: number;
  if (explicit !== null) {
    candidate = explicit;
  } else if (scope?.boundTabId != null) {
    candidate = scope.boundTabId;
  } else {
    candidate = await resolveTabId(deps, args);
  }
  if (scope) {
    const allowed = new Set(scope.allowedTabIds);
    if (scope.boundTabId != null) allowed.add(scope.boundTabId);
    if (allowed.size > 0) {
      if (!allowed.has(candidate)) {
        throw toolError("browser.not_in_scope", `tab ${candidate} is outside this task's tab scope`);
      }
    } else {
      const foreign = new Set(scope.foreignTabIds);
      if (foreign.has(candidate)) {
        throw toolError("browser.not_in_scope", `tab ${candidate} is bound to another task`);
      }
    }
  }
  return candidate;
}

/** §4.8 preflight for the tool server's risk classifier: resolve the
 *  pending action's target inside the page and report ground-truth
 *  facts (real label, input type, form method/action, page origin).
 *  Agent args are untrusted steering — classification must use what
 *  the element actually is. Read-only: never mutates the page. */
async function describeTargetForRisk(
  deps: ToolHostDeps,
  args: Record<string, unknown>,
  scope: TabScopePayload | null,
): Promise<unknown> {
  const tabId = await resolveScopedTabId(deps, args, scope);
  const frameId = frameIdArg(args);
  // pz refs live in closed shadow roots — the content-script describe
  // can't see them, so resolve facts via CDP on the owning session
  // (frame target for OOPIF refs; location.* inside the injected
  // function already reports the owning frame's origin+path).
  const pzRef = typeof args.ref === "string" && PIERCE_REF_RE.test(args.ref) ? args.ref : undefined;
  if (pzRef !== undefined) {
    if (frameId !== 0) {
      throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId");
    }
    try {
      const hit = pierceHit(tabId, pzRef);
      const { session, release } = await pierceAcquire(deps, hit);
      try {
        const facts = await pierceElementFacts(session, hit.backendNodeId, pzRef);
        return { found: true, ...facts, resolvedTabId: tabId };
      } finally {
        await release();
      }
    } catch (e) {
      if ((e as { code?: string })?.code === "browser.element_not_found") {
        return { found: false, reason: "unknown_pierce_ref", resolvedTabId: tabId };
      }
      throw e;
    }
  }
  const res = (await deps.sendToTab(
    tabId,
    {
      type: "page.dom.describe",
      ...(typeof args.ref === "string" ? { targetRef: args.ref } : {}),
      ...(typeof args.selector === "string" ? { selector: args.selector } : {}),
      ...(typeof args.label === "string" ? { label: args.label } : {}),
      ...(typeof args.snapshotId === "string" ? { snapshotId: args.snapshotId } : {}),
    },
    { frameId },
  )) as Record<string, unknown> | undefined;
  const tab = await deps.getTab(tabId).catch(() => null);
  let pageOrigin = "";
  let pageUrl = "";
  try {
    const u = new URL(tab?.url ?? "");
    pageOrigin = u.origin;
    pageUrl = `${u.origin}${u.pathname}`;
  } catch {
    // non-http(s) or empty tab url — origin stays unresolved, which
    // fails closed inside the classifier for financial checks.
  }
  // The content script reports THIS frame's location — prefer it over
  // the tab url so subframe actions classify against the frame origin
  // (and so expectedTarget matches what dispatch-time re-verification
  // will compute inside the same frame). Tab url is the fallback for
  // not-found/no-response describes.
  const frameOrigin = res && typeof res.pageOrigin === "string" ? res.pageOrigin : "";
  const frameUrl = res && typeof res.pageUrl === "string" ? res.pageUrl : "";
  return {
    ...(res ?? { found: false, reason: "no_response" }),
    pageOrigin: frameOrigin || pageOrigin,
    pageUrl: frameUrl || pageUrl,
    resolvedTabId: tabId,
  };
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** §4.8 expectedTarget payload → bounded fact map for the content
 *  script's dispatch-time re-check. Only the known BrowserTargetFacts
 *  keys survive, strings only, each capped — the payload crosses a
 *  process boundary so it is treated as untrusted shape even though
 *  only the tool server produces it. */
const EXPECTED_TARGET_KEYS = [
  "label",
  "tagName",
  "role",
  "inputType",
  "controlType",
  "formMethod",
  "formAction",
  "href",
  "pageOrigin",
  "pageUrl",
] as const;

function sanitizeExpectedTarget(v: unknown): Record<string, string> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const src = v as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const key of EXPECTED_TARGET_KEYS) {
    const val = src[key];
    if (typeof val === "string" && val) out[key] = val.slice(0, 2048);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** args.frameId — which frame inside the tab a page.* call targets.
 *  Absent → 0 (top frame). chrome.webNavigation frameIds are
 *  non-negative integers; anything else is a caller bug. */
function frameIdArg(args: Record<string, unknown>): number {
  const v = args.frameId;
  if (v === undefined || v === null) return 0;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) {
    throw toolError("proto.invalid", "args.frameId must be a non-negative integer");
  }
  return v;
}

/** Console buffers live per-frame (`window.__chromexConsoleBuffer` in
 *  each frame's own MAIN world) — an unscoped read that only hits the
 *  top frame misses every embedded widget's console/errors. Merged
 *  collection enumerates the tab's frames and reads each buffer,
 *  tagging entries with their frameId. Capped so iframe-heavy pages
 *  stay bounded; per-frame injection failures skip honestly. */
const CONSOLE_MERGE_FRAME_CAP = 16;

async function collectConsoleEntries(
  deps: { runInMainWorld?: ToolHostDeps["runInMainWorld"] },
  tabId: number,
  limit: number,
  level: string | null,
  frameIds: number[],
): Promise<{ entries: Array<Record<string, unknown>>; captured: boolean }> {
  const merged: Array<Record<string, unknown>> = [];
  let captured = false;
  for (const fid of frameIds.slice(0, CONSOLE_MERGE_FRAME_CAP)) {
    try {
      const res = (await deps.runInMainWorld!(tabId, chromexConsoleCollect, [limit, level], [fid])) as
        | { installed?: boolean; entries?: unknown }
        | undefined;
      if (res?.installed === true) captured = true;
      for (const e of Array.isArray(res?.entries) ? res.entries : []) {
        if (e !== null && typeof e === "object") {
          merged.push({ ...(e as Record<string, unknown>), frameId: fid });
        }
      }
    } catch {
      // frame navigated away or injection refused — skip it honestly
    }
  }
  merged.sort(
    (a, b) => (typeof a.ts === "number" ? a.ts : 0) - (typeof b.ts === "number" ? b.ts : 0),
  );
  return { entries: merged.slice(-limit), captured };
}

/** Unscoped content-condition waits fan out across every frame —
 *  positive conditions (text/selector/urlContains/readyState/
 *  visibleSelector) are met when ANY frame satisfies them all;
 *  negative conditions (textGone/selectorGone) must hold in EVERY
 *  frame ("the spinner is gone" means gone everywhere, not just the
 *  top document). Each frame's page.dom.wait polls independently for
 *  the shared timeout; results combine host-side. A frame whose
 *  content script is unreachable counts as not-matched for positive
 *  conditions and not-cleared for negative ones — the wait can only
 *  claim what it verified. Returns the winning frameId as evidence. */
async function waitContentAllFrames(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  timeoutMs: number,
  frameIds: number[],
): Promise<Record<string, unknown>> {
  const started = Date.now();
  const POS_KEYS = ["text", "selector", "urlContains", "readyState", "visibleSelector"] as const;
  const NEG_KEYS = ["textGone", "selectorGone"] as const;
  const pick = (keys: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const k of keys) {
      const v = str(args[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  };
  const posArgs = pick(POS_KEYS);
  const negArgs = pick(NEG_KEYS);
  const hasPos = Object.keys(posArgs).length > 0;
  const hasNeg = Object.keys(negArgs).length > 0;
  const fids = frameIds.slice(0, CONSOLE_MERGE_FRAME_CAP);
  type WaitRes = { ok?: boolean; timedOut?: boolean; elapsedMs?: number; error?: string };
  type Job = { fid: number; group: "pos" | "neg"; res: WaitRes | undefined };
  const waitOne = async (
    fid: number,
    extra: Record<string, string>,
    group: "pos" | "neg",
  ): Promise<Job> => {
    const res = (await deps
      .sendToTab(tabId, { type: "page.dom.wait", ...extra, timeoutMs }, { frameId: fid })
      .catch(() => undefined)) as WaitRes | undefined;
    return { fid, group, res };
  };
  // Early-finish coordinator: positive conditions resolve on the FIRST
  // frame match, negative conditions need EVERY frame — waiting for
  // all jobs would hold the full timeout even after the outcome is
  // decided. Losing frames' content-script waits expire harmlessly.
  return await new Promise<Record<string, unknown>>((resolve, reject) => {
    let negPending = hasNeg ? fids.length : 0;
    let negFailed = false;
    let posSettled = 0;
    let posTotal = 0;
    let posWinner: number | undefined;
    const timeoutErr = () =>
      toolError(
        "browser.timeout",
        `wait condition was not met within ${timeoutMs}ms (${negFailed ? "condition still present in a frame" : "no frame satisfied the wait conditions"})`,
      );
    const check = () => {
      if (negFailed || (hasPos && posWinner === undefined && posSettled === posTotal)) {
        reject(timeoutErr());
        return;
      }
      if ((!hasPos || posWinner !== undefined) && negPending === 0) {
        resolve({
          ok: true,
          matched: "conditions",
          elapsedMs: Date.now() - started,
          frames: fids.length,
          resolvedTabId: tabId,
          ...(posWinner !== undefined ? { frameId: posWinner } : {}),
        });
      }
    };
    for (const fid of fids) {
      if (hasPos) {
        posTotal += 1;
        void waitOne(fid, posArgs, "pos").then((j) => {
          posSettled += 1;
          if (j.res?.ok === true && posWinner === undefined) posWinner = j.fid;
          check();
        });
      }
      if (hasNeg) {
        void waitOne(fid, negArgs, "neg").then((j) => {
          negPending -= 1;
          if (j.res?.ok !== true) negFailed = true;
          check();
        });
      }
    }
    check();
  });
}

/** Frame ids for an unscoped console read: all frames via webNavigation
 *  when available, else the top frame (frameId 0) as before. */
async function consoleFrameIds(
  deps: ToolHostDeps,
  tabId: number,
): Promise<number[] | undefined> {
  if (typeof deps.listFrames !== "function") return undefined;
  try {
    const frames = await deps.listFrames(tabId);
    const ids = [...new Set(frames.map((f) => f.frameId).filter((n) => Number.isInteger(n)))];
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

/** §6.2 snapshot metadata: TTL 5min, LRU 32/task — used by P2-02
 *  stale/verify semantics. Registry is per-extension-install. */
const snapshotRegistry = new SnapshotRegistry();

export function toolHostSnapshotRegistry(): SnapshotRegistry {
  return snapshotRegistry;
}

/** Mirrors the gateway artifact.upload decoded cap (512KiB) — keep in
 *  sync with packages/bridge/src/gateway/main.ts. */
const SCREENSHOT_MAX_DECODED_BYTES = 512 * 1024;
/** browser.page.cdp result bound — oversized CDP payloads (DOM trees,
 *  heap snapshots) report omitted:true + resultBytes instead of
 *  flooding the tool-result channel. */
const CDP_RESULT_MAX_BYTES = 256 * 1024;
/** jpeg quality ladder tried after the dep's default capture. */
const SCREENSHOT_QUALITY_RETRY = [45, 25] as const;

async function sha256Hex(data: ArrayBufferView): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function base64DecodedBytes(dataBase64: string): number {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((dataBase64.length * 3) / 4) - padding);
}

/** Shared 512KiB artifact-cap retry: attempt() returns {mimeType,
 *  dataBase64}; quality steps down until the decoded payload fits. */
async function shotWithinArtifactCap(
  attempt: (quality?: number) => Promise<{ mimeType: string; dataBase64: string }>,
): Promise<{ mimeType: string; dataBase64: string }> {
  let shot = await attempt();
  for (const quality of SCREENSHOT_QUALITY_RETRY) {
    if (base64DecodedBytes(shot.dataBase64) <= SCREENSHOT_MAX_DECODED_BYTES) return shot;
    shot = await attempt(quality);
  }
  if (base64DecodedBytes(shot.dataBase64) > SCREENSHOT_MAX_DECODED_BYTES) {
    throw toolError(
      "artifact.too_large",
      `screenshot exceeds ${SCREENSHOT_MAX_DECODED_BYTES} bytes even at the lowest jpeg quality`,
    );
  }
  return shot;
}

async function captureScreenshotWithinArtifactCap(
  capture: (windowId: number, opts?: { quality?: number }) => Promise<string>,
  windowId: number,
): Promise<{ mimeType: string; dataBase64: string }> {
  return shotWithinArtifactCap(async (quality) => {
    const dataUrl = await capture(windowId, quality === undefined ? undefined : { quality });
    const m = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(dataUrl);
    if (!m) throw toolError("browser.action_failed", "captureVisibleTab returned unexpected format");
    return { mimeType: m[1]!, dataBase64: m[2]! };
  });
}

/** Full-page capture via CDP Page.captureScreenshot captureBeyondViewport
 *  — the whole document, not just the visible viewport. Content size
 *  comes from Page.getLayoutMetrics; clip is in page CSS pixels. Very
 *  tall pages can still exceed the 512KiB artifact cap → the shared
 *  quality-retry runs, then artifact.too_large honestly (element clips
 *  remain the fallback for huge pages). */
async function captureFullPageScreenshot(
  deps: ToolHostDeps,
  tabId: number,
): Promise<{ mimeType: string; dataBase64: string }> {
  const { session, release } = await cdpAcquire(deps, tabId);
  try {
    const metrics = await session.send<{
      cssContentSize?: { width?: number; height?: number };
      contentSize?: { width?: number; height?: number };
    }>("Page.getLayoutMetrics");
    const size = metrics?.cssContentSize ?? metrics?.contentSize;
    const width = size?.width;
    const height = size?.height;
    if (typeof width !== "number" || typeof height !== "number" || width <= 0 || height <= 0) {
      throw toolError("browser.action_failed", "Page.getLayoutMetrics returned no content size");
    }
    return await shotWithinArtifactCap(async (quality) => {
      const res = await session.send<{ data?: string }>("Page.captureScreenshot", {
        format: "jpeg",
        ...(quality !== undefined ? { quality } : {}),
        captureBeyondViewport: true,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      if (typeof res?.data !== "string" || res.data.length === 0) {
        throw toolError("browser.action_failed", "Page.captureScreenshot returned no image data");
      }
      return { mimeType: "image/jpeg", dataBase64: res.data };
    });
  } finally {
    await release();
  }
}

/** Viewport capture via CDP Page.captureScreenshot WITHOUT clip —
 *  captures THIS tab's own target. Needed for background/inactive tabs:
 *  chrome.tabs.captureVisibleTab only sees the window's ACTIVE tab and
 *  would silently return another tab's pixels. */
async function captureViewportScreenshot(
  deps: ToolHostDeps,
  tabId: number,
): Promise<{ mimeType: string; dataBase64: string }> {
  const { session, release } = await cdpAcquire(deps, tabId);
  try {
    return await shotWithinArtifactCap(async (quality) => {
      const res = await session.send<{ data?: string }>("Page.captureScreenshot", {
        format: "jpeg",
        ...(quality !== undefined ? { quality } : {}),
      });
      if (typeof res?.data !== "string" || res.data.length === 0) {
        throw toolError("browser.action_failed", "Page.captureScreenshot returned no image data");
      }
      return { mimeType: "image/jpeg", dataBase64: res.data };
    });
  } finally {
    await release();
  }
}

/** Element-targeted screenshot via CDP Page.captureScreenshot clip.
 *  The element is scrolled into view, located (frame-relative or
 *  absolute via the geometry chain for subframes), then clipped in
 *  viewport CSS pixels. Requires the debugger tier — callers on other
 *  backends get proto.unsupported from cdpRequired/cdpAcquire. */
async function captureElementScreenshot(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  frameId: number,
): Promise<{ mimeType: string; dataBase64: string }> {
  const refStr = str(args.ref);
  // pz refs resolve through CDP on the session that owns the node —
  // closed roots have no content-script path. Clip coords come from
  // DOM.getBoxModel on that session: root-viewport pixels for tab-scope
  // refs (incl. same-process iframe content), frame-local for OOPIF
  // refs captured on the frame target.
  if (refStr !== undefined && PIERCE_REF_RE.test(refStr)) {
    if (frameId !== 0 || str(args.selector) !== undefined || str(args.label) !== undefined) {
      throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId and selector/label");
    }
    const hit = pierceHit(tabId, refStr);
    const { session, release } = await pierceAcquire(deps, hit);
    try {
      await session.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: hit.backendNodeId }).catch(() => {});
      const rect = await pierceBoxRect(session, hit.backendNodeId, refStr);
      if (rect.width <= 0 || rect.height <= 0) {
        throw toolError("browser.element_not_found", "element has no layout box to capture");
      }
      const clip = {
        x: Math.max(0, rect.x - rect.width / 2),
        y: Math.max(0, rect.y - rect.height / 2),
        width: rect.width,
        height: rect.height,
        scale: 1,
      };
      return await shotWithinArtifactCap(async (quality) => {
        const res = await session.send<{ data?: string }>("Page.captureScreenshot", {
          format: "jpeg",
          ...(quality !== undefined ? { quality } : {}),
          clip,
        });
        if (typeof res?.data !== "string" || res.data.length === 0) {
          throw toolError("browser.action_failed", "Page.captureScreenshot returned no image data");
        }
        return { mimeType: "image/jpeg", dataBase64: res.data };
      });
    } finally {
      await release();
    }
  }
  const target = {
    ref: str(args.ref),
    selector: str(args.selector),
    label: str(args.label),
  };
  const rect = frameId !== 0
    ? await frameAbsolutePoint(deps, tabId, target, frameId, true)
    : await cdpLocateElement(deps, tabId, args, 0, true);
  const w = rect.width;
  const h = rect.height;
  if (typeof w !== "number" || typeof h !== "number" || w <= 0 || h <= 0) {
    throw toolError("browser.element_not_found", "element has no layout box to capture");
  }
  const clip = {
    x: Math.max(0, rect.x - w / 2),
    y: Math.max(0, rect.y - h / 2),
    width: w,
    height: h,
    scale: 1,
  };
  const { session, release } = await cdpAcquire(deps, tabId);
  try {
    const res = await session.send<{ data?: string }>("Page.captureScreenshot", {
      format: "jpeg",
      quality: 80,
      clip,
    });
    if (typeof res?.data !== "string" || res.data.length === 0) {
      throw toolError("browser.action_failed", "Page.captureScreenshot returned no image data");
    }
    return { mimeType: "image/jpeg", dataBase64: res.data };
  } finally {
    await release();
  }
}

/** Tab closed: release every held CDP resource for it — emulation
 *  override, route interception, network/WS tap — and unsubscribe their
 *  chrome.debugger.onEvent listeners, which otherwise accumulate for
 *  the SW's lifetime. Sessions themselves are refcounted in cdp.ts and
 *  detach on tab close regardless. */
export async function disposeBrowserToolTabState(tabId: number): Promise<void> {
  await releaseEmulationHold(tabId).catch(() => {});
  // pz refs hold session-scoped backendNodeIds — dead with the tab;
  // drop them so a stale ref fails element_not_found instead of
  // resolving a dead node id (or leaking map entries forever).
  for (const [k, hit] of [...pierceRefs.entries()]) {
    if (hit.tabId === tabId) pierceRefs.delete(k);
  }
  // Armed file choosers die with their tab — release the held CDP
  // session so the debugger refcount doesn't leak on a dead target.
  for (const [id, p] of pendingFileChoosers) {
    if (p.tabId === tabId) {
      pendingFileChoosers.delete(id);
      await p.release().catch(() => {});
    }
  }
  const tap = networkTaps.get(tabId);
  if (tap) {
    networkTaps.delete(tabId);
    for (const un of tap.unsubs) un();
    await tap.session.send("Network.disable").catch(() => {});
    for (const f of tap.frames.values()) {
      for (const un of f.unsubs) un();
      await f.session.send("Network.disable").catch(() => {});
      await f.release?.().catch(() => {});
    }
    tap.frames.clear();
    // tap sessions are never released by design (bodies need the tap
    // alive); release the extra ref the tap holds now that the tab is
    // gone — cdp.ts already dropped the state, so this is a no-op guard.
  }
  const hold = routeHolds.get(tabId);
  if (hold) {
    routeHolds.delete(tabId);
    for (const un of hold.unsubs) un();
    await hold.session.send("Fetch.disable").catch(() => {});
    for (const f of hold.frames.values()) {
      for (const un of f.unsubs) un();
      await f.session.send("Fetch.disable").catch(() => {});
      await f.release?.().catch(() => {});
    }
    hold.frames.clear();
    await hold.release().catch(() => {});
  }
}

/** Task purged/released: drop task-scoped held state so a dead task's
 *  pending file chooser can't pin a CDP session (and block the page's
 *  chooser flow) until its tab happens to close. Tab-scoped resources
 *  (routes, taps, emulation, CDP holds) are NOT touched — they belong
 *  to the tab, which outlives any single task. */
export async function disposeBrowserToolTaskState(taskId: string): Promise<void> {
  if (!taskId) return;
  for (const [id, p] of pendingFileChoosers) {
    if (p.taskId === taskId) {
      pendingFileChoosers.delete(id);
      await p.release().catch(() => {});
    }
  }
}

/** Tool-request handler plus tab-scoped cleanup for closure-held CDP
 *  sessions (coverage/metrics/screencast) — index.ts calls disposeTab
 *  from chrome.tabs.onRemoved alongside disposeBrowserToolTabState. */
export interface BrowserToolHostHandler {
  (payload: unknown): Promise<unknown>;
  disposeTab?: (tabId: number) => Promise<void>;
}

export function createToolHostHandler(deps: ToolHostDeps): BrowserToolHostHandler {
  // JS-coverage sessions held across tool calls — one Profiler session
  // per tab, refcounted through the shared CDP layer so other CDP tools
  // keep working while coverage runs. Dies with the handler (SW
  // restart detaches debugger targets) — the next call reports
  // not-running honestly.
  const coverageHolds = new Map<
    number,
    { session: CdpSession; release: () => Promise<void> }
  >();
  // Performance-metric sessions — same held-session pattern as
  // coverageHolds (one per tab, dies with the SW).
  const metricsHolds = new Map<
    number,
    { session: CdpSession; release: () => Promise<void> }
  >();
  // Screencast sessions — Page.startScreencast held across tool calls,
  // one per tab. Frames accumulate in memory (bounded by maxFrames)
  // and become artifacts on stop. Dies with the handler (SW restart
  // detaches the debugger) — status then reports not-running honestly.
  const screencastHolds = new Map<
    number,
    {
      session: CdpSession;
      release: () => Promise<void>;
      frames: Array<{ data: string; timestamp: number }>;
      unsubs: Array<() => void>;
    }
  >();
  const handleToolRequest: BrowserToolHostHandler = async function handleToolRequest(payload: unknown): Promise<unknown> {
    const req = (payload ?? {}) as {
      toolCallId?: string;
      taskId?: string;
      turnId?: string;
      tool?: string;
      args?: Record<string, unknown>;
      expectedTarget?: unknown;
    };
    const tool = req.tool ?? "";
    const args = req.args ?? {};
    const tabScope = parseTabScope(payload);
    // §4.8 dispatch binding: facts the tool server's risk classifier
    // approved — forwarded to whichever dispatch path runs (DOM step,
    // trusted locate, or targetless describe-verify) so the content
    // script re-derives them at the closest atomic point before acting.
    // Sanitized to known string keys; malformed payloads drop the check
    // (unbound dispatch is honest — the action still runs).
    const expectedTarget = sanitizeExpectedTarget(req.expectedTarget);
    // §4.8 risk preflight — NOT an agent tool: the tool server calls this
    // internally before classification so the verdict sees ground-truth
    // element/page facts instead of only agent-supplied args. Resolves
    // the same scoped tab + target the action would hit.
    if (tool === "browser.internal.describeTarget") {
      return describeTargetForRisk(deps, args, tabScope);
    }
    if (!SUPPORTED.has(tool)) {
      throw toolError("proto.unsupported", `browser tool ${tool} is not implemented in the extension host`);
    }
    // args.frameId selects a frame inside the tab (chrome.webNavigation
    // frameIds; 0/absent = top). Only tools that execute inside a frame's
    // DOM accept it — tab-level tools must reject it loudly rather than
    // silently ignore a scope the caller asked for.
    if (args.frameId !== undefined && args.frameId !== null && !FRAME_SCOPED_TOOLS.has(tool)) {
      throw toolError("proto.invalid", `args.frameId is not supported for ${tool}`);
    }

    switch (tool) {
      case "browser.tabs.list": {
        // §6.1.1 privacy-first: on-demand only, internal pages excluded,
        // query/hash stripped (may carry sensitive params). Full URLs
        // are available via browser.page.get / snapshot within scope.
        const INTERNAL = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;
        // chromex-9e3: never surface tabs owned by other tasks.
        const foreign = new Set(tabScope?.foreignTabIds ?? []);
        const tabs = (await deps.queryTabs()).filter((t) => {
          const u = t.url ?? "";
          return u !== "" && !INTERNAL.test(u) && !(typeof t.id === "number" && foreign.has(t.id));
        });
        return {
          tabs: tabs.map((t) => {
            let safeUrl = t.url ?? "";
            let origin = "";
            try {
              const u = new URL(safeUrl);
              origin = u.origin;
              safeUrl = `${u.origin}${u.pathname}`;
            } catch {
              safeUrl = "";
            }
            return {
              id: t.id,
              title: t.title ?? "",
              url: safeUrl,
              origin,
              active: t.active === true,
              windowId: t.windowId,
              // loading state matters to the agent: snapshot/click on a
              // still-loading tab observes a half-built DOM.
              status: t.status ?? "complete",
              ...(typeof t.pinned === "boolean" ? { pinned: t.pinned } : {}),
              ...(typeof t.groupId === "number" ? { groupId: t.groupId } : {}),
              // strip position — the agent needs it to reason about
              // tab.update index moves (chrome.tabs.move counts every
              // tab in the window, including foreign ones).
              ...(typeof t.index === "number" ? { index: t.index } : {}),
              // discard state — the agent sees which tabs Chrome already
              // unloaded and which are protected from auto-discard.
              ...(typeof t.discarded === "boolean" ? { discarded: t.discarded } : {}),
              ...(typeof t.autoDiscardable === "boolean" ? { autoDiscardable: t.autoDiscardable } : {}),
              // strip selection state — browser.tab.highlight sets it;
              // the agent reads it back to verify its mark landed.
              ...(typeof t.highlighted === "boolean" ? { highlighted: t.highlighted } : {}),
            };
          }),
        };
      }
      case "browser.tabs.wait": {
        // Wait for a NEW tab matching urlContains — the async-popup
        // barrier (OAuth/SSO redirects, window.open, target=_blank
        // flows) that post-action openedTabs[] cannot cover because
        // the popup arrives seconds after the click returns.
        // Baseline-diff semantics: tabs present at call time never
        // match, so a pre-existing tab with the same URL can't
        // false-positive. Same visibility filter as tabs.list.
        // closedTabId mode: wait until a SPECIFIC tab disappears —
        // the "popup self-closes after OAuth callback" complement to
        // disappear (which matches by URL). Mutually exclusive with
        // the urlContains modes.
        const closedTabId = args.closedTabId;
        if (closedTabId !== undefined) {
          if (typeof closedTabId !== "number" || !Number.isInteger(closedTabId) || closedTabId < 0) {
            throw toolError("proto.invalid", "browser.tabs.wait args.closedTabId must be a non-negative integer tabId");
          }
          if (args.urlContains !== undefined || args.disappear !== undefined || args.waitForLoad !== undefined) {
            throw toolError("proto.invalid", "browser.tabs.wait args.closedTabId cannot combine with urlContains/disappear/waitForLoad");
          }
          const closeTimeoutMs = Math.min(
            Math.max(typeof args.timeoutMs === "number" ? args.timeoutMs : 10_000, 0),
            30_000,
          );
          const allTabs = await deps.queryTabs();
          if (!allTabs.some((t) => t.id === closedTabId)) {
            // Already gone (or never existed) — the condition is
            // satisfied; alreadyClosed distinguishes a real close
            // from a mistyped id in the evidence.
            return { ok: true, matched: "closed", closedTabId, alreadyClosed: true };
          }
          const closeDeadline = Date.now() + closeTimeoutMs;
          for (;;) {
            const stillThere = (await deps.queryTabs()).some((t) => t.id === closedTabId);
            if (!stillThere) {
              return { ok: true, matched: "closed", closedTabId };
            }
            if (Date.now() >= closeDeadline) {
              throw toolError(
                "browser.timeout",
                `tab ${closedTabId} still open after ${closeTimeoutMs}ms`,
              );
            }
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        const urlContains = str(args.urlContains);
        if (urlContains === undefined || urlContains.length === 0 || urlContains.length > 512) {
          throw toolError("proto.invalid", "browser.tabs.wait requires args.urlContains (non-empty string ≤512 chars) or args.closedTabId");
        }
        const waitTimeoutMs = Math.min(
          Math.max(typeof args.timeoutMs === "number" ? args.timeoutMs : 10_000, 0),
          30_000,
        );
        // waitForLoad: keep waiting until the matched tab reaches
        // status "complete" — OAuth redirects land on the URL while the
        // document is still loading, and operating a half-loaded page is
        // the classic popup-flow bug.
        if (args.waitForLoad !== undefined && typeof args.waitForLoad !== "boolean") {
          throw toolError("proto.invalid", "browser.tabs.wait args.waitForLoad must be a boolean");
        }
        const waitForLoad = args.waitForLoad === true;
        // disappear:true inverts the wait — hold until NO visible tab's
        // sanitized URL contains urlContains anymore. The OAuth-popup
        // self-close pattern (window.close() after the callback) needs
        // exactly this: the agent must observe the tab going away, not
        // just arriving. Returns immediately if nothing matches at call
        // time — that IS the satisfied condition.
        if (args.disappear !== undefined && typeof args.disappear !== "boolean") {
          throw toolError("proto.invalid", "browser.tabs.wait args.disappear must be a boolean");
        }
        const disappear = args.disappear === true;
        if (disappear && waitForLoad) {
          throw toolError("proto.invalid", "browser.tabs.wait waitForLoad has no meaning with disappear");
        }
        const INTERNAL = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;
        const foreign = new Set(tabScope?.foreignTabIds ?? []);
        const visible = (tabs: chrome.tabs.Tab[]) =>
          tabs.filter((t) => {
            const u = t.url ?? "";
            return u !== "" && !INTERNAL.test(u) && !(typeof t.id === "number" && foreign.has(t.id));
          });
        const sanitize = (raw: string) => {
          try {
            const u = new URL(raw);
            return `${u.origin}${u.pathname}`;
          } catch {
            return "";
          }
        };
        if (disappear) {
          const goneDeadline = Date.now() + waitTimeoutMs;
          for (;;) {
            const stillThere = visible(await deps.queryTabs()).some(
              (t) => sanitize(t.url ?? "").includes(urlContains),
            );
            if (!stillThere) {
              return { ok: true, matched: "disappear" };
            }
            if (Date.now() >= goneDeadline) {
              throw toolError(
                "browser.timeout",
                `tab matching "${urlContains}" still present after ${waitTimeoutMs}ms`,
              );
            }
            await new Promise((r) => setTimeout(r, 200));
          }
        }
        const baseline = new Set(
          visible(await deps.queryTabs())
            .map((t) => t.id)
            .filter((id): id is number => typeof id === "number"),
        );
        const deadline = Date.now() + waitTimeoutMs;
        let candidate: chrome.tabs.Tab | undefined;
        while (Date.now() < deadline) {
          const tabs = visible(await deps.queryTabs());
          if (!candidate) {
            candidate = tabs.find(
              (t) => typeof t.id === "number" && !baseline.has(t.id) && sanitize(t.url ?? "").includes(urlContains),
            );
          } else {
            // Same tab, fresh state — it may have finished loading or
            // been closed (closed → drop candidate, a later new tab
            // with the same URL may still match).
            candidate = tabs.find((t) => t.id === candidate?.id) ?? undefined;
          }
          if (candidate && (!waitForLoad || candidate.status === "complete")) break;
          await new Promise((r) => setTimeout(r, 200));
        }
        const hit = candidate;
        if (!hit || typeof hit.id !== "number") {
          throw toolError(
            "browser.timeout",
            `no new tab matching "${urlContains}" within ${waitTimeoutMs}ms`,
          );
        }
        return {
          ok: true,
          matched: "newTab",
          // tabId is a harvest key — the bridge acquires the popup into
          // this task's scope so follow-up tools don't hit
          // browser.not_in_scope. id mirrors the tabs.list shape.
          newTabId: hit.id,
          tab: {
            tabId: hit.id,
            id: hit.id,
            title: hit.title ?? "",
            url: sanitize(hit.url ?? ""),
            windowId: hit.windowId,
            status: hit.status ?? "complete",
          },
        };
      }
      case "browser.tab.activate": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        await deps.activateTab(tabId);
        return { activated: tabId, resolvedTabId: tabId };
      }
      case "browser.tab.highlight": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        if (!deps.highlightTab) {
          throw toolError("proto.unsupported", "tab highlight is not available on this host");
        }
        const tab = await deps.getTab(tabId);
        const windowId = tab?.windowId;
        // chrome.tabs.highlight takes tab INDICES within the window, not
        // tab ids — passing the id throws "No tab at index".
        const index = tab?.index;
        if (typeof windowId !== "number" || typeof index !== "number") {
          throw toolError("browser.action_failed", `tab ${tabId} has no window/index`);
        }
        await deps.highlightTab(windowId, index);
        return { highlighted: tabId, windowId, index, resolvedTabId: tabId };
      }
      case "browser.tab.close": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        // Headless Chromium crashes on window teardown — closing a
        // window's LAST tab destroys the window (BUS_ADRALN, reproduced
        // on CfT 158). Refuse rather than kill the whole browser; the
        // agent can open a sibling tab first, then close this one.
        if (deps.headlessChrome) {
          const [tab, all] = await Promise.all([deps.getTab(tabId), deps.queryTabs()]);
          const siblings = all.filter((t) => t.windowId === tab?.windowId);
          if (siblings.length <= 1) {
            throw toolError(
              "proto.unsupported",
              "closing the last tab of a window tears the window down, which crashes headless Chromium — open another tab in the window first, then close this one",
            );
          }
        }
        await deps.closeTab(tabId);
        return { closed: tabId, resolvedTabId: tabId };
      }
      case "browser.tab.update": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const pinned = typeof args.pinned === "boolean" ? args.pinned : undefined;
        const muted = typeof args.muted === "boolean" ? args.muted : undefined;
        const autoDiscardable = typeof args.autoDiscardable === "boolean" ? args.autoDiscardable : undefined;
        const frozen = typeof args.frozen === "boolean" ? args.frozen : undefined;
        const zoomFactor =
          typeof args.zoomFactor === "number" && Number.isFinite(args.zoomFactor)
            ? args.zoomFactor
            : undefined;
        if (args.zoomFactor !== undefined && (zoomFactor === undefined || zoomFactor < 0.25 || zoomFactor > 5)) {
          throw toolError("proto.invalid", "browser.tab.update args.zoomFactor must be a number in [0.25, 5]");
        }
        const index =
          typeof args.index === "number" && Number.isInteger(args.index) && args.index >= -1
            ? args.index
            : undefined;
        if (args.index !== undefined && index === undefined) {
          throw toolError("proto.invalid", "browser.tab.update args.index must be an integer >= -1 (-1 = end of strip)");
        }
        // windowId retargets the move into another window (chrome.tabs.move
        // cross-window). Alone it means "end of that window's strip".
        const windowId =
          typeof args.windowId === "number" && Number.isInteger(args.windowId)
            ? args.windowId
            : undefined;
        if (args.windowId !== undefined && windowId === undefined) {
          throw toolError("proto.invalid", "browser.tab.update args.windowId must be an integer");
        }
        const wantsMove = index !== undefined || windowId !== undefined;
        if (pinned === undefined && muted === undefined && autoDiscardable === undefined && frozen === undefined && zoomFactor === undefined && !wantsMove) {
          throw toolError("proto.invalid", "browser.tab.update requires args.pinned, args.muted, args.autoDiscardable, args.frozen, args.zoomFactor, args.index and/or args.windowId");
        }
        if ((pinned !== undefined || muted !== undefined || autoDiscardable !== undefined) && !deps.updateTab) {
          throw toolError("proto.unsupported", "tab update is not available on this host");
        }
        if (zoomFactor !== undefined && !deps.setTabZoom) {
          throw toolError("proto.unsupported", "tab zoom is not available on this host");
        }
        if (wantsMove && !deps.moveTab) {
          throw toolError("proto.unsupported", "tab reorder is not available on this host");
        }
        if (pinned !== undefined || muted !== undefined || autoDiscardable !== undefined) {
          await deps.updateTab!(tabId, {
            ...(pinned !== undefined ? { pinned } : {}),
            ...(muted !== undefined ? { muted } : {}),
            ...(autoDiscardable !== undefined ? { autoDiscardable } : {}),
          });
        }
        if (zoomFactor !== undefined) {
          await deps.setTabZoom!(tabId, zoomFactor);
        }
        if (wantsMove) {
          // windowId alone → end of the target window's strip.
          const moveIndex = index ?? -1;
          // Headless Chromium crashes on window teardown — moving a
          // window's LAST tab into another window destroys the source
          // window (same BUS_ADRALN class as tab.close/windows.remove).
          // Refuse rather than kill the browser.
          if (deps.headlessChrome && windowId !== undefined) {
            const [tab, all] = await Promise.all([deps.getTab(tabId), deps.queryTabs()]);
            if (windowId !== tab?.windowId) {
              const siblings = all.filter((t) => t.windowId === tab?.windowId);
              if (siblings.length <= 1) {
                throw toolError(
                  "proto.unsupported",
                  "moving the last tab out of a window tears the window down, which crashes headless Chromium — leave a sibling tab in the source window first",
                );
              }
            }
          }
          await deps.moveTab!(tabId, moveIndex, windowId);
        }
        if (frozen !== undefined) {
          // WICG web-lifecycle freeze via CDP Page domain — Page is NOT
          // one of the domains chrome.debugger filters (unlike
          // Profiler), so this has real parity with the isolated
          // backend's CDPSession. Freezing halts the page's event loop
          // (timers/rAF/input) without unloading — the honest middle
          // ground between discard and close.
          const { session, release } = await cdpAcquire(deps, tabId);
          try {
            await session.send("Page.setWebLifecycleState", {
              state: frozen ? "frozen" : "active",
            });
          } catch (e) {
            const msg = String((e as Error)?.message ?? e);
            const code = (e as { code?: number })?.code;
            if (code === -32601 || msg.includes("wasn't found") || msg.includes("not found")) {
              throw toolError(
                "proto.unsupported",
                "Page.setWebLifecycleState is not exposed via chrome.debugger on this Chrome build",
              );
            }
            throw toolError("browser.action_failed", `Page.setWebLifecycleState failed: ${msg.slice(0, 200)}`);
          } finally {
            await release().catch(() => {});
          }
        }
        return {
          updated: tabId,
          resolvedTabId: tabId,
          ...(pinned !== undefined ? { pinned } : {}),
          ...(muted !== undefined ? { muted } : {}),
          ...(autoDiscardable !== undefined ? { autoDiscardable } : {}),
          ...(frozen !== undefined ? { frozen } : {}),
          ...(zoomFactor !== undefined ? { zoomFactor } : {}),
          ...(index !== undefined ? { index } : {}),
          ...(windowId !== undefined ? { windowId } : {}),
        };
      }
      case "browser.tab.discard": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        if (!deps.discardTab) {
          throw toolError("proto.unsupported", "tab discard is not available on this host");
        }
        await deps.discardTab(tabId);
        return { discarded: tabId, resolvedTabId: tabId };
      }
      case "browser.tab.create": {
        // chromex-he2: opens a NEW tab — no existing tab to scope-check.
        // The created tab enters this task's scope via the result's
        // tabId/openedTabId (tool-server harvestTabRefs + resolvedTabId
        // bind). Only http(s) or blank — other schemes are refused
        // host-side even if the classifier approved them.
        if (!deps.createTab) {
          throw toolError("proto.unsupported", "tab creation is not available on this host");
        }
        const rawUrl = str(args.url);
        let url: string | undefined;
        if (rawUrl) {
          let parsed: URL;
          try {
            parsed = new URL(rawUrl);
          } catch {
            throw toolError("proto.invalid", "browser.tab.create args.url is not a valid URL");
          }
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw toolError("proto.invalid", "browser.tab.create only supports http(s) urls");
          }
          url = parsed.href;
        }
        const active = typeof args.active === "boolean" ? args.active : true;
        const pinned = typeof args.pinned === "boolean" ? args.pinned : undefined;
        const muted = typeof args.muted === "boolean" ? args.muted : undefined;
        const autoDiscardable = typeof args.autoDiscardable === "boolean" ? args.autoDiscardable : undefined;
        // windowId targets a specific browser window — must be a real
        // window or chrome.tabs.create throws; validate as non-negative
        // int and let the API surface unknown-window errors honestly.
        const windowId =
          typeof args.windowId === "number" && Number.isInteger(args.windowId) && args.windowId >= 0
            ? args.windowId
            : undefined;
        if (args.windowId !== undefined && windowId === undefined) {
          throw toolError("proto.invalid", "browser.tab.create args.windowId must be a non-negative integer");
        }
        const tab = await deps.createTab({
          ...(url ? { url } : {}),
          active,
          ...(windowId !== undefined ? { windowId } : {}),
          ...(pinned !== undefined ? { pinned } : {}),
          ...(muted !== undefined ? { muted } : {}),
          ...(autoDiscardable !== undefined ? { autoDiscardable } : {}),
        });
        if (typeof tab.id !== "number") {
          throw toolError("browser.action_failed", "chrome.tabs.create returned no tab id");
        }
        // §6.1.1 privacy: same redaction as tabs.list — no query/hash.
        let safeUrl = "";
        let origin = "";
        try {
          const u = new URL(tab.url ?? url ?? "about:blank");
          origin = u.origin;
          safeUrl = `${u.origin}${u.pathname}`;
        } catch {
          safeUrl = "";
        }
        return {
          openedTabId: tab.id,
          tabId: tab.id,
          resolvedTabId: tab.id,
          id: tab.id,
          url: safeUrl,
          origin,
          title: tab.title ?? "",
          active: tab.active === true,
        };
      }
      case "browser.tab.duplicate": {
        // Clones a scoped tab with its session — the agent can fork a
        // page to experiment without losing the original state. The new
        // tab enters this task's scope via openedTabId harvest.
        if (!deps.duplicateTab) {
          throw toolError("proto.unsupported", "tab duplication is not available on this host");
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const tab = await deps.duplicateTab(tabId);
        if (typeof tab.id !== "number") {
          throw toolError("browser.action_failed", "chrome.tabs.duplicate returned no tab id");
        }
        let safeUrl = "";
        let origin = "";
        try {
          const u = new URL(tab.url ?? "about:blank");
          origin = u.origin;
          safeUrl = `${u.origin}${u.pathname}`;
        } catch {
          safeUrl = "";
        }
        return {
          openedTabId: tab.id,
          tabId: tab.id,
          resolvedTabId: tab.id,
          id: tab.id,
          duplicatedFromTabId: tabId,
          url: safeUrl,
          origin,
          title: tab.title ?? "",
          active: tab.active === true,
        };
      }
      case "browser.page.console": {
        // chromex-nr8: MAIN-world console buffer via chrome.scripting.
        // Content scripts cannot see page console calls (isolated world).
        if (!deps.runInMainWorld) {
          throw toolError("proto.unsupported", "console capture requires the scripting permission");
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.min(Math.max(Math.floor(args.limit), 1), 200)
            : 100;
        const level = str(args.level) ?? null;
        // Unscoped (no args.frameId) reads merge every frame's buffer —
        // console buffers are per-frame, so a top-frame-only read would
        // silently miss embedded-widget errors. Explicit frameId keeps
        // the single-frame read (0 = top frame, unchanged).
        if (args.frameId === undefined || args.frameId === null) {
          const fids = await consoleFrameIds(deps, tabId);
          if (fids !== undefined) {
            const merged = await collectConsoleEntries(deps, tabId, limit, level, fids);
            return {
              entries: merged.entries,
              captured: merged.captured,
              frames: fids.length,
              resolvedTabId: tabId,
            };
          }
        }
        const frameId = frameIdArg(args);
        const res = (await deps.runInMainWorld!(tabId, chromexConsoleCollect, [limit, level], [frameId])) as
          | { installed?: boolean; entries?: unknown }
          | undefined;
        return {
          entries: Array.isArray(res?.entries) ? res.entries : [],
          captured: res?.installed === true,
          resolvedTabId: tabId,
        };
      }
      case "browser.page.evaluate": {
        // Arbitrary JS in the page MAIN world (chrome.scripting). Always
        // approval-gated by the risk classifier — the expression is
        // opaque to it. Result is JSON-bounded; page-thrown errors come
        // back as {ok:false,error} rather than a tool failure.
        // pz refs take the CDP node-scoped path below and need no
        // scripting permission — only the MAIN-world path does.
        const evalRef = str(args.ref);
        const isPierceEval = evalRef !== undefined && PIERCE_REF_RE.test(evalRef);
        if (!isPierceEval && !deps.runInMainWorld) {
          throw toolError("proto.unsupported", "page evaluation requires the scripting permission");
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const expression = str(args.expression);
        if (expression === undefined || expression.trim().length === 0) {
          throw toolError("proto.invalid", "browser.page.evaluate requires args.expression");
        }
        if (expression.length > 65536) {
          throw toolError("proto.invalid", "args.expression exceeds 64KiB");
        }
        const frameId = frameIdArg(args);
        const timeoutMs =
          typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
            ? Math.min(Math.max(args.timeoutMs, 100), 15_000)
            : 10_000;
        // pz refs scope the expression to a closed-shadow-root element —
        // `this` binds to the node via Runtime.callFunctionOn. Same
        // approval gate applies (opaque expression, risk classifier).
        if (isPierceEval) {
          if (frameId !== 0) {
            throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId");
          }
          cdpRequired(deps);
          return await pierceEvaluate(deps, tabId, evalRef!, expression, timeoutMs);
        }
        const evaluateDispatchedAt = Date.now();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let res = (await Promise.race([
          deps.runInMainWorld!(tabId, chromexEvaluate as (...fnArgs: unknown[]) => unknown, [expression], [frameId]),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(toolError("browser.timeout", `evaluate exceeded ${timeoutMs}ms`)), timeoutMs);
          }),
        ]).finally(() => clearTimeout(timer))) as
          | { ok?: boolean; value?: unknown; error?: string; truncated?: boolean }
          | undefined;
        // Trusted Types fallback: sites like YouTube block string→script
        // compilation in the page, so chrome.scripting's AsyncFunction
        // constructor throws before the expression runs (no side effects
        // — safe to retry). CDP Runtime.evaluate compiles in the
        // inspector context, bypassing the page policy. Top frame only:
        // Runtime.evaluate has no per-frame context without extra
        // Page.createIsolatedWorld plumbing.
        if (
          res?.ok !== true &&
          frameId === 0 &&
          typeof res?.error === "string" &&
          /trusted ?types?/i.test(res.error) &&
          deps.acquireCdp &&
          deps.releaseCdp
        ) {
          const { session, release } = await cdpAcquire(deps, tabId);
          try {
            const cdpRes = await session.send<{
              result?: { value?: unknown };
              exceptionDetails?: { text?: string; exception?: { description?: string } };
            }>("Runtime.evaluate", {
              expression: `(async()=>{ "use strict"; return (\n${expression}\n); })()`,
              awaitPromise: true,
              returnByValue: true,
            });
            const exc = cdpRes?.exceptionDetails;
            if (exc) {
              throw toolError(
                "browser.action_failed",
                `page evaluation failed: ${exc.exception?.description ?? exc.text ?? "page threw"}`,
              );
            }
            res = { ok: true, value: cdpRes?.result?.value ?? null };
          } finally {
            await release().catch(() => {});
          }
        }
        if (!res || res.ok !== true) {
          throw toolError("browser.action_failed", `page evaluation failed: ${res?.error ?? "no result"}`);
        }
        const openedTabs = await collectOpenedTabs(deps, tabId, evaluateDispatchedAt);
        return {
          ok: true,
          value: res.value ?? null,
          truncated: res.truncated === true,
          ...(openedTabs.length > 0 ? { openedTabs } : {}),
          resolvedTabId: tabId,
          frameId,
        };
      }
      case "browser.page.emulate": {
        // CDP Emulation/Network overrides are SESSION-scoped: they die
        // with the debugger attach, and our sessions detach at
        // refcount 0. emulate therefore holds its session open until
        // args.reset or tab close — the "debugging" infobar stays while
        // emulation is active (honest UX, documented in the ADR).
        cdpRequired(deps);
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        if (frameIdArg(args) !== 0) {
          throw toolError("proto.invalid", "browser.page.emulate is tab-scoped; args.frameId is not supported");
        }
        const hold = await emulationHold(deps, tabId);
        try {
          if (args.reset === true) {
            await applyEmulationReset(hold.session);
            await deps.emulationStore?.delete(tabId).catch(() => {});
            await releaseEmulationHold(tabId);
            return { ok: true, reset: true, resolvedTabId: tabId };
          }
          const applied = await applyEmulation(hold.session, args);
          await persistEmulationArgs(deps, tabId, args);
          return { ok: true, applied, resolvedTabId: tabId };
        } catch (e) {
          if (e instanceof Error && "code" in e) throw e;
          throw toolError("browser.action_failed", `emulation failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      case "browser.page.pdf": {
        // CDP Page.printToPDF — the agent's "save this page" deliverable.
        // PDF bytes go to the artifact store (no inline payload: a PDF
        // is not provider-consumable image input and would flood context).
        cdpRequired(deps);
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        if (frameIdArg(args) !== 0) {
          throw toolError("proto.invalid", "browser.page.pdf is tab-scoped; args.frameId is not supported");
        }
        const { session, release } = await cdpAcquire(deps, tabId);
        try {
          const landscape = args.landscape === true;
          const printBackground = args.printBackground !== false;
          const paperWidth = numArg(args.paperWidth, "paperWidth", 3, 24) ?? 8.5;
          const paperHeight = numArg(args.paperHeight, "paperHeight", 3, 24) ?? 11;
          // Retry at lower scale until the PDF fits the 512KiB artifact
          // cap — same bounded-egress rule as screenshots.
          let pdf: { data: string } | undefined;
          for (const scale of [1, 0.8, 0.6, 0.45]) {
            const res = (await session.send("Page.printToPDF", {
              landscape, printBackground, scale,
              paperWidth, paperHeight,
              marginTop: 0.4, marginBottom: 0.4, marginLeft: 0.4, marginRight: 0.4,
            })) as { data?: string } | undefined;
            pdf = res?.data ? { data: res.data } : undefined;
            if (pdf && base64DecodedBytes(pdf.data) <= SCREENSHOT_MAX_DECODED_BYTES) break;
          }
          if (!pdf) throw toolError("browser.action_failed", "Page.printToPDF returned no data");
          const bytes = base64DecodedBytes(pdf.data);
          if (bytes > SCREENSHOT_MAX_DECODED_BYTES) {
            throw toolError(
              "proto.payload_too_large",
              `pdf is ${bytes} bytes — exceeds the ${SCREENSHOT_MAX_DECODED_BYTES}-byte artifact cap even at minimum scale`,
            );
          }
          const out: Record<string, unknown> = {
            ok: true,
            mimeType: "application/pdf",
            bytes,
            sha256: await sha256Hex(Uint8Array.from(atob(pdf.data), (c) => c.charCodeAt(0))),
            resolvedTabId: tabId,
          };
          if (deps.uploadArtifact) {
            const art = await deps.uploadArtifact({
              taskId: req.taskId ?? "",
              kind: "pdf",
              mimeType: "application/pdf",
              dataBase64: pdf.data,
            });
            out.artifactRef = art.artifactRef;
          }
          return out;
        } finally {
          await release();
        }
      }
      case "browser.page.mhtml": {
        // CDP Page.captureSnapshot — full-fidelity MHTML evidence
        // (iframes, shadow DOM, external resources, inline styles).
        // The MHTML string is UTF-8 encoded, base64'd for the artifact
        // store, and bounded by the same 512KiB cap as pdf/screenshot.
        cdpRequired(deps);
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        if (frameIdArg(args) !== 0) {
          throw toolError("proto.invalid", "browser.page.mhtml is tab-scoped; args.frameId is not supported");
        }
        const { session, release } = await cdpAcquire(deps, tabId);
        try {
          const res = (await session.send("Page.captureSnapshot", { format: "mhtml" })) as { data?: unknown } | undefined;
          if (typeof res?.data !== "string" || res.data.length === 0) {
            throw toolError("browser.action_failed", "Page.captureSnapshot returned no data");
          }
          const dataBase64 = utf8ToBase64(res.data);
          const bytes = base64DecodedBytes(dataBase64);
          if (bytes > SCREENSHOT_MAX_DECODED_BYTES) {
            throw toolError(
              "proto.payload_too_large",
              `mhtml is ${bytes} bytes — exceeds the ${SCREENSHOT_MAX_DECODED_BYTES}-byte artifact cap`,
            );
          }
          const out: Record<string, unknown> = {
            ok: true,
            mimeType: "multipart/related",
            bytes,
            sha256: await sha256Hex(new TextEncoder().encode(res.data)),
            resolvedTabId: tabId,
          };
          if (deps.uploadArtifact) {
            const art = await deps.uploadArtifact({
              taskId: req.taskId ?? "",
              kind: "mhtml",
              mimeType: "multipart/related",
              dataBase64,
            });
            out.artifactRef = art.artifactRef;
          }
          return out;
        } finally {
          await release();
        }
      }
      case "browser.page.get": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const tab = await deps.getTab(tabId);
        if (!tab) throw toolError("browser.no_tab", `tab ${tabId} not found`);
        // Frame discovery for args.frameId: urls are stripped to
        // origin+path (same privacy rule as tabs.list — query/hash can
        // carry tokens). frameId 0 is always the top frame.
        let frames: Array<{ frameId: number; url: string; parentFrameId?: number }> | undefined;
        if (deps.listFrames) {
          try {
            frames = (await deps.listFrames(tabId)).map((f) => {
              let safe = "";
              try {
                const u = new URL(f.url);
                safe = `${u.origin}${u.pathname}`;
              } catch {
                safe = "";
              }
              return {
                frameId: f.frameId,
                url: safe,
                ...(typeof f.parentFrameId === "number" ? { parentFrameId: f.parentFrameId } : {}),
              };
            });
          } catch {
            frames = undefined;
          }
        }
        // Scroll/viewport position — content script knows it; chrome.tabs
        // does not. Absent content script → field omitted, not faked.
        let scroll: Record<string, number> | undefined;
        try {
          const sp = (await deps.sendToTab(tabId, { type: "page.scrollpos" })) as Record<string, number>;
          if (sp && typeof sp.scrollY === "number") scroll = sp;
        } catch {
          scroll = undefined;
        }
        // Page-liveness probe (readyState/visibilityState/focus/online) —
        // same honest-omission rule as scroll: unreachable content script
        // (crashed tab, chrome:// page, no injection) → field absent.
        let pageState: Record<string, unknown> | undefined;
        try {
          const ps = (await deps.sendToTab(tabId, { type: "page.state" })) as Record<string, unknown>;
          if (ps && typeof ps.readyState === "string") pageState = ps;
        } catch {
          pageState = undefined;
        }
        // Crash probe: a dead renderer makes the content script
        // unreachable, but so does a live page without injection —
        // ambiguous omission. A CDP Runtime.evaluate ping disambiguates:
        // session acquired + eval fails → renderer crashed; eval
        // succeeds → page alive, content script simply absent; acquire
        // fails → unknown (no debugger tier), report nothing.
        let crashed: true | undefined;
        if (!pageState && deps.acquireCdp) {
          try {
            const { session, release } = await cdpAcquire(deps, tabId);
            try {
              await session.send("Runtime.evaluate", { expression: "1", returnByValue: true });
            } catch {
              crashed = true;
            } finally {
              await release();
            }
          } catch {
            // acquireCdp failed — debugger unavailable or target gone;
            // not proof of a crash, omit the field.
          }
        }
        // Same privacy rule as tabs.list/frames — query/hash can carry
        // tokens; strip to origin+pathname.
        let safeTabUrl = "";
        try {
          const u = new URL(tab.url ?? "");
          safeTabUrl = `${u.origin}${u.pathname}`;
        } catch {
          safeTabUrl = "";
        }
        // args.key parity with playwright-isolated: text|title|url read
        // the top-frame page value via the content script. Absent content
        // script → value omitted, not faked (same rule as scroll).
        const key = str(args.key);
        if (key !== undefined && key !== "text" && key !== "title" && key !== "url") {
          throw toolError("proto.invalid", "browser.page.get args.key must be text|title|url");
        }
        let value: string | undefined;
        if (key !== undefined) {
          try {
            const res = (await deps.sendToTab(tabId, {
              type: "page.extract",
              maxChars: key === "text" ? 50_000 : 1,
            })) as { text?: string; url?: string; title?: string };
            const raw = key === "text" ? res.text : key === "title" ? res.title : res.url;
            value = typeof raw === "string" ? (key === "url" ? urlOriginPath(raw) : raw) : "";
          } catch {
            value = undefined;
          }
        }
        return {
          id: tab.id,
          tabId: tab.id,
          url: safeTabUrl,
          title: tab.title ?? "",
          active: tab.active === true,
          resolvedTabId: tabId,
          ...(value !== undefined ? { value } : {}),
          ...(typeof tab.windowId === "number" ? { windowId: tab.windowId } : {}),
          ...(typeof tab.status === "string" ? { status: tab.status } : {}),
          ...(typeof tab.pinned === "boolean" ? { pinned: tab.pinned } : {}),
          ...(typeof tab.discarded === "boolean" ? { discarded: tab.discarded } : {}),
          ...(typeof tab.autoDiscardable === "boolean" ? { autoDiscardable: tab.autoDiscardable } : {}),
          ...(typeof tab.mutedInfo?.muted === "boolean" ? { muted: tab.mutedInfo.muted } : {}),
          ...(pageState ? { page: pageState } : {}),
          ...(crashed === true ? { crashed: true } : {}),
          ...(typeof tab.groupId === "number" ? { groupId: tab.groupId } : {}),
          ...(scroll ? { scroll } : {}),
          ...(frames ? { frames } : {}),
        };
      }
      case "browser.page.snapshot": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const frameId = frameIdArg(args);
        const mode = str(args.mode);
        if (mode !== undefined && mode !== "dom" && mode !== "aria") {
          throw toolError("proto.invalid", "browser.page.snapshot args.mode must be dom|aria");
        }
        if (mode === "aria") {
          // CDP Accessibility.getFullAXTree — the tab target's tree
          // covers the MAIN frame only: Iframe nodes exist but their
          // childIds stay empty (verified on CfT 158 — Accessibility.
          // enable does not change this, and Page-style per-frame AX
          // is unavailable for same-process subframes). OOPIF iframe
          // targets DO serve their own full AX tree, so merge each
          // live OOPIF's tree under an Iframe marker. Same-process
          // subframe content stays reachable via mode:"dom" frameId.
          if (frameId !== 0) {
            throw toolError("proto.invalid", "args.frameId is meaningless for snapshot mode aria");
          }
          const { session, release } = await cdpAcquire(deps, tabId);
          try {
            const res = (await session.send("Accessibility.getFullAXTree")) as { nodes?: AxNode[] };
            const formatted = formatAxTree(Array.isArray(res?.nodes) ? res.nodes : []);
            let tree = formatted.tree;
            let nodeCount = formatted.nodeCount;
            let truncated = formatted.truncated;
            let oopifFrames = 0;
            if (deps.acquireCdpTarget && deps.releaseCdpTarget) {
              const matches = await matchOopifFrameTargets(deps, tabId).catch(() => null);
              for (const { frame, target } of (matches ?? []).slice(0, AX_OOPIF_MAX)) {
                try {
                  const fs = await deps.acquireCdpTarget(target.id);
                  try {
                    const fres = (await fs.send("Accessibility.getFullAXTree")) as { nodes?: AxNode[] };
                    const ff = formatAxTree(Array.isArray(fres?.nodes) ? fres.nodes : []);
                    const label = String(frame.url ?? target.id).replace(/"/g, '\\"');
                    const body = ff.tree.split("\n").map((l) => `  ${l}`).join("\n");
                    tree += `\n- Iframe "${label}"${body ? `\n${body}` : ""}`;
                    nodeCount += ff.nodeCount;
                    truncated = truncated || ff.truncated;
                    oopifFrames += 1;
                  } finally {
                    await deps.releaseCdpTarget(target.id).catch(() => {});
                  }
                } catch {
                  // frame target raced away or rejected the domain — skip
                }
              }
            }
            return {
              mode: "aria",
              tree,
              nodeCount,
              truncated,
              oopifFrames,
              resolvedTabId: tabId,
            };
          } finally {
            await release();
          }
        }
        const snap = (await deps.sendToTab(tabId, { type: "page.dom.snapshot" }, { frameId })) as BrowserDomSnapshot;
        if (
          snap.snapshotId &&
          snap.structuralFingerprint &&
          snap.stateFingerprint &&
          typeof snap.saltEpoch === "number"
        ) {
          // §6.2: a structural change on this frame stales every older
          // snapshot's refs — drop them before registering the new one.
          const prior = snapshotRegistry.latestForFrame(tabId, frameId);
          if (prior && prior.structuralFingerprint !== snap.structuralFingerprint) {
            snapshotRegistry.invalidateFrame(tabId, frameId);
          }
          snapshotRegistry.put({
            snapshotId: snap.snapshotId,
            tabId,
            frameId,
            ...(req.taskId ? { taskId: req.taskId } : {}),
            structuralFingerprint: snap.structuralFingerprint,
            stateFingerprint: snap.stateFingerprint,
            saltEpoch: snap.saltEpoch,
            ...(typeof snap.metadata?.url === "string"
              ? { urlOriginPath: urlOriginPath(snap.metadata.url) }
              : {}),
            capturedAt: Date.now(),
          });
        }
        // metadata.url arrives as full location.href — strip query/hash
        // before it reaches the provider (same rule as tabs.list).
        const safeSnap =
          snap.metadata && typeof snap.metadata.url === "string"
            ? { ...snap, metadata: { ...snap.metadata, url: urlOriginPath(snap.metadata.url) } }
            : snap;
        return { ...safeSnap, resolvedTabId: tabId };
      }
      case "browser.page.wait": {
        // Conditional wait (text/textGone/selector/urlContains) polls in
        // the content script; bare `ms` stays a bounded host-side sleep.
        // responseUrl is a host-side condition over the persistent
        // webRequest log — approval latency can exceed a fast local
        // response, so matching looks BACK within the wait window
        // (documented; the matched entry's ts/status is returned as
        // evidence so staleness is visible to the agent).
        const networkIdle = args.networkIdle === true;
        const responseUrl = str(args.responseUrl);
        if (responseUrl !== undefined && (responseUrl.length === 0 || responseUrl.length > 512)) {
          throw toolError("proto.invalid", "browser.page.wait args.responseUrl must be a non-empty string ≤512 chars");
        }
        // args.frameId narrows the webRequest match to one frame's
        // requests (frameId is tagged per-entry by the network log) —
        // e.g. wait for a response fired inside a cross-origin iframe.
        const responseFrameId =
          responseUrl !== undefined && typeof args.frameId === "number" && args.frameId >= 0
            ? args.frameId
            : undefined;
        if (responseUrl !== undefined && typeof deps.listNetworkRequests !== "function") {
          throw toolError("proto.unsupported", "response wait requires the webRequest permission");
        }
        // consoleText waits on the in-page MAIN-world console buffer
        // (same source as browser.page.console). Coverage begins when
        // the capture hook installs — first collect call, or earlier
        // if the agent already called page.console — so lookback can
        // only match entries recorded while the hook was live. Entries
        // carry page-side ts; freshness stays visible like responseUrl.
        const consoleText = str(args.consoleText);
        if (consoleText !== undefined && (consoleText.length === 0 || consoleText.length > 512)) {
          throw toolError("proto.invalid", "browser.page.wait args.consoleText must be a non-empty string ≤512 chars");
        }
        const consoleLevel = str(args.consoleLevel);
        if (consoleLevel !== undefined) {
          if (consoleText === undefined) {
            throw toolError("proto.invalid", "args.consoleLevel requires args.consoleText");
          }
          if (!["log", "info", "warn", "error", "debug"].includes(consoleLevel)) {
            throw toolError("proto.invalid", "args.consoleLevel must be log|info|warn|error|debug");
          }
        }
        if (consoleText !== undefined && typeof deps.runInMainWorld !== "function") {
          throw toolError("proto.unsupported", "console wait requires the scripting permission");
        }
        // pierceRef+pierceText waits on a closed-shadow-root element's
        // live state (value/textContent) via Runtime.callFunctionOn —
        // the async barrier for embedded widgets (payment status,
        // captcha clearing) that content-script waits cannot see.
        // pierceText WITHOUT pierceRef is the discovery barrier: poll
        // browser.page.pierce until a matching closed-root element
        // appears (async widgets that render late), returning its
        // fresh ref. State condition, not lookback: polls forward only.
        const pierceRef = str(args.pierceRef);
        const pierceText = str(args.pierceText);
        if (pierceText !== undefined && (pierceText.length === 0 || pierceText.length > 512)) {
          throw toolError("proto.invalid", "browser.page.wait args.pierceText must be a non-empty string ≤512 chars");
        }
        if (pierceRef !== undefined && pierceText === undefined) {
          throw toolError("proto.invalid", "args.pierceRef requires args.pierceText");
        }
        if (pierceRef !== undefined) {
          if (!PIERCE_REF_RE.test(pierceRef)) {
            throw toolError("proto.invalid", "args.pierceRef must be a pz-N ref from browser.page.pierce");
          }
          if (args.frameId !== undefined && args.frameId !== null) {
            throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId");
          }
          cdpRequired(deps);
        } else if (pierceText !== undefined) {
          cdpRequired(deps);
        }
        const hasPierceCondition = pierceRef !== undefined || pierceText !== undefined;
        const hasConsoleCondition = consoleText !== undefined;
        const hasResponseCondition = responseUrl !== undefined;
        const hasContentCondition =
          str(args.text) !== undefined ||
          str(args.textGone) !== undefined ||
          str(args.selector) !== undefined ||
          str(args.selectorGone) !== undefined ||
          str(args.urlContains) !== undefined ||
          str(args.readyState) !== undefined ||
          str(args.visibleSelector) !== undefined;
        // fileChooser arms CDP file-chooser interception for the wait
        // window — the async barrier for button-triggered native file
        // dialogs (input.click() flows the agent cannot target directly).
        // Sole condition only: the armed chooser must be consumed by a
        // setInputFiles call carrying the returned fileChooserId, and
        // combining it with polled conditions would orphan the pending
        // chooser if a later condition times out.
        const fileChooserWait = args.fileChooser === true;
        if (args.fileChooser !== undefined && args.fileChooser !== true) {
          throw toolError("proto.invalid", "browser.page.wait args.fileChooser must be true when present");
        }
        const hasCondition =
          hasContentCondition || hasResponseCondition || hasConsoleCondition ||
          hasPierceCondition || fileChooserWait;
        if (fileChooserWait) {
          cdpRequired(deps);
          if (args.frameId !== undefined && args.frameId !== null) {
            throw toolError("proto.invalid", "args.frameId is meaningless for a fileChooser wait");
          }
          if (hasContentCondition || hasResponseCondition || hasConsoleCondition ||
              hasPierceCondition || networkIdle) {
            throw toolError(
              "proto.invalid",
              "fileChooser cannot combine with other wait conditions — run it as its own browser.page.wait",
            );
          }
        }
        if (str(args.readyState) !== undefined &&
            !["loading", "interactive", "complete"].includes(str(args.readyState)!)) {
          throw toolError("proto.invalid", "browser.page.wait args.readyState must be loading|interactive|complete");
        }
        if (str(args.selector) !== undefined && str(args.selector) === str(args.selectorGone)) {
          throw toolError("proto.invalid", "browser.page.wait args.selector and args.selectorGone must differ");
        }
        if (networkIdle && typeof deps.networkInflightCount !== "function") {
          throw toolError("proto.unsupported", "network-idle wait is unavailable on this host");
        }
        if (networkIdle && !hasCondition && args.frameId !== undefined && args.frameId !== null) {
          // networkIdle is tab-wide — a frameId here would be silently
          // ignored, so reject it like other meaningless scope args.
          throw toolError("proto.invalid", "args.frameId is meaningless for a networkIdle-only wait");
        }
        if (!hasCondition && !networkIdle) {
          const ms = Math.min(Math.max(typeof args.ms === "number" ? args.ms : 1000, 0), 30_000);
          await new Promise((r) => setTimeout(r, ms));
          return { ok: true, waitedMs: ms };
        }
        const waitTimeoutMs = Math.min(
          Math.max(typeof args.timeoutMs === "number" ? args.timeoutMs : 10_000, 0),
          30_000,
        );
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        if (hasResponseCondition) {
          // Newest matching finished entry within [callStart-lookback,
          // now]. lookback = the wait window itself: a response that
          // completed during approval/tool latency still counts, and
          // its ts is returned so the agent can judge freshness.
          const since = Date.now() - waitTimeoutMs;
          const deadline = Date.now() + waitTimeoutMs;
          let matchedEntry: Record<string, unknown> | undefined;
          while (Date.now() < deadline) {
            const entries = deps.listNetworkRequests!(tabId, {
              limit: 200,
              urlContains: responseUrl,
              ...(responseFrameId !== undefined ? { frameId: responseFrameId } : {}),
            });
            const hit = (Array.isArray(entries) ? entries : []).find(
              (e) => typeof e.ts === "number" && e.ts >= since,
            );
            if (hit) {
              matchedEntry = hit as Record<string, unknown>;
              break;
            }
            await new Promise((r) => setTimeout(r, 150));
          }
          if (!matchedEntry) {
            throw toolError(
              "browser.timeout",
              `no completed response matching "${responseUrl}" within ${waitTimeoutMs}ms`,
            );
          }
          if (!hasContentCondition && !networkIdle && !hasConsoleCondition && !hasPierceCondition) {
            return {
              ok: true,
              matched: "response",
              response: {
                method: matchedEntry.method ?? "",
                url: matchedEntry.url ?? "",
                ...(typeof matchedEntry.status === "number" ? { status: matchedEntry.status } : {}),
                ...(matchedEntry.error ? { error: matchedEntry.error } : {}),
                ...(typeof matchedEntry.frameId === "number" ? { frameId: matchedEntry.frameId } : {}),
                ts: matchedEntry.ts ?? 0,
              },
              resolvedTabId: tabId,
            };
          }
        }
        if (hasConsoleCondition) {
          // Same lookback semantics as responseUrl: entries carry
          // page-side ts, so messages logged during approval/tool
          // latency still match IF the capture hook was already live.
          // The first collect call installs the hook — coverage before
          // that is honestly absent (documented in the tool description).
          const since = Date.now() - waitTimeoutMs;
          const deadline = Date.now() + waitTimeoutMs;
          // Unscoped consoleText polls every frame's buffer (console
          // buffers are per-frame) — an OOPIF widget's console.error is
          // just as matchable as the top frame's. Explicit frameId keeps
          // the single-frame poll.
          const consoleUnscoped = args.frameId === undefined || args.frameId === null;
          const consoleFids = consoleUnscoped
            ? ((await consoleFrameIds(deps, tabId)) ?? [frameIdArg(args)])
            : [frameIdArg(args)];
          const pollConsole = async (): Promise<Array<Record<string, unknown>>> => {
            if (consoleFids.length === 1) {
              const cres = (await deps
                .runInMainWorld!(tabId, chromexConsoleCollect, [200, null], [consoleFids[0]!])
                .catch(() => undefined)) as { entries?: unknown } | undefined;
              return (Array.isArray(cres?.entries) ? cres.entries : [])
                .filter((e): e is Record<string, unknown> => e !== null && typeof e === "object")
                .map((e) => ({ ...e, frameId: consoleFids[0] }));
            }
            return (await collectConsoleEntries(deps, tabId, 200, null, consoleFids)).entries;
          };
          try {
            if (consoleFids.length === 1) {
              await deps.runInMainWorld!(tabId, chromexConsoleCollect, [200, consoleLevel ?? null], [consoleFids[0]!]);
            } else {
              await collectConsoleEntries(deps, tabId, 200, consoleLevel ?? null, consoleFids);
            }
          } catch {
            // install failure surfaces on the poll below as timeout
          }
          let consoleHit: { level?: unknown; text?: unknown; ts?: unknown; frameId?: unknown } | undefined;
          while (Date.now() < deadline) {
            const entries = await pollConsole();
            const hit = entries.find((e) => {
              return (
                typeof e.ts === "number" && e.ts >= since &&
                typeof e.text === "string" && e.text.includes(consoleText!) &&
                (consoleLevel === undefined || e.level === consoleLevel)
              );
            });
            if (hit) {
              consoleHit = hit;
              break;
            }
            await new Promise((r) => setTimeout(r, 150));
          }
          if (!consoleHit) {
            throw toolError(
              "browser.timeout",
              `no console message matching "${consoleText}" within ${waitTimeoutMs}ms`,
            );
          }
          if (!hasContentCondition && !networkIdle && !hasPierceCondition) {
            return {
              ok: true,
              matched: "console",
              console: {
                level: consoleHit.level ?? "",
                text: consoleHit.text ?? "",
                ...(typeof consoleHit.frameId === "number" ? { frameId: consoleHit.frameId } : {}),
                ts: consoleHit.ts ?? 0,
              },
              resolvedTabId: tabId,
            };
          }
        }
        if (networkIdle) {
          const deadline = Date.now() + waitTimeoutMs;
          while (deps.networkInflightCount!(tabId) > 0) {
            if (Date.now() >= deadline) {
              throw toolError(
                "browser.timeout",
                `network idle not reached: ${deps.networkInflightCount!(tabId)} request(s) still in flight`,
              );
            }
            await new Promise((r) => setTimeout(r, 150));
          }
          if (!hasContentCondition && !hasResponseCondition && !hasConsoleCondition && !hasPierceCondition) {
            return { ok: true, matched: "networkIdle", resolvedTabId: tabId };
          }
        }
        if (pierceRef !== undefined) {
          // Live-state poll on the closed-root node — value +
          // textContent haystack, substring match. The node is resolved
          // once; a detached node fails the poll as element_not_found.
          const pierceHitRef = pierceHit(tabId, pierceRef!);
          const { session, release } = await pierceAcquire(deps, pierceHitRef);
          let pierceHitText: string | undefined;
          try {
            const node = (await session.send("DOM.resolveNode", { backendNodeId: pierceHitRef.backendNodeId })) as {
              object?: { objectId?: string };
            };
            const objectId = node?.object?.objectId;
            if (!objectId) {
              throw toolError("browser.element_not_found", "pierce target detached — re-run browser.page.pierce");
            }
            const deadline = Date.now() + waitTimeoutMs;
            while (Date.now() < deadline) {
              const cres = (await session.send("Runtime.callFunctionOn", {
                objectId,
                functionDeclaration:
                  "function(){var v='';try{v=String(this.value||'')}catch(e){}var t='';try{t=String(this.textContent||'')}catch(e){}return v+'\\n'+t}",
                returnByValue: true,
              })) as { result?: { value?: unknown } };
              const hay = String(cres?.result?.value ?? "");
              if (hay.includes(pierceText!)) {
                pierceHitText = hay;
                break;
              }
              await new Promise((r) => setTimeout(r, 200));
            }
          } finally {
            await release();
          }
          if (!pierceHitText) {
            throw toolError(
              "browser.timeout",
              `no pierce element state matching "${pierceText}" within ${waitTimeoutMs}ms`,
            );
          }
          if (!hasContentCondition && !networkIdle && !hasResponseCondition && !hasConsoleCondition) {
            return {
              ok: true,
              matched: "pierce",
              pierce: { ref: pierceRef, excerpt: pierceHitText.slice(0, 500) },
              resolvedTabId: tabId,
            };
          }
        } else if (pierceText !== undefined) {
          // Discovery barrier: poll browser.page.pierce until a
          // closed-root element matching pierceText appears — covers
          // async widgets that render after the wait starts (no ref
          // could have been minted yet). Each poll re-mints the
          // scope's refs; the matched element's fresh ref comes back
          // so the caller can act on it immediately. args.frameId
          // scopes discovery to that frame (OOPIF support).
          const discFrameId = frameIdArg(args);
          const deadline = Date.now() + waitTimeoutMs;
          let found: Record<string, unknown> | undefined;
          while (Date.now() < deadline) {
            const pz = await pagePierce(deps, tabId, {
              text: pierceText,
              limit: 5,
              ...(discFrameId !== 0 ? { frameId: discFrameId } : {}),
            });
            const els = (pz.elements as Array<Record<string, unknown>> | undefined) ?? [];
            if (els.length > 0) {
              found = els[0];
              break;
            }
            await new Promise((r) => setTimeout(r, 400));
          }
          if (!found) {
            throw toolError(
              "browser.timeout",
              `no pierce element matching "${pierceText}" within ${waitTimeoutMs}ms`,
            );
          }
          if (!hasContentCondition && !networkIdle && !hasResponseCondition && !hasConsoleCondition) {
            return {
              ok: true,
              matched: "pierce",
              pierce: {
                ref: found.ref,
                discovered: true,
                ...(found.name !== undefined ? { name: found.name } : {}),
                ...(found.role !== undefined ? { role: found.role } : {}),
              },
              resolvedTabId: tabId,
            };
          }
        }
        if (fileChooserWait) {
          // Arm interception BEFORE polling — the chooser must be
          // opened by a concurrent tool call (click/type) while this
          // wait holds the window open. On match the CDP session stays
          // held inside pendingFileChoosers: backendNodeId is
          // session-scoped, so setInputFiles must send
          // DOM.setFileInputFiles on the same session that observed the
          // event. Interception is disabled as soon as the wait settles
          // so later choosers (user-initiated or unarmed agent flows)
          // behave normally; the already-intercepted chooser remains
          // consumable until setInputFiles or page teardown.
          const { session, release } = await cdpAcquire(deps, tabId);
          let seen:
            | { backendNodeId: number | undefined; mode: string | undefined; frameId: string | undefined }
            | undefined;
          const unsub = session.on("Page.fileChooserOpened", (p) => {
            seen = {
              backendNodeId: typeof p.backendNodeId === "number" ? p.backendNodeId : undefined,
              mode: typeof p.mode === "string" ? p.mode : undefined,
              frameId: typeof p.frameId === "string" ? p.frameId : undefined,
            };
          });
          try {
            await Promise.race([
              session.send("Page.enable").catch(() => {}),
              new Promise((r) => setTimeout(r, 3_000)),
            ]);
            await session.send("Page.setInterceptFileChooserDialog", { enabled: true });
            const deadline = Date.now() + waitTimeoutMs;
            while (seen === undefined && Date.now() < deadline) {
              await new Promise((r) => setTimeout(r, 50));
            }
          } finally {
            unsub();
            await session.send("Page.setInterceptFileChooserDialog", { enabled: false }).catch(() => {});
          }
          if (seen?.backendNodeId === undefined) {
            await release();
            throw toolError(
              "browser.timeout",
              `no file chooser opened within ${waitTimeoutMs}ms`,
            );
          }
          const fileChooserId = `fc-${Date.now().toString(36)}-${++fileChooserSeq}`;
          pendingFileChoosers.set(fileChooserId, {
            taskId: req.taskId ?? "",
            tabId,
            backendNodeId: seen.backendNodeId,
            ...(seen.mode !== undefined ? { mode: seen.mode } : {}),
            ...(seen.frameId !== undefined ? { frameId: seen.frameId } : {}),
            session,
            release,
          });
          return {
            ok: true,
            matched: "fileChooser",
            fileChooserId,
            ...(seen.mode !== undefined ? { mode: seen.mode } : {}),
            ...(seen.frameId !== undefined ? { frameId: seen.frameId } : {}),
            resolvedTabId: tabId,
          };
        }
        if (!hasContentCondition) {
          // Only host-side conditions were requested (response/console/
          // networkIdle combos) — all matched above; a content-script
          // wait with zero conditions would be meaningless.
          return { ok: true, matched: "conditions", resolvedTabId: tabId };
        }
        // Unscoped content waits cover EVERY frame — text/selector
        // conditions inside same-process and cross-origin subframes
        // are just as much "the page" as top-frame DOM. Explicit
        // args.frameId keeps the single-frame wait.
        if (args.frameId === undefined || args.frameId === null) {
          const fids = await consoleFrameIds(deps, tabId);
          if (fids !== undefined && fids.length > 1) {
            return await waitContentAllFrames(deps, tabId, args, waitTimeoutMs, fids);
          }
        }
        const frameId = frameIdArg(args);
        const res = (await deps.sendToTab(tabId, {
          type: "page.dom.wait",
          ...(str(args.text) ? { text: str(args.text) } : {}),
          ...(str(args.textGone) ? { textGone: str(args.textGone) } : {}),
          ...(str(args.selector) ? { selector: str(args.selector) } : {}),
          ...(str(args.selectorGone) ? { selectorGone: str(args.selectorGone) } : {}),
          ...(str(args.urlContains) ? { urlContains: str(args.urlContains) } : {}),
          ...(str(args.readyState) ? { readyState: str(args.readyState) } : {}),
          ...(str(args.visibleSelector) ? { visibleSelector: str(args.visibleSelector) } : {}),
          timeoutMs: waitTimeoutMs,
        }, { frameId })) as { ok?: boolean; timedOut?: boolean; elapsedMs?: number; error?: string };
        if (res?.ok !== true) {
          throw toolError(
            res?.timedOut === true ? "browser.timeout" : "browser.action_failed",
            res?.error ?? "wait condition was not met before timeout",
          );
        }
        return { ok: true, matched: "conditions", elapsedMs: res.elapsedMs ?? 0, resolvedTabId: tabId };
      }
      case "browser.page.find": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const text = str(args.text);
        const regex = str(args.regex);
        if (!text && !regex) {
          throw toolError("proto.invalid", "browser.page.find requires args.text or args.regex");
        }
        if (regex) {
          try {
            new RegExp(regex, args.caseSensitive === true ? "" : "i");
          } catch {
            throw toolError("proto.invalid", "browser.page.find args.regex is not a valid pattern");
          }
        }
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.min(Math.max(Math.floor(args.limit), 1), 200)
            : 50;
        const findMsg = {
          type: "page.dom.find",
          ...(text ? { text } : {}),
          ...(regex ? { regex } : {}),
          ...(args.caseSensitive === true ? { caseSensitive: true } : {}),
          limit,
          ...(str(args.scopeSelector) ? { scopeSelector: str(args.scopeSelector) } : {}),
        };
        // Unscoped find searches EVERY frame — DOM matches inside
        // same-process and cross-origin subframes are just as much
        // "the page" as top-frame text (each match tagged with its
        // frameId so refs/selectors stay frame-scoped). Explicit
        // frameId keeps the single-frame search.
        if (args.frameId === undefined || args.frameId === null) {
          const fids = await consoleFrameIds(deps, tabId);
          if (fids !== undefined && fids.length > 1) {
            const merged: Array<Record<string, unknown>> = [];
            let scanned = 0;
            let truncated = false;
            for (const fid of fids.slice(0, CONSOLE_MERGE_FRAME_CAP)) {
              const fres = (await deps.sendToTab(tabId, findMsg, { frameId: fid }).catch(() => undefined)) as
                | { ok?: boolean; matches?: unknown[]; scanned?: number; truncated?: boolean }
                | undefined;
              if (fres?.ok !== true) continue;
              scanned += fres.scanned ?? 0;
              truncated = truncated || fres.truncated === true;
              for (const m of Array.isArray(fres.matches) ? fres.matches : []) {
                if (m !== null && typeof m === "object") {
                  merged.push({ ...(m as Record<string, unknown>), frameId: fid });
                }
              }
            }
            return {
              ok: true,
              matches: merged.slice(0, limit),
              scanned,
              truncated,
              frames: fids.length,
              resolvedTabId: tabId,
            };
          }
        }
        const res = (await deps.sendToTab(tabId, findMsg, { frameId: frameIdArg(args) })) as { ok?: boolean; matches?: unknown[]; scanned?: number; truncated?: boolean };
        if (res?.ok !== true) {
          throw toolError("proto.invalid", "browser.page.find requires args.text or args.regex");
        }
        return {
          ok: true,
          matches: Array.isArray(res.matches) ? res.matches : [],
          scanned: res.scanned ?? 0,
          truncated: res.truncated === true,
          resolvedTabId: tabId,
        };
      }
      case "browser.page.pierce": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        return await pagePierce(deps, tabId, args);
      }
      case "browser.page.dialog": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        return await handlePageDialog(deps, tabId, args);
      }
      case "browser.page.setInputFiles": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        return await setInputFiles(deps, tabId, args, frameIdArg(args), req.taskId);
      }
      case "browser.page.responseBody": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        return await pageResponseBody(deps, tabId, args);
      }
      case "browser.page.webSocket": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        return await pageWebSocket(deps, tabId, args);
      }
      case "browser.page.route": {
        cdpRequired(deps);
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        // args.frameId is a RULE scope (which frame's requests the rule
        // intercepts), not a dispatch target — addPageRoute validates it.
        return await addPageRoute(deps, tabId, args);
      }
      case "browser.page.unroute": {
        cdpRequired(deps);
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        return await removePageRoutes(deps, tabId, args);
      }
      case "browser.page.history": {
        const action = str(args.action);
        if (action !== "back" && action !== "forward" && action !== "reload") {
          throw toolError("proto.invalid", "browser.page.history requires args.action back|forward|reload");
        }
        // bypassCache only has meaning on reload — refuse on back/forward
        // rather than silently ignoring it.
        const bypassCache = args.bypassCache === true;
        if (args.bypassCache !== undefined && typeof args.bypassCache !== "boolean") {
          throw toolError("proto.invalid", "browser.page.history args.bypassCache must be a boolean");
        }
        if (bypassCache && action !== "reload") {
          throw toolError("proto.invalid", "browser.page.history args.bypassCache only applies to action reload");
        }
        if (!deps.navigateHistory) {
          throw toolError("proto.unsupported", "history navigation is not available on this host");
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        await deps.navigateHistory(tabId, action, bypassCache ? { bypassCache: true } : undefined);
        return { navigated: action, ...(bypassCache ? { bypassCache: true } : {}), resolvedTabId: tabId };
      }
      case "browser.page.cookies": {
        cdpRequired(deps);
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        if (frameIdArg(args) !== 0) {
          throw toolError("proto.invalid", "browser.page.cookies is tab-scoped; args.frameId is not supported");
        }
        return await pageCookies(deps, tabId, args);
      }
      case "browser.page.localStorage": {
        // Fixed-shape storage access in the page MAIN world — the agent
        // supplies keys/values, never code. Risk gating lives in the
        // classifier (values + mutations always approval).
        if (!deps.runInMainWorld) {
          throw toolError("proto.unsupported", "web storage access requires the scripting permission");
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);

        const action = str(args.action) ?? "list";
        if (!["list", "get", "set", "remove", "clear"].includes(action)) {
          throw toolError("proto.invalid", "browser.page.localStorage args.action must be list|get|set|remove|clear");
        }
        const area = str(args.area) === "session" ? "session" : "local";
        const key = str(args.key);
        if ((action === "get" || action === "set" || action === "remove") && !key) {
          throw toolError("proto.invalid", `browser.page.localStorage ${action} requires args.key`);
        }
        if (action === "set" && typeof args.value !== "string") {
          throw toolError("proto.invalid", "browser.page.localStorage set requires args.value");
        }
        const res = (await deps.runInMainWorld!(
          tabId,
          chromexStorageOp as (...fnArgs: unknown[]) => unknown,
          [area, action, key ?? "", typeof args.value === "string" ? args.value : "", args.includeValues === true],
          [frameIdArg(args)],
        )) as { ok?: boolean; result?: unknown; error?: string } | undefined;
        if (!res || res.ok !== true) {
          throw toolError("browser.action_failed", `storage op failed: ${res?.error ?? "no result"}`);
        }
        return { ...(res.result as Record<string, unknown>), resolvedTabId: tabId };
      }
      case "browser.page.indexedDB": {
        // Same fixed-shape pattern as localStorage — agent supplies
        // names/keys/values, never code. Read ops never create a
        // missing database (verified inside chromexIdbOp).
        if (!deps.runInMainWorld) {
          throw toolError("proto.unsupported", "indexedDB access requires the scripting permission");
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);

        const action = str(args.action) ?? "listDbs";
        const VALID = ["listDbs", "listStores", "keys", "get", "put", "delete", "clear", "createStore"];
        if (!VALID.includes(action)) {
          throw toolError("proto.invalid", `browser.page.indexedDB args.action must be ${VALID.join("|")}`);
        }
        const database = str(args.database);
        const store = str(args.store);
        if (action !== "listDbs" && !database) {
          throw toolError("proto.invalid", `browser.page.indexedDB ${action} requires args.database`);
        }
        if (!["listDbs", "listStores"].includes(action) && !store) {
          throw toolError("proto.invalid", `browser.page.indexedDB ${action} requires args.store`);
        }
        if ((action === "get" || action === "delete") && args.key === undefined) {
          throw toolError("proto.invalid", `browser.page.indexedDB ${action} requires args.key`);
        }
        if (action === "put" && args.value === undefined) {
          throw toolError("proto.invalid", "browser.page.indexedDB put requires args.value");
        }
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.min(Math.max(Math.floor(args.limit), 1), 1000)
            : 100;
        const res = (await deps.runInMainWorld!(
          tabId,
          chromexIdbOp as (...fnArgs: unknown[]) => unknown,
          [
            database ?? "",
            store ?? "",
            action,
            args.key ?? null,
            args.value ?? null,
            str(args.keyPath) ?? "",
            limit,
          ],
          [frameIdArg(args)],
        )) as { ok?: boolean; result?: unknown; error?: string } | undefined;
        if (!res || res.ok !== true) {
          throw toolError("browser.action_failed", `indexedDB op failed: ${res?.error ?? "no result"}`);
        }
        return { ...(res.result as Record<string, unknown>), resolvedTabId: tabId };
      }
      case "browser.page.caches": {
        // Fixed-shape Cache API helper — agent supplies names/URLs/put
        // specs, never code. Read ops never create caches.
        if (!deps.runInMainWorld) {
          throw toolError("proto.unsupported", "cache access requires the scripting permission");
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);

        const action = str(args.action) ?? "listCaches";
        const VALID = ["listCaches", "listKeys", "match", "put", "delete", "clear"];
        if (!VALID.includes(action)) {
          throw toolError("proto.invalid", `browser.page.caches args.action must be ${VALID.join("|")}`);
        }
        const cache = str(args.cache);
        const cUrl = str(args.url);
        if (action !== "listCaches" && !cache) {
          throw toolError("proto.invalid", `browser.page.caches ${action} requires args.cache`);
        }
        if (["match", "put", "delete"].includes(action) && !cUrl) {
          throw toolError("proto.invalid", `browser.page.caches ${action} requires args.url`);
        }
        const putSpec =
          action === "put"
            ? {
                ...(typeof args.status === "number" ? { status: args.status } : {}),
                ...(args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)
                  ? { headers: args.headers as Record<string, string> }
                  : {}),
                ...(typeof args.bodyBase64 === "string" ? { bodyBase64: args.bodyBase64 } : {}),
                ...(typeof args.bodyText === "string" ? { bodyText: args.bodyText } : {}),
              }
            : undefined;
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.min(Math.max(Math.floor(args.limit), 1), 1000)
            : 100;
        const res = (await deps.runInMainWorld!(
          tabId,
          chromexCacheOp as (...fnArgs: unknown[]) => unknown,
          // chrome.scripting args must be JSON-serializable — undefined
          // elements are rejected, so absent values go as ""/null.
          [action, cache ?? "", cUrl ?? "", putSpec ?? null, args.ignoreSearch === true, limit],
          [frameIdArg(args)],
        )) as { ok?: boolean; result?: unknown; error?: string } | undefined;
        if (!res || res.ok !== true) {
          throw toolError("browser.action_failed", `cache op failed: ${res?.error ?? "no result"}`);
        }
        return { ...(res.result as Record<string, unknown>), resolvedTabId: tabId };
      }
      case "browser.page.serviceWorker": {
        // Fixed-shape SW registration helper — list reads metadata,
        // unregister removes by exact scope.
        if (!deps.runInMainWorld) {
          throw toolError("proto.unsupported", "serviceWorker access requires the scripting permission");
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const action = str(args.action) ?? "list";
        if (!["list", "unregister", "update"].includes(action)) {
          throw toolError("proto.invalid", "browser.page.serviceWorker args.action must be list|unregister|update");
        }
        const scope = str(args.scope);
        if (action === "unregister" && !scope) {
          throw toolError("proto.invalid", "browser.page.serviceWorker unregister requires args.scope");
        }
        const res = (await deps.runInMainWorld!(
          tabId,
          chromexSwOp as (...fnArgs: unknown[]) => unknown,
          [action, scope ?? ""],
          [frameIdArg(args)],
        )) as { ok?: boolean; result?: unknown; error?: string } | undefined;
        if (!res || res.ok !== true) {
          throw toolError("browser.action_failed", `serviceWorker op failed: ${res?.error ?? "no result"}`);
        }
        const result = res.result as Record<string, unknown>;
        // Annotate each registration with its debugger targetId when the
        // worker is actually attachable — the discovery half of
        // page.cdp {targetId} (service workers are separate CDP targets,
        // not frames). Absent dep or no match → field omitted honestly.
        if (action === "list" && deps.listCdpTargets) {
          try {
            const targets = await deps.listCdpTargets();
            const byUrl = new Map(targets.map((t) => [t.url, t.id]));
            const regs = Array.isArray(result.registrations) ? result.registrations : [];
            for (const r of regs) {
              const scriptURL = (r as { scriptURL?: unknown }).scriptURL;
              if (typeof scriptURL === "string" && scriptURL.length > 0) {
                const tid = byUrl.get(scriptURL);
                if (tid) (r as Record<string, unknown>).targetId = tid;
              }
            }
          } catch {
            // target enumeration failed — list stays usable without ids
          }
        }
        return { ...result, resolvedTabId: tabId };
      }
      case "browser.page.cdp": {
        // Raw CDP passthrough — the deepest protocol surface. One-shot
        // acquire/send/release on the tab target; the risk classifier
        // already forced approval for every call. args.frameId routes
        // to the frame's own debugger target — only out-of-process
        // iframes have one; same-process frames share the tab session.
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const frameId = frameIdArg(args);
        const method = str(args.method);
        if (
          !method ||
          method.length > 128 ||
          !/^[A-Za-z][A-Za-z0-9]{0,63}\.[A-Za-z][A-Za-z0-9]{0,63}$/.test(method)
        ) {
          throw toolError(
            "proto.invalid",
            "browser.page.cdp requires args.method as 'Domain.method' (≤128 chars)",
          );
        }
        let params: Record<string, unknown> | undefined;
        if (args.params !== undefined && args.params !== null) {
          if (typeof args.params !== "object" || Array.isArray(args.params)) {
            throw toolError("proto.invalid", "browser.page.cdp args.params must be a JSON object");
          }
          try {
            if ((JSON.stringify(args.params) ?? "").length > 64 * 1024) {
              throw new Error("params too large");
            }
            params = args.params as Record<string, unknown>;
          } catch {
            throw toolError("proto.invalid", "browser.page.cdp args.params must be JSON-serializable ≤64KiB");
          }
        }
        // args.targetId reaches a NON-frame debugger target owned by
        // this tab — service workers today (they are separate CDP
        // targets, not frames). Ownership is proven by URL: the target
        // must be a webNavigation frame of this tab or a service-worker
        // scriptURL registered by it — page/background_page targets
        // (other tabs, extension pages) are refused outright so a guessed
        // id cannot escape tab scope.
        const cdpTargetId = str(args.targetId);
        let acquired: { session: CdpSession; release: () => Promise<void> };
        let resolvedTargetId: string | undefined;
        if (cdpTargetId !== undefined) {
          if (frameId !== 0) {
            throw toolError("proto.invalid", "browser.page.cdp args.targetId cannot combine with args.frameId");
          }
          if (cdpTargetId.length === 0 || cdpTargetId.length > 128) {
            throw toolError("proto.invalid", "browser.page.cdp args.targetId must be 1-128 chars");
          }
          if (!deps.listCdpTargets || !deps.acquireCdpTarget || !deps.releaseCdpTarget) {
            throw toolError("proto.unsupported", "cdp target access requires the debugger tier");
          }
          const targets = await deps.listCdpTargets();
          const target = targets.find((t) => t.id === cdpTargetId);
          if (!target) {
            throw toolError("browser.not_found", `no debugger target ${cdpTargetId}`);
          }
          if (target.type === "page" || target.type === "background_page") {
            throw toolError(
              "proto.invalid",
              "browser.page.cdp args.targetId must name a frame/worker sub-target, not a page target",
            );
          }
          if (!(await cdpTargetOwnedByTab(deps, tabId, target.url))) {
            throw toolError(
              "browser.not_in_scope",
              `debugger target ${cdpTargetId} does not belong to this tab`,
            );
          }
          acquired = await cdpTargetAcquire(deps, cdpTargetId);
          resolvedTargetId = cdpTargetId;
        } else {
          acquired = frameId === 0
            ? await cdpAcquire(deps, tabId)
            : await cdpAcquireForFrame(deps, tabId, frameId);
        }
        const { session, release } = acquired;
        try {
          const result = await session.send(method, params);
          const serialized = JSON.stringify(result ?? null);
          const bytes = serialized?.length ?? 0;
          if (bytes > CDP_RESULT_MAX_BYTES) {
            return {
              method, ok: true, result: null, omitted: true,
              resultBytes: bytes, resolvedTabId: tabId,
              ...(frameId !== 0 ? { resolvedFrameId: frameId } : {}),
              ...(resolvedTargetId ? { resolvedTargetId } : {}),
            };
          }
          return {
            method, ok: true, result: result ?? null,
            resultBytes: bytes, resolvedTabId: tabId,
            ...(frameId !== 0 ? { resolvedFrameId: frameId } : {}),
            ...(resolvedTargetId ? { resolvedTargetId } : {}),
          };
        } catch (e) {
          // CDP protocol errors are data, not transport failure — an
          // agent probing domains iterates on {ok:false,error} honestly.
          return {
            method, ok: false,
            error: { code: "cdp_error", message: String((e as Error)?.message ?? e).slice(0, 500) },
            resolvedTabId: tabId,
            ...(frameId !== 0 ? { resolvedFrameId: frameId } : {}),
            ...(resolvedTargetId ? { resolvedTargetId } : {}),
          };
        } finally {
          await release().catch(() => {});
        }
      }
      case "browser.page.coverage": {
        // JS coverage via the CDP Profiler domain — a fixed read-only
        // protocol subset (unlike raw page.cdp). start holds a
        // refcounted debugger session so coverage accumulates across
        // later page work; stop takes precise coverage and releases.
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const action = str(args.action);
        if (action !== "start" && action !== "stop" && action !== "status") {
          throw toolError(
            "proto.invalid",
            "browser.page.coverage requires args.action start|stop|status",
          );
        }
        if (action === "status") {
          return { running: coverageHolds.has(tabId), resolvedTabId: tabId };
        }
        if (action === "start") {
          if (coverageHolds.has(tabId)) {
            throw toolError(
              "proto.invalid",
              "coverage is already running for this tab — call action:'stop' first",
            );
          }
          const { session, release } = await cdpAcquire(deps, tabId);
          try {
            await session.send("Profiler.enable");
            await session.send("Profiler.startPreciseCoverage", {
              callCount: true,
              detailed: false,
            });
          } catch (e) {
            await release().catch(() => {});
            // chrome.debugger filters whole CDP domains (Profiler,
            // HeapProfiler, Security, IndexedDB, …) — the -32601
            // "wasn't found" reply means this build does not expose
            // the domain to extension sessions at all.
            if (/-32601|wasn't found/.test(String((e as Error)?.message ?? e))) {
              throw toolError(
                "proto.unsupported",
                "the Profiler CDP domain is not exposed via chrome.debugger on this Chrome build",
              );
            }
            throw e;
          }
          coverageHolds.set(tabId, { session, release });
          return { started: true, resolvedTabId: tabId };
        }
        const held = coverageHolds.get(tabId);
        if (!held) {
          throw toolError(
            "proto.invalid",
            "coverage is not running for this tab — call action:'start' first",
          );
        }
        coverageHolds.delete(tabId);
        try {
          const cov = await held.session.send<{ result?: unknown }>(
            "Profiler.takePreciseCoverage",
          );
          await held.session.send("Profiler.stopPreciseCoverage").catch(() => {});
          await held.session.send("Profiler.disable").catch(() => {});
          return {
            ...summarizeCoverage(cov?.result),
            stopped: true,
            resolvedTabId: tabId,
          };
        } finally {
          await held.release().catch(() => {});
        }
      }
      case "browser.page.metrics": {
        // Performance-domain metrics via the same held-session pattern
        // as coverage: start enables collection, read snapshots the
        // cumulative counters, stop ends + releases. Pure numeric
        // telemetry — no page content.
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const action = str(args.action);
        if (action !== "start" && action !== "read" && action !== "stop" && action !== "status") {
          throw toolError(
            "proto.invalid",
            "browser.page.metrics requires args.action start|read|stop|status",
          );
        }
        if (action === "status") {
          return { running: metricsHolds.has(tabId), resolvedTabId: tabId };
        }
        if (action === "start") {
          if (metricsHolds.has(tabId)) {
            throw toolError(
              "proto.invalid",
              "metrics is already running for this tab — call action:'stop' first",
            );
          }
          const { session, release } = await cdpAcquire(deps, tabId);
          try {
            await session.send("Performance.enable");
          } catch (e) {
            await release().catch(() => {});
            if (/-32601|wasn't found/.test(String((e as Error)?.message ?? e))) {
              throw toolError(
                "proto.unsupported",
                "the Performance CDP domain is not exposed via chrome.debugger on this Chrome build",
              );
            }
            throw e;
          }
          metricsHolds.set(tabId, { session, release });
          return { started: true, resolvedTabId: tabId };
        }
        const held = metricsHolds.get(tabId);
        if (!held) {
          throw toolError(
            "proto.invalid",
            "metrics is not running for this tab — call action:'start' first",
          );
        }
        if (action === "read") {
          const snap = await held.session.send<{ metrics?: unknown }>("Performance.getMetrics");
          return { ...summarizeMetrics(snap), resolvedTabId: tabId };
        }
        metricsHolds.delete(tabId);
        try {
          const snap = await held.session.send<{ metrics?: unknown }>("Performance.getMetrics");
          await held.session.send("Performance.disable").catch(() => {});
          return { ...summarizeMetrics(snap), stopped: true, resolvedTabId: tabId };
        } finally {
          await held.release().catch(() => {});
        }
      }
      case "browser.page.screencast": {
        // CDP Page.startScreencast — motion/timing evidence a single
        // screenshot cannot prove (did the spinner animate, did the
        // toast appear and dismiss). start holds a refcounted session
        // and subscribes screencastFrame; every frame is acked
        // immediately (Chrome pauses delivery without acks) and stored
        // bounded by args.maxFrames. stop ends capture and uploads each
        // frame as an artifact — the coding agent gets files on disk,
        // not an inline base64 flood.
        cdpRequired(deps);
        if (!deps.uploadArtifact) {
          throw toolError("proto.unsupported", "screencast requires the artifact channel");
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        if (frameIdArg(args) !== 0) {
          throw toolError("proto.invalid", "browser.page.screencast is tab-scoped; args.frameId is not supported");
        }
        const action = str(args.action);
        if (action !== "start" && action !== "stop" && action !== "status") {
          throw toolError(
            "proto.invalid",
            "browser.page.screencast requires args.action start|stop|status",
          );
        }
        const held = screencastHolds.get(tabId);
        if (action === "status") {
          return {
            running: held !== undefined,
            frames: held?.frames.length ?? 0,
            resolvedTabId: tabId,
          };
        }
        if (action === "start") {
          if (held) {
            throw toolError(
              "proto.invalid",
              "screencast is already running for this tab — call action:'stop' first",
            );
          }
          const quality = numArg(args.quality, "quality", 1, 100) ?? 70;
          const maxWidth = numArg(args.maxWidth, "maxWidth", 320, 1920) ?? 1280;
          const everyNthFrame = numArg(args.everyNthFrame, "everyNthFrame", 1, 10) ?? 1;
          const maxFrames = numArg(args.maxFrames, "maxFrames", 1, 120) ?? 60;
          const { session, release } = await cdpAcquire(deps, tabId);
          const frames: Array<{ data: string; timestamp: number }> = [];
          const hold = { session, release, frames, unsubs: [] as Array<() => void> };
          try {
            await session.send("Page.enable");
            await session.send("Page.startScreencast", {
              format: "jpeg",
              quality,
              maxWidth,
              maxHeight: maxWidth,
              everyNthFrame,
            });
          } catch (e) {
            await release().catch(() => {});
            if (/-32601|wasn't found/.test(String((e as Error)?.message ?? e))) {
              throw toolError(
                "proto.unsupported",
                "Page.startScreencast is not exposed via chrome.debugger on this Chrome build",
              );
            }
            throw e;
          }
          hold.unsubs.push(session.on("Page.screencastFrame", (p) => {
            const data = typeof p.data === "string" ? p.data : "";
            const sessionId = typeof p.sessionId === "number" ? p.sessionId : 0;
            const ts = typeof (p.metadata as { timestamp?: unknown } | undefined)?.timestamp === "number"
              ? (p.metadata as { timestamp: number }).timestamp
              : 0;
            if (data && frames.length < maxFrames) frames.push({ data, timestamp: ts });
            // Chrome stalls delivery if frames go unacked — ack every
            // frame even past the storage cap.
            void session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
          }));
          screencastHolds.set(tabId, hold);
          return { started: true, maxFrames, resolvedTabId: tabId };
        }
        if (!held) {
          throw toolError(
            "proto.invalid",
            "screencast is not running for this tab — call action:'start' first",
          );
        }
        screencastHolds.delete(tabId);
        try {
          await held.session.send("Page.stopScreencast").catch(() => {});
          for (const u of held.unsubs) u();
          const frames = held.frames;
          const artifactRefs: Array<Record<string, unknown>> = [];
          for (const [i, f] of frames.entries()) {
            const up = await deps.uploadArtifact!({
              taskId: req.taskId ?? "",
              kind: "screencast",
              mimeType: "image/jpeg",
              dataBase64: f.data,
            });
            artifactRefs.push({
              artifactRef: up.artifactRef,
              index: i,
              timestamp: f.timestamp,
              bytes: up.bytes,
            });
          }
          const first = frames[0]?.timestamp;
          const last = frames[frames.length - 1]?.timestamp;
          return {
            stopped: true,
            frames: frames.length,
            artifactRefs,
            firstTimestamp: first ?? null,
            lastTimestamp: last ?? null,
            durationMs: typeof first === "number" && typeof last === "number"
              ? Math.max(0, Math.round((last - first) * 1000))
              : null,
            resolvedTabId: tabId,
          };
        } finally {
          await held.release().catch(() => {});
        }
      }
      case "browser.history.delete": {
        // Not tab-scoped: profile history deletion via chrome.history.
        // Same OPTIONAL "history" permission — ungranted → unsupported.
        if (!deps.deleteHistory) {
          throw toolError("proto.unsupported", "history delete requires the optional history permission");
        }
        const url = str(args.url);
        const parseTime = (v: unknown): number | undefined => {
          if (typeof v === "number" && Number.isFinite(v)) return v;
          if (typeof v === "string") {
            const t = Date.parse(v);
            if (Number.isFinite(t)) return t;
          }
          return undefined;
        };
        const startTime = parseTime(args.startTime);
        const endTime = parseTime(args.endTime);
        const hasRange = startTime !== undefined || endTime !== undefined;
        if (url && hasRange) {
          throw toolError("proto.invalid", "browser.history.delete takes args.url OR args.startTime+args.endTime, not both");
        }
        if (!url && (startTime === undefined || endTime === undefined)) {
          throw toolError("proto.invalid", "browser.history.delete requires args.url or args.startTime+args.endTime");
        }
        const res = await deps.deleteHistory({
          ...(url ? { url } : {}),
          ...(startTime !== undefined ? { startTime } : {}),
          ...(endTime !== undefined ? { endTime } : {}),
        });
        if (res === null) {
          throw toolError("proto.unsupported", "history permission is not granted");
        }
        return res as Record<string, unknown>;
      }
      case "browser.browsingData.clear": {
        // Not tab-scoped: whole-profile browsing data via
        // chrome.browsingData. OPTIONAL "browsingData" permission —
        // ungranted → proto.unsupported, never a fake success.
        if (!deps.browsingDataClear) {
          throw toolError("proto.unsupported", "browsing data clear requires the optional browsingData permission");
        }
        const VALID_TYPES = new Set([
          "appcache", "cache", "cacheStorage", "cookies", "downloads",
          "fileSystems", "formData", "history", "indexedDB", "localStorage",
          "passwords", "serviceWorkers", "webSQL",
        ]);
        const rawTypes = args.dataTypes;
        if (!Array.isArray(rawTypes) || rawTypes.length === 0 || rawTypes.length > 16) {
          throw toolError("proto.invalid", "browser.browsingData.clear requires args.dataTypes (non-empty array ≤16)");
        }
        const dataTypes = [...new Set(rawTypes.map((t) => (typeof t === "string" ? t : "")))];
        if (dataTypes.some((t) => !VALID_TYPES.has(t))) {
          throw toolError("proto.invalid", `browser.browsingData.clear args.dataTypes must be one of ${[...VALID_TYPES].join("|")}`);
        }
        const parseTime = (v: unknown): number | undefined => {
          if (typeof v === "number" && Number.isFinite(v)) return v;
          if (typeof v === "string") {
            const t = Date.parse(v);
            if (Number.isFinite(t)) return t;
          }
          return undefined;
        };
        const sinceMs = parseTime(args.since);
        if (args.since !== undefined && sinceMs === undefined) {
          throw toolError("proto.invalid", "browser.browsingData.clear args.since must be epoch ms or ISO date string");
        }
        let origins: string[] | undefined;
        if (args.origins !== undefined) {
          if (!Array.isArray(args.origins) || args.origins.length > 50 ||
              args.origins.some((o) => typeof o !== "string" || o.length === 0 || o.length > 500)) {
            throw toolError("proto.invalid", "browser.browsingData.clear args.origins must be an array of origin strings (≤50)");
          }
          origins = args.origins as string[];
        }
        const res = await deps.browsingDataClear({
          dataTypes,
          ...(sinceMs !== undefined && sinceMs > 0 ? { sinceMs } : {}),
          ...(origins ? { origins } : {}),
        });
        if (res === null) {
          throw toolError("proto.unsupported", "browsingData permission is not granted");
        }
        return res as Record<string, unknown>;
      }
      case "browser.history.search": {
        // Not tab-scoped: profile browsing history via chrome.history.
        // The permission is OPTIONAL — ungranted → proto.unsupported.
        if (!deps.searchHistory) {
          throw toolError("proto.unsupported", "history search requires the optional history permission");
        }
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.min(Math.max(Math.floor(args.limit), 1), 200)
            : 50;
        const parseTime = (v: unknown): number | undefined => {
          if (typeof v === "number" && Number.isFinite(v)) return v;
          if (typeof v === "string") {
            const t = Date.parse(v);
            if (Number.isFinite(t)) return t;
          }
          return undefined;
        };
        const qText = str(args.text);
        const qUrl = str(args.url);
        const qStart = parseTime(args.startTime);
        const qEnd = parseTime(args.endTime);
        const items = await deps.searchHistory({
          ...(qText ? { text: qText } : {}),
          ...(qUrl ? { url: qUrl } : {}),
          ...(qStart !== undefined ? { startTime: qStart } : {}),
          ...(qEnd !== undefined ? { endTime: qEnd } : {}),
          limit,
        });
        if (items === null) {
          throw toolError("proto.unsupported", "history permission is not granted");
        }
        return {
          visits: items.map((h) => ({
            url: h.url,
            ...(h.title ? { title: h.title } : {}),
            ...(typeof h.visitCount === "number" ? { visitCount: h.visitCount } : {}),
            // chrome.history reports times in microseconds since epoch —
            // normalize to epoch ms and keep the ISO form unambiguous.
            ...(typeof h.lastVisitTime === "number"
              ? {
                  lastVisitTime: h.lastVisitTime > 1e14 ? Math.floor(h.lastVisitTime / 1000) : h.lastVisitTime,
                  lastVisitTimeIso: new Date(
                    h.lastVisitTime > 1e14 ? h.lastVisitTime / 1000 : h.lastVisitTime,
                  ).toISOString(),
                }
              : {}),
          })),
          count: items.length,
        };
      }
      case "browser.bookmarks": {
        // Not tab-scoped: the profile's bookmark tree via chrome.bookmarks.
        // OPTIONAL permission — ungranted → proto.unsupported.
        if (!deps.bookmarkOp) {
          throw toolError("proto.unsupported", "bookmarks requires the optional bookmarks permission");
        }
        const bmAction = str(args.action) ?? "list";
        const BM_VALID = ["list", "search", "get", "create", "update", "remove"];
        if (!BM_VALID.includes(bmAction)) {
          throw toolError("proto.invalid", `browser.bookmarks args.action must be ${BM_VALID.join("|")}`);
        }
        const bmId = str(args.id);
        const bmParent = str(args.parentId);
        const bmQuery = str(args.query);
        const bmTitle = str(args.title);
        const bmUrl = str(args.url);
        if (["get", "update", "remove"].includes(bmAction) && !bmId) {
          throw toolError("proto.invalid", `browser.bookmarks ${bmAction} requires args.id`);
        }
        if (bmAction === "search" && !bmQuery) {
          throw toolError("proto.invalid", "browser.bookmarks search requires args.query");
        }
        if (bmAction === "create" && bmTitle === undefined && bmUrl === undefined) {
          throw toolError("proto.invalid", "browser.bookmarks create requires args.title and/or args.url");
        }
        if (bmAction === "update" && bmTitle === undefined && bmUrl === undefined) {
          throw toolError("proto.invalid", "browser.bookmarks update requires args.title and/or args.url");
        }
        const bmLimit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.min(Math.max(Math.floor(args.limit), 1), 1000)
            : 100;
        const res = await deps.bookmarkOp({
          action: bmAction as "list" | "search" | "get" | "create" | "update" | "remove",
          ...(bmId ? { id: bmId } : {}),
          ...(bmParent ? { parentId: bmParent } : {}),
          ...(bmQuery ? { query: bmQuery } : {}),
          ...(bmTitle !== undefined ? { title: bmTitle } : {}),
          ...(bmUrl !== undefined ? { url: bmUrl } : {}),
          limit: bmLimit,
        });
        if (res === null) {
          throw toolError("proto.unsupported", "bookmarks permission is not granted");
        }
        return res as Record<string, unknown>;
      }
      case "browser.downloads.list": {
        // Not tab-scoped: lists the profile's downloads via chrome.downloads.
        if (!deps.listDownloads) {
          throw toolError("proto.unsupported", "download listing requires the downloads permission");
        }
        const state = str(args.state);
        if (state && !["in_progress", "interrupted", "complete"].includes(state)) {
          throw toolError("proto.invalid", "browser.downloads.list args.state must be in_progress|interrupted|complete");
        }
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.min(Math.max(Math.floor(args.limit), 1), 200)
            : 50;
        let startTime: number | undefined;
        if (typeof args.since === "number" && Number.isFinite(args.since)) {
          startTime = args.since;
        } else if (typeof args.since === "string") {
          const parsed = Date.parse(args.since);
          if (Number.isNaN(parsed)) {
            throw toolError("proto.invalid", "browser.downloads.list args.since must be epoch ms or an ISO date");
          }
          startTime = parsed;
        }
        const items = await deps.listDownloads({
          ...(state ? { state } : {}),
          limit,
          ...(startTime !== undefined ? { startTime } : {}),
        });
        return {
          downloads: (Array.isArray(items) ? items : []).map((d) => ({
            id: typeof d.id === "number" ? d.id : undefined,
            state: d.state ?? "unknown",
            filename: d.filename ?? "",
            bytesReceived: d.bytesReceived ?? 0,
            totalBytes: d.totalBytes ?? -1,
            ...(d.error ? { error: d.error } : {}),
            startTime: d.startTime ?? "",
            ...(d.mime ? { mime: d.mime } : {}),
            ...(typeof d.fileExists === "boolean" ? { fileExists: d.fileExists } : {}),
          })),
        };
      }
      case "browser.downloads.wait": {
        // Profile-wide wait for a NEW download — the "click export →
        // wait for the file" primitive. Baseline-diff like tabs.wait:
        // only downloads whose startTime is at/after this call match,
        // so pre-existing profile downloads never false-positive.
        // Not tab-scoped.
        if (!deps.listDownloads) {
          throw toolError("proto.unsupported", "download wait requires the downloads permission");
        }
        const urlContains = str(args.urlContains);
        const filenameContains = str(args.filenameContains);
        if (urlContains !== undefined && urlContains.length > 512) {
          throw toolError("proto.invalid", "browser.downloads.wait args.urlContains must be ≤512 chars");
        }
        if (filenameContains !== undefined && filenameContains.length > 512) {
          throw toolError("proto.invalid", "browser.downloads.wait args.filenameContains must be ≤512 chars");
        }
        const untilState = str(args.untilState);
        if (untilState !== undefined && !["in_progress", "interrupted", "complete"].includes(untilState)) {
          throw toolError("proto.invalid", "browser.downloads.wait args.untilState must be in_progress|interrupted|complete");
        }
        const timeoutMs = clampMs(args.timeoutMs, 20_000, 60_000);
        const since = Date.now();
        // Baseline-diff is client-side: query unfiltered and match on
        // parsed startTime — chrome.downloads startedAfter granularity
        // is not trustworthy enough to gate the match on.
        const matchDownload = (d: {
          state?: string; filename?: string; suggestedFilename?: string;
          url?: string; startTime?: string;
        }): boolean => {
          const started = d.startTime ? Date.parse(d.startTime) : NaN;
          if (!Number.isFinite(started) || started < since - 1_000) return false;
          if (urlContains !== undefined && !(d.url ?? "").includes(urlContains)) return false;
          if (filenameContains !== undefined) {
            const name = d.filename || d.suggestedFilename || "";
            if (!name.includes(filenameContains)) return false;
          }
          // "in_progress" is satisfied by any observed state — seeing
          // the download at all proves it passed through in_progress.
          if (untilState !== undefined && untilState !== "in_progress" && d.state !== untilState) {
            return false;
          }
          return true;
        };
        const deadline = Date.now() + timeoutMs;
        let matched: Record<string, unknown> | undefined;
        while (Date.now() < deadline) {
          const items = await deps.listDownloads({ limit: 50 });
          const hit = (Array.isArray(items) ? items : []).find(matchDownload);
          if (hit) {
            matched = {
              id: hit.id, state: hit.state ?? "unknown",
              filename: hit.filename ?? "",
              ...(hit.suggestedFilename ? { suggestedFilename: hit.suggestedFilename } : {}),
              bytesReceived: hit.bytesReceived ?? 0,
              totalBytes: hit.totalBytes ?? -1,
              ...(hit.error ? { error: hit.error } : {}),
              startTime: hit.startTime ?? "",
              ...(typeof hit.fileExists === "boolean" ? { fileExists: hit.fileExists } : {}),
              // sanitized echo — full URL stays internal (signed tokens)
              ...(hit.url ? { url: urlOriginPath(hit.url) } : {}),
            };
            break;
          }
          await new Promise((r) => setTimeout(r, 250));
        }
        if (!matched) {
          throw toolError(
            "browser.timeout",
            `no new download matched within ${timeoutMs}ms`,
          );
        }
        return { matched: true, download: matched, waitedMs: Date.now() - since };
      }
      case "browser.downloads.save": {
        // Not tab-scoped: starts a download into the profile's download
        // directory. http(s) only — file:/chrome: URLs would let the
        // agent pull local/browser-internal resources to disk.
        if (!deps.downloadFile) {
          throw toolError("proto.unsupported", "download save requires the downloads permission");
        }
        const url = str(args.url);
        if (!url) {
          throw toolError("proto.invalid", "browser.downloads.save args.url is required");
        }
        let parsed: URL;
        try {
          parsed = new URL(url);
        } catch {
          throw toolError("proto.invalid", "browser.downloads.save args.url must be a valid URL");
        }
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw toolError("proto.invalid", "browser.downloads.save args.url must be http(s)");
        }
        // chrome.downloads filename is relative to the download dir —
        // reject absolute paths and traversal so the agent cannot write
        // outside it.
        const filename = str(args.filename);
        if (filename !== undefined) {
          if (
            filename.length > 200 ||
            filename.startsWith("/") ||
            filename.includes("..") ||
            filename.includes("\\") ||
            /[\x00-\x1f]/.test(filename)
          ) {
            throw toolError(
              "proto.invalid",
              "browser.downloads.save args.filename must be a relative path inside the download directory",
            );
          }
        }
        const res = await deps.downloadFile({ url, ...(filename !== undefined ? { filename } : {}) });
        const downloadId = typeof res?.id === "number" ? res.id : undefined;
        const base = {
          downloadId,
          filename: res?.filename,
        };
        if (args.waitForCompletion !== true) {
          return {
            ...base,
            note: "Download started — call browser.downloads.list to resolve the final on-disk path.",
          };
        }
        // Optional completion wait — closes the download→disk loop in
        // one call. Polls the downloads search API; terminal states are
        // complete|interrupted (interrupted carries error).
        if (!deps.listDownloads) {
          throw toolError("proto.unsupported", "download completion wait requires the downloads permission");
        }
        if (downloadId === undefined) {
          return {
            ...base,
            note: "Download started but no id was returned — poll browser.downloads.list to track it.",
          };
        }
        const waitMs = Math.min(
          Math.max(typeof args.timeoutMs === "number" ? args.timeoutMs : 30_000, 0),
          120_000,
        );
        const started = Date.now();
        const deadline = started + waitMs;
        let lastState: string | undefined;
        for (;;) {
          const items = await deps.listDownloads({ limit: 50 });
          const item = (Array.isArray(items) ? items : []).find((d) => d.id === downloadId);
          if (item) {
            lastState = item.state;
            if (item.state === "complete" || item.state === "interrupted") {
              return {
                downloadId,
                state: item.state,
                filename: item.filename,
                ...(typeof item.fileExists === "boolean" ? { fileExists: item.fileExists } : {}),
                ...(item.error ? { error: item.error } : {}),
                waitedMs: Date.now() - started,
              };
            }
          }
          if (Date.now() >= deadline) {
            throw toolError(
              "browser.timeout",
              `download ${downloadId} still ${lastState ?? "in_progress"} after ${waitMs}ms`,
            );
          }
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      case "browser.downloads.cancel": {
        // Not tab-scoped: profile-wide downloads — cancelling can stop a
        // download the USER started, which is why the risk classifier
        // leaves this tool unclassified → always approval-gated.
        if (!deps.cancelDownload) {
          throw toolError("proto.unsupported", "download cancel requires the downloads permission");
        }
        const downloadId = args.downloadId;
        if (typeof downloadId !== "number" || !Number.isInteger(downloadId) || downloadId < 0) {
          throw toolError("proto.invalid", "browser.downloads.cancel requires args.downloadId (integer from browser.downloads.list)");
        }
        // chrome.downloads.cancel rejects when the id is unknown or the
        // download is already terminal — the error propagates honestly
        // instead of claiming a cancellation that never happened.
        await deps.cancelDownload(downloadId);
        return { downloadId, cancelled: true };
      }
      case "browser.downloads.open": {
        // Deliverable handoff: launch the file with the OS default
        // handler, or reveal it in the file manager. External app
        // spawn — the risk classifier always gates this behind
        // approval. chrome.downloads.open rejects on unknown/in-
        // progress ids — the error propagates honestly.
        if (!deps.openDownload) {
          throw toolError("proto.unsupported", "download open requires the downloads permission");
        }
        const downloadId = args.downloadId;
        if (typeof downloadId !== "number" || !Number.isInteger(downloadId) || downloadId < 0) {
          throw toolError("proto.invalid", "browser.downloads.open requires args.downloadId (integer from browser.downloads.list)");
        }
        const reveal = args.reveal === true;
        await deps.openDownload(downloadId, { reveal });
        return { downloadId, opened: true, ...(reveal ? { revealed: true } : {}) };
      }
      case "browser.downloads.pause":
      case "browser.downloads.resume":
      case "browser.downloads.erase": {
        // Download-queue management — profile-wide like cancel, so the
        // risk classifier's default fail-closed keeps these
        // approval-gated. Chrome rejects on terminal/unknown ids with
        // its real error; nothing is faked.
        const op = tool === "browser.downloads.pause" ? "pause"
          : tool === "browser.downloads.resume" ? "resume" : "erase";
        if (!deps.manageDownload) {
          throw toolError("proto.unsupported", `download ${op} requires the downloads permission`);
        }
        const downloadId = args.downloadId;
        if (typeof downloadId !== "number" || !Number.isInteger(downloadId) || downloadId < 0) {
          throw toolError("proto.invalid", `browser.downloads.${op} requires args.downloadId (integer from browser.downloads.list)`);
        }
        await deps.manageDownload(downloadId, op);
        return { downloadId, [op === "erase" ? "erased" : op === "pause" ? "paused" : "resumed"]: true };
      }
      case "browser.tabGroups": {
        // Tab-strip organization via chrome.tabs.group/ungroup +
        // chrome.tabGroups. Not single-tab scoped — every tabId arg is
        // checked against the task scope individually; list only
        // surfaces groups containing in-scope tabs.
        if (!deps.tabGroups) {
          throw toolError("proto.unsupported", "tab groups are not available on this host");
        }
        const api = deps.tabGroups;
        const action = str(args.action) ?? "list";
        const COLORS = new Set(["grey", "blue", "red", "yellow", "green", "pink", "purple", "cyan", "orange"]);
        const parseTabIds = (v: unknown): number[] => {
          if (!Array.isArray(v) || v.length === 0 || v.length > 50 ||
              v.some((n) => typeof n !== "number" || !Number.isInteger(n) || n <= 0)) {
            throw toolError("proto.invalid", "browser.tabGroups args.tabIds must be an array of 1–50 positive integer tab ids");
          }
          return [...new Set(v as number[])];
        };
        const requireInScope = (tabIds: number[]): void => {
          for (const id of tabIds) {
            if (!tabInScope(tabScope, id)) {
              throw toolError("browser.not_in_scope", `tab ${id} is outside this task's tab scope`);
            }
          }
        };
        const parseGroupId = (v: unknown): number => {
          if (typeof v !== "number" || !Number.isInteger(v)) {
            throw toolError("proto.invalid", "browser.tabGroups requires integer args.groupId");
          }
          return v;
        };
        const parseTitle = (): string | undefined => {
          const t = str(args.title);
          if (t !== undefined && t.length > 500) {
            throw toolError("proto.invalid", "browser.tabGroups args.title must be ≤500 chars");
          }
          return t;
        };
        const parseColor = (): string | undefined => {
          const c = str(args.color);
          if (c !== undefined && !COLORS.has(c)) {
            throw toolError("proto.invalid", `browser.tabGroups args.color must be one of ${[...COLORS].join("|")}`);
          }
          return c;
        };

        if (action === "list") {
          const groups = await api.list();
          const out: Array<Record<string, unknown>> = [];
          for (const g of Array.isArray(groups) ? groups : []) {
            if (typeof g.id !== "number") continue;
            const memberIds = await api.tabsInGroup(g.id);
            const scoped = memberIds.filter((id) => tabInScope(tabScope, id));
            if (scoped.length === 0) continue; // never surface foreign groups
            out.push({
              id: g.id,
              ...(typeof g.windowId === "number" ? { windowId: g.windowId } : {}),
              title: g.title ?? "",
              color: g.color ?? "",
              collapsed: g.collapsed === true,
              tabIds: scoped,
              tabCount: scoped.length,
            });
          }
          return { groups: out, count: out.length };
        }
        if (action === "create") {
          const tabIds = parseTabIds(args.tabIds);
          requireInScope(tabIds);
          let joinId: number | undefined;
          if (args.groupId !== undefined) {
            joinId = parseGroupId(args.groupId);
            // joining an existing group requires it to be visible to
            // this task — at least one member tab in scope
            const members = await api.tabsInGroup(joinId);
            if (!members.some((id) => tabInScope(tabScope, id))) {
              throw toolError("browser.not_in_scope", `group ${joinId} has no tabs in this task's scope`);
            }
          }
          const created = await api.create(tabIds, joinId);
          if (typeof created?.id !== "number") {
            throw toolError("browser.action_failed", "chrome.tabs.group returned no group id");
          }
          const gid = created.id;
          const title = parseTitle();
          const color = parseColor();
          if (title !== undefined || color !== undefined) {
            await api.update(gid, {
              ...(title !== undefined ? { title } : {}),
              ...(color !== undefined ? { color } : {}),
            });
          }
          return {
            groupId: gid,
            tabIds,
            ...(joinId !== undefined ? { joined: joinId } : {}),
            ...(title !== undefined ? { title } : {}),
            ...(color !== undefined ? { color } : {}),
          };
        }
        if (action === "update") {
          const groupId = parseGroupId(args.groupId);
          const title = parseTitle();
          const color = parseColor();
          const collapsed = typeof args.collapsed === "boolean" ? args.collapsed : undefined;
          if (title === undefined && color === undefined && collapsed === undefined) {
            throw toolError("proto.invalid", "browser.tabGroups update requires args.title, args.color and/or args.collapsed");
          }
          const members = await api.tabsInGroup(groupId);
          if (!members.some((id) => tabInScope(tabScope, id))) {
            throw toolError("browser.not_in_scope", `group ${groupId} has no tabs in this task's scope`);
          }
          await api.update(groupId, {
            ...(title !== undefined ? { title } : {}),
            ...(color !== undefined ? { color } : {}),
            ...(collapsed !== undefined ? { collapsed } : {}),
          });
          return {
            updated: groupId,
            ...(title !== undefined ? { title } : {}),
            ...(color !== undefined ? { color } : {}),
            ...(collapsed !== undefined ? { collapsed } : {}),
          };
        }
        if (action === "ungroup") {
          const tabIds = parseTabIds(args.tabIds);
          requireInScope(tabIds);
          await api.ungroup(tabIds);
          return { ungrouped: tabIds };
        }
        throw toolError("proto.invalid", "browser.tabGroups args.action must be list|create|update|ungroup");
      }
      case "browser.siteSettings": {
        // Per-origin content settings via chrome.contentSettings —
        // the permission state behind browser-native prompts
        // (notifications, camera, mic…) the agent cannot click.
        if (!deps.siteSettings) {
          throw toolError("proto.unsupported", "site settings are not available on this host");
        }
        const api = deps.siteSettings;
        const action = str(args.action) ?? "get";
        if (!["get", "set", "clear"].includes(action)) {
          throw toolError("proto.invalid", "browser.siteSettings args.action must be get|set|clear");
        }
        const contentType = str(args.contentType);
        if (contentType === undefined || !/^[a-z][a-z0-9_]{0,63}$/.test(contentType)) {
          throw toolError("proto.invalid", "browser.siteSettings requires args.contentType (snake_case, e.g. notifications)");
        }
        const rawOrigin = str(args.origin);
        if (rawOrigin === undefined) {
          throw toolError("proto.invalid", "browser.siteSettings requires args.origin (http(s) origin)");
        }
        let originUrl: URL;
        try {
          originUrl = new URL(rawOrigin);
        } catch {
          throw toolError("proto.invalid", "browser.siteSettings args.origin is not a valid URL");
        }
        if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
          throw toolError("proto.invalid", "browser.siteSettings args.origin must be http(s)");
        }
        // chrome match patterns cannot express ports — the pattern is
        // scheme://host/* (site settings are host-scoped in Chrome).
        const primaryPattern = `${originUrl.protocol}//${originUrl.hostname}/*`;
        const SCOPES = new Set(["regular", "incognito_session_only", "off_the_record", "span_incognito", "regular_only"]);
        const scope = str(args.scope);
        if (scope !== undefined && !SCOPES.has(scope)) {
          throw toolError("proto.invalid", `browser.siteSettings args.scope must be one of ${[...SCOPES].join("|")}`);
        }
        if (action === "get") {
          const res = await api.get(contentType, primaryPattern, scope);
          if (res === "permission") {
            throw toolError("proto.unsupported", "contentSettings permission is not granted");
          }
          if (res === null) {
            throw toolError("proto.unsupported", `content type '${contentType}' is not available in this Chrome version`);
          }
          return {
            contentType,
            origin: originUrl.origin,
            pattern: primaryPattern,
            setting: res.setting ?? "default",
            ...(typeof res.scope === "string" ? { scope: res.scope } : {}),
          };
        }
        if (action === "set") {
          const setting = str(args.setting);
          if (setting === undefined || setting.length === 0 || setting.length > 64) {
            throw toolError("proto.invalid", "browser.siteSettings set requires args.setting (≤64 chars)");
          }
          const res = await api.set(contentType, primaryPattern, setting, scope);
          if (res === "permission") {
            throw toolError("proto.unsupported", "contentSettings permission is not granted");
          }
          if (res === null) {
            throw toolError("proto.unsupported", `content type '${contentType}' is not available in this Chrome version`);
          }
          return {
            contentType,
            origin: originUrl.origin,
            pattern: primaryPattern,
            setting,
            ...(scope ? { scope } : {}),
          };
        }
        const res = await api.clear(contentType, primaryPattern);
        if (res === "permission") {
          throw toolError("proto.unsupported", "contentSettings permission is not granted");
        }
        if (res === null) {
          throw toolError("proto.unsupported", `content type '${contentType}' is not available in this Chrome version`);
        }
        return { contentType, origin: originUrl.origin, pattern: primaryPattern, cleared: true };
      }
      case "browser.sessions": {
        // Not tab-scoped: chrome.sessions recently-closed entries.
        // Optional "sessions" permission — ungranted → unsupported.
        if (!deps.sessions) {
          throw toolError("proto.unsupported", "session data is not available on this host");
        }
        const action = str(args.action) ?? "list";
        if (action !== "list" && action !== "restore") {
          throw toolError("proto.invalid", "browser.sessions args.action must be list|restore");
        }
        if (action === "restore") {
          if (args.sessionId !== undefined && args.sessionId !== null) {
            const sessionId = str(args.sessionId);
            if (sessionId === undefined || sessionId.length > 256) {
              throw toolError("proto.invalid", "browser.sessions args.sessionId must be 1-256 chars");
            }
          }
          const sessionId = str(args.sessionId);
          const res = await deps.sessions.restore(sessionId);
          if (res === "permission") {
            throw toolError("proto.unsupported", "sessions permission is not granted");
          }
          if (res === null) {
            throw toolError("proto.unsupported", "session restore is not available on this host");
          }
          return { ...(res as Record<string, unknown>), restored: true };
        }
        let maxResults = 25;
        if (args.maxResults !== undefined && args.maxResults !== null) {
          const n = args.maxResults;
          if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 25) {
            throw toolError("proto.invalid", "browser.sessions args.maxResults must be an integer 1-25");
          }
          maxResults = n;
        }
        const res = await deps.sessions.list(maxResults);
        if (res === "permission") {
          throw toolError("proto.unsupported", "sessions permission is not granted");
        }
        if (res === null) {
          throw toolError("proto.unsupported", "session data is not available on this host");
        }
        return { entries: res, count: res.length };
      }
      case "browser.proxy": {
        // Not tab-scoped: chrome.proxy.settings — profile-wide egress
        // control. Optional "proxy" permission — ungranted → unsupported.
        if (!deps.proxy) {
          throw toolError("proto.unsupported", "proxy control is not available on this host");
        }
        const action = str(args.action) ?? "get";
        if (!["get", "set", "clear"].includes(action)) {
          throw toolError("proto.invalid", "browser.proxy args.action must be get|set|clear");
        }
        const SCOPES = new Set(["regular", "incognito_session_only", "off_the_record", "span_incognito", "regular_only"]);
        const scope = str(args.scope);
        if (scope !== undefined && !SCOPES.has(scope)) {
          throw toolError("proto.invalid", `browser.proxy args.scope must be one of ${[...SCOPES].join("|")}`);
        }
        if (action === "get") {
          const res = await deps.proxy.get(scope);
          if (res === "permission") {
            throw toolError("proto.unsupported", "proxy permission is not granted");
          }
          if (res === null) {
            throw toolError("proto.unsupported", "proxy control is not available on this host");
          }
          return {
            value: res.value ?? null,
            ...(typeof res.levelOfControl === "string" ? { levelOfControl: res.levelOfControl } : {}),
            ...(scope ? { scope } : {}),
          };
        }
        if (action === "clear") {
          const res = await deps.proxy.clear(scope);
          if (res === "permission") {
            throw toolError("proto.unsupported", "proxy permission is not granted");
          }
          if (res === null) {
            throw toolError("proto.unsupported", "proxy control is not available on this host");
          }
          return { cleared: true, ...(scope ? { scope } : {}) };
        }
        // set — build the chrome ProxyConfig from the simplified spec.
        const mode = str(args.mode);
        if (mode === undefined || !["direct", "system", "auto_detect", "pac_script", "fixed_servers"].includes(mode)) {
          throw toolError("proto.invalid", "browser.proxy set requires args.mode direct|system|auto_detect|pac_script|fixed_servers");
        }
        let value: Record<string, unknown>;
        if (mode === "fixed_servers") {
          const p = args.proxy;
          if (typeof p !== "object" || p === null || Array.isArray(p)) {
            throw toolError("proto.invalid", "browser.proxy fixed_servers requires args.proxy {host, scheme?, port?}");
          }
          const host = str((p as Record<string, unknown>).host);
          if (host === undefined || host.length > 253) {
            throw toolError("proto.invalid", "browser.proxy args.proxy.host is required (≤253 chars)");
          }
          const scheme = str((p as Record<string, unknown>).scheme);
          if (scheme !== undefined && !["http", "https", "quic", "socks4", "socks5"].includes(scheme)) {
            throw toolError("proto.invalid", "browser.proxy args.proxy.scheme must be http|https|quic|socks4|socks5");
          }
          const port = (p as Record<string, unknown>).port;
          if (port !== undefined && (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535)) {
            throw toolError("proto.invalid", "browser.proxy args.proxy.port must be an integer 1-65535");
          }
          const bypass = args.bypassList;
          if (bypass !== undefined) {
            if (!Array.isArray(bypass) || bypass.length > 32 || bypass.some((b) => typeof b !== "string" || b.length === 0 || b.length > 253)) {
              throw toolError("proto.invalid", "browser.proxy args.bypassList must be ≤32 non-empty strings ≤253 chars");
            }
          }
          value = {
            mode,
            rules: {
              singleProxy: {
                host,
                ...(scheme ? { scheme } : {}),
                ...(port !== undefined ? { port } : {}),
              },
              ...(Array.isArray(bypass) ? { bypassList: bypass as string[] } : {}),
            },
          };
        } else if (mode === "pac_script") {
          const pac = args.pacScript;
          if (typeof pac !== "object" || pac === null || Array.isArray(pac)) {
            throw toolError("proto.invalid", "browser.proxy pac_script requires args.pacScript {url|data, mandatory?}");
          }
          const pacUrl = str((pac as Record<string, unknown>).url);
          const pacData = str((pac as Record<string, unknown>).data);
          if ((pacUrl === undefined) === (pacData === undefined)) {
            throw toolError("proto.invalid", "browser.proxy args.pacScript takes args.pacScript.url XOR args.pacScript.data");
          }
          if (pacUrl !== undefined) {
            try {
              const u = new URL(pacUrl);
              if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("scheme");
            } catch {
              throw toolError("proto.invalid", "browser.proxy args.pacScript.url must be http(s)");
            }
          }
          if (pacData !== undefined && pacData.length > 128 * 1024) {
            throw toolError("proto.invalid", "browser.proxy args.pacScript.data must be ≤128KiB");
          }
          const mandatory = (pac as Record<string, unknown>).mandatory;
          if (mandatory !== undefined && typeof mandatory !== "boolean") {
            throw toolError("proto.invalid", "browser.proxy args.pacScript.mandatory must be boolean");
          }
          value = {
            mode,
            pacScript: {
              ...(pacUrl !== undefined ? { url: pacUrl } : { data: pacData }),
              ...(mandatory !== undefined ? { mandatory } : {}),
            },
          };
        } else {
          value = { mode };
        }
        const res = await deps.proxy.set(value, scope);
        if (res === "permission") {
          throw toolError("proto.unsupported", "proxy permission is not granted");
        }
        if (res === null) {
          throw toolError("proto.unsupported", "proxy control is not available on this host");
        }
        return { mode, value, ...(scope ? { scope } : {}), applied: true };
      }
      case "browser.privacy": {
        // Not tab-scoped: chrome.privacy — profile-wide privacy posture.
        // Optional "privacy" permission — ungranted → unsupported.
        if (!deps.privacy) {
          throw toolError("proto.unsupported", "privacy settings are not available on this host");
        }
        const action = str(args.action) ?? "get";
        if (!["get", "set", "clear"].includes(action)) {
          throw toolError("proto.invalid", "browser.privacy args.action must be get|set|clear");
        }
        const SCOPES = new Set(["regular", "incognito_session_only", "off_the_record", "span_incognito", "regular_only"]);
        const scope = str(args.scope);
        if (scope !== undefined && !SCOPES.has(scope)) {
          throw toolError("proto.invalid", `browser.privacy args.scope must be one of ${[...SCOPES].join("|")}`);
        }
        const setting = str(args.setting);
        if (setting !== undefined && !/^(services|network|websites)\.[A-Za-z][A-Za-z0-9]{0,63}$/.test(setting)) {
          throw toolError("proto.invalid", "browser.privacy args.setting must be 'section.key' with section services|network|websites");
        }
        const sentinel = (res: unknown, what: string): never | Record<string, unknown> => {
          if (res === "permission") {
            throw toolError("proto.unsupported", "privacy permission is not granted");
          }
          if (res === null) {
            throw toolError(
              "proto.unsupported",
              setting !== undefined
                ? `privacy setting '${setting}' is not available in this Chrome version`
                : `${what} is not available on this host`,
            );
          }
          return res as Record<string, unknown>;
        };
        if (action === "get") {
          const res = sentinel(await deps.privacy.get(setting, scope), "privacy settings");
          return { ...res, ...(scope ? { scope } : {}) };
        }
        if (action === "clear") {
          const res = sentinel(await deps.privacy.clear(setting, scope), "privacy settings");
          return { ...res, ...(setting ? { setting } : {}), ...(scope ? { scope } : {}) };
        }
        // set — value is boolean for every setting except
        // network.webRTCIPHandlingPolicy (enum string).
        if (setting === undefined) {
          throw toolError("proto.invalid", "browser.privacy set requires args.setting");
        }
        const value = args.value;
        if (setting === "network.webRTCIPHandlingPolicy") {
          const WEBRTC = new Set([
            "default",
            "default_public_and_private_interfaces",
            "default_public_interface_only",
            "disable_non_proxied_udp",
          ]);
          if (typeof value !== "string" || !WEBRTC.has(value)) {
            throw toolError(
              "proto.invalid",
              "browser.privacy network.webRTCIPHandlingPolicy value must be default|default_public_and_private_interfaces|default_public_interface_only|disable_non_proxied_udp",
            );
          }
        } else if (typeof value !== "boolean") {
          throw toolError("proto.invalid", "browser.privacy args.value must be boolean");
        }
        // Chrome documents these as disable-only — re-enabling throws.
        const DISABLE_ONLY = new Set([
          "websites.adMeasurementEnabled",
          "websites.fledgeEnabled",
          "websites.relatedWebsiteSetsEnabled",
          "websites.topicsEnabled",
        ]);
        if (DISABLE_ONLY.has(setting) && value === true) {
          throw toolError("proto.invalid", `browser.privacy ${setting} can only be disabled (value:false)`);
        }
        const res = sentinel(await deps.privacy.set(setting, value, scope), "privacy settings");
        return { setting, value, ...res, ...(scope ? { scope } : {}) };
      }
      case "browser.management": {
        // Not tab-scoped: chrome.management — the installed extension
        // inventory. Optional "management" permission — ungranted →
        // unsupported. The agent's own extension is protected: it can
        // never disable or uninstall its own host.
        if (!deps.management) {
          throw toolError("proto.unsupported", "extension management is not available on this host");
        }
        const action = str(args.action) ?? "list";
        if (!["list", "get", "setEnabled", "uninstall"].includes(action)) {
          throw toolError("proto.invalid", "browser.management args.action must be list|get|setEnabled|uninstall");
        }
        const sentinel = (res: unknown, what: string): never | Record<string, unknown> | Array<Record<string, unknown>> => {
          if (res === "permission") {
            throw toolError("proto.unsupported", "management permission is not granted");
          }
          if (res === null) {
            throw toolError("proto.unsupported", `${what} is not available on this host`);
          }
          return res as Record<string, unknown> | Array<Record<string, unknown>>;
        };
        if (action === "list") {
          const maxResults = args.maxResults === undefined ? 100 : args.maxResults;
          if (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1 || maxResults > 200) {
            throw toolError("proto.invalid", "browser.management args.maxResults must be an integer 1-200");
          }
          const res = sentinel(await deps.management.list(maxResults), "extension inventory");
          return { extensions: res, count: Array.isArray(res) ? res.length : 0, maxResults };
        }
        const id = str(args.id);
        if (id === undefined || id.length === 0 || id.length > 128) {
          throw toolError("proto.invalid", "browser.management args.id is required (1-128 chars)");
        }
        if ((action === "setEnabled" || action === "uninstall") && deps.selfExtensionId !== undefined && id === deps.selfExtensionId) {
          throw toolError("proto.invalid", "browser.management cannot modify the Chromex extension itself");
        }
        if (action === "get") {
          const res = sentinel(await deps.management.get(id), "extension");
          if (typeof res === "object" && !Array.isArray(res) && Object.keys(res).length === 0) {
            throw toolError("proto.unsupported", `extension '${id}' was not found`);
          }
          return { extension: res };
        }
        if (action === "setEnabled") {
          const enabled = args.enabled;
          if (typeof enabled !== "boolean") {
            throw toolError("proto.invalid", "browser.management setEnabled requires args.enabled boolean");
          }
          const res = sentinel(await deps.management.setEnabled(id, enabled), "extension");
          return { id, enabled, ...res };
        }
        const res = sentinel(await deps.management.uninstall(id), "extension");
        return { id, ...res };
      }
      case "browser.notifications": {
        // Not tab-scoped: chrome.notifications — OS desktop alerts, the
        // agent's channel to reach the human. Optional "notifications"
        // permission — ungranted → unsupported.
        if (!deps.notifications) {
          throw toolError("proto.unsupported", "desktop notifications are not available on this host");
        }
        const action = str(args.action) ?? "list";
        if (!["send", "update", "clear", "list", "permission"].includes(action)) {
          throw toolError("proto.invalid", "browser.notifications args.action must be send|update|clear|list|permission");
        }
        const sentinel = (res: unknown): never | Record<string, unknown> => {
          if (res === "permission") {
            throw toolError("proto.unsupported", "notifications permission is not granted");
          }
          if (res === null) {
            throw toolError("proto.unsupported", "desktop notifications are not available on this host");
          }
          return res as Record<string, unknown>;
        };
        if (action === "permission") {
          const res = await deps.notifications.permission();
          if (res === "permission") {
            throw toolError("proto.unsupported", "notifications permission is not granted");
          }
          if (res === null) {
            throw toolError("proto.unsupported", "desktop notifications are not available on this host");
          }
          return { permission: res };
        }
        if (action === "list") {
          return sentinel(await deps.notifications.list());
        }
        if (action === "clear") {
          // Raw-arg check: "" must NOT silently widen to clear-all.
          const rawNid = args.notificationId;
          if (rawNid !== undefined && (typeof rawNid !== "string" || rawNid.length === 0 || rawNid.length > 500)) {
            throw toolError("proto.invalid", "browser.notifications args.notificationId must be a string 1-500 chars");
          }
          return sentinel(await deps.notifications.clear(rawNid as string | undefined));
        }
        // send|update — build the chrome NotificationOptions subset.
        const rawSendNid = args.notificationId;
        if (rawSendNid !== undefined && (typeof rawSendNid !== "string" || rawSendNid.length === 0 || rawSendNid.length > 500)) {
          throw toolError("proto.invalid", "browser.notifications args.notificationId must be a string 1-500 chars");
        }
        const notificationId = rawSendNid as string | undefined;
        if (action === "update" && notificationId === undefined) {
          throw toolError("proto.invalid", "browser.notifications update requires args.notificationId");
        }
        const requireContent = action === "send";
        const options: Record<string, unknown> = {};
        const title = str(args.title);
        const message = str(args.message);
        if (requireContent) {
          if (title === undefined || title.length === 0 || title.length > 200) {
            throw toolError("proto.invalid", "browser.notifications send requires args.title (1-200 chars)");
          }
          if (message === undefined || message.length === 0 || message.length > 4000) {
            throw toolError("proto.invalid", "browser.notifications send requires args.message (1-4000 chars)");
          }
        }
        if (title !== undefined) {
          if (title.length === 0 || title.length > 200) {
            throw toolError("proto.invalid", "browser.notifications args.title must be 1-200 chars");
          }
          options.title = title;
        }
        if (message !== undefined) {
          if (message.length === 0 || message.length > 4000) {
            throw toolError("proto.invalid", "browser.notifications args.message must be 1-4000 chars");
          }
          options.message = message;
        }
        const type = str(args.type);
        if (type !== undefined) {
          if (!["basic", "list", "progress"].includes(type)) {
            throw toolError("proto.invalid", "browser.notifications args.type must be basic|list|progress");
          }
          options.type = type;
        } else if (requireContent) {
          options.type = "basic";
        }
        const iconUrl = str(args.iconUrl);
        if (iconUrl !== undefined) {
          // chrome.notifications accepts data: URLs or extension
          // resources only — http(s) icon URLs are rejected by Chrome.
          if (!/^data:image\/(png|jpe?g|gif|webp|svg\+xml)[;,]/.test(iconUrl) || iconUrl.length > 128 * 1024) {
            throw toolError("proto.invalid", "browser.notifications args.iconUrl must be a data:image/* URL ≤128KiB");
          }
          options.iconUrl = iconUrl;
        }
        const priority = args.priority;
        if (priority !== undefined) {
          if (typeof priority !== "number" || !Number.isInteger(priority) || priority < -2 || priority > 2) {
            throw toolError("proto.invalid", "browser.notifications args.priority must be an integer -2..2");
          }
          options.priority = priority;
        }
        for (const flag of ["requireInteraction", "silent"] as const) {
          const v = args[flag];
          if (v !== undefined) {
            if (typeof v !== "boolean") {
              throw toolError("proto.invalid", `browser.notifications args.${flag} must be boolean`);
            }
            options[flag] = v;
          }
        }
        const eventTime = args.eventTime;
        if (eventTime !== undefined) {
          if (typeof eventTime !== "number" || !Number.isFinite(eventTime)) {
            throw toolError("proto.invalid", "browser.notifications args.eventTime must be a number (epoch ms)");
          }
          options.eventTime = eventTime;
        }
        const items = args.items;
        if (items !== undefined) {
          if (!Array.isArray(items) || items.length === 0 || items.length > 10) {
            throw toolError("proto.invalid", "browser.notifications args.items must be 1-10 {title,message} entries");
          }
          const clean = items.map((it) => {
            const o = it as Record<string, unknown>;
            const t = str(o?.title);
            const m = str(o?.message);
            if (t === undefined || t.length === 0 || t.length > 200 || m === undefined || m.length === 0 || m.length > 1000) {
              throw toolError("proto.invalid", "browser.notifications args.items entries need {title ≤200, message ≤1000}");
            }
            return { title: t, message: m };
          });
          options.items = clean;
        }
        const progress = args.progress;
        if (progress !== undefined) {
          if (typeof progress !== "number" || !Number.isInteger(progress) || progress < 0 || progress > 100) {
            throw toolError("proto.invalid", "browser.notifications args.progress must be an integer 0-100");
          }
          options.progress = progress;
        }
        const buttons = args.buttons;
        if (buttons !== undefined) {
          if (!Array.isArray(buttons) || buttons.length === 0 || buttons.length > 2) {
            throw toolError("proto.invalid", "browser.notifications args.buttons must be 1-2 {title} entries");
          }
          options.buttons = buttons.map((b) => {
            const t = str((b as Record<string, unknown>)?.title);
            if (t === undefined || t.length === 0 || t.length > 64) {
              throw toolError("proto.invalid", "browser.notifications args.buttons entries need {title ≤64}");
            }
            return { title: t };
          });
        }
        if (notificationId !== undefined) options.notificationId = notificationId;
        if (action === "update") {
          const { notificationId: nid, ...rest } = options;
          return sentinel(await deps.notifications.update(nid as string, rest));
        }
        return sentinel(await deps.notifications.send(options));
      }
      case "browser.dnr": {
        // Not tab-scoped: chrome.declarativeNetRequest SESSION rules —
        // profile-wide network interception at the network stack (all
        // tabs, frames, service workers; survives navigations, no
        // debugger). Optional "declarativeNetRequest" permission —
        // ungranted → unsupported.
        if (!deps.dnr) {
          throw toolError("proto.unsupported", "network rules are not available on this host");
        }
        const api = deps.dnr;
        const action = str(args.action) ?? "list";
        if (!["list", "add", "remove", "clear", "matched", "test", "permission"].includes(action)) {
          throw toolError("proto.invalid", "browser.dnr args.action must be list|add|remove|clear|matched|test|permission");
        }
        const dnrSentinel = async <T>(v: Promise<T | "permission" | null>): Promise<T> => {
          const r = await v;
          if (r === "permission") {
            throw toolError("proto.unsupported", "declarativeNetRequest permission is not granted");
          }
          if (r === null) {
            throw toolError("proto.unsupported", "declarativeNetRequest is not available on this host");
          }
          return r as T;
        };
        if (action === "permission") {
          return { permission: await dnrSentinel(api.permission()) };
        }
        if (action === "list") {
          const rules = await dnrSentinel(api.list());
          return { rules, count: rules.length };
        }
        if (action === "add") {
          const rules = parseDnrRules(args.rules);
          const needIds = rules.filter((r) => r.id === undefined);
          if (needIds.length > 0) {
            const existing = await dnrSentinel(api.list());
            const used = new Set<number>();
            for (const r of existing) {
              const id = (r as { id?: unknown })?.id;
              if (typeof id === "number" && Number.isInteger(id)) used.add(id);
            }
            // explicit ids in this batch must not be re-assigned either
            for (const r of rules) {
              if (typeof r.id === "number") used.add(r.id);
            }
            let next = 1;
            for (const rule of needIds) {
              while (used.has(next)) next += 1;
              rule.id = next;
              used.add(next);
              next += 1;
            }
          }
          await dnrSentinel(api.update({ addRules: rules }));
          return { added: rules.length, ids: rules.map((r) => r.id) };
        }
        if (action === "remove") {
          const ids = parseDnrRuleIds(args.ruleIds);
          await dnrSentinel(api.update({ removeRuleIds: ids }));
          return { removed: ids.length };
        }
        if (action === "clear") {
          const existing = await dnrSentinel(api.list());
          const ids = existing
            .map((r) => (r as { id?: unknown })?.id)
            .filter((n): n is number => typeof n === "number" && Number.isInteger(n));
          if (ids.length === 0) return { removed: 0 };
          await dnrSentinel(api.update({ removeRuleIds: ids }));
          return { removed: ids.length };
        }
        if (action === "matched") {
          const filter: Record<string, unknown> = {};
          if (args.tabId !== undefined) {
            const t = args.tabId;
            if (typeof t !== "number" || !Number.isInteger(t) || t < -1) {
              throw toolError("proto.invalid", "browser.dnr args.tabId must be an integer >= -1 (-1 = requests with no tab)");
            }
            filter.tabId = t;
          }
          if (args.minTimeStamp !== undefined) {
            const n = args.minTimeStamp;
            if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
              throw toolError("proto.invalid", "browser.dnr args.minTimeStamp must be a non-negative number (epoch ms)");
            }
            filter.minTimeStamp = n;
          }
          const matches = await dnrSentinel(api.matched(filter));
          const bounded = matches.slice(0, 200);
          return {
            matches: bounded,
            totalCount: matches.length,
            omitted: matches.length - bounded.length,
          };
        }
        // action === "test" — dry-run a hypothetical request against
        // the current rule set; no traffic is affected.
        const req = args.request;
        if (req === null || typeof req !== "object" || Array.isArray(req)) {
          throw toolError("proto.invalid", "browser.dnr test requires args.request {url, type}");
        }
        const ro = req as Record<string, unknown>;
        const url = str(ro.url);
        if (url === undefined || url.length === 0 || url.length > 2048) {
          throw toolError("proto.invalid", "browser.dnr args.request.url is required (≤2048 chars)");
        }
        try {
          new URL(url);
        } catch {
          throw toolError("proto.invalid", "browser.dnr args.request.url is not a valid URL");
        }
        const rtype = str(ro.type);
        if (rtype === undefined || !DNR_RESOURCE_TYPES.has(rtype)) {
          throw toolError("proto.invalid", `browser.dnr args.request.type must be one of ${[...DNR_RESOURCE_TYPES].join("|")}`);
        }
        const request: Record<string, unknown> = { url, type: rtype };
        if (ro.method !== undefined) {
          const m = str(ro.method);
          if (m === undefined || !DNR_REQUEST_METHODS.has(m)) {
            throw toolError("proto.invalid", `browser.dnr args.request.method must be one of ${[...DNR_REQUEST_METHODS].join("|")}`);
          }
          request.method = m;
        }
        if (ro.initiator !== undefined) {
          const i = str(ro.initiator);
          if (i === undefined || i.length > 2048) {
            throw toolError("proto.invalid", "browser.dnr args.request.initiator must be ≤2048 chars");
          }
          request.initiator = i;
        }
        if (ro.tabId !== undefined) {
          const t = ro.tabId;
          if (typeof t !== "number" || !Number.isInteger(t)) {
            throw toolError("proto.invalid", "browser.dnr args.request.tabId must be an integer");
          }
          request.tabId = t;
        }
        const matchedRules = await dnrSentinel(api.test(request));
        const bounded = matchedRules.slice(0, 50);
        return {
          url,
          matchedRules: bounded,
          totalCount: matchedRules.length,
          omitted: matchedRules.length - bounded.length,
        };
      }
      case "browser.userScripts": {
        // chrome.userScripts — persistent page injections + one-shot
        // execution. Optional "userScripts" permission checked per call
        // in index.ts ("permission" sentinel → proto.unsupported).
        // Scripts/worlds/lifecycle args are validated here; the dep
        // only marshals to the Chrome API.
        if (!deps.userScripts) {
          throw toolError("proto.unsupported", "user scripts are not available on this host");
        }
        const api = deps.userScripts;
        const action = str(args.action) ?? "list";
        const usSentinel = async <T>(v: Promise<T | "permission" | null>): Promise<T> => {
          const r = await v;
          if (r === "permission") {
            throw toolError("proto.unsupported", "userScripts permission is not granted");
          }
          if (r === null) {
            throw toolError("proto.unsupported", "chrome.userScripts is not available on this Chrome build");
          }
          return r as T;
        };
        const worldIdArg = (): string | undefined => {
          const w = str(args.worldId);
          if (w === undefined) return undefined;
          if (w.length > 128 || w.startsWith("_")) {
            throw toolError("proto.invalid", "browser.userScripts args.worldId must be ≤128 chars and not '_'-prefixed");
          }
          return w;
        };
        switch (action) {
          case "permission": {
            const p = await api.permission();
            if (p === "permission") {
              return { permission: "not_granted", granted: false };
            }
            if (p === null) {
              throw toolError("proto.unsupported", "chrome.userScripts is not available on this Chrome build");
            }
            return { permission: p, granted: p === "granted" };
          }
          case "list": {
            const ids = usStrArray(args.ids, "ids", 100);
            const scripts = await usSentinel(api.list(ids));
            return { scripts, count: scripts.length };
          }
          case "worlds": {
            const worlds = await usSentinel(api.worlds());
            return { worlds };
          }
          case "register":
          case "update": {
            const scripts = usValidateScripts(args.scripts, action === "register");
            const out = await usSentinel(
              action === "register" ? api.register(scripts) : api.update(scripts),
            );
            return out ?? { ok: true };
          }
          case "unregister": {
            const ids = usStrArray(args.ids, "ids", 100);
            const out = await usSentinel(api.unregister(ids));
            return out ?? { ok: true };
          }
          case "execute": {
            const tabId = await resolveScopedTabId(deps, args, tabScope);
            const code = str(args.code);
            if (!code || code.length > 256 * 1024) {
              throw toolError("proto.invalid", "browser.userScripts execute requires args.code (≤256KiB)");
            }
            const world = str(args.world);
            if (world !== undefined && world !== "MAIN" && world !== "USER_SCRIPT") {
              throw toolError("proto.invalid", "browser.userScripts args.world must be MAIN|USER_SCRIPT");
            }
            const frameIds = usIntArray(args.frameIds, "frameIds", 100);
            if (frameIds && args.allFrames === true) {
              throw toolError("proto.invalid", "browser.userScripts execute args.allFrames and args.frameIds are mutually exclusive");
            }
            const worldId = worldIdArg();
            const injection: Record<string, unknown> = {
              js: [{ code }],
              target: {
                tabId,
                ...(args.allFrames === true ? { allFrames: true } : {}),
                ...(frameIds ? { frameIds } : {}),
              },
              ...(world ? { world } : {}),
              ...(worldId ? { worldId } : {}),
              ...(args.injectImmediately === true ? { injectImmediately: true } : {}),
            };
            const results = await usSentinel(api.execute(injection));
            return { results, resolvedTabId: tabId };
          }
          case "configureWorld": {
            const worldId = worldIdArg();
            const csp = str(args.csp);
            if (csp !== undefined && csp.length > 8192) {
              throw toolError("proto.invalid", "browser.userScripts args.csp must be ≤8KiB");
            }
            if (csp === undefined && typeof args.messaging !== "boolean") {
              throw toolError("proto.invalid", "browser.userScripts configureWorld requires args.csp and/or args.messaging");
            }
            const props: Record<string, unknown> = {
              ...(worldId ? { worldId } : {}),
              ...(csp !== undefined ? { csp } : {}),
              ...(typeof args.messaging === "boolean" ? { messaging: args.messaging } : {}),
            };
            const out = await usSentinel(api.configureWorld(props));
            return out ?? { ok: true };
          }
          case "resetWorld": {
            const out = await usSentinel(api.resetWorld(worldIdArg()));
            return out ?? { ok: true };
          }
          default:
            throw toolError(
              "proto.invalid",
              "browser.userScripts args.action must be list|worlds|register|update|unregister|execute|configureWorld|resetWorld|permission",
            );
        }
      }
      case "browser.system": {
        // chrome.system memory/cpu — machine stats, each op gated by
        // its own optional permission ("permission" sentinel →
        // proto.unsupported naming the specific permission).
        if (!deps.system) {
          throw toolError("proto.unsupported", "system stats are not available on this host");
        }
        const api = deps.system;
        const action = str(args.action) ?? "memory";
        const sysSentinel = async <T>(v: Promise<T | "permission" | null>, perm: string): Promise<T> => {
          const r = await v;
          if (r === "permission") {
            throw toolError("proto.unsupported", `${perm} permission is not granted`);
          }
          if (r === null) {
            throw toolError("proto.unsupported", "chrome.system is not available on this Chrome build");
          }
          return r as T;
        };
        switch (action) {
          case "memory": {
            const info = await sysSentinel(api.memory(), "system.memory");
            return info;
          }
          case "cpu": {
            const info = await sysSentinel(api.cpu(), "system.cpu");
            return info;
          }
          case "permission": {
            const perms = await api.permissions();
            if (perms === null) {
              throw toolError("proto.unsupported", "chrome.permissions is not available on this Chrome build");
            }
            return { memory: perms.memory === true, cpu: perms.cpu === true };
          }
          default:
            throw toolError("proto.invalid", "browser.system args.action must be memory|cpu|permission");
        }
      }
      case "browser.processes": {
        // chrome.processes — task-manager inventory. Optional
        // "processes" permission checked per call in index.ts.
        if (!deps.processes) {
          throw toolError("proto.unsupported", "process inventory is not available on this host");
        }
        const api = deps.processes;
        const action = str(args.action) ?? "list";
        const procSentinel = async <T>(v: Promise<T | "permission" | null>): Promise<T> => {
          const r = await v;
          if (r === "permission") {
            throw toolError("proto.unsupported", "processes permission is not granted");
          }
          if (r === null) {
            throw toolError("proto.unsupported", "chrome.processes is not available on this Chrome build");
          }
          return r as T;
        };
        switch (action) {
          case "list": {
            const procs = await procSentinel(api.list());
            return { processes: procs, count: procs.length };
          }
          case "terminate": {
            // Renderer-kill recovery path: look the process up first so
            // non-renderer types (browser/gpu/utility/…) are refused
            // honestly instead of crashing Chrome. chrome.processes
            // .terminate only accepts renderer pids, but the pre-flight
            // check gives a typed error and guards API drift.
            if (!api.info || !api.terminate) {
              throw toolError("proto.unsupported", "process terminate is not available on this host");
            }
            const pid = args.processId;
            if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 0) {
              throw toolError("proto.invalid", "browser.processes terminate requires args.processId (integer ≥ 0 — the Process.id from list, not osProcessId)");
            }
            const info = await api.info(pid);
            if (info === "permission") {
              throw toolError("proto.unsupported", "processes permission is not granted");
            }
            if (info === "unavailable") {
              throw toolError("proto.unsupported", "chrome.processes is not available on this Chrome build");
            }
            if (info === null) {
              throw toolError("browser.action_failed", `process ${pid} not found`);
            }
            if (info.type !== "renderer") {
              throw toolError("proto.invalid", `browser.processes terminate only supports renderer processes — pid ${pid} is type '${info.type}'`);
            }
            const term = await api.terminate(pid);
            if (term === "permission") {
              throw toolError("proto.unsupported", "processes permission is not granted");
            }
            if (term === "unavailable" || term === null) {
              throw toolError("proto.unsupported", "chrome.processes is not available on this Chrome build");
            }
            return { terminated: true, processId: pid, type: info.type };
          }
          case "permission": {
            const p = await api.permission();
            if (p === "permission") {
              return { permission: "not_granted", granted: false };
            }
            if (p === null) {
              throw toolError("proto.unsupported", "chrome.processes is not available on this Chrome build");
            }
            return { permission: p, granted: p === "granted" };
          }
          default:
            throw toolError("proto.invalid", "browser.processes args.action must be list|terminate|permission");
        }
      }
      case "browser.dns": {
        // chrome.dns — hostname resolution. Optional "dns" permission
        // checked per call in index.ts; resolution failures surface
        // in-band as resolved:false, not protocol errors.
        if (!deps.dns) {
          throw toolError("proto.unsupported", "dns resolution is not available on this host");
        }
        const api = deps.dns;
        const action = str(args.action) ?? "resolve";
        const dnsSentinel = async <T>(v: Promise<T | "permission" | null>): Promise<T> => {
          const r = await v;
          if (r === "permission") {
            throw toolError("proto.unsupported", "dns permission is not granted");
          }
          if (r === null) {
            throw toolError("proto.unsupported", "chrome.dns is not available on this Chrome build");
          }
          return r as T;
        };
        switch (action) {
          case "resolve": {
            const hostname = str(args.hostname);
            if (
              hostname === undefined ||
              hostname.length < 1 ||
              hostname.length > 253 ||
              !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(hostname)
            ) {
              throw toolError(
                "proto.invalid",
                "browser.dns args.hostname must be 1-253 chars of [a-zA-Z0-9._-] starting alphanumeric",
              );
            }
            const out = await dnsSentinel(api.resolve(hostname));
            return out;
          }
          case "permission": {
            const p = await api.permission();
            if (p === "permission") {
              return { permission: "not_granted", granted: false };
            }
            if (p === null) {
              throw toolError("proto.unsupported", "chrome.dns is not available on this Chrome build");
            }
            return { permission: p, granted: p === "granted" };
          }
          default:
            throw toolError("proto.invalid", "browser.dns args.action must be resolve|permission");
        }
      }
      case "browser.power": {
        // chrome.power — keep-awake assertions. Optional "power"
        // permission checked per call in index.ts.
        if (!deps.power) {
          throw toolError("proto.unsupported", "power management is not available on this host");
        }
        const api = deps.power;
        const action = str(args.action) ?? "request";
        const powerSentinel = async <T>(v: Promise<T | "permission" | null>): Promise<T> => {
          const r = await v;
          if (r === "permission") {
            throw toolError("proto.unsupported", "power permission is not granted");
          }
          if (r === null) {
            throw toolError("proto.unsupported", "chrome.power is not available on this Chrome build");
          }
          return r as T;
        };
        switch (action) {
          case "request": {
            const level = str(args.level) ?? "system";
            if (level !== "system" && level !== "display") {
              throw toolError("proto.invalid", "browser.power args.level must be system|display");
            }
            return powerSentinel(api.request(level));
          }
          case "release":
            return powerSentinel(api.release());
          case "permission": {
            const p = await api.permission();
            if (p === "permission") {
              return { permission: "not_granted", granted: false };
            }
            if (p === null) {
              throw toolError("proto.unsupported", "chrome.power is not available on this Chrome build");
            }
            return { permission: p, granted: p === "granted" };
          }
          default:
            throw toolError("proto.invalid", "browser.power args.action must be request|release|permission");
        }
      }
      case "browser.runtime": {
        // chrome.runtime host introspection — always available on the
        // extension backend, no permission gate.
        if (!deps.runtime) {
          throw toolError("proto.unsupported", "runtime info is not available on this host");
        }
        const action = str(args.action) ?? "info";
        if (action !== "info") {
          throw toolError("proto.invalid", "browser.runtime args.action must be info");
        }
        return deps.runtime.info();
      }
      case "browser.permissions": {
        // chrome.permissions — optional-permission lifecycle. Not
        // tab-scoped. request/remove are approval-gated upstream;
        // args are validated against the manifest's optional set
        // BEFORE any Chrome call so an invalid name can never pop a
        // prompt.
        if (!deps.permissions) {
          throw toolError("proto.unsupported", "permission management is not available on this host");
        }
        const api = deps.permissions;
        const action = str(args.action) ?? "getAll";
        if (action !== "getAll" && action !== "contains" && action !== "request" && action !== "remove") {
          throw toolError("proto.invalid", "browser.permissions args.action must be getAll|contains|request|remove");
        }
        if (args.origins !== undefined) {
          throw toolError("proto.invalid", "browser.permissions does not support args.origins — host-origin grants are a different class");
        }
        const optional = new Set(api.optionalPermissions());
        const parsePerms = (): string[] => {
          const raw = args.permissions;
          if (!Array.isArray(raw) || raw.length === 0 || raw.length > 32) {
            throw toolError("proto.invalid", "browser.permissions args.permissions must be a non-empty array (≤32)");
          }
          const names: string[] = [];
          for (const p of raw) {
            if (typeof p !== "string" || !/^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/.test(p)) {
              throw toolError("proto.invalid", `browser.permissions args.permissions entries must be permission names — got ${JSON.stringify(p).slice(0, 60)}`);
            }
            if (!optional.has(p)) {
              throw toolError("proto.invalid", `browser.permissions '${p}' is not an optional permission of this extension`);
            }
            names.push(p);
          }
          return [...new Set(names)];
        };
        const callOrUnsupported = async <T>(v: Promise<T | null>): Promise<T> => {
          const r = await v;
          if (r === null) {
            throw toolError("proto.unsupported", "chrome.permissions is not available on this Chrome build");
          }
          return r;
        };
        switch (action) {
          case "getAll": {
            const all = await callOrUnsupported(api.getAll());
            return {
              permissions: Array.isArray(all?.permissions) ? all.permissions.slice(0, 200) : [],
              origins: Array.isArray(all?.origins) ? all.origins.slice(0, 200) : [],
            };
          }
          case "contains": {
            const perms = parsePerms();
            const granted = await callOrUnsupported(api.contains(perms));
            return { granted, permissions: perms };
          }
          case "request": {
            const perms = parsePerms();
            const granted = await callOrUnsupported(api.request(perms));
            return { granted, permissions: perms };
          }
          case "remove": {
            const perms = parsePerms();
            const removed = await callOrUnsupported(api.remove(perms));
            return { removed, permissions: perms };
          }
        }
      }
      case "browser.clipboard.get":
      case "browser.clipboard.set": {
        // System clipboard — browser-global, not tab-scoped. The dep
        // enforces the optional permission (clipboardRead for get,
        // clipboardWrite for set) and surfaces proto.unsupported with
        // a browser.permissions hint when ungranted.
        if (!deps.clipboard) {
          throw toolError("proto.unsupported", "clipboard access is not available on this host");
        }
        if (tool === "browser.clipboard.get") {
          const r = await deps.clipboard.get();
          if (r === null) {
            throw toolError("proto.unsupported", "clipboard read unavailable — grant the optional 'clipboardRead' permission via browser.permissions request first");
          }
          return { text: r.text };
        }
        const text = args.text;
        if (typeof text !== "string" || text.length === 0 || text.length > 256 * 1024) {
          throw toolError("proto.invalid", "browser.clipboard.set requires args.text (1-262144 chars)");
        }
        const wrote = await deps.clipboard.set(text);
        if (!wrote) {
          throw toolError("proto.unsupported", "clipboard write unavailable — grant the optional 'clipboardWrite' permission via browser.permissions request first");
        }
        return { ok: true, chars: text.length };
      }
      case "browser.action": {
        // chrome.action badge/title — the agent's always-visible status
        // channel on the toolbar icon. Not tab-scoped. get reads the
        // LIVE display values (attention count may override agent
        // text); set/clear write the agent badge which the host merges
        // under the attention count.
        if (!deps.actionBadge) {
          throw toolError("proto.unsupported", "action badge control is not available on this host");
        }
        const api = deps.actionBadge;
        const action = str(args.action) ?? "get";
        if (action !== "get" && action !== "set" && action !== "clear") {
          throw toolError("proto.invalid", "browser.action args.action must be get|set|clear");
        }
        if (action === "get") {
          const cur = await api.get();
          return { text: cur.text, title: cur.title };
        }
        if (action === "clear") {
          await api.set(null);
          return { cleared: true };
        }
        const text = args.text;
        if (typeof text !== "string" || text.length === 0 || text.length > 32) {
          throw toolError("proto.invalid", "browser.action set requires args.text (1-32 chars)");
        }
        let color: string | undefined;
        if (args.color !== undefined && args.color !== null) {
          if (typeof args.color !== "string" || !/^#[0-9a-fA-F]{6}$/.test(args.color)) {
            throw toolError("proto.invalid", "browser.action args.color must be #rrggbb");
          }
          color = args.color;
        }
        let title: string | undefined;
        if (args.title !== undefined && args.title !== null) {
          if (typeof args.title !== "string" || args.title.length > 128) {
            throw toolError("proto.invalid", "browser.action args.title must be ≤128 chars");
          }
          title = args.title;
        }
        const ownerTaskId = typeof req.taskId === "string" && req.taskId ? req.taskId : undefined;
        await api.set({ text, ...(color ? { color } : {}), ...(title !== undefined ? { title } : {}) }, ownerTaskId);
        return { set: true, text, ...(color ? { color } : {}), ...(title !== undefined ? { title } : {}), ...(ownerTaskId ? { ownerTaskId } : {}) };
      }
      case "browser.windows.list": {
        // Not tab-scoped: chrome.windows.getAll across normal windows.
        if (!deps.listWindows) {
          throw toolError("proto.unsupported", "window listing is not available on this host");
        }
        const windows = await deps.listWindows();
        return {
          windows: (Array.isArray(windows) ? windows : [])
            .filter((w) => w.id !== undefined)
            .map(sanitizeWindowInfo),
        };
      }
      case "browser.windows.get": {
        // Single-window chrome state — windowId from windows.list, or
        // lastFocused:true → the window the user is looking at
        // (deliverable-surfacing target). No tab payloads → no egress.
        const lastFocused = args.lastFocused === true;
        const windowId = args.windowId;
        if (lastFocused) {
          if (!deps.getLastFocusedWindow) {
            throw toolError("proto.unsupported", "window focus query is not available on this host");
          }
          if (windowId !== undefined) {
            throw toolError("proto.invalid", "browser.windows.get takes args.windowId OR args.lastFocused, not both");
          }
          const win = await deps.getLastFocusedWindow();
          if (!win || win.id === undefined) {
            throw toolError("proto.unsupported", "no focused window reported by the browser");
          }
          return { window: sanitizeWindowInfo(win), lastFocused: true };
        }
        if (typeof windowId !== "number" || !Number.isInteger(windowId) || windowId < 0) {
          throw toolError("proto.invalid", "browser.windows.get requires args.windowId (integer) or args.lastFocused:true");
        }
        if (!deps.getWindow) {
          throw toolError("proto.unsupported", "window lookup is not available on this host");
        }
        const win = await deps.getWindow(windowId);
        if (!win || win.id === undefined) {
          throw toolError("browser.action_failed", `window ${windowId} not found`);
        }
        return { window: sanitizeWindowInfo(win) };
      }
      case "browser.windows.create": {
        // Not tab-scoped: opens a new browser window. http(s)/blank
        // only — same egress model as tab.create.
        if (!deps.createWindow) {
          throw toolError("proto.unsupported", "window creation is not available on this host");
        }
        const rawUrl = str(args.url);
        let url: string | undefined;
        if (rawUrl) {
          let parsed: URL;
          try {
            parsed = new URL(rawUrl);
          } catch {
            throw toolError("proto.invalid", "browser.windows.create args.url is not a valid URL");
          }
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            throw toolError("proto.invalid", "browser.windows.create only supports http(s) urls");
          }
          url = parsed.href;
        }
        const state = str(args.state);
        if (state !== undefined && !["normal", "minimized", "maximized", "fullscreen"].includes(state)) {
          throw toolError("proto.invalid", "browser.windows.create args.state must be normal|minimized|maximized|fullscreen");
        }
        const type = str(args.type);
        if (type !== undefined && !["normal", "popup"].includes(type)) {
          throw toolError("proto.invalid", "browser.windows.create args.type must be normal|popup");
        }
        const numArg = (key: string): number | undefined => {
          const v = args[key];
          return typeof v === "number" && Number.isFinite(v) ? v : undefined;
        };
        const win = await deps.createWindow({
          ...(url ? { url } : {}),
          ...(type ? { type } : {}),
          ...(typeof args.focused === "boolean" ? { focused: args.focused } : {}),
          ...(numArg("width") !== undefined ? { width: numArg("width") } : {}),
          ...(numArg("height") !== undefined ? { height: numArg("height") } : {}),
          ...(numArg("left") !== undefined ? { left: numArg("left") } : {}),
          ...(numArg("top") !== undefined ? { top: numArg("top") } : {}),
          ...(state ? { state } : {}),
        });
        if (typeof win?.id !== "number") {
          throw toolError("browser.action_failed", "chrome.windows.create returned no window id");
        }
        // Surface the window's tabs (sanitized urls) so the agent can
        // address them — first tab also enters task scope via
        // openedTabId like tab.create.
        const tabs = (Array.isArray(win.tabs) ? win.tabs : [])
          .filter((t) => typeof t.id === "number")
          .map((t) => {
            let safeUrl = "";
            try {
              const u = new URL(t.url ?? "about:blank");
              safeUrl = `${u.origin}${u.pathname}`;
            } catch {
              safeUrl = "";
            }
            return {
              id: t.id,
              url: safeUrl,
              title: t.title ?? "",
              active: t.active === true,
            };
          });
        const firstTabId = tabs[0]?.id;
        return {
          windowId: win.id,
          id: win.id,
          focused: win.focused === true,
          state: win.state ?? state ?? "normal",
          type: win.type ?? type ?? "normal",
          tabs,
          ...(typeof firstTabId === "number" ? { openedTabId: firstTabId, tabId: firstTabId, resolvedTabId: firstTabId } : {}),
        };
      }
      case "browser.windows.update": {
        // Not tab-scoped: focus/state/bounds on an existing window.
        if (!deps.updateWindow) {
          throw toolError("proto.unsupported", "window update is not available on this host");
        }
        const windowId = args.windowId;
        if (typeof windowId !== "number" || !Number.isInteger(windowId)) {
          throw toolError("proto.invalid", "browser.windows.update requires integer args.windowId");
        }
        const focused = typeof args.focused === "boolean" ? args.focused : undefined;
        const state = str(args.state);
        if (state !== undefined && !["normal", "minimized", "maximized", "fullscreen"].includes(state)) {
          throw toolError("proto.invalid", "browser.windows.update args.state must be normal|minimized|maximized|fullscreen");
        }
        const boundArg = (key: string, min: number): number | undefined => {
          const v = args[key];
          if (v === undefined) return undefined;
          if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
            throw toolError("proto.invalid", `browser.windows.update args.${key} must be a finite number >= ${min}`);
          }
          return v;
        };
        const left = boundArg("left", -32768);
        const top = boundArg("top", -32768);
        const width = boundArg("width", 1);
        const height = boundArg("height", 1);
        const drawAttention = typeof args.drawAttention === "boolean" ? args.drawAttention : undefined;
        if (args.drawAttention !== undefined && drawAttention === undefined) {
          throw toolError("proto.invalid", "browser.windows.update args.drawAttention must be a boolean");
        }
        if (focused === undefined && state === undefined && left === undefined && top === undefined && width === undefined && height === undefined && drawAttention === undefined) {
          throw toolError("proto.invalid", "browser.windows.update requires at least one of focused|state|left|top|width|height|drawAttention");
        }
        await deps.updateWindow(windowId, {
          ...(focused !== undefined ? { focused } : {}),
          ...(state ? { state } : {}),
          ...(left !== undefined ? { left } : {}),
          ...(top !== undefined ? { top } : {}),
          ...(width !== undefined ? { width } : {}),
          ...(height !== undefined ? { height } : {}),
          ...(drawAttention !== undefined ? { drawAttention } : {}),
        });
        return { updated: windowId };
      }
      case "browser.windows.remove": {
        // Not tab-scoped: closes the window AND every tab inside it —
        // blast radius is tab.close × N, so risk classification keeps
        // it approval-gated and never task-eligible. Absent on headless
        // (window teardown crashes the browser there).
        if (!deps.removeWindow) {
          throw toolError("proto.unsupported", "window remove is not available on this host");
        }
        const windowId = args.windowId;
        if (typeof windowId !== "number" || !Number.isInteger(windowId)) {
          throw toolError("proto.invalid", "browser.windows.remove requires integer args.windowId");
        }
        const res = await deps.removeWindow(windowId);
        return typeof res === "object" && res !== null ? res : { removed: windowId };
      }
      case "browser.page.network": {
        // Requests span frames — args.frameId filters to requests a
        // specific frame initiated (webRequest details.frameId).
        // Metadata only: status/mime/size, never response bodies.
        if (!deps.listNetworkRequests) {
          throw toolError("proto.unsupported", "network log requires the webRequest permission");
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const frameFilter = frameIdArg(args);
        const limit =
          typeof args.limit === "number" && Number.isFinite(args.limit)
            ? Math.min(Math.max(Math.floor(args.limit), 1), 200)
            : 50;
        const status = str(args.status);
        if (status !== undefined && status !== "error" && !/^[245]xx$/.test(status)) {
          throw toolError("proto.invalid", "browser.page.network args.status must be error|2xx|4xx|5xx");
        }
        const urlContains = str(args.urlContains);
        const type = str(args.type);
        const entries = deps.listNetworkRequests(tabId, {
          limit,
          ...(urlContains ? { urlContains } : {}),
          ...(type ? { type } : {}),
          ...(status ? { status } : {}),
          // only filter when the caller asked — frameIdArg defaults to 0
          // and an always-on filter would drop non-frame requests.
          ...(args.frameId !== undefined && args.frameId !== null ? { frameId: frameFilter } : {}),
        });
        return {
          requests: (Array.isArray(entries) ? entries : []).map((e) => ({
            method: e.method ?? "",
            url: e.url ?? "",
            type: e.type ?? "",
            ...(typeof e.status === "number" ? { status: e.status } : {}),
            ...(e.error ? { error: e.error } : {}),
            ...(e.mimeType ? { mimeType: e.mimeType } : {}),
            ...(typeof e.frameId === "number" ? { frameId: e.frameId } : {}),
            ts: e.ts ?? 0,
          })),
          resolvedTabId: tabId,
        };
      }
      case "browser.page.screenshot": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const hasElementTarget =
          str(args.ref) !== undefined || str(args.selector) !== undefined || str(args.label) !== undefined;
        const fullPage = args.fullPage === true;
        if (args.fullPage !== undefined && typeof args.fullPage !== "boolean") {
          throw toolError("proto.invalid", "browser.page.screenshot args.fullPage must be a boolean");
        }
        if (fullPage && hasElementTarget) {
          throw toolError("proto.invalid", "args.fullPage cannot combine with an element target (ref/selector/label)");
        }
        let shot: { mimeType: string; dataBase64: string };
        if (hasElementTarget) {
          // Element clip via CDP Page.captureScreenshot — works on
          // chrome-extension only; subframe targets resolve through the
          // geometry chain. Element is scrolled into view first.
          shot = await captureElementScreenshot(deps, tabId, args, frameIdArg(args));
        } else if (fullPage) {
          if (frameIdArg(args) !== 0) {
            throw toolError("proto.invalid", "args.frameId is not supported with args.fullPage");
          }
          shot = await captureFullPageScreenshot(deps, tabId);
        } else {
          if (frameIdArg(args) !== 0) {
            // whole-tab capture is frame-agnostic — refuse rather than
            // silently ignore the scope the caller asked for
            throw toolError("proto.invalid", "args.frameId requires an element target (ref/selector/label) on browser.page.screenshot");
          }
          const tab = await deps.getTab(tabId);
          if (typeof tab?.windowId !== "number") {
            throw toolError("browser.no_tab", `tab ${tabId} has no window`);
          }
          if (tab.active === true) {
            if (!deps.captureVisibleTab) {
              throw toolError("proto.unsupported", "screenshot capture is not available on this host");
            }
            // chromex-22wi: the artifact store caps uploads at 512KiB decoded
            // (gateway artifact.upload). Retry at lower jpeg quality until
            // the capture fits — the same bytes are returned inline as
            // dataBase64 so the provider receives image input, not just a
            // reference it cannot resolve. Bounded egress: the tool is
            // already classified agentEgress "screenshot" upstream.
            shot = await captureScreenshotWithinArtifactCap(deps.captureVisibleTab, tab.windowId);
          } else {
            // captureVisibleTab(windowId) captures the window's ACTIVE
            // tab — for a background tab that silently returns ANOTHER
            // tab's pixels. CDP captures this tab's own target instead.
            shot = await captureViewportScreenshot(deps, tabId);
          }
        }
        if (!deps.uploadArtifact) {
          // no artifact channel → the durable artifactRef cannot be
          // minted; the bounded inline payload alone is not enough —
          // fail honestly rather than silently degrade the contract.
          throw toolError("proto.unsupported", "artifact upload channel unavailable");
        }
        const art = await deps.uploadArtifact({
          taskId: req.taskId ?? "",
          kind: "screenshot",
          mimeType: shot.mimeType,
          dataBase64: shot.dataBase64,
        });
        return {
          artifactRef: art.artifactRef,
          sha256: art.sha256,
          bytes: art.bytes,
          mimeType: shot.mimeType,
          dataBase64: shot.dataBase64,
          resolvedTabId: tabId,
        };
      }
      case "browser.page.extract": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const frameId = frameIdArg(args);
        const maxChars = typeof args.maxChars === "number" ? Math.min(args.maxChars, 50_000) : 12_000;
        const format = str(args.format);
        if (format !== undefined && format !== "text" && format !== "html") {
          throw toolError("proto.invalid", "browser.page.extract args.format must be text|html");
        }
        const extractMsg = {
          type: "page.extract",
          maxChars,
          ...(str(args.selector) ? { selector: str(args.selector) } : {}),
          ...(format ? { format } : {}),
        };
        // Unscoped extract reads EVERY frame — text inside same-process
        // and cross-origin subframes is page content too. Sections are
        // joined with `--- frame <id>: <url> ---` markers (same honesty
        // contract as the aria snapshot's Iframe markers); the merged
        // text keeps the maxChars cap, so narrow with args.frameId for
        // one frame's full text. Explicit frameId stays single-frame.
        if (args.frameId === undefined || args.frameId === null) {
          const fids = await consoleFrameIds(deps, tabId);
          if (fids !== undefined && fids.length > 1) {
            const sections: string[] = [];
            let truncated = false;
            let url = "";
            let title = "";
            let framesOk = 0;
            for (const fid of fids.slice(0, CONSOLE_MERGE_FRAME_CAP)) {
              const r = (await deps.sendToTab(tabId, extractMsg, { frameId: fid }).catch(() => undefined)) as
                | { text?: string; truncated?: boolean; url?: string; title?: string; error?: string }
                | undefined;
              if (!r || typeof r.text !== "string") continue;
              framesOk += 1;
              if (!url) {
                url = r.url ?? "";
                title = r.title ?? "";
              }
              truncated = truncated || r.truncated === true;
              sections.push(`--- frame ${fid}: ${urlOriginPath(r.url ?? "")} ---\n${r.text}`);
            }
            if (framesOk > 0) {
              let merged = sections.join("\n");
              if (merged.length > maxChars) {
                merged = merged.slice(0, maxChars);
                truncated = true;
              }
              return {
                text: merged,
                truncated,
                url: urlOriginPath(url),
                title,
                frames: framesOk,
                resolvedTabId: tabId,
              };
            }
          }
        }
        const res = (await deps.sendToTab(tabId, extractMsg, { frameId })) as { text?: string; truncated?: boolean; url?: string; title?: string; error?: string };
        return {
          text: res.text ?? "",
          truncated: res.truncated === true,
          url: res.url ? urlOriginPath(res.url) : "",
          title: res.title ?? "",
          ...(res.error ? { error: res.error } : {}),
          resolvedTabId: tabId,
        };
      }
      default: {
        // DOM action tools → single page.dom.perform step
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const frameId = frameIdArg(args);
        const snapId = str(args.snapshotId);
        if (snapId) {
          const meta = snapshotRegistry.get(snapId);
          // chromex-9e3: snapshots are bound to (taskId, tabId) — a
          // snapshot created under another task must not resolve even
          // on the same tab.
          if (meta && meta.taskId !== req.taskId) {
            throw toolError(
              "browser.not_in_scope",
              "snapshot belongs to another task; call browser.page.snapshot again",
            );
          }
          if (!meta || meta.tabId !== tabId) {
            throw toolError(
              "browser.stale_snapshot",
              "snapshot expired or belongs to another tab; call browser.page.snapshot again",
            );
          }
          // Refs live in the frame that minted them — a snapshot from
          // frame 3 cannot drive actions in the top frame.
          if ((meta.frameId ?? 0) !== frameId) {
            throw toolError(
              "browser.stale_snapshot",
              "snapshot was captured in a different frame; call browser.page.snapshot with the same args.frameId",
            );
          }
          if (meta.urlOriginPath) {
            // The stored origin+path is the FRAME's url at capture
            // (content scripts report their own location.href). For
            // frameId 0 that's the tab url; for subframes resolve the
            // frame's current url via webNavigation — comparing a frame
            // url against the tab url would false-positive "navigated".
            let current: string | null = null;
            if (frameId === 0) {
              const tab = await deps.getTab(tabId);
              current = typeof tab?.url === "string" && tab.url ? urlOriginPath(tab.url) : null;
            } else if (deps.listFrames) {
              const frame = (await deps.listFrames(tabId)).find((f) => f.frameId === frameId);
              current = frame?.url ? urlOriginPath(frame.url) : null;
            }
            if (current && current !== meta.urlOriginPath) {
              throw toolError("browser.navigated", "page navigated since the snapshot; call browser.page.snapshot again");
            }
          }
        }
        // chromex-0fza: validate args.expect BEFORE dispatch — a
        // malformed expectation must not run the action and then fail.
        const expectCond = parseExpectCondition(args.expect);
        // CDP tier: args.trusted switches dispatch from the content
        // script (isTrusted=false) to CDP Input.* (isTrusted=true).
        // Element targets inside subframes are converted to absolute
        // viewport coords via DOM.getContentQuads. Never silently
        // downgrades — absent CDP dep fails proto.unsupported.
        // pierce refs (pz-N from browser.page.pierce) can ONLY dispatch
        // via CDP — auto-route them to the trusted path even without
        // args.trusted, since no untrusted path exists for closed
        // shadow roots. There is no silent downgrade: the result still
        // reports trusted:true honestly.
        const pierceRefTarget =
          typeof args.ref === "string" && PIERCE_REF_RE.test(args.ref);
        const pierceClick = tool === "browser.page.click" && pierceRefTarget;
        if (tool === "browser.page.click" && (args.trusted === true || pierceClick)) {
          return await trustedClick(deps, tabId, args, expectCond, frameId, expectedTarget);
        }
        const pierceHover = tool === "browser.page.hover" && pierceRefTarget;
        if (tool === "browser.page.hover" && (args.trusted === true || pierceHover)) {
          return await trustedHover(deps, tabId, args, expectCond, frameId, expectedTarget);
        }
        // Keyboard trusted ops work in subframes too: the element is
        // focused through that frame's content script and CDP key
        // events follow the focused frame. Pointer ops also work in
        // subframes — element targets resolve to absolute viewport
        // coordinates via CDP DOM quads before dispatch.
        if (tool === "browser.page.press" && (args.trusted === true || pierceRefTarget)) {
          const startedAt = Date.now();
          const res = await trustedPress(deps, tabId, args, expectCond, frameId, expectedTarget);
          const openedTabs = await collectOpenedTabs(deps, tabId, startedAt);
          return openedTabs.length > 0 ? { ...res, openedTabs } : res;
        }
        // Enter inside type/fill text submits forms — a target=_blank
        // form or JS handler can open a popup, so collect openedTabs
        // only when the text can produce a newline. Hover cannot click;
        // drag drop handlers can window.open — always collect there.
        if (tool === "browser.page.type" && (args.trusted === true || pierceRefTarget)) {
          const startedAt = Date.now();
          const res = await trustedType(deps, tabId, args, expectCond, frameId, expectedTarget);
          const maySubmit = String(args.text ?? args.value ?? "").includes("\n");
          const openedTabs = maySubmit ? await collectOpenedTabs(deps, tabId, startedAt) : [];
          return openedTabs.length > 0 ? { ...res, openedTabs } : res;
        }
        if (tool === "browser.page.fill" && (args.trusted === true || pierceRefTarget)) {
          const startedAt = Date.now();
          const res = await trustedFill(deps, tabId, args, expectCond, frameId, expectedTarget);
          const maySubmit = String(args.text ?? args.value ?? "").includes("\n");
          const openedTabs = maySubmit ? await collectOpenedTabs(deps, tabId, startedAt) : [];
          return openedTabs.length > 0 ? { ...res, openedTabs } : res;
        }
        if (tool === "browser.page.hover" && args.trusted === true) {
          return await trustedHover(deps, tabId, args, expectCond, frameId, expectedTarget);
        }
        const pierceDragRef =
          tool === "browser.page.drag" &&
          (pierceRefTarget ||
            (typeof args.toRef === "string" && PIERCE_REF_RE.test(args.toRef)));
        if (tool === "browser.page.drag" && (args.trusted === true || pierceDragRef)) {
          const startedAt = Date.now();
          const res = await trustedDrag(deps, tabId, args, expectCond, frameId, expectedTarget);
          const openedTabs = await collectOpenedTabs(deps, tabId, startedAt);
          return openedTabs.length > 0 ? { ...res, openedTabs } : res;
        }
        // Trusted wheel scroll — real wheel events for infinite-scroll
        // and wheel-gated pages. Page-level only (see trustedScroll).
        if (tool === "browser.page.scroll" && args.trusted === true) {
          return await trustedScroll(deps, tabId, args, expectCond, frameId);
        }
        // args.trusted is a CDP-tier opt-in — never silently ignored on
        // tools that have no trusted path.
        if (args.trusted === true) {
          throw toolError(
            "proto.unsupported",
            `args.trusted is not supported for ${tool} (trusted input exists only for click, press, type, fill, hover, drag and scroll)`,
          );
        }
        // pz refs can't reach the content-script select path — route to
        // the CDP node-scoped equivalent instead.
        if (tool === "browser.page.select" && pierceRefTarget) {
          return await pierceSelect(deps, tabId, args, expectCond, frameId);
        }
        // Same for focus/submit — closed roots have no content-script
        // path; DOM.focus + node-scoped requestSubmit mirror the
        // content-script semantics (submitter preservation included).
        if ((tool === "browser.page.focus" || tool === "browser.page.submit") && pierceRefTarget) {
          return await pierceFocusSubmit(deps, tabId, tool, args, expectCond, frameId, expectedTarget);
        }
        // Element scroll inside a closed root — same node-scoped
        // scrollBy the content script performs, minus the content
        // script that can't see the node. (trusted scroll stays
        // page-level and refuses element targets above.)
        if (tool === "browser.page.scroll" && pierceRefTarget) {
          return await pierceScroll(deps, tabId, args, expectCond, frameId);
        }
        const step = domStepFor(tool, args);
        if (expectedTarget) step.expectedTarget = expectedTarget;
        const actionDispatchedAt = Date.now();
        const result = (await deps.sendToTab(tabId, {
          type: "page.dom.perform",
          steps: [step],
        }, { frameId })) as BrowserDomActionResult;
        const first = result.results?.[0];
        if (!result.ok || first?.ok === false) {
          const code = typeof first?.code === "string" && first.code.startsWith("browser.") ? first.code : "browser.action_failed";
          throw toolError(code, first?.message ?? result.summary ?? "browser action failed");
        }
        // chromex-0fza: optional args.expect postcondition — poll the
        // content script briefly (same machinery as browser.page.wait)
        // and let the explicit expectation override the generic
        // before/after verdict: met → true, timed out → false,
        // unreachable → keep the step verdict / "unknown".
        let verified = first?.verified;
        let expectInfo: { met: boolean | "unknown"; elapsedMs?: number } | undefined;
        if (expectCond) {
          const check = await runExpectCondition(deps, tabId, expectCond, frameId);
          expectInfo = check;
          if (check.met === true) verified = true;
          else if (check.met === false) verified = false;
          else verified = verified ?? "unknown";
        }
        const openedTabs =
          tool === "browser.page.click" ||
          tool === "browser.page.submit" ||
          tool === "browser.page.press"
            ? await collectOpenedTabs(deps, tabId, actionDispatchedAt)
            : [];
        return {
          ok: true,
          summary: result.summary,
          step: first,
          ...(verified !== undefined ? { verified } : {}),
          ...(expectInfo ? { expect: expectInfo } : {}),
          ...(openedTabs.length > 0 ? { openedTabs } : {}),
          resolvedTabId: tabId,
        };
      }
    }
  };

  // Tab-close cleanup for the closure-held CDP sessions — coverage,
  // metrics and screencast holds would otherwise keep dead-target
  // sessions + stale "running" state forever (cdp.ts drops its state
  // on tabs.onRemoved without consulting these maps). Frames are
  // dropped with the tab — an abandoned recording has no deliverable.
  const disposeTabState = async (tabId: number): Promise<void> => {
    const cov = coverageHolds.get(tabId);
    if (cov) {
      coverageHolds.delete(tabId);
      await cov.release().catch(() => {});
    }
    const met = metricsHolds.get(tabId);
    if (met) {
      metricsHolds.delete(tabId);
      await met.release().catch(() => {});
    }
    const cast = screencastHolds.get(tabId);
    if (cast) {
      screencastHolds.delete(tabId);
      for (const un of cast.unsubs) un();
      await cast.release().catch(() => {});
    }
  };
  handleToolRequest.disposeTab = disposeTabState;
  return handleToolRequest;
}

function domStepFor(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const base = {
    reason: `gateway tool ${tool}`,
    ...(str(args.ref) ? { targetRef: str(args.ref) } : {}),
    ...(str(args.selector) ? { selector: str(args.selector) } : {}),
    ...(str(args.label) ? { label: str(args.label) } : {}),
  };
  switch (tool) {
    case "browser.page.click": {
      const button = str(args.button);
      if (button !== undefined && !["left", "right", "middle"].includes(button)) {
        throw toolError("proto.invalid", "browser.page.click args.button must be left|right|middle");
      }
      const clickCount = typeof args.clickCount === "number" ? args.clickCount : undefined;
      if (clickCount !== undefined && clickCount !== 1 && clickCount !== 2) {
        throw toolError("proto.invalid", "browser.page.click args.clickCount must be 1|2");
      }
      const clickModifiers = Array.isArray(args.modifiers)
        ? args.modifiers.filter((m): m is string => typeof m === "string")
        : undefined;
      const x = typeof args.x === "number" && Number.isFinite(args.x) ? args.x : undefined;
      const y = typeof args.y === "number" && Number.isFinite(args.y) ? args.y : undefined;
      if ((x === undefined) !== (y === undefined)) {
        throw toolError("proto.invalid", "browser.page.click args.x and args.y must be provided together");
      }
      if (x !== undefined && (x < 0 || y! < 0)) {
        throw toolError("proto.invalid", "browser.page.click coordinates must be non-negative viewport pixels");
      }
      if (x !== undefined && (str(args.ref) || str(args.selector) || str(args.label))) {
        throw toolError("proto.invalid", "browser.page.click accepts coordinates or an element target, not both");
      }
      return {
        ...base,
        action: "click",
        ...(button && button !== "left" ? { button } : {}),
        ...(clickCount === 2 ? { clickCount: 2 } : {}),
        ...(clickModifiers && clickModifiers.length > 0 ? { modifiers: clickModifiers } : {}),
        ...(x !== undefined ? { x, y: y! } : {}),
      };
    }
    case "browser.page.focus":
      return { ...base, action: "focus" };
    case "browser.page.fill":
      return { ...base, action: "fill", value: typeof args.text === "string" ? args.text : typeof args.value === "string" ? args.value : "" };
    case "browser.page.type":
      // Real append semantics (parity with playwright pressSequentially)
      // — NOT fill: type inserts char-by-char at the caret/end and does
      // not clear existing content.
      return { ...base, action: "type", value: typeof args.text === "string" ? args.text : typeof args.value === "string" ? args.value : "" };
    case "browser.page.select": {
      const values = Array.isArray(args.values)
        ? args.values.filter((v): v is string => typeof v === "string" && v.length > 0)
        : undefined;
      if (values && values.length === 0) {
        throw toolError("proto.invalid", "browser.page.select args.values must contain at least one string");
      }
      if (values && values.length > 0 && str(args.value) !== undefined) {
        throw toolError("proto.invalid", "browser.page.select accepts value or values, not both");
      }
      return {
        ...base,
        action: "select",
        value: typeof args.value === "string" ? args.value : "",
        ...(values ? { values } : {}),
      };
    }
    case "browser.page.submit":
      return { ...base, action: "submit" };
    case "browser.page.hover": {
      const hx = typeof args.x === "number" && Number.isFinite(args.x) ? args.x : undefined;
      const hy = typeof args.y === "number" && Number.isFinite(args.y) ? args.y : undefined;
      if ((hx === undefined) !== (hy === undefined)) {
        throw toolError("proto.invalid", "browser.page.hover args.x and args.y must be provided together");
      }
      if (hx !== undefined && (hx < 0 || hy! < 0)) {
        throw toolError("proto.invalid", "browser.page.hover coordinates must be non-negative viewport pixels");
      }
      if (hx !== undefined && (str(args.ref) || str(args.selector) || str(args.label))) {
        throw toolError("proto.invalid", "browser.page.hover accepts coordinates or an element target, not both");
      }
      return {
        ...base,
        action: "hover",
        ...(hx !== undefined ? { x: hx, y: hy! } : {}),
      };
    }
    case "browser.page.press": {
      const key = str(args.key);
      if (!key) throw toolError("proto.invalid", "browser.page.press requires args.key");
      const modifiers = Array.isArray(args.modifiers)
        ? args.modifiers.filter((m): m is string => typeof m === "string")
        : undefined;
      return {
        ...base,
        action: "press",
        key,
        ...(modifiers && modifiers.length > 0 ? { modifiers } : {}),
      };
    }
    case "browser.page.scroll":
      return {
        ...base,
        action: "scroll",
        direction: typeof args.direction === "string" ? args.direction : "down",
        ...(typeof args.amountPx === "number" ? { amountPx: args.amountPx } : {}),
      };
    case "browser.page.drag": {
      // Coordinate form: x,y → dropX,dropY — canvas/surface drags with
      // no DOM source or drop element. Mutually exclusive with every
      // element target field.
      const coordFields = [args.x, args.y, args.dropX, args.dropY];
      const coordCount = coordFields.filter((v) => v !== undefined && v !== null).length;
      if (coordCount > 0) {
        if (coordCount !== 4) {
          throw toolError("proto.invalid", "browser.page.drag coordinate drag requires x, y, dropX and dropY together");
        }
        const coords = coordFields as number[];
        if (coords.some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
          throw toolError("proto.invalid", "browser.page.drag coordinates must be non-negative finite viewport pixels");
        }
        if (str(args.ref) || str(args.selector) || str(args.label) ||
            str(args.toRef) || str(args.toSelector) || str(args.toLabel)) {
          throw toolError("proto.invalid", "browser.page.drag accepts coordinates or element targets, not both");
        }
        return {
          ...base,
          action: "drag",
          x: coords[0], y: coords[1], dropX: coords[2], dropY: coords[3],
        };
      }
      // Source uses the standard target triple; destination uses the
      // toRef/toSelector/toLabel triple. At least one drop field is
      // required — a drag with no destination is a caller bug.
      if (!str(args.toRef) && !str(args.toSelector) && !str(args.toLabel)) {
        throw toolError(
          "proto.invalid",
          "browser.page.drag requires a drop target: toRef, toSelector, or toLabel",
        );
      }
      return {
        ...base,
        action: "drag",
        ...(str(args.toRef) ? { dropTargetRef: str(args.toRef) } : {}),
        ...(str(args.toSelector) ? { dropSelector: str(args.toSelector) } : {}),
        ...(str(args.toLabel) ? { dropLabel: str(args.toLabel) } : {}),
      };
    }
    case "browser.page.navigate": {
      const url = str(args.url);
      if (!url) throw toolError("proto.invalid", "browser.page.navigate requires args.url");
      return { action: "navigate", url, reason: "gateway tool browser.page.navigate" };
    }
    case "browser.page.upload": {
      // Bytes path only: {name,mimeType,base64} files become File objects
      // via DataTransfer in the content script. Local paths / native
      // picker requests still need a REAL user gesture — refused here.
      const files = normalizeUploadFiles(args.files);
      return { ...base, action: "upload", files };
    }
    default:
      throw toolError("proto.unsupported", `no DOM mapping for ${tool}`);
  }
}

/** chromex-0fza: post-action expectation budget — deliberately short;
 *  this is a verification poll, not a wait tool. */
const EXPECT_DEFAULT_TIMEOUT_MS = 2_000;
const EXPECT_MAX_TIMEOUT_MS = 5_000;

/** Parse args.expect into a BrowserExpectCondition. Returns null when
 *  absent or empty; throws proto.invalid on a non-object payload. */
function parseExpectCondition(raw: unknown): BrowserExpectCondition | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw toolError("proto.invalid", "args.expect must be an object {selector?, text?, urlContains?, goneSelector?, timeoutMs?}");
  }
  const o = raw as Record<string, unknown>;
  const selector = str(o.selector);
  const text = str(o.text);
  const urlContains = str(o.urlContains);
  const goneSelector = str(o.goneSelector);
  const readyState = str(o.readyState);
  if (readyState !== undefined && !["loading", "interactive", "complete"].includes(readyState)) {
    throw toolError("proto.invalid", "args.expect.readyState must be loading|interactive|complete");
  }
  const timeoutMs =
    typeof o.timeoutMs === "number" && Number.isFinite(o.timeoutMs)
      ? Math.min(Math.max(Math.floor(o.timeoutMs), 0), EXPECT_MAX_TIMEOUT_MS)
      : undefined;
  const cond: BrowserExpectCondition = {
    ...(selector ? { selector } : {}),
    ...(text ? { text } : {}),
    ...(urlContains ? { urlContains } : {}),
    ...(goneSelector ? { goneSelector } : {}),
    ...(readyState ? { readyState: readyState as "loading" | "interactive" | "complete" } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  return cond.selector || cond.text || cond.urlContains || cond.goneSelector || cond.readyState ? cond : null;
}

/** Poll the content script for the expect conditions via page.dom.wait.
 *  A satisfied poll → met:true; deadline → met:false (the declared
 *  postcondition is absent — honest negative evidence); an
 *  unreachable/failed poll → met:"unknown" (no evidence either way). */
async function runExpectCondition(
  deps: ToolHostDeps,
  tabId: number,
  cond: BrowserExpectCondition,
  frameId = 0,
): Promise<{ met: boolean | "unknown"; elapsedMs?: number }> {
  const timeoutMs = cond.timeoutMs ?? EXPECT_DEFAULT_TIMEOUT_MS;
  try {
    const res = (await deps.sendToTab(tabId, {
      type: "page.dom.wait",
      ...(cond.selector ? { selector: cond.selector } : {}),
      ...(cond.text ? { text: cond.text } : {}),
      ...(cond.urlContains ? { urlContains: cond.urlContains } : {}),
      ...(cond.goneSelector ? { selectorGone: cond.goneSelector } : {}),
      ...(cond.readyState ? { readyState: cond.readyState } : {}),
      timeoutMs,
    }, { frameId })) as { ok?: boolean; timedOut?: boolean; elapsedMs?: number };
    if (res?.ok === true) return { met: true, elapsedMs: res.elapsedMs ?? 0 };
    if (res?.timedOut === true) return { met: false, elapsedMs: res.elapsedMs ?? timeoutMs };
    return { met: "unknown" };
  } catch {
    return { met: "unknown" };
  }
}

/** Tabs a page action may have opened (target=_blank, window.open).
 *  Modern Chrome opens target=_blank with noopener, so openerTabId is
 *  often absent — match on creation time alone, bounded to a short
 *  grace window after dispatch. Reported as openedTabs[]; the tool
 *  server harvests the nested tabIds into the task's tab scope so the
 *  agent can actually drive the popup it created. */
const OPENED_TAB_GRACE_MS = 600;
const OPENED_TAB_QUIET_MS = 150;

async function collectOpenedTabs(
  deps: ToolHostDeps,
  actedTabId: number,
  sinceMs: number,
): Promise<Array<{ tabId: number; url?: string; title?: string; openerTabId?: number }>> {
  const read = deps.recentTabCreations;
  if (!read) return [];
  const seen = new Map<number, { tabId: number; url?: string; title?: string; openerTabId?: number }>();
  const deadline = Date.now() + OPENED_TAB_GRACE_MS;
  let quietSince = 0;
  while (Date.now() < deadline) {
    let added = false;
    for (const t of read()) {
      if (t.tabId === actedTabId || t.at < sinceMs || seen.has(t.tabId)) continue;
      seen.set(t.tabId, {
        tabId: t.tabId,
        ...(t.url ? { url: t.url } : {}),
        ...(t.title ? { title: t.title } : {}),
        ...(typeof t.openerTabId === "number" ? { openerTabId: t.openerTabId } : {}),
      });
      added = true;
    }
    if (added) {
      quietSince = Date.now();
    } else if (seen.size > 0 && Date.now() - quietSince >= OPENED_TAB_QUIET_MS) {
      break;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return [...seen.values()];
}

const UPLOAD_MAX_FILES = 8;

/** Normalize args.files for browser.page.upload. String entries and
 *  {path|localPath|filePath} objects are local-path/native-picker
 *  requests → browser.gesture_required (never silently read host fs). */
function normalizeUploadFiles(raw: unknown): Array<{ name: string; mimeType: string; base64: string }> {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw toolError(
      "proto.invalid",
      "browser.page.upload requires args.files[] entries of {name, mimeType, base64}",
    );
  }
  if (raw.length > UPLOAD_MAX_FILES) {
    throw toolError("proto.invalid", `browser.page.upload accepts at most ${UPLOAD_MAX_FILES} files`);
  }
  return raw.map((entry) => {
    if (typeof entry === "string") {
      throw toolError(
        "browser.gesture_required",
        "local file paths require a real user gesture; pass {name, mimeType, base64} bytes instead",
      );
    }
    const o = (entry ?? {}) as Record<string, unknown>;
    if ("path" in o || "localPath" in o || "filePath" in o) {
      throw toolError(
        "browser.gesture_required",
        "local file paths require a real user gesture; pass {name, mimeType, base64} bytes instead",
      );
    }
    if (typeof o.name !== "string" || o.name.length === 0 || typeof o.base64 !== "string" || o.base64.length === 0) {
      throw toolError("proto.invalid", "upload file entries require {name, mimeType, base64}");
    }
    return {
      name: o.name,
      mimeType: typeof o.mimeType === "string" ? o.mimeType : "",
      base64: o.base64,
    };
  });
}

// ---------------------------------------------------------------------------
// CDP tier (docs/adr/debugger-tier.md) — chrome.debugger-backed paths that
// the DOM tier cannot express: trusted input, JS dialogs, file inputs by
// path, response bodies, and the real accessibility tree.
// ---------------------------------------------------------------------------

function sanitizeWindowInfo(w: WindowInfo) {
  return {
    id: w.id,
    focused: w.focused === true,
    type: w.type ?? "normal",
    state: w.state ?? "normal",
    incognito: w.incognito === true,
    ...(typeof w.left === "number" ? { left: w.left } : {}),
    ...(typeof w.top === "number" ? { top: w.top } : {}),
    ...(typeof w.width === "number" ? { width: w.width } : {}),
    ...(typeof w.height === "number" ? { height: w.height } : {}),
    ...(typeof w.tabCount === "number" ? { tabCount: w.tabCount } : {}),
  };
}

function cdpRequired(deps: ToolHostDeps): {
  acquire: NonNullable<ToolHostDeps["acquireCdp"]>;
  release: NonNullable<ToolHostDeps["releaseCdp"]>;
} {
  if (!deps.acquireCdp || !deps.releaseCdp) {
    throw toolError(
      "proto.unsupported",
      "the debugger (CDP) tier is not available on this host",
    );
  }
  return { acquire: deps.acquireCdp, release: deps.releaseCdp };
}

/** Acquire with attach-failure mapped to proto.unsupported — a missing
 *  debugger permission or a chrome://-restricted tab must fail typed,
 *  not as an opaque internal error. */
async function cdpAcquire(
  deps: ToolHostDeps,
  tabId: number,
): Promise<{ session: CdpSession; release: () => Promise<void> }> {
  const cdp = cdpRequired(deps);
  let session: CdpSession;
  try {
    session = await cdp.acquire(tabId);
  } catch (e) {
    throw toolError(
      "proto.unsupported",
      `debugger attach failed: ${String((e as Error)?.message ?? e)}`,
    );
  }
  // SW-restart recovery: re-arm persisted emulation overrides so the
  // caller observes the emulated page, not the raw one. Never lets a
  // restore failure break this acquire.
  await maybeRestoreEmulation(deps, tabId).catch(() => {});
  return { session, release: () => cdp.release(tabId) };
}

/** Frame-scoped CDP acquire: chrome.webNavigation frameId → frame URL →
 *  matching out-of-process iframe debugger target. Only OOPIFs have
 *  their own target — same-process frames share the tab session, so a
 *  frameId that resolves to no iframe target is honestly unsupported
 *  (the caller should drop frameId and use the tab session). */
async function cdpAcquireForFrame(
  deps: ToolHostDeps,
  tabId: number,
  frameId: number,
): Promise<{ session: CdpSession; release: () => Promise<void>; targetId: string }> {
  if (!deps.listFrames || !deps.listCdpTargets || !deps.acquireCdpTarget || !deps.releaseCdpTarget) {
    throw toolError(
      "proto.unsupported",
      "frame-scoped CDP requires the debugger frame-target tier",
    );
  }
  const frames = await deps.listFrames(tabId);
  const frame = frames.find((f) => f.frameId === frameId);
  if (!frame) {
    throw toolError("proto.invalid", `args.frameId ${frameId} is not a frame in this tab`);
  }
  if (!frame.url) {
    throw toolError("proto.unsupported", `frame ${frameId} has no URL to match a debugger target`);
  }
  const targets = await deps.listCdpTargets();
  // Same matching rule as setInputFilesViaFrameTarget: OOPIF targets
  // report type "iframe" on some builds, "other" on others — URL
  // equality with the webNavigation frame is the real key.
  const target = targets.find(
    (t) => (t.type === "iframe" || t.type === "other") && t.url === frame.url,
  );
  if (!target) {
    throw toolError(
      "proto.unsupported",
      `frame ${frameId} has no dedicated debugger target (same-process frames share the tab session — drop args.frameId)`,
    );
  }
  const acquired = await cdpTargetAcquire(deps, target.id);
  return { ...acquired, targetId: target.id };
}

interface AxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  value?: { value?: unknown };
  backendDOMNodeId?: number;
  childIds?: string[];
}

const AX_MAX_LINES = 400;
const AX_SKIP_ROLES = new Set(["none", "generic", "InlineTextBox"]);
/** Cap on OOPIF AX trees merged into one aria snapshot — each merge is
 *  a separate debugger-target attach + getFullAXTree round-trip. */
const AX_OOPIF_MAX = 8;

/** Accessibility.getFullAXTree → playwright-style indented `- role "name"`
 *  lines. Iterative DFS (trees can be very deep); nodes with generic roles
 *  are flattened so their children surface at the parent depth. */
function formatAxTree(nodes: AxNode[]): { tree: string; nodeCount: number; truncated: boolean } {
  const byId = new Map<string, AxNode>();
  const hasParent = new Set<string>();
  for (const n of nodes) {
    if (n.nodeId) byId.set(n.nodeId, n);
    for (const c of n.childIds ?? []) hasParent.add(c);
  }
  const lines: string[] = [];
  let truncated = false;
  const roots = nodes.filter((n) => n.nodeId && !hasParent.has(n.nodeId));
  const stack: Array<{ node: AxNode; depth: number }> = roots
    .slice()
    .reverse()
    .map((node) => ({ node, depth: 0 }));
  while (stack.length > 0) {
    if (lines.length >= AX_MAX_LINES) {
      truncated = true;
      break;
    }
    const { node, depth } = stack.pop()!;
    const role = node.role?.value ?? "";
    const emit = role !== "" && !AX_SKIP_ROLES.has(role) && node.ignored !== true;
    if (emit) {
      const name = (node.name?.value ?? "").replace(/"/g, '\\"');
      lines.push(`${"  ".repeat(depth)}- ${role}${name ? ` "${name}"` : ""}`);
    }
    const childDepth = emit ? depth + 1 : depth;
    const children = (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((c): c is AxNode => c !== undefined);
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i]!, depth: childDepth });
    }
  }
  return { tree: lines.join("\n"), nodeCount: nodes.length, truncated };
}

// --- browser.page.pierce — closed shadow roots via CDP DOM pierce ------
// Content scripts cannot see closed shadow roots (element.shadowRoot is
// null for mode:"closed"). CDP DOM.getDocument {pierce:true} DOES traverse
// them — the same data DevTools uses to render #closed roots. We collect
// element backendNodeIds under closed/user-agent shadow roots, join with
// Accessibility.getFullAXTree for semantic role/name/value, and mint pz-N
// refs. Click/hover resolve the ref → fresh DOM.getBoxModel → trusted
// Input coordinates (there is no untrusted dispatch path for them).

const PIERCE_REF_RE = /^pz-\d+$/;
// scope = which pierce call minted the ref — re-piercing the same scope
// drops its old refs; other scopes (e.g. a different frameId) survive.
interface PierceHit {
  tabId: number;
  backendNodeId: number;
  scope: string;
  /** Set for refs minted inside an out-of-process iframe — the ref's
   *  DOM/Runtime/Input commands must run on that frame's own debugger
   *  target (frame-local coordinates), not the tab session. */
  targetId?: string;
}
const pierceRefs = new Map<string, PierceHit>();
let pierceSeq = 0;

/** File choosers armed by browser.page.wait {fileChooser:true} and not
 *  yet consumed by browser.page.setInputFiles {fileChooserId}. The CDP
 *  session stays held: backendNodeId is session-scoped, so the feeding
 *  call must reuse the session that observed Page.fileChooserOpened.
 *  Entries die with the service worker — an unconsumed chooser leaves
 *  the page's chooser flow blocked exactly like an unanswered native
 *  dialog, which is the honest failure mode. */
interface PendingFileChooser {
  taskId: string;
  tabId: number;
  backendNodeId: number;
  mode?: string;
  frameId?: string;
  session: CdpSession;
  release: () => Promise<void>;
}
const pendingFileChoosers = new Map<string, PendingFileChooser>();
let fileChooserSeq = 0;

/** result_lost reconcile foundation (§4.2/P1.6): when the IPC channel
 *  drops after the host executed a call but before the result reached
 *  the gateway, the gateway resolves `unknown` — honest but lossy. This
 *  bounded buffer keeps the last outcomes so a later
 *  `browser.tool.reconcile` (same SW lifetime — a restart loses both
 *  sides equally) can report what actually happened. LRU-capped; the
 *  gateway's durable tool.* events remain the audit source of truth. */
const MAX_RECONCILE_OUTCOMES = 512;
/** Per-outcome payload bound — tool results can be large snapshots;
 *  reconcile needs the verdict + bounded evidence, not the full body. */
const MAX_RECONCILE_RESULT_BYTES = 64 * 1024;
const recentToolOutcomes = new Map<string, unknown>();

function boundReconcilePayload(value: unknown): unknown {
  try {
    const json = JSON.stringify(value);
    if (json === undefined || json.length <= MAX_RECONCILE_RESULT_BYTES) return value;
    return { omitted: true, bytes: json.length };
  } catch {
    return { omitted: true };
  }
}

/** outcome shape: {status, result?|error?} — the verdict fields are
 *  always kept; only the bulky result payload is bounded. */
export function recordBrowserToolOutcome(
  toolCallId: string,
  outcome: { status: string; result?: unknown; error?: unknown },
): void {
  if (!toolCallId) return;
  recentToolOutcomes.delete(toolCallId);
  recentToolOutcomes.set(toolCallId, {
    status: outcome.status,
    ...(outcome.result !== undefined ? { result: boundReconcilePayload(outcome.result) } : {}),
    ...(outcome.error !== undefined ? { error: outcome.error } : {}),
  });
  while (recentToolOutcomes.size > MAX_RECONCILE_OUTCOMES) {
    const oldest = recentToolOutcomes.keys().next().value;
    if (oldest === undefined) break;
    recentToolOutcomes.delete(oldest);
  }
}

/** toolCallId → recorded outcome, or null for unknown ids. */
export function lookupBrowserToolOutcomes(
  toolCallIds: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const id of toolCallIds) {
    const o = recentToolOutcomes.get(id);
    if (o !== undefined) out[id] = o;
  }
  return out;
}

interface PierceDomNode {
  nodeId?: number;
  backendNodeId?: number;
  nodeType?: number;
  nodeName?: string;
  shadowRootType?: string;
  attributes?: string[];
  children?: PierceDomNode[];
  shadowRoots?: PierceDomNode[];
  contentDocument?: PierceDomNode;
}

interface PierceElInfo { nodeName: string; attrs: Record<string, string>; subframe: boolean }

function pierceAttrs(attrs: string[] | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < (attrs?.length ?? 0); i += 2) {
    const k = attrs![i]!;
    if (k === "style" || k === "class") continue;
    out[k] = (attrs![i + 1] ?? "").slice(0, 200);
  }
  return out;
}

/** Collect closed/user-agent shadowRoot nodes anywhere in the pierced
 *  document. `subframe` tracks whether the root sits inside a
 *  contentDocument — same-process iframe content the tab AX tree does
 *  not cover (needs per-node queryAXTree instead). */
function findPierceRoots(
  node: PierceDomNode | undefined,
  roots: Array<{ root: PierceDomNode; subframe: boolean }>,
  budget: { left: number },
  subframe = false,
): void {
  if (!node || budget.left <= 0) return;
  budget.left -= 1;
  for (const sr of node.shadowRoots ?? []) {
    if (sr.shadowRootType === "closed" || sr.shadowRootType === "user-agent") {
      roots.push({ root: sr, subframe });
    }
  }
  for (const c of node.children ?? []) findPierceRoots(c, roots, budget, subframe);
  if (node.contentDocument) findPierceRoots(node.contentDocument, roots, budget, true);
}

/** Every ELEMENT descendant of a shadow root (nested roots + subframe
 *  docs included) → backendNodeId → tag/attrs. `subframe` marks nodes
 *  reached through a contentDocument — same-process iframe content the
 *  tab AX tree does not cover (needs per-node queryAXTree instead). */
function collectPierceElements(
  node: PierceDomNode | undefined,
  into: Map<number, PierceElInfo>,
  budget: { left: number },
  subframe = false,
): void {
  if (!node || budget.left <= 0) return;
  if (node.nodeType === 1 && typeof node.backendNodeId === "number") {
    budget.left -= 1;
    into.set(node.backendNodeId, {
      nodeName: (node.nodeName ?? "").toLowerCase(),
      attrs: pierceAttrs(node.attributes),
      subframe,
    });
  }
  for (const c of node.children ?? []) collectPierceElements(c, into, budget, subframe);
  for (const sr of node.shadowRoots ?? []) collectPierceElements(sr, into, budget, subframe);
  if (node.contentDocument) collectPierceElements(node.contentDocument, into, budget, true);
}

function axScalar(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  return String(v).slice(0, 160);
}

/** browser.page.pierce — discover elements inside closed shadow roots.
 *  Read-only: mints pz-N refs bound to backendNodeIds for this tab. */
async function pagePierce(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  cdpRequired(deps);
  const frameId = frameIdArg(args);
  const text = str(args.text);
  if (text !== undefined && text.length > 512) {
    throw toolError("proto.invalid", "browser.page.pierce args.text must be ≤512 chars");
  }
  const limit =
    typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.min(Math.max(Math.floor(args.limit), 1), 200)
      : 50;
  // frameId scopes discovery to that frame's own debugger target —
  // required for out-of-process iframes, whose documents the tab DOM
  // agent cannot see. Same-process frames share the tab session and
  // are covered by tab-scoped pierce automatically (their closed-root
  // elements appear via contentDocument traversal).
  const acquired: { session: CdpSession; release: () => Promise<void>; targetId?: string } = frameId === 0
    ? await cdpAcquire(deps, tabId)
    : await cdpAcquireForFrame(deps, tabId, frameId);
  const { session, release } = acquired;
  const targetId = acquired.targetId;
  const scope = frameId === 0 ? `t${tabId}` : `t${tabId}f${frameId}`;
  try {
    const doc = (await session.send("DOM.getDocument", { depth: -1, pierce: true })) as {
      root?: PierceDomNode;
    };
    const roots: Array<{ root: PierceDomNode; subframe: boolean }> = [];
    findPierceRoots(doc.root, roots, { left: 2000 });
    const elInfo = new Map<number, PierceElInfo>();
    for (const r of roots) collectPierceElements(r.root, elInfo, { left: 5000 }, r.subframe);
    if (elInfo.size === 0) {
      return { ok: true, closedRoots: roots.length, scanned: 0, truncated: false, elements: [], resolvedTabId: tabId, ...(frameId !== 0 ? { resolvedFrameId: frameId } : {}) };
    }
    const ax = (await session.send("Accessibility.getFullAXTree")) as { nodes?: AxNode[] };
    const seen = new Set<number>();
    interface Cand { backendNodeId: number; role: string; name: string; value?: string }
    const cands: Cand[] = [];
    for (const n of ax.nodes ?? []) {
      const bid = n.backendDOMNodeId;
      if (typeof bid !== "number" || !elInfo.has(bid) || seen.has(bid)) continue;
      seen.add(bid);
      const value = axScalar(n.value?.value);
      cands.push({
        backendNodeId: bid,
        role: n.role?.value ?? "",
        name: (n.name?.value ?? "").slice(0, 200),
        ...(value !== undefined ? { value } : {}),
      });
      if (cands.length >= 500) break;
    }
    // Subframe content is in this session's DOM agent but NOT in its
    // AX tree (each frame has its own). queryAXTree per node is the
    // only join — bounded so a huge subframe can't stall the call.
    {
      let axBudget = 400;
      for (const [bid, info] of elInfo) {
        if (seen.has(bid) || !info.subframe || axBudget <= 0) continue;
        axBudget -= 1;
        try {
          const q = (await session.send("Accessibility.queryAXTree", { backendNodeId: bid })) as {
            nodes?: AxNode[];
          };
          const n = (q.nodes ?? []).find((x) => x.backendDOMNodeId === bid);
          if (!n || n.ignored === true) continue;
          seen.add(bid);
          const value = axScalar(n.value?.value);
          cands.push({
            backendNodeId: bid,
            role: n.role?.value ?? "",
            name: (n.name?.value ?? "").slice(0, 200),
            ...(value !== undefined ? { value } : {}),
          });
        } catch {
          // AX query unsupported/failed for this node — skip honestly
        }
        if (cands.length >= 500) break;
      }
    }
    const needle = text?.toLowerCase();
    const filtered = needle
      ? cands.filter((c) => {
          const info = elInfo.get(c.backendNodeId);
          const hay = `${c.name} ${c.value ?? ""} ${info?.attrs.id ?? ""} ${info?.attrs["aria-label"] ?? ""} ${c.role}`.toLowerCase();
          return hay.includes(needle);
        })
      : cands;
    // Refs are per-call per-scope: drop this scope's previous pz refs
    // before minting; refs from other pierce scopes stay valid.
    for (const [k, hit] of [...pierceRefs.entries()]) {
      if (hit.scope === scope) pierceRefs.delete(k);
    }
    const elements: Array<Record<string, unknown>> = [];
    for (const c of filtered.slice(0, limit)) {
      const ref = `pz-${++pierceSeq}`;
      pierceRefs.set(`${tabId}:${ref}`, {
        tabId,
        backendNodeId: c.backendNodeId,
        scope,
        ...(targetId !== undefined ? { targetId } : {}),
      });
      const info = elInfo.get(c.backendNodeId)!;
      let box: { x: number; y: number; width: number; height: number } | null = null;
      try {
        const bm = (await session.send("DOM.getBoxModel", { backendNodeId: c.backendNodeId })) as {
          model?: { content?: number[] };
        };
        const q = bm?.model?.content;
        if (q && q.length >= 8) {
          const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
          const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
          const x0 = Math.min(...xs);
          const y0 = Math.min(...ys);
          box = {
            x: Math.round(x0),
            y: Math.round(y0),
            width: Math.round(Math.max(...xs) - x0),
            height: Math.round(Math.max(...ys) - y0),
          };
        }
      } catch {
        // display:none / detached → box:null, element still listed
      }
      elements.push({
        ref,
        tagName: info.nodeName,
        role: c.role,
        name: c.name,
        ...(c.value !== undefined ? { value: c.value } : {}),
        ...(info.attrs.id ? { id: info.attrs.id } : {}),
        ...(info.attrs["aria-label"] ? { ariaLabel: info.attrs["aria-label"] } : {}),
        ...(info.subframe ? { subframe: true } : {}),
        box,
      });
    }
    return {
      ok: true,
      closedRoots: roots.length,
      scanned: cands.length,
      truncated: filtered.length > limit,
      elements,
      resolvedTabId: tabId,
      ...(frameId !== 0 ? { resolvedFrameId: frameId } : {}),
    };
  } finally {
    await release();
  }
}

/** pz ref → registry hit, throwing element_not_found when unknown. */
function pierceHit(tabId: number, ref: string): PierceHit {
  const hit = pierceRefs.get(`${tabId}:${ref}`);
  if (!hit) {
    throw toolError(
      "browser.element_not_found",
      `unknown pierce ref "${ref}" — re-run browser.page.pierce for fresh refs`,
    );
  }
  return hit;
}

/** Acquire the CDP session a pierce ref belongs to: OOPIF-minted refs
 *  (targetId set) run on the frame's own debugger target — frame-local
 *  coordinates and that frame's DOM/Runtime/AX agents; everything else
 *  shares the tab session. */
async function pierceAcquire(
  deps: ToolHostDeps,
  hit: PierceHit,
): Promise<{ session: CdpSession; release: () => Promise<void> }> {
  if (hit.targetId !== undefined) {
    return await cdpTargetAcquire(deps, hit.targetId);
  }
  return await cdpAcquire(deps, hit.tabId);
}

/** Fresh viewport/frame-local center for a pierce ref on an already
 *  acquired session. Throws element_not_found when the node is gone or
 *  lost layout. */
async function pierceBoxCenter(
  session: CdpSession,
  backendNodeId: number,
  ref: string,
): Promise<{ x: number; y: number }> {
  const r = await pierceBoxRect(session, backendNodeId, ref);
  return { x: r.x, y: r.y };
}

/** Same quad read as pierceBoxCenter but returns center + extents —
 *  the shape cdpLocateElement/frameAbsolutePoint produce, so callers
 *  (element screenshot clip) can share downstream math. */
async function pierceBoxRect(
  session: CdpSession,
  backendNodeId: number,
  ref: string,
): Promise<{ x: number; y: number; width: number; height: number }> {
  let bm: { model?: { content?: number[] } };
  try {
    bm = (await session.send("DOM.getBoxModel", { backendNodeId })) as {
      model?: { content?: number[] };
    };
  } catch {
    throw toolError("browser.element_not_found", `pierce target "${ref}" is gone — re-run browser.page.pierce`);
  }
  const q = bm?.model?.content;
  if (!q || q.length < 8) {
    throw toolError("browser.element_not_found", `pierce target "${ref}" has no layout — re-run browser.page.pierce`);
  }
  const xs = [q[0]!, q[2]!, q[4]!, q[6]!];
  const ys = [q[1]!, q[3]!, q[5]!, q[7]!];
  const x0 = Math.min(...xs);
  const x1 = Math.max(...xs);
  const y0 = Math.min(...ys);
  const y1 = Math.max(...ys);
  return {
    x: (x0 + x1) / 2,
    y: (y0 + y1) / 2,
    width: x1 - x0,
    height: y1 - y0,
  };
}

/** §4.8 ground-truth facts for a closed-root element via
 *  Runtime.callFunctionOn — mirrors describeDomElementFacts /
 *  getElementLabel but self-contained (injected functions can't import
 *  content-script code) and shadow-aware: label[for] / aria-labelledby
 *  lookups go through el.getRootNode() since document.* can't pierce
 *  the closed root the element lives in. pageOrigin/pageUrl come from
 *  the executing frame's location — correct for OOPIF targets too. */
const PIERCE_FACTS_FN = `function(){
var el=this;
function txt(e){try{return String(e&&(e.innerText||e.textContent||'')).replace(/\\s+/g,' ').trim()}catch(x){return ''}}
function attr(n){try{return el.getAttribute&&el.getAttribute(n)||''}catch(x){return ''}}
var root=null;try{root=el.getRootNode&&el.getRootNode()}catch(x){}
var doc=el.ownerDocument||null;
function byId(id){try{if(root&&root.getElementById)return root.getElementById(id);return doc&&doc.getElementById?doc.getElementById(id):null}catch(x){return null}}
var lb=attr('aria-labelledby');
var lbText=lb?lb.split(/\\s+/).map(function(id){var n=byId(id);return n?txt(n):''}).join(' '):'';
var inputLabels='';
try{if(el.id){var scope=root&&root.querySelectorAll?root:doc;if(scope&&scope.querySelectorAll){Array.prototype.forEach.call(scope.querySelectorAll('label[for]'),function(l){if(l.getAttribute('for')===el.id)inputLabels+=(inputLabels?' ':'')+txt(l)})}}}catch(x){}
var label=attr('aria-label')||lbText||inputLabels||attr('placeholder')||attr('title')||(el.value!=null?String(el.value):'')||txt(el);
label=String(label||'').slice(0,160);
var form=null;try{form=el.closest&&el.closest('form')}catch(x){}
var anchor=null;try{anchor=String(el.tagName||'').toLowerCase()==='a'?el:(el.querySelector?el.querySelector('a[href]'):null)}catch(x){}
var formAction='';var fa=form&&form.getAttribute('action');
if(fa){try{var u=new URL(fa,location.href);formAction=u.origin+u.pathname}catch(x){}}
var href='';var ah=anchor&&anchor.href;
if(ah){try{var u2=new URL(ah);href=u2.origin+u2.pathname}catch(x){}}
var out={label:label,tagName:String(el.tagName||'').toLowerCase()};
var role=attr('role');if(role)out.role=role;
var tg=out.tagName;
if(tg==='input'||tg==='textarea'||tg==='select'){var it=el.type;out.inputType=(typeof it==='string'&&it)?it:'text'}
if(tg==='button'||tg==='input'){out.controlType=String(attr('type')||'submit').toLowerCase()}
if(form)out.formMethod=String(form.getAttribute('method')||'get').toLowerCase();
if(formAction)out.formAction=formAction;
if(href)out.href=href;
out.pageOrigin=location.origin;
out.pageUrl=location.origin+location.pathname;
return out;
}`;

/** Resolve a pz ref's node and return its §4.8 facts. Throws
 *  element_not_found when the node is gone — same contract as the
 *  content-script describe path's not-found. */
async function pierceElementFacts(
  session: CdpSession,
  backendNodeId: number,
  ref: string,
): Promise<Record<string, unknown>> {
  const node = (await session.send("DOM.resolveNode", { backendNodeId })) as {
    object?: { objectId?: string };
  };
  const objectId = node?.object?.objectId;
  if (!objectId) {
    throw toolError("browser.element_not_found", `pierce target "${ref}" is gone — re-run browser.page.pierce`);
  }
  const res = (await session.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: PIERCE_FACTS_FN,
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  const v = res?.result?.value;
  if (!v || typeof v !== "object" || Array.isArray(v)) {
    throw toolError("browser.action_failed", "pierce fact extraction returned no object");
  }
  return v as Record<string, unknown>;
}

const PIERCE_FACT_KEYS = [
  "label", "tagName", "role", "inputType", "controlType",
  "formMethod", "formAction", "href", "pageOrigin", "pageUrl",
] as const;

/** §4.8 dispatch-time re-check for pz actions — the classifier
 *  approved facts for THIS element; if they drifted between approval
 *  and dispatch the action aborts like the content-script path's
 *  domElementFactsMatch. */
async function pierceVerifyExpected(
  session: CdpSession,
  hit: PierceHit,
  expectedTarget: Record<string, string>,
): Promise<void> {
  const actual = await pierceElementFacts(session, hit.backendNodeId, "pz");
  for (const k of PIERCE_FACT_KEYS) {
    const exp = expectedTarget[k] ?? "";
    const act = typeof actual[k] === "string" ? actual[k] : "";
    if (exp !== act) {
      throw toolError(
        "browser.target_changed",
        `pierce target facts changed since approval (${k}: "${exp.slice(0, 60)}" → "${act.slice(0, 60)}") — re-observe and retry`,
      );
    }
  }
}

/** DOM.focus on a closed-root element — the only focus path that reaches
 *  it (content-script .focus() can't). */
async function pierceFocusOn(session: CdpSession, backendNodeId: number): Promise<void> {
  await session.send("DOM.focus", { backendNodeId });
}

/** Select-all inside a closed root for pierce fill — the content-script
 *  selectAll step can't reach it. input/textarea use .select();
 *  contenteditable uses execCommand. Anything else reports
 *  not-fillable instead of selecting the whole document (a Backspace
 *  after a document-wide selection would wipe the page). */
async function pierceSelectAll(session: CdpSession, backendNodeId: number): Promise<void> {
  const resolved = (await session.send("DOM.resolveNode", { backendNodeId })) as {
    object?: { objectId?: string };
  };
  const objectId = resolved?.object?.objectId;
  if (!objectId) {
    throw toolError("browser.action_failed", "could not resolve pierce target for select-all");
  }
  const res = (await session.send("Runtime.callFunctionOn", {
    objectId,
    functionDeclaration:
      "function(){try{if(typeof this.select==='function'){this.select();return 'selected'}if(this.isContentEditable){(this.ownerDocument||document).execCommand('selectAll');return 'selected'}}catch(e){}return 'not-fillable'}",
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  if (res?.result?.value !== "selected") {
    throw toolError(
      "browser.action_failed",
      "pierce fill target is not fillable (needs input/textarea/contenteditable)",
    );
  }
}

/** Element-scoped evaluate for pz refs — the READ counterpart of pierce
 *  actions. Runtime.callFunctionOn binds `this` to the closed-root node,
 *  so `return this.value` / `this.textContent` reach state content
 *  scripts cannot. Same expression contract as page.evaluate
 *  (`return (EXPR)` in an async context, awaitPromise). */
async function pierceEvaluate(
  deps: ToolHostDeps,
  tabId: number,
  ref: string,
  expression: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const hit = pierceHit(tabId, ref);
  const { session, release } = await pierceAcquire(deps, hit);
  try {
    const node = (await session.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = node?.object?.objectId;
    if (!objectId) {
      throw toolError("browser.element_not_found", "pierce target detached — re-run browser.page.pierce");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cdpRes = (await Promise.race([
      session.send<{
        result?: { value?: unknown };
        exceptionDetails?: { text?: string; exception?: { description?: string } };
      }>("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: `async function(){ return (\n${expression}\n); }`,
        returnByValue: true,
        awaitPromise: true,
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(toolError("browser.timeout", `pierce evaluate exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]).finally(() => clearTimeout(timer))) as {
      result?: { value?: unknown };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    };
    const exc = cdpRes?.exceptionDetails;
    if (exc) {
      throw toolError(
        "browser.action_failed",
        `pierce evaluation failed: ${exc.exception?.description ?? exc.text ?? "page threw"}`,
      );
    }
    let value = cdpRes?.result?.value ?? null;
    let truncated = false;
    try {
      const json = JSON.stringify(value);
      if (json !== undefined && json.length > 256 * 1024) {
        value = typeof value === "string" ? value.slice(0, 256 * 1024) : json.slice(0, 256 * 1024);
        truncated = true;
      }
    } catch {
      value = null;
      truncated = true;
    }
    return { ok: true, value, truncated, pierced: true, resolvedTabId: tabId };
  } finally {
    await release();
  }
}

// --- browser.dnr rule validation -------------------------------------
// chrome.declarativeNetRequest session rules. The tool host whitelists
// every field before it reaches updateSessionRules — an unmatched-all
// rule (empty condition) or an unbounded payload must fail proto.invalid
// here, not silently widen inside Chrome.

const DNR_ACTION_TYPES = new Set(["block", "redirect", "allow", "upgradeScheme", "allowAllRequests"]);
const DNR_RESOURCE_TYPES = new Set([
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
  "object", "xmlhttprequest", "ping", "csp_report", "media", "websocket",
  "webtransport", "webbundle", "other",
]);
const DNR_REQUEST_METHODS = new Set([
  "connect", "delete", "get", "head", "options", "patch", "post", "put", "other",
]);
const DNR_DOMAIN_TYPES = new Set(["firstParty", "thirdParty"]);
const DNR_RULE_KEYS = new Set(["id", "priority", "action", "condition"]);
const DNR_ACTION_KEYS = new Set(["type", "redirect"]);
const DNR_REDIRECT_KEYS = new Set(["url", "transform", "regexSubstitution"]);
const DNR_TRANSFORM_KEYS = new Set([
  "scheme", "host", "port", "path", "query", "fragment", "username", "password",
]);
const DNR_CONDITION_KEYS = new Set([
  "urlFilter", "regexFilter", "isUrlFilterCaseSensitive",
  "initiatorDomains", "excludedInitiatorDomains",
  "requestDomains", "excludedRequestDomains",
  "resourceTypes", "requestMethods", "domainType",
  "tabIds", "excludedTabIds",
]);
const DNR_DOMAIN_LIST_KEYS = new Set([
  "initiatorDomains", "excludedInitiatorDomains",
  "requestDomains", "excludedRequestDomains",
]);
const DNR_TAB_ID_KEYS = new Set(["tabIds", "excludedTabIds"]);
// At least one of these must scope the rule — a condition with only
// resourceTypes/requestMethods could still match nearly all traffic.
const DNR_SCOPING_KEYS = [
  "urlFilter", "regexFilter",
  "initiatorDomains", "excludedInitiatorDomains",
  "requestDomains", "excludedRequestDomains",
  "tabIds", "excludedTabIds",
];

function dnrInvalid(msg: string): never {
  throw toolError("proto.invalid", `browser.dnr ${msg}`);
}

function dnrStr(v: unknown, field: string, max: number, required = false): string | undefined {
  if (v === undefined) {
    if (required) dnrInvalid(`rule ${field} is required`);
    return undefined;
  }
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    dnrInvalid(`rule ${field} must be a string 1-${max} chars`);
  }
  return v as string;
}

function dnrDomainList(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 100) {
    dnrInvalid(`rule condition.${field} must be an array of 1-100 domains`);
  }
  return (v as unknown[]).map((d) => {
    if (typeof d !== "string" || d.length === 0 || d.length > 253 || /\s/.test(d)) {
      dnrInvalid(`rule condition.${field} entries must be domain strings ≤253 chars`);
    }
    return d as string;
  });
}

function dnrIdList(v: unknown, field: string): number[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > 200) {
    dnrInvalid(`rule condition.${field} must be an array of 1-200 tab ids`);
  }
  return (v as unknown[]).map((t) => {
    if (typeof t !== "number" || !Number.isInteger(t)) {
      dnrInvalid(`rule condition.${field} entries must be integers`);
    }
    return t as number;
  });
}

function dnrEnumList(v: unknown, field: string, allowed: ReadonlySet<string>): string[] {
  if (!Array.isArray(v) || v.length === 0 || v.length > allowed.size) {
    dnrInvalid(`rule condition.${field} must be a non-empty array of known values`);
  }
  return (v as unknown[]).map((e) => {
    const s = typeof e === "string" ? e : "";
    if (!allowed.has(s)) {
      dnrInvalid(`rule condition.${field} has unknown value '${String(e).slice(0, 40)}'`);
    }
    return s;
  });
}

function parseDnrCondition(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    dnrInvalid("rule condition must be an object");
  }
  const src = raw as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (!DNR_CONDITION_KEYS.has(k)) dnrInvalid(`rule condition has unsupported field '${k}'`);
  }
  const out: Record<string, unknown> = {};
  const urlFilter = dnrStr(src.urlFilter, "condition.urlFilter", 2048);
  if (urlFilter !== undefined) out.urlFilter = urlFilter;
  const regexFilter = dnrStr(src.regexFilter, "condition.regexFilter", 1024);
  if (regexFilter !== undefined) out.regexFilter = regexFilter;
  if (src.isUrlFilterCaseSensitive !== undefined) {
    if (typeof src.isUrlFilterCaseSensitive !== "boolean") {
      dnrInvalid("rule condition.isUrlFilterCaseSensitive must be a boolean");
    }
    out.isUrlFilterCaseSensitive = src.isUrlFilterCaseSensitive;
  }
  for (const k of DNR_DOMAIN_LIST_KEYS) {
    if (src[k] !== undefined) out[k] = dnrDomainList(src[k], k);
  }
  if (src.resourceTypes !== undefined) out.resourceTypes = dnrEnumList(src.resourceTypes, "resourceTypes", DNR_RESOURCE_TYPES);
  if (src.requestMethods !== undefined) out.requestMethods = dnrEnumList(src.requestMethods, "requestMethods", DNR_REQUEST_METHODS);
  if (src.domainType !== undefined) {
    const dt = str(src.domainType);
    if (dt === undefined || !DNR_DOMAIN_TYPES.has(dt)) {
      dnrInvalid(`rule condition.domainType must be one of ${[...DNR_DOMAIN_TYPES].join("|")}`);
    }
    out.domainType = dt;
  }
  for (const k of DNR_TAB_ID_KEYS) {
    if (src[k] !== undefined) out[k] = dnrIdList(src[k], k);
  }
  if (!DNR_SCOPING_KEYS.some((k) => out[k] !== undefined)) {
    dnrInvalid("rule condition must scope the rule — urlFilter/regexFilter/domains/tabIds required (an empty condition matches ALL traffic)");
  }
  return out;
}

function parseDnrRedirect(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    dnrInvalid("rule action.redirect must be an object");
  }
  const src = raw as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (!DNR_REDIRECT_KEYS.has(k)) {
      dnrInvalid(`rule action.redirect field '${k}' is not supported (extensionPath redirects are refused)`);
    }
  }
  const out: Record<string, unknown> = {};
  const url = dnrStr(src.url, "action.redirect.url", 2048);
  if (url !== undefined) {
    try {
      new URL(url);
    } catch {
      dnrInvalid("rule action.redirect.url is not a valid URL");
    }
    out.url = url;
  }
  const regexSub = dnrStr(src.regexSubstitution, "action.redirect.regexSubstitution", 2048);
  if (regexSub !== undefined) out.regexSubstitution = regexSub;
  if (src.transform !== undefined) {
    if (src.transform === null || typeof src.transform !== "object" || Array.isArray(src.transform)) {
      dnrInvalid("rule action.redirect.transform must be an object");
    }
    const t = src.transform as Record<string, unknown>;
    const to: Record<string, unknown> = {};
    for (const k of Object.keys(t)) {
      if (!DNR_TRANSFORM_KEYS.has(k)) dnrInvalid(`rule action.redirect.transform field '${k}' is not supported`);
      const v = dnrStr(t[k], `action.redirect.transform.${k}`, 2048);
      if (v !== undefined) to[k] = v;
    }
    if (Object.keys(to).length === 0) dnrInvalid("rule action.redirect.transform must set at least one field");
    out.transform = to;
  }
  if (out.url === undefined && out.transform === undefined && out.regexSubstitution === undefined) {
    dnrInvalid("rule action.redirect needs url, transform, or regexSubstitution");
  }
  return out;
}

function parseDnrRule(raw: unknown): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    dnrInvalid("each rule must be an object");
  }
  const src = raw as Record<string, unknown>;
  for (const k of Object.keys(src)) {
    if (!DNR_RULE_KEYS.has(k)) dnrInvalid(`rule field '${k}' is not supported`);
  }
  const out: Record<string, unknown> = {};
  if (src.id !== undefined) {
    const id = src.id;
    if (typeof id !== "number" || !Number.isInteger(id) || id < 1) {
      dnrInvalid("rule id must be an integer >= 1 (omit to auto-assign)");
    }
    out.id = id;
  }
  if (src.priority !== undefined) {
    const p = src.priority;
    if (typeof p !== "number" || !Number.isInteger(p)) {
      dnrInvalid("rule priority must be an integer");
    }
    out.priority = p;
  }
  if (src.action === null || typeof src.action !== "object" || Array.isArray(src.action)) {
    dnrInvalid("rule action must be an object {type, redirect?}");
  }
  const act = src.action as Record<string, unknown>;
  for (const k of Object.keys(act)) {
    if (!DNR_ACTION_KEYS.has(k)) dnrInvalid(`rule action field '${k}' is not supported`);
  }
  const type = str(act.type);
  if (type === undefined || !DNR_ACTION_TYPES.has(type)) {
    dnrInvalid(`rule action.type must be one of ${[...DNR_ACTION_TYPES].join("|")}`);
  }
  const outAction: Record<string, unknown> = { type };
  if (act.redirect !== undefined) {
    if (type !== "redirect") dnrInvalid("rule action.redirect is only valid with type 'redirect'");
    outAction.redirect = parseDnrRedirect(act.redirect);
  } else if (type === "redirect") {
    dnrInvalid("rule action.type 'redirect' requires action.redirect {url|transform|regexSubstitution}");
  }
  out.action = outAction;
  out.condition = parseDnrCondition(src.condition);
  if (outAction.redirect !== undefined &&
      (outAction.redirect as Record<string, unknown>).regexSubstitution !== undefined &&
      (out.condition as Record<string, unknown>).regexFilter === undefined) {
    dnrInvalid("rule action.redirect.regexSubstitution requires condition.regexFilter");
  }
  return out;
}

function parseDnrRules(raw: unknown): Array<Record<string, unknown> & { id?: number }> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) {
    dnrInvalid("args.rules must be an array of 1-50 rules");
  }
  return (raw as unknown[]).map((r) => parseDnrRule(r) as Record<string, unknown> & { id?: number });
}

function parseDnrRuleIds(raw: unknown): number[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) {
    dnrInvalid("args.ruleIds must be an array of 1-500 rule ids");
  }
  const ids = (raw as unknown[]).map((n) => {
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      dnrInvalid("args.ruleIds entries must be integers >= 1");
    }
    return n as number;
  });
  return [...new Set(ids)];
}

// --- browser.userScripts validation ----------------------------------
// chrome.userScripts RegisteredUserScript/UserScriptInjection shapes.
// Every field is whitelisted here — script code is agent-supplied and
// runs in page contexts, so unknown keys and oversized payloads must
// fail proto.invalid before reaching Chrome.

const US_RUN_AT = new Set(["document_start", "document_end", "document_idle"]);
const US_WORLDS = new Set(["MAIN", "USER_SCRIPT"]);
const US_SCRIPT_KEYS = new Set([
  "id", "matches", "excludeMatches", "includeGlobs", "excludeGlobs",
  "js", "runAt", "world", "worldId", "allFrames",
]);
const US_JS_SOURCE_KEYS = new Set(["code", "file"]);
const US_CODE_MAX = 256 * 1024;

function usInvalid(msg: string): never {
  throw toolError("proto.invalid", `browser.userScripts ${msg}`);
}

function usStrArray(raw: unknown, field: string, max: number): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
    usInvalid(`args.${field} must be an array of 1-${max} strings`);
  }
  return (raw as unknown[]).map((v) => {
    if (typeof v !== "string" || v.length === 0 || v.length > 1024) {
      usInvalid(`args.${field} entries must be strings 1-1024 chars`);
    }
    return v as string;
  });
}

function usIntArray(raw: unknown, field: string, max: number): number[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > max) {
    usInvalid(`args.${field} must be an array of 1-${max} integers`);
  }
  return (raw as unknown[]).map((v) => {
    if (typeof v !== "number" || !Number.isInteger(v)) {
      usInvalid(`args.${field} entries must be integers`);
    }
    return v as number;
  });
}

function usScriptId(v: unknown, required: boolean): string | undefined {
  if (v === undefined) {
    if (required) usInvalid("script id is required");
    return undefined;
  }
  if (typeof v !== "string" || v.length === 0 || v.length > 128 || v.startsWith("_")) {
    usInvalid("script id must be a string 1-128 chars and not '_'-prefixed");
  }
  return v as string;
}

function usPatternList(v: unknown, field: string, required: boolean): string[] | undefined {
  if (v === undefined) {
    if (required) usInvalid(`script ${field} is required`);
    return undefined;
  }
  return usStrArray(v, `scripts[].${field}`, 100) ?? usInvalid(`script ${field} must be a non-empty array`);
}

function usValidateScript(raw: unknown, requireFull: boolean): Record<string, unknown> {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    usInvalid("scripts entries must be objects");
  }
  const s = raw as Record<string, unknown>;
  for (const key of Object.keys(s)) {
    if (!US_SCRIPT_KEYS.has(key)) usInvalid(`script has unknown field '${key.slice(0, 40)}'`);
  }
  const out: Record<string, unknown> = {};
  const id = usScriptId(s.id, true);
  if (id !== undefined) out.id = id;
  const matches = usPatternList(s.matches, "matches", requireFull);
  if (matches !== undefined) out.matches = matches;
  for (const key of ["excludeMatches", "includeGlobs", "excludeGlobs"] as const) {
    const list = usPatternList(s[key], key, false);
    if (list !== undefined) out[key] = list;
  }
  if (s.js !== undefined || requireFull) {
    if (!Array.isArray(s.js) || s.js.length === 0 || s.js.length > 20) {
      usInvalid("script js must be an array of 1-20 sources");
    }
    out.js = (s.js as unknown[]).map((src) => {
      if (src === null || typeof src !== "object" || Array.isArray(src)) {
        usInvalid("script js entries must be objects");
      }
      const o = src as Record<string, unknown>;
      for (const key of Object.keys(o)) {
        if (!US_JS_SOURCE_KEYS.has(key)) usInvalid(`script js entry has unknown field '${key.slice(0, 40)}'`);
      }
      const hasCode = typeof o.code === "string";
      const hasFile = typeof o.file === "string";
      if (hasCode === hasFile) usInvalid("script js entry needs exactly one of code|file");
      if (hasCode) {
        const code = o.code as string;
        if (code.length === 0 || code.length > US_CODE_MAX) {
          usInvalid(`script js code must be 1-${US_CODE_MAX} chars`);
        }
        return { code };
      }
      const file = o.file as string;
      if (file.length === 0 || file.length > 1024 || file.includes("..") || file.startsWith("/")) {
        usInvalid("script js file must be a relative extension path ≤1024 chars without '..'");
      }
      return { file };
    });
  }
  if (s.runAt !== undefined) {
    if (typeof s.runAt !== "string" || !US_RUN_AT.has(s.runAt)) {
      usInvalid("script runAt must be document_start|document_end|document_idle");
    }
    out.runAt = s.runAt;
  }
  if (s.world !== undefined) {
    if (typeof s.world !== "string" || !US_WORLDS.has(s.world)) {
      usInvalid("script world must be MAIN|USER_SCRIPT");
    }
    out.world = s.world;
  }
  if (s.allFrames !== undefined) {
    if (typeof s.allFrames !== "boolean") usInvalid("script allFrames must be a boolean");
    out.allFrames = s.allFrames;
  }
  if (s.worldId !== undefined) {
    if (typeof s.worldId !== "string" || s.worldId.length === 0 || s.worldId.length > 128 || s.worldId.startsWith("_")) {
      usInvalid("script worldId must be a string 1-128 chars and not '_'-prefixed");
    }
    out.worldId = s.worldId;
    if (out.world === "MAIN") usInvalid("worldId is only valid with world USER_SCRIPT or omitted");
  }
  return out;
}

function usValidateScripts(raw: unknown, requireFull: boolean): Array<Record<string, unknown>> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 20) {
    usInvalid("args.scripts must be an array of 1-20 scripts");
  }
  const scripts = (raw as unknown[]).map((s) => usValidateScript(s, requireFull));
  const ids = scripts.map((s) => s.id as string);
  if (new Set(ids).size !== ids.length) usInvalid("args.scripts contains duplicate ids");
  return scripts;
}

/** Map a locate/geom/describe `target_changed` reason to the coded
 *  tool error — the approved facts no longer hold for the resolved
 *  element, so the action must not dispatch. */
function throwIfTargetChanged(reason: string | undefined): void {
  if (reason === "target_changed") {
    throw toolError(
      "browser.target_changed",
      "target changed since the action was risk-checked — take a fresh browser.page.snapshot and retry",
    );
  }
}

/** Locate an element target in the top frame via the content script and
 *  return its viewport-center point + a querySelector-able selector. */
async function cdpLocatePoint(
  deps: ToolHostDeps,
  tabId: number,
  target: { ref?: string | undefined; selector?: string | undefined; label?: string | undefined },
  frameId = 0,
  scrollIntoView = false,
  expectedTarget?: Record<string, string> | null,
): Promise<{ x: number; y: number; width?: number; height?: number; selector: string }> {
  const loc = (await deps.sendToTab(tabId, {
    type: "page.dom.locate",
    ...(target.ref ? { targetRef: target.ref } : {}),
    ...(target.selector ? { selector: target.selector } : {}),
    ...(target.label ? { label: target.label } : {}),
    ...(scrollIntoView ? { scrollIntoView: true } : {}),
    ...(expectedTarget ? { expectedTarget } : {}),
  }, { frameId })) as {
    found?: boolean; reason?: string; count?: number;
    x?: number; y?: number; width?: number; height?: number; selector?: string;
  };
  throwIfTargetChanged(loc?.reason);
  if (loc?.found !== true || typeof loc.x !== "number" || typeof loc.y !== "number" || typeof loc.selector !== "string") {
    if (loc?.reason === "ambiguous") {
      throw toolError("browser.ambiguous_target", `target matches ${loc.count ?? "multiple"} elements`);
    }
    throw toolError("browser.element_not_found", "no element matched ref/selector/label — take a fresh browser.page.snapshot and target a returned ref/label instead of guessing selectors");
  }
  return {
    x: loc.x,
    y: loc.y,
    ...(typeof loc.width === "number" ? { width: loc.width } : {}),
    ...(typeof loc.height === "number" ? { height: loc.height } : {}),
    selector: loc.selector,
  };
}

async function cdpLocateElement(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  frameId = 0,
  scrollIntoView = false,
  expectedTarget?: Record<string, string> | null,
): Promise<{ x: number; y: number; width?: number; height?: number; selector: string }> {
  return cdpLocatePoint(deps, tabId, {
    ref: str(args.ref),
    selector: str(args.selector),
    label: str(args.label),
  }, frameId, scrollIntoView, expectedTarget);
}

/** Element target inside a subframe → top-viewport coordinates via the
 *  content script's postMessage frame-geometry chain (frame-geometry.ts).
 *  Needed because CDP Input.dispatchMouseEvent takes whole-page viewport
 *  coords while content-script rects are frame-relative. */
async function frameAbsolutePoint(
  deps: ToolHostDeps,
  tabId: number,
  target: { ref?: string | undefined; selector?: string | undefined; label?: string | undefined },
  frameId: number,
  scrollIntoView = false,
  expectedTarget?: Record<string, string> | null,
): Promise<{ x: number; y: number; width?: number; height?: number; selector?: string }> {
  const res = (await deps.sendToTab(tabId, {
    type: "page.geom.absolute",
    ...(target.ref ? { targetRef: target.ref } : {}),
    ...(target.selector ? { selector: target.selector } : {}),
    ...(target.label ? { label: target.label } : {}),
    ...(scrollIntoView ? { scrollIntoView: true } : {}),
    ...(expectedTarget ? { expectedTarget } : {}),
  }, { frameId })) as {
    found?: boolean; reason?: string; count?: number;
    x?: number; y?: number; width?: number; height?: number; selector?: string;
  };
  throwIfTargetChanged(res?.reason);
  if (res?.found !== true || typeof res.x !== "number" || typeof res.y !== "number") {
    if (res?.reason === "ambiguous") {
      throw toolError("browser.ambiguous_target", `target matches ${res.count ?? "multiple"} elements`);
    }
    if (res?.reason === "frame_geometry_unavailable") {
      throw toolError("browser.timeout", "could not resolve iframe geometry for trusted dispatch");
    }
    throw toolError("browser.element_not_found", "no element matched ref/selector/label — take a fresh browser.page.snapshot and target a returned ref/label instead of guessing selectors");
  }
  return {
    x: res.x,
    y: res.y,
    ...(typeof res.width === "number" ? { width: res.width } : {}),
    ...(typeof res.height === "number" ? { height: res.height } : {}),
    ...(typeof res.selector === "string" ? { selector: res.selector } : {}),
  };
}

const CDP_MOUSE_BUTTONS = new Set(["left", "right", "middle"]);
// CDP modifier bitmask is shared by Input.dispatchMouseEvent and
// Input.dispatchKeyEvent: Alt=1, Control=2, Meta=4, Shift=8.
const CDP_MODIFIERS: Record<string, number> = {
  Alt: 1,
  Control: 2,
  Meta: 4,
  Shift: 8,
};

/** browser.page.click args.trusted — Input.dispatchMouseEvent produces
 *  isTrusted=true events (verified headless, docs/adr/debugger-tier.md).
 *  Top frame only: iframe geometry would need frame-viewport offsetting
 *  that CDP Input does not provide. */
async function trustedClick(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  expectCond: BrowserExpectCondition | null,
  frameId = 0,
  expectedTarget?: Record<string, string> | null,
): Promise<Record<string, unknown>> {
  const button = str(args.button);
  if (button !== undefined && !CDP_MOUSE_BUTTONS.has(button)) {
    throw toolError("proto.invalid", "browser.page.click args.button must be left|right|middle");
  }
  const clickCount = typeof args.clickCount === "number" ? args.clickCount : 1;
  if (clickCount !== 1 && clickCount !== 2) {
    throw toolError("proto.invalid", "browser.page.click args.clickCount must be 1|2");
  }
  const modifiers = Array.isArray(args.modifiers)
    ? args.modifiers.filter((m): m is string => typeof m === "string")
    : [];
  const modifierMask = modifiers.reduce((mask, m) => mask | (CDP_MODIFIERS[m] ?? 0), 0);

  const xArg = typeof args.x === "number" && Number.isFinite(args.x) ? args.x : undefined;
  const yArg = typeof args.y === "number" && Number.isFinite(args.y) ? args.y : undefined;
  if ((xArg === undefined) !== (yArg === undefined)) {
    throw toolError("proto.invalid", "browser.page.click args.x and args.y must be provided together");
  }
  if (xArg !== undefined && xArg < 0) {
    throw toolError("proto.invalid", "browser.page.click coordinates must be non-negative viewport pixels");
  }
  const hasTarget = str(args.ref) !== undefined || str(args.selector) !== undefined || str(args.label) !== undefined;
  if (xArg !== undefined && hasTarget) {
    throw toolError("proto.invalid", "browser.page.click accepts coordinates or an element target, not both");
  }
  if (xArg === undefined && !hasTarget) {
    throw toolError("proto.invalid", "browser.page.click requires a target (ref/selector/label) or x/y coordinates");
  }
  cdpRequired(deps); // fail proto.unsupported before any page work

  // pz-N pierce refs resolve through CDP DOM.getBoxModel on the session
  // that owns the node — OOPIF refs dispatch frame-local coordinates on
  // the frame's own target; tab-scope refs (incl. same-process iframe
  // content) use root-viewport coordinates on the tab session. They
  // can't be combined with selector/label (one target per dispatch).
  const clickRef = str(args.ref);
  const isPierceRef = clickRef !== undefined && PIERCE_REF_RE.test(clickRef);
  if (isPierceRef && frameId !== 0) {
    throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId");
  }
  if (isPierceRef && (str(args.selector) !== undefined || str(args.label) !== undefined)) {
    throw toolError("proto.invalid", "a pierce ref cannot be combined with selector/label");
  }

  let point: { x: number; y: number };
  let session: CdpSession;
  let release: () => Promise<void>;
  if (isPierceRef) {
    const hit = pierceHit(tabId, clickRef!);
    ({ session, release } = await pierceAcquire(deps, hit));
    try {
      point = await pierceBoxCenter(session, hit.backendNodeId, clickRef!);
      if (expectedTarget) await pierceVerifyExpected(session, hit, expectedTarget);
    } catch (e) {
      await release().catch(() => {});
      throw e;
    }
  } else {
    point = xArg !== undefined
      ? { x: xArg, y: yArg! }
      : frameId !== 0
        ? await frameAbsolutePoint(deps, tabId, {
            ref: str(args.ref), selector: str(args.selector), label: str(args.label),
          }, frameId, false, expectedTarget)
        : await cdpLocateElement(deps, tabId, args, 0, false, expectedTarget);
    ({ session, release } = await cdpAcquire(deps, tabId));
  }
  const actionDispatchedAt = Date.now();
  try {
    const btn = (button ?? "left") as "left" | "right" | "middle";
    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    for (let i = 1; i <= clickCount; i++) {
      await session.send("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: point.x,
        y: point.y,
        button: btn,
        clickCount: i,
        modifiers: modifierMask,
      });
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: point.x,
        y: point.y,
        button: btn,
        clickCount: i,
        modifiers: modifierMask,
      });
    }
  } finally {
    await release();
  }

  let verified: boolean | "unknown" | undefined;
  let expectInfo: { met: boolean | "unknown"; elapsedMs?: number } | undefined;
  if (expectCond) {
    const check = await runExpectCondition(deps, tabId, expectCond, frameId);
    expectInfo = check;
    verified = check.met === true ? true : check.met === false ? false : "unknown";
  }
  const openedTabs = await collectOpenedTabs(deps, tabId, actionDispatchedAt);
  return {
    ok: true,
    summary: `trusted click at ${Math.round(point.x)},${Math.round(point.y)}`,
    step: { action: "click", trusted: true, x: point.x, y: point.y, ok: true, frameId },
    ...(isPierceRef ? { pierced: true } : {}),
    ...(verified !== undefined ? { verified } : {}),
    ...(expectInfo ? { expect: expectInfo } : {}),
    ...(openedTabs.length > 0 ? { openedTabs } : {}),
    resolvedTabId: tabId,
  };
}

/** browser.page.hover args.trusted — a single Input.dispatchMouseEvent
 *  mouseMoved produces isTrusted=true mouseover/mouseenter/mousemove and
 *  real :hover CSS state, which synthetic DOM events cannot. */
async function trustedHover(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  expectCond: BrowserExpectCondition | null,
  frameId = 0,
  expectedTarget?: Record<string, string> | null,
): Promise<Record<string, unknown>> {
  const xArg = typeof args.x === "number" && Number.isFinite(args.x) ? args.x : undefined;
  const yArg = typeof args.y === "number" && Number.isFinite(args.y) ? args.y : undefined;
  if ((xArg === undefined) !== (yArg === undefined)) {
    throw toolError("proto.invalid", "browser.page.hover args.x and args.y must be provided together");
  }
  const hasTarget = str(args.ref) !== undefined || str(args.selector) !== undefined || str(args.label) !== undefined;
  if (xArg !== undefined && hasTarget) {
    throw toolError("proto.invalid", "browser.page.hover accepts coordinates or an element target, not both");
  }
  cdpRequired(deps);
  const hoverRef = str(args.ref);
  const isPierceRef = hoverRef !== undefined && PIERCE_REF_RE.test(hoverRef);
  if (isPierceRef && frameId !== 0) {
    throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId");
  }
  if (isPierceRef && (str(args.selector) !== undefined || str(args.label) !== undefined)) {
    throw toolError("proto.invalid", "a pierce ref cannot be combined with selector/label");
  }
  let point: { x: number; y: number };
  if (isPierceRef) {
    const hit = pierceHit(tabId, hoverRef!);
    const { session, release } = await pierceAcquire(deps, hit);
    try {
      point = await pierceBoxCenter(session, hit.backendNodeId, hoverRef!);
      if (expectedTarget) await pierceVerifyExpected(session, hit, expectedTarget);
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    } finally {
      await release();
    }
  } else {
    point = xArg !== undefined
      ? { x: xArg, y: yArg! }
      : frameId !== 0
        ? await frameAbsolutePoint(deps, tabId, {
            ref: str(args.ref), selector: str(args.selector), label: str(args.label),
          }, frameId, false, expectedTarget)
        : await cdpLocateElement(deps, tabId, args, 0, false, expectedTarget);
    const { session, release } = await cdpAcquire(deps, tabId);
    try {
      await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    } finally {
      await release();
    }
  }

  let verified: boolean | "unknown" | undefined;
  let expectInfo: { met: boolean | "unknown"; elapsedMs?: number } | undefined;
  if (expectCond) {
    const check = await runExpectCondition(deps, tabId, expectCond, frameId);
    expectInfo = check;
    verified = check.met === true ? true : check.met === false ? false : "unknown";
  }
  return {
    ok: true,
    summary: `trusted hover at ${Math.round(point.x)},${Math.round(point.y)}`,
    step: { action: "hover", trusted: true, x: point.x, y: point.y, ok: true, frameId },
    ...(isPierceRef ? { pierced: true } : {}),
    ...(verified !== undefined ? { verified } : {}),
    ...(expectInfo ? { expect: expectInfo } : {}),
    resolvedTabId: tabId,
  };
}

/** browser.page.select on a pz ref — the content-script select path
 *  can't reach closed roots, so the value is applied node-scoped via
 *  Runtime.callFunctionOn: native value setter + selected flags, then
 *  composed input/change events (composed:true is what lets them cross
 *  the shadow boundary to document listeners — same event contract the
 *  content-script path produces, still isTrusted=false either way). */
async function pierceSelect(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  expectCond: BrowserExpectCondition | null,
  frameId: number,
): Promise<Record<string, unknown>> {
  const ref = str(args.ref);
  if (ref === undefined || !PIERCE_REF_RE.test(ref)) {
    throw toolError("proto.invalid", "browser.page.select pz path requires args.ref");
  }
  if (frameId !== 0) {
    throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId");
  }
  if (str(args.selector) !== undefined || str(args.label) !== undefined) {
    throw toolError("proto.invalid", "a pierce ref cannot be combined with selector/label");
  }
  const values = Array.isArray(args.values)
    ? args.values.filter((v): v is string => typeof v === "string" && v.length > 0)
    : undefined;
  if (values && values.length === 0) {
    throw toolError("proto.invalid", "browser.page.select args.values must contain at least one string");
  }
  if (values && values.length > 0 && str(args.value) !== undefined) {
    throw toolError("proto.invalid", "browser.page.select accepts value or values, not both");
  }
  const single = typeof args.value === "string" ? args.value : values?.[0];
  if (single === undefined && !values) {
    throw toolError("proto.invalid", "browser.page.select requires args.value or args.values");
  }
  const hit = pierceHit(tabId, ref);
  cdpRequired(deps);
  const { session, release } = await pierceAcquire(deps, hit);
  try {
    const node = (await session.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = node?.object?.objectId;
    if (!objectId) {
      throw toolError("browser.element_not_found", "pierce target detached — re-run browser.page.pierce");
    }
    const wanted = values ?? [single!];
    const res = (await session.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration:
        "function(wanted){if(this.tagName!=='SELECT')return 'not-select';" +
        "var set={};wanted.forEach(function(v){set[v]=true});" +
        "for(var i=0;i<this.options.length;i++){var o=this.options[i];o.selected=set[o.value]===true}" +
        "if(!this.multiple){var fv=this.options.length?this.options[0].value:'';for(var j=0;j<this.options.length;j++){if(this.options[j].selected){fv=this.options[j].value;break}}this.value=fv}" +
        "this.dispatchEvent(new Event('input',{bubbles:true,composed:true}));" +
        "this.dispatchEvent(new Event('change',{bubbles:true,composed:true}));" +
        "return 'selected'}",
      arguments: [{ value: wanted }],
      returnByValue: true,
    })) as { result?: { value?: unknown } };
    if (res?.result?.value !== "selected") {
      throw toolError(
        "browser.action_failed",
        "pierce select target is not a <select> element",
      );
    }
  } finally {
    await release();
  }

  let verified: boolean | "unknown" | undefined;
  let expectInfo: { met: boolean | "unknown"; elapsedMs?: number } | undefined;
  if (expectCond) {
    const check = await runExpectCondition(deps, tabId, expectCond, frameId);
    expectInfo = check;
    verified = check.met === true ? true : check.met === false ? false : "unknown";
  }
  return {
    ok: true,
    summary: `pierce select ${JSON.stringify(values ?? single)}`,
    step: { action: "select", value: single ?? values, ok: true },
    pierced: true,
    ...(verified !== undefined ? { verified } : {}),
    ...(expectInfo ? { expect: expectInfo } : {}),
    resolvedTabId: tabId,
  };
}

/** browser.page.focus / browser.page.submit on pz refs — the
 *  content-script paths can't reach closed roots. Focus is DOM.focus
 *  on the node; submit mirrors submitDomActionElement semantics:
 *  nearest form (or the element itself when it IS a form), submitter
 *  preserved for multi-button forms, requestSubmit with form.submit()
 *  fallback, validation errors surfaced honestly. */
async function pierceFocusSubmit(
  deps: ToolHostDeps,
  tabId: number,
  tool: string,
  args: Record<string, unknown>,
  expectCond: BrowserExpectCondition | null,
  frameId: number,
  expectedTarget?: Record<string, string> | null,
): Promise<Record<string, unknown>> {
  const ref = str(args.ref);
  if (ref === undefined || !PIERCE_REF_RE.test(ref)) {
    throw toolError("proto.invalid", `${tool} pz path requires args.ref`);
  }
  if (frameId !== 0) {
    throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId");
  }
  if (str(args.selector) !== undefined || str(args.label) !== undefined) {
    throw toolError("proto.invalid", "a pierce ref cannot be combined with selector/label");
  }
  const hit = pierceHit(tabId, ref);
  cdpRequired(deps);
  const { session, release } = await pierceAcquire(deps, hit);
  const actionDispatchedAt = Date.now();
  try {
    if (expectedTarget) await pierceVerifyExpected(session, hit, expectedTarget);
    if (tool === "browser.page.focus") {
      // Mirror the content-script path: el.focus() inside the node's
      // own root scope — DOM.focus doesn't reliably set activeElement
      // for nodes inside closed shadow roots.
      const node = (await session.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId })) as {
        object?: { objectId?: string };
      };
      const objectId = node?.object?.objectId;
      if (!objectId) {
        throw toolError("browser.element_not_found", "pierce target detached — re-run browser.page.pierce");
      }
      const fres = (await session.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function(){this.focus();var r=this.getRootNode();return r&&r.activeElement===this?true:this.matches(':focus')}",
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      if (fres?.result?.value !== true) {
        throw toolError("browser.action_failed", "pierce focus did not take — element may be unfocusable");
      }
    } else {
      const node = (await session.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId })) as {
        object?: { objectId?: string };
      };
      const objectId = node?.object?.objectId;
      if (!objectId) {
        throw toolError("browser.element_not_found", "pierce target detached — re-run browser.page.pierce");
      }
      const res = (await session.send("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration:
          "function(){var el=this;" +
          "var form=(String(el.tagName||'').toLowerCase()==='form')?el:(el.closest?el.closest('form'):null);" +
          "if(!form)return 'no-form';" +
          "var tn=String(el.tagName||'').toLowerCase();" +
          "var submitter=((tn==='button'||tn==='input')&&(el.type==='submit'||el.type==='image')&&el.form===form)?el:undefined;" +
          "try{if(typeof form.requestSubmit==='function'){form.requestSubmit(submitter);return 'submitted'}}catch(e){return 'error:'+String(e&&e.message||e).slice(0,140)}" +
          "try{form.submit();return 'submitted'}catch(e){return 'error:'+String(e&&e.message||e).slice(0,140)}}",
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      const outcome = String(res?.result?.value ?? "");
      if (outcome === "no-form") {
        throw toolError("browser.action_failed", "No form was found near the pierce target.");
      }
      if (outcome !== "submitted") {
        throw toolError("browser.action_failed", `pierce submit failed: ${outcome.replace(/^error:/, "")}`);
      }
    }
  } finally {
    await release();
  }

  let verified: boolean | "unknown" | undefined;
  let expectInfo: { met: boolean | "unknown"; elapsedMs?: number } | undefined;
  if (expectCond) {
    const check = await runExpectCondition(deps, tabId, expectCond, frameId);
    expectInfo = check;
    verified = check.met === true ? true : check.met === false ? false : "unknown";
  }
  // submit can open target=_blank popups — same harvest as the
  // content-script path.
  const openedTabs = tool === "browser.page.submit"
    ? await collectOpenedTabs(deps, tabId, actionDispatchedAt)
    : [];
  return {
    ok: true,
    summary: tool === "browser.page.focus" ? "pierce focus" : "pierce submit",
    step: { action: tool === "browser.page.focus" ? "focus" : "submit", ok: true },
    pierced: true,
    ...(verified !== undefined ? { verified } : {}),
    ...(expectInfo ? { expect: expectInfo } : {}),
    ...(openedTabs.length > 0 ? { openedTabs } : {}),
    resolvedTabId: tabId,
  };
}

/** browser.page.scroll on a pz ref — element scroll inside a closed
 *  root. Mirrors performScrollAction's element branch: scrollBy with
 *  smooth behavior, amountPx default 75% of the owning frame's
 *  viewport height, direction top/bottom are page-level only so they
 *  produce a zero delta on an element (same as the content-script
 *  path). Returns the post-scroll offsets as evidence. */
async function pierceScroll(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  expectCond: BrowserExpectCondition | null,
  frameId: number,
): Promise<Record<string, unknown>> {
  const ref = str(args.ref);
  if (ref === undefined || !PIERCE_REF_RE.test(ref)) {
    throw toolError("proto.invalid", "browser.page.scroll pz path requires args.ref");
  }
  if (frameId !== 0) {
    throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId");
  }
  if (str(args.selector) !== undefined || str(args.label) !== undefined) {
    throw toolError("proto.invalid", "a pierce ref cannot be combined with selector/label");
  }
  const direction = typeof args.direction === "string" ? args.direction : "down";
  if (!["up", "down", "left", "right", "top", "bottom"].includes(direction)) {
    throw toolError("proto.invalid", "browser.page.scroll args.direction must be up|down|left|right|top|bottom");
  }
  const amountPx = args.amountPx;
  if (amountPx !== undefined && (typeof amountPx !== "number" || !Number.isFinite(amountPx) || amountPx <= 0)) {
    throw toolError("proto.invalid", "browser.page.scroll args.amountPx must be a positive finite number");
  }
  const hit = pierceHit(tabId, ref);
  cdpRequired(deps);
  const { session, release } = await pierceAcquire(deps, hit);
  try {
    const node = (await session.send("DOM.resolveNode", { backendNodeId: hit.backendNodeId })) as {
      object?: { objectId?: string };
    };
    const objectId = node?.object?.objectId;
    if (!objectId) {
      throw toolError("browser.element_not_found", "pierce target detached — re-run browser.page.pierce");
    }
    const res = (await session.send("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration:
        "async function(dir,amount){" +
        "var a=(typeof amount==='number'&&isFinite(amount)&&amount>0)?amount:Math.round((window.innerHeight||800)*0.75);" +
        "this.scrollBy({left:dir==='left'?-a:dir==='right'?a:0,top:dir==='up'?-a:dir==='down'?a:0,behavior:'smooth'});" +
        // smooth scroll animates — let it settle before sampling the
        // offsets, same idea as the content script's action tick.
        "await new Promise(function(r){setTimeout(r,350)});" +
        "return {top:this.scrollTop,left:this.scrollLeft}}",
      arguments: [{ value: direction }, { value: amountPx ?? null }],
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: { top?: number; left?: number } } };
    const pos = res?.result?.value ?? {};
    let verified: boolean | "unknown" | undefined;
    let expectInfo: { met: boolean | "unknown"; elapsedMs?: number } | undefined;
    if (expectCond) {
      const check = await runExpectCondition(deps, tabId, expectCond, frameId);
      expectInfo = check;
      verified = check.met === true ? true : check.met === false ? false : "unknown";
    }
    return {
      ok: true,
      summary: `pierce scroll ${direction}`,
      step: { action: "scroll", direction, ok: true, scrollTop: pos.top, scrollLeft: pos.left },
      pierced: true,
      ...(verified !== undefined ? { verified } : {}),
      ...(expectInfo ? { expect: expectInfo } : {}),
      resolvedTabId: tabId,
    };
  } finally {
    await release();
  }
}

/** browser.page.drag args.trusted — CDP mouse press → interpolated
 *  moves → release, all isTrusted=true. Covers mouse-driven drag
 *  surfaces (sliders, custom mouse DnD); HTML5 drag events follow the
 *  same trusted pipeline. Coordinate form (x,y→dropX,dropY) or element
 *  targets (ref/selector/label → toRef/toSelector/toLabel). */
async function trustedDrag(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  expectCond: BrowserExpectCondition | null,
  frameId = 0,
  expectedTarget?: Record<string, string> | null,
): Promise<Record<string, unknown>> {
  const coordFields = [args.x, args.y, args.dropX, args.dropY];
  const coordCount = coordFields.filter((v) => v !== undefined && v !== null).length;
  let from: { x: number; y: number };
  let to: { x: number; y: number };
  let pierceDrag = false;
  let pierceSrc = false;
  let srcHit: PierceHit | null = null;
  // When a pierce endpoint lives on an OOPIF target, the whole gesture
  // must dispatch on THAT session with frame-local coords — mixed
  // coordinate spaces cannot form one drag.
  let dragSession: { session: CdpSession; release: () => Promise<void> } | null = null;
  if (coordCount > 0) {
    if (coordCount !== 4) {
      throw toolError("proto.invalid", "browser.page.drag coordinate drag requires x, y, dropX and dropY together");
    }
    if (coordFields.some((v) => typeof v !== "number" || !Number.isFinite(v) || (v as number) < 0)) {
      throw toolError("proto.invalid", "browser.page.drag coordinates must be non-negative finite viewport pixels");
    }
    const nums = coordFields as number[];
    from = { x: nums[0]!, y: nums[1]! };
    to = { x: nums[2]!, y: nums[3]! };
  } else {
    if (!str(args.toRef) && !str(args.toSelector) && !str(args.toLabel)) {
      throw toolError("proto.invalid", "browser.page.drag requires a drop target: toRef, toSelector, or toLabel");
    }
    const srcTarget = {
      ref: str(args.ref), selector: str(args.selector), label: str(args.label),
    };
    const dstTarget = {
      ref: str(args.toRef), selector: str(args.toSelector), label: str(args.toLabel),
    };
    const isPz = (t: { ref?: string | undefined; selector?: string | undefined; label?: string | undefined }) =>
      typeof t.ref === "string" && PIERCE_REF_RE.test(t.ref);
    pierceSrc = isPz(srcTarget);
    const pierceDst = isPz(dstTarget);
    if (pierceSrc || pierceDst) {
      pierceDrag = true;
      if (frameId !== 0) {
        throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId");
      }
      for (const [t, name] of [[srcTarget, "source"], [dstTarget, "drop"]] as const) {
        if (isPz(t) && (t.selector !== undefined || t.label !== undefined)) {
          throw toolError("proto.invalid", `a pierce ${name} ref cannot be combined with selector/label`);
        }
      }
      srcHit = pierceSrc ? pierceHit(tabId, srcTarget.ref!) : null;
      const dstHit = pierceDst ? pierceHit(tabId, dstTarget.ref!) : null;
      const oopifTid = srcHit?.targetId ?? dstHit?.targetId;
      if (oopifTid !== undefined) {
        // OOPIF drag: BOTH endpoints must be pierce refs discovered on
        // the same frame target — frame-local coords only compose
        // within one frame's coordinate space.
        if (!pierceSrc || !pierceDst || srcHit!.targetId !== oopifTid || dstHit!.targetId !== oopifTid) {
          throw toolError(
            "proto.unsupported",
            "drag across an out-of-process pierce ref and another target/frame is not supported — pierce both endpoints inside the same frame",
          );
        }
        dragSession = await cdpTargetAcquire(deps, oopifTid);
        try {
          from = await pierceBoxCenter(dragSession.session, srcHit!.backendNodeId, srcTarget.ref!);
          to = await pierceBoxCenter(dragSession.session, dstHit!.backendNodeId, dstTarget.ref!);
        } catch (e) {
          await dragSession.release().catch(() => {});
          dragSession = null;
          throw e;
        }
      } else {
        // Tab scope: pierce endpoints (incl. same-process iframe content)
        // resolve to root-viewport coords on the tab session.
        dragSession = await cdpAcquire(deps, tabId);
        try {
          from = srcHit
            ? await pierceBoxCenter(dragSession.session, srcHit.backendNodeId, srcTarget.ref!)
            : await cdpLocatePoint(deps, tabId, srcTarget, 0, false, expectedTarget);
          to = dstHit
            ? await pierceBoxCenter(dragSession.session, dstHit.backendNodeId, dstTarget.ref!)
            : await cdpLocatePoint(deps, tabId, dstTarget);
        } catch (e) {
          await dragSession.release().catch(() => {});
          dragSession = null;
          throw e;
        }
      }
    } else if (frameId !== 0) {
      from = await frameAbsolutePoint(deps, tabId, srcTarget, frameId, false, expectedTarget);
      to = await frameAbsolutePoint(deps, tabId, dstTarget, frameId);
    } else {
      const src = await cdpLocatePoint(deps, tabId, srcTarget, 0, false, expectedTarget);
      const dst = await cdpLocatePoint(deps, tabId, dstTarget);
      from = { x: src.x, y: src.y };
      to = { x: dst.x, y: dst.y };
    }
  }
  cdpRequired(deps);

  const acquired = dragSession ?? await cdpAcquire(deps, tabId);
  const { session, release } = acquired;
  try {
    // §4.8: expectedTarget describes the drag SOURCE — re-verify it
    // on the session that owns the pierce node before dispatch.
    if (pierceSrc && srcHit && expectedTarget) {
      await pierceVerifyExpected(session, srcHit, expectedTarget);
    }
    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: from.x, y: from.y });
    await session.send("Input.dispatchMouseEvent", {
      type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1,
    });
    // interpolated moves — a single jump can be ignored by drag
    // thresholds; ~8 steps mirrors a real pointer path.
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      await session.send("Input.dispatchMouseEvent", {
        type: "mouseMoved",
        x: from.x + (to.x - from.x) * t,
        y: from.y + (to.y - from.y) * t,
        button: "left",
      });
    }
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1,
    });
  } finally {
    await release();
  }

  let verified: boolean | "unknown" | undefined;
  let expectInfo: { met: boolean | "unknown"; elapsedMs?: number } | undefined;
  if (expectCond) {
    const check = await runExpectCondition(deps, tabId, expectCond, frameId);
    expectInfo = check;
    verified = check.met === true ? true : check.met === false ? false : "unknown";
  }
  return {
    ok: true,
    summary: `trusted drag ${Math.round(from.x)},${Math.round(from.y)} → ${Math.round(to.x)},${Math.round(to.y)}`,
    step: { action: "drag", trusted: true, x: from.x, y: from.y, dropX: to.x, dropY: to.y, ok: true, frameId },
    ...(pierceDrag ? { pierced: true } : {}),
    ...(verified !== undefined ? { verified } : {}),
    ...(expectInfo ? { expect: expectInfo } : {}),
    resolvedTabId: tabId,
  };
}

/** browser.page.scroll args.trusted — Input.dispatchMouseEvent
 *  mouseWheel produces isTrusted=true wheel events, which the DOM
 *  scrollBy/scrollTo path cannot: wheel listeners (infinite scroll,
 *  lazy-load triggers, scroll-jacking defenses) never fire for
 *  programmatic scrolls. Page-level only — a wheel event lands on
 *  whatever is under the cursor, so element targets stay on the DOM
 *  path (honest proto.invalid rather than silently scrolling the
 *  wrong container). */
async function trustedScroll(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  expectCond: BrowserExpectCondition | null,
  frameId = 0,
): Promise<Record<string, unknown>> {
  if (frameId !== 0) {
    throw toolError("proto.invalid", "browser.page.scroll args.trusted is page-level only (frameId must be 0)");
  }
  if (str(args.ref) || str(args.selector) || str(args.label)) {
    throw toolError("proto.invalid", "browser.page.scroll args.trusted is page-level only — drop ref/selector/label or omit trusted");
  }
  const dir = typeof args.direction === "string" ? args.direction : "down";
  if (!["up", "down", "left", "right", "top", "bottom"].includes(dir)) {
    throw toolError("proto.invalid", "browser.page.scroll args.direction must be up|down|left|right|top|bottom");
  }
  const amount =
    typeof args.amountPx === "number" && Number.isFinite(args.amountPx)
      ? Math.min(Math.max(args.amountPx, 0), 10_000)
      : 600;
  cdpRequired(deps);
  const { session, release } = await cdpAcquire(deps, tabId);
  try {
    const metrics = await session.send<{
      cssVisualViewport?: { width?: number; height?: number; clientWidth?: number; clientHeight?: number };
      visualViewport?: { width?: number; height?: number; clientWidth?: number; clientHeight?: number };
      layoutViewport?: { width?: number; height?: number; clientWidth?: number; clientHeight?: number };
    }>("Page.getLayoutMetrics");
    // Viewport metrics name their extents clientWidth/clientHeight on
    // current protocol versions (width/height on older ones).
    const vp = metrics.cssVisualViewport ?? metrics.visualViewport ?? metrics.layoutViewport;
    const vw = vp?.width ?? vp?.clientWidth ?? 0;
    const vh = vp?.height ?? vp?.clientHeight ?? 0;
    if (vw <= 0 || vh <= 0) {
      throw toolError("browser.action_failed", "Page.getLayoutMetrics returned no viewport size");
    }
    // 'top'/'bottom' are edge jumps, not distances — a wheel delta far
    // beyond the scroll range clamps at the boundary, same as a long
    // real flick. Directional scrolls use amountPx directly.
    const EDGE = 2_000_000;
    const deltaX = dir === "right" ? amount : dir === "left" ? -amount : 0;
    const deltaY =
      dir === "down" ? amount
      : dir === "up" ? -amount
      : dir === "bottom" ? EDGE
      : dir === "top" ? -EDGE
      : 0;
    const x = vw / 2;
    const y = vh / 2;
    // Chrome only routes wheel input to the page once the pointer is
    // known to be over web contents — establish position with a
    // mouseMoved first (same reason trusted click/hover move first).
    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, pointerType: "mouse" });
    await session.send("Input.dispatchMouseEvent", {
      type: "mouseWheel",
      x,
      y,
      deltaX,
      deltaY,
      pointerType: "mouse",
    });
  } finally {
    await release();
  }

  let verified: boolean | "unknown" | undefined;
  let expectInfo: { met: boolean | "unknown"; elapsedMs?: number } | undefined;
  if (expectCond) {
    const check = await runExpectCondition(deps, tabId, expectCond, frameId);
    expectInfo = check;
    verified = check.met === true ? true : check.met === false ? false : "unknown";
  }
  return {
    ok: true,
    summary: `trusted scroll ${dir}`,
    step: { action: "scroll", trusted: true, direction: dir, amountPx: amount, ok: true, frameId },
    ...(verified !== undefined ? { verified } : {}),
    ...(expectInfo ? { expect: expectInfo } : {}),
    resolvedTabId: tabId,
  };
}

// --- trusted keyboard (browser.page.press/type args.trusted) ---------------
// US-layout key table for Input.dispatchKeyEvent. `text` is the string the
// key produces (undefined for non-printing keys); vk/code drive the
// KeyboardEvent fields pages actually inspect.

interface CdpKeyDef {
  key: string;
  code?: string;
  vk?: number;
  text?: string;
}

const CDP_NAMED_KEYS: Record<string, CdpKeyDef> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9 },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  del: { key: "Delete", code: "Delete", vk: 46 },
  insert: { key: "Insert", code: "Insert", vk: 45 },
  ins: { key: "Insert", code: "Insert", vk: 45 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pgup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  pgdn: { key: "PageDown", code: "PageDown", vk: 34 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  " ": { key: " ", code: "Space", vk: 32, text: " " },
  space: { key: " ", code: "Space", vk: 32, text: " " },
  spacebar: { key: " ", code: "Space", vk: 32, text: " " },
};
for (let i = 1; i <= 12; i++) {
  CDP_NAMED_KEYS[`f${i}`] = { key: `F${i}`, code: `F${i}`, vk: 111 + i };
}

// Printable single characters, US layout. Punctuation maps the physical
// key; shiftedText is what the key produces with Shift held.
const CDP_PRINTABLE: Record<string, { code: string; vk: number; shifted?: string }> = {
  a: { code: "KeyA", vk: 65 }, b: { code: "KeyB", vk: 66 }, c: { code: "KeyC", vk: 67 },
  d: { code: "KeyD", vk: 68 }, e: { code: "KeyE", vk: 69 }, f: { code: "KeyF", vk: 70 },
  g: { code: "KeyG", vk: 71 }, h: { code: "KeyH", vk: 72 }, i: { code: "KeyI", vk: 73 },
  j: { code: "KeyJ", vk: 74 }, k: { code: "KeyK", vk: 75 }, l: { code: "KeyL", vk: 76 },
  m: { code: "KeyM", vk: 77 }, n: { code: "KeyN", vk: 78 }, o: { code: "KeyO", vk: 79 },
  p: { code: "KeyP", vk: 80 }, q: { code: "KeyQ", vk: 81 }, r: { code: "KeyR", vk: 82 },
  s: { code: "KeyS", vk: 83 }, t: { code: "KeyT", vk: 84 }, u: { code: "KeyU", vk: 85 },
  v: { code: "KeyV", vk: 86 }, w: { code: "KeyW", vk: 87 }, x: { code: "KeyX", vk: 88 },
  y: { code: "KeyY", vk: 89 }, z: { code: "KeyZ", vk: 90 },
  "0": { code: "Digit0", vk: 48, shifted: ")" }, "1": { code: "Digit1", vk: 49, shifted: "!" },
  "2": { code: "Digit2", vk: 50, shifted: "@" }, "3": { code: "Digit3", vk: 51, shifted: "#" },
  "4": { code: "Digit4", vk: 52, shifted: "$" }, "5": { code: "Digit5", vk: 53, shifted: "%" },
  "6": { code: "Digit6", vk: 54, shifted: "^" }, "7": { code: "Digit7", vk: 55, shifted: "&" },
  "8": { code: "Digit8", vk: 56, shifted: "*" }, "9": { code: "Digit9", vk: 57, shifted: "(" },
  "-": { code: "Minus", vk: 189, shifted: "_" }, "=": { code: "Equal", vk: 187, shifted: "+" },
  "[": { code: "BracketLeft", vk: 219, shifted: "{" }, "]": { code: "BracketRight", vk: 221, shifted: "}" },
  ";": { code: "Semicolon", vk: 186, shifted: ":" }, "'": { code: "Quote", vk: 222, shifted: '"' },
  "`": { code: "Backquote", vk: 192, shifted: "~" }, "\\": { code: "Backslash", vk: 220, shifted: "|" },
  ",": { code: "Comma", vk: 188, shifted: "<" }, ".": { code: "Period", vk: 190, shifted: ">" },
  "/": { code: "Slash", vk: 191, shifted: "?" },
};
// Reverse lookup: shifted symbol → base key (e.g. "!" means Shift+1).
const CDP_SHIFTED_TO_BASE: Record<string, string> = {};
for (const [base, def] of Object.entries(CDP_PRINTABLE)) {
  if (def.shifted) CDP_SHIFTED_TO_BASE[def.shifted] = base;
  if (/[a-z]/.test(base)) CDP_SHIFTED_TO_BASE[base.toUpperCase()] = base;
}

function cdpKeyDef(rawKey: string, modifierMask: number): { def: CdpKeyDef; modifiers: number } | null {
  const named = CDP_NAMED_KEYS[rawKey.toLowerCase()];
  if (named) return { def: named, modifiers: modifierMask };
  if (rawKey.length !== 1) return null;
  let ch = rawKey;
  let mask = modifierMask;
  let base = ch.toLowerCase();
  const isUpperAlpha = /[A-Z]/.test(ch);
  const shiftedSymbol = CDP_SHIFTED_TO_BASE[ch];
  if (shiftedSymbol !== undefined) {
    base = shiftedSymbol;
    mask |= CDP_MODIFIERS["Shift"] ?? 8;
  } else if (isUpperAlpha) {
    mask |= CDP_MODIFIERS["Shift"] ?? 8;
  }
  const phys = CDP_PRINTABLE[base];
  if (!phys) return null;
  const shifted = (mask & (CDP_MODIFIERS["Shift"] ?? 8)) !== 0;
  const produced = shifted && phys.shifted ? phys.shifted : shifted && /[a-z]/.test(base) ? base.toUpperCase() : base;
  return {
    def: { key: produced, code: phys.code, vk: phys.vk, text: produced },
    modifiers: mask,
  };
}

/** Focus an element target through the content script before trusted
 *  keyboard/mouse dispatch — focus() is not gesture-gated; the trusted
 *  part is the CDP Input event itself. No target → currently focused
 *  element/page. */
async function cdpFocusTarget(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  frameId = 0,
  expectedTarget?: Record<string, string> | null,
): Promise<void> {
  const hasTarget = str(args.ref) !== undefined || str(args.selector) !== undefined || str(args.label) !== undefined;
  if (!hasTarget) {
    // Targetless trusted key op (press/type on the focused element):
    // the classifier described document.activeElement — verify those
    // facts still hold right before the CDP keys dispatch.
    if (expectedTarget) {
      const res = (await deps.sendToTab(tabId, {
        type: "page.dom.describe",
        expectedTarget,
      }, { frameId })) as { found?: boolean; reason?: string } | undefined;
      throwIfTargetChanged(res?.reason);
    }
    return;
  }
  const loc = await cdpLocateElement(deps, tabId, args, frameId, false, expectedTarget);
  const focusRes = (await deps.sendToTab(tabId, {
    type: "page.dom.perform",
    steps: [{ action: "focus", selector: loc.selector, reason: "trusted input focus" }],
  }, { frameId })) as BrowserDomActionResult;
  const focusStep = focusRes?.results?.[0];
  if (focusRes?.ok === false || focusStep?.ok === false) {
    throw toolError(
      typeof focusStep?.code === "string" && focusStep.code.startsWith("browser.")
        ? focusStep.code
        : "browser.action_failed",
      focusStep?.message ?? focusRes?.summary ?? "could not focus the target element",
    );
  }
}

async function cdpDispatchKey(
  session: CdpSession,
  def: CdpKeyDef,
  modifiers: number,
): Promise<void> {
  const params: Record<string, unknown> = { key: def.key, modifiers };
  if (def.code !== undefined) params.code = def.code;
  if (def.vk !== undefined) params.windowsVirtualKeyCode = def.vk;
  // `text` is the string the key produces — only valid without
  // Control/Alt/Meta. Ctrl+A with text:"a" confuses the renderer (the
  // chord is a shortcut, not text input); Shift still produces text.
  const nonShiftMods = modifiers & ((CDP_MODIFIERS["Control"] ?? 2) | (CDP_MODIFIERS["Alt"] ?? 1) | (CDP_MODIFIERS["Meta"] ?? 4));
  if (def.text !== undefined && nonShiftMods === 0) params.text = def.text;
  await session.send("Input.dispatchKeyEvent", { type: "keyDown", ...params });
  await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...params });
}

function cdpModifiersMask(args: Record<string, unknown>): number {
  const modifiers = Array.isArray(args.modifiers)
    ? args.modifiers.filter((m): m is string => typeof m === "string")
    : [];
  return modifiers.reduce((mask, m) => mask | (CDP_MODIFIERS[m] ?? 0), 0);
}

/** browser.page.press args.trusted — Input.dispatchKeyEvent produces
 *  isTrusted=true key events. Top frame only, same constraint as
 *  trustedClick. */
async function trustedPress(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  expectCond: BrowserExpectCondition | null,
  frameId = 0,
  expectedTarget?: Record<string, string> | null,
): Promise<Record<string, unknown>> {
  const key = str(args.key);
  if (!key) throw toolError("proto.invalid", "browser.page.press requires args.key");
  const resolved = cdpKeyDef(key, cdpModifiersMask(args));
  if (!resolved) {
    throw toolError(
      "proto.invalid",
      `browser.page.press trusted key '${key}' is not in the US-layout key table (named keys, a-z, 0-9, common punctuation)`,
    );
  }
  cdpRequired(deps); // fail proto.unsupported before any page work
  const pressRef = str(args.ref);
  const isPierceRef = pressRef !== undefined && PIERCE_REF_RE.test(pressRef);
  let keySession: { session: CdpSession; release: () => Promise<void> } | null = null;
  if (isPierceRef) {
    if (frameId !== 0) {
      throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId");
    }
    if (str(args.selector) !== undefined || str(args.label) !== undefined) {
      throw toolError("proto.invalid", "a pierce ref cannot be combined with selector/label");
    }
    const hit = pierceHit(tabId, pressRef!);
    keySession = await pierceAcquire(deps, hit);
    try {
      if (expectedTarget) await pierceVerifyExpected(keySession.session, hit, expectedTarget);
      await pierceFocusOn(keySession.session, hit.backendNodeId);
    } catch (e) {
      await keySession.release().catch(() => {});
      keySession = null;
      throw e;
    }
  } else {
    await cdpFocusTarget(deps, tabId, args, frameId, expectedTarget);
  }

  const { session, release } = keySession ?? await cdpAcquire(deps, tabId);
  try {
    await cdpDispatchKey(session, resolved.def, resolved.modifiers);
  } finally {
    await release();
  }

  let verified: boolean | "unknown" | undefined;
  let expectInfo: { met: boolean | "unknown"; elapsedMs?: number } | undefined;
  if (expectCond) {
    const check = await runExpectCondition(deps, tabId, expectCond, frameId);
    expectInfo = check;
    verified = check.met === true ? true : check.met === false ? false : "unknown";
  }
  return {
    ok: true,
    summary: `trusted press ${resolved.def.key}`,
    step: { action: "press", trusted: true, key: resolved.def.key, ok: true },
    ...(isPierceRef ? { pierced: true } : {}),
    ...(verified !== undefined ? { verified } : {}),
    ...(expectInfo ? { expect: expectInfo } : {}),
    resolvedTabId: tabId,
  };
}

/** Resolve trusted-type text to per-char key defs. EVERY char validates
 *  before any dispatch — unsupported input fails with zero partial
 *  typing. \n maps to Enter; the rest go through the US-layout table. */
function cdpResolveTypeText(tool: string, text: string): Array<{ def: CdpKeyDef; modifiers: number }> {
  const enter = CDP_NAMED_KEYS["enter"];
  if (!enter) throw toolError("proto.invalid", "internal: Enter key definition missing");
  const keys: Array<{ def: CdpKeyDef; modifiers: number }> = [];
  for (const ch of text) {
    const resolved = ch === "\n" ? { def: enter, modifiers: 0 } : cdpKeyDef(ch, 0);
    if (!resolved) {
      throw toolError(
        "proto.invalid",
        `${tool} trusted text contains '${ch}' which is outside the US-layout key table (ASCII printable + newline)`,
      );
    }
    keys.push(resolved);
  }
  return keys;
}

/** browser.page.type args.trusted — per-character dispatchKeyEvent, the
 *  trusted equivalent of pressSequentially. ASCII printable + \n only;
 *  anything else is proto.invalid — never a silent downgrade. */
async function trustedType(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  expectCond: BrowserExpectCondition | null,
  frameId = 0,
  expectedTarget?: Record<string, string> | null,
): Promise<Record<string, unknown>> {
  const text = str(args.text) ?? str(args.value);
  if (text === undefined || text.length === 0) {
    throw toolError("proto.invalid", "browser.page.type requires args.text");
  }
  const keys = cdpResolveTypeText("browser.page.type", text);
  cdpRequired(deps);
  const typeRef = str(args.ref);
  const isPierceRef = typeRef !== undefined && PIERCE_REF_RE.test(typeRef);
  let keySession: { session: CdpSession; release: () => Promise<void> } | null = null;
  if (isPierceRef) {
    if (frameId !== 0) {
      throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId");
    }
    if (str(args.selector) !== undefined || str(args.label) !== undefined) {
      throw toolError("proto.invalid", "a pierce ref cannot be combined with selector/label");
    }
    const hit = pierceHit(tabId, typeRef!);
    keySession = await pierceAcquire(deps, hit);
    try {
      if (expectedTarget) await pierceVerifyExpected(keySession.session, hit, expectedTarget);
      await pierceFocusOn(keySession.session, hit.backendNodeId);
    } catch (e) {
      await keySession.release().catch(() => {});
      keySession = null;
      throw e;
    }
  } else {
    await cdpFocusTarget(deps, tabId, args, frameId, expectedTarget);
  }

  const { session, release } = keySession ?? await cdpAcquire(deps, tabId);
  try {
    for (const k of keys) {
      await cdpDispatchKey(session, k.def, k.modifiers);
    }
  } finally {
    await release();
  }

  let verified: boolean | "unknown" | undefined;
  let expectInfo: { met: boolean | "unknown"; elapsedMs?: number } | undefined;
  if (expectCond) {
    const check = await runExpectCondition(deps, tabId, expectCond, frameId);
    expectInfo = check;
    verified = check.met === true ? true : check.met === false ? false : "unknown";
  }
  return {
    ok: true,
    summary: `trusted type ${text.length} chars`,
    step: { action: "type", trusted: true, chars: text.length, ok: true },
    ...(isPierceRef ? { pierced: true } : {}),
    ...(verified !== undefined ? { verified } : {}),
    ...(expectInfo ? { expect: expectInfo } : {}),
    resolvedTabId: tabId,
  };
}

/** browser.page.fill args.trusted — real keystrokes that REPLACE the
 *  value: focus → select-all → Backspace → per-char trusted type. Same
 *  US-layout/ASCII constraint as trustedType; all chars validate before
 *  the first key event so a bad string leaves the field untouched. */
async function trustedFill(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  expectCond: BrowserExpectCondition | null,
  frameId = 0,
  expectedTarget?: Record<string, string> | null,
): Promise<Record<string, unknown>> {
  const text = str(args.text) ?? str(args.value);
  if (text === undefined) {
    throw toolError("proto.invalid", "browser.page.fill requires args.text");
  }
  const keys = cdpResolveTypeText("browser.page.fill", text);
  const del = CDP_NAMED_KEYS["backspace"];
  if (!del) throw toolError("proto.invalid", "internal: fill key definitions missing");
  cdpRequired(deps);
  const fillRef = str(args.ref);
  const isPierceRef = fillRef !== undefined && PIERCE_REF_RE.test(fillRef);
  let pierceBackend: number | undefined;
  let keySession: { session: CdpSession; release: () => Promise<void> } | null = null;
  if (isPierceRef) {
    if (frameId !== 0) {
      throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId");
    }
    if (str(args.selector) !== undefined || str(args.label) !== undefined) {
      throw toolError("proto.invalid", "a pierce ref cannot be combined with selector/label");
    }
    const hit = pierceHit(tabId, fillRef!);
    keySession = await pierceAcquire(deps, hit);
    pierceBackend = hit.backendNodeId;
    try {
      if (expectedTarget) await pierceVerifyExpected(keySession.session, hit, expectedTarget);
      await pierceFocusOn(keySession.session, hit.backendNodeId);
    } catch (e) {
      await keySession.release().catch(() => {});
      keySession = null;
      pierceBackend = undefined;
      throw e;
    }
  } else {
    // fill always targets an element — focus is mandatory, not optional
    const loc = await cdpLocateElement(deps, tabId, args, frameId, false, expectedTarget);
    await cdpFocusTarget(deps, tabId, args, frameId, expectedTarget);
    // Select-all via the content script (input.select()/execCommand) —
    // the select-all CHORD does not survive CDP dispatch reliably on
    // every platform, and selection is not the trusted part anyway: the
    // Backspace + typed chars below are isTrusted=true either way.
    const selRes = (await deps.sendToTab(tabId, {
      type: "page.dom.perform",
      steps: [{ action: "selectAll", selector: loc.selector, reason: "trusted fill select-all" }],
    }, { frameId })) as BrowserDomActionResult;
    const selStep = selRes?.results?.[0];
    if (selRes?.ok === false || selStep?.ok === false) {
      throw toolError(
        typeof selStep?.code === "string" && selStep.code.startsWith("browser.")
          ? selStep.code
          : "browser.action_failed",
        selStep?.message ?? selRes?.summary ?? "could not select the field contents",
      );
    }
  }

  const { session, release } = keySession ?? await cdpAcquire(deps, tabId);
  try {
    if (pierceBackend !== undefined) {
      await pierceSelectAll(session, pierceBackend);
    }
    await cdpDispatchKey(session, del, 0);
    for (const k of keys) {
      await cdpDispatchKey(session, k.def, k.modifiers);
    }
  } finally {
    await release();
  }

  let verified: boolean | "unknown" | undefined;
  let expectInfo: { met: boolean | "unknown"; elapsedMs?: number } | undefined;
  if (expectCond) {
    const check = await runExpectCondition(deps, tabId, expectCond, frameId);
    expectInfo = check;
    verified = check.met === true ? true : check.met === false ? false : "unknown";
  }
  return {
    ok: true,
    summary: `trusted fill ${text.length} chars`,
    step: { action: "fill", trusted: true, chars: text.length, ok: true },
    ...(isPierceRef ? { pierced: true } : {}),
    ...(verified !== undefined ? { verified } : {}),
    ...(expectInfo ? { expect: expectInfo } : {}),
    resolvedTabId: tabId,
  };
}

function clampMs(raw: unknown, fallback: number, max: number): number {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.min(Math.max(Math.floor(raw), 0), max)
    : fallback;
}

// ---- browser.page.dialog ---------------------------------------------------

async function handlePageDialog(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const accept = args.accept === true; // default dismiss — never confirm implicitly
  const promptText = str(args.promptText);
  const timeoutMs = clampMs(args.timeoutMs, 5_000, 10_000);
  const { session, release } = await cdpAcquire(deps, tabId);
  // NOTE: Page.* is top-level-target only — iframe/OOPIF targets reject
  // Page.enable/Page.handleJavaScriptDialog ("Command can only be
  // executed on top-level targets", verified on CfT 158). And the tab
  // agent does NOT surface javascriptDialogOpening for dialogs opened
  // inside OOPIFs either (they auto-resolve; confirm() returned false
  // with no CDP event) — a platform limitation, so page.dialog covers
  // main-frame and same-process-frame dialogs only.
  const handleDialog = () =>
    session.send("Page.handleJavaScriptDialog", {
      accept,
      ...(promptText !== undefined ? { promptText } : {}),
    });
  const isNoDialog = (e: unknown) => /no dialog/i.test(String((e as Error)?.message ?? e));
  try {
    // A modal JS dialog blocks the page's command queue — Page.enable
    // can hang behind it, but Page.handleJavaScriptDialog is still
    // served. Try it FIRST: an already-open dialog is handled without
    // needing the javascriptDialogOpening event at all.
    try {
      await handleDialog();
      return { handled: true, accept, resolvedTabId: tabId };
    } catch (e) {
      if (!isNoDialog(e)) {
        throw toolError(
          "browser.action_failed",
          `dialog handling failed: ${String((e as Error)?.message ?? e)}`,
        );
      }
    }
    // No dialog open yet — enable Page (best-effort, bounded: it can
    // still hang if a dialog opens in the gap) and wait for
    // javascriptDialogOpening so the common case returns fast with
    // dialog metadata instead of always burning the full timeout.
    let seen: { type?: unknown; message?: unknown; defaultPrompt?: unknown } | undefined;
    const unsub = session.on("Page.javascriptDialogOpening", (p) => {
      seen = {
        type: typeof p.type === "string" ? p.type : undefined,
        message: typeof p.message === "string" ? p.message : undefined,
        defaultPrompt: typeof p.defaultPrompt === "string" ? p.defaultPrompt : undefined,
      };
    });
    await Promise.race([
      session.send("Page.enable").catch(() => {}),
      new Promise((r) => setTimeout(r, 3_000)),
    ]);
    const deadline = Date.now() + timeoutMs;
    while (seen === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    unsub();
    try {
      await handleDialog();
    } catch (e) {
      if (isNoDialog(e)) {
        return {
          handled: false,
          reason: "no_dialog",
          ...(seen ? { dialog: seen } : {}),
          resolvedTabId: tabId,
        };
      }
      throw toolError(
        "browser.action_failed",
        `dialog handling failed: ${String((e as Error)?.message ?? e)}`,
      );
    }
    return {
      handled: true,
      accept,
      ...(seen ? { dialog: seen } : {}),
      resolvedTabId: tabId,
    };
  } finally {
    await release();
  }
}

// ---- browser.page.setInputFiles --------------------------------------------

function isAbsoluteLocalPath(p: string): boolean {
  return p.startsWith("/") || p.startsWith("\\\\") || /^[A-Za-z]:[\\/]/.test(p);
}

function pathBaseName(p: string): string {
  const parts = p.split(/[\\/]/).filter((s) => s.length > 0);
  return parts[parts.length - 1] ?? p;
}

interface CdpDomNode {
  nodeId?: number;
  nodeType?: number;
  nodeName?: string;
  attributes?: string[];
  children?: CdpDomNode[];
  contentDocument?: CdpDomNode;
  frameId?: string;
}

/** Find the nodeId carrying markerAttr=markerValue in a (possibly
 *  pierced) DOM.getDocument tree. Used to locate an element inside an
 *  iframe — frame-scoped selectors cannot cross document boundaries. */
function findMarkedNodeId(
  node: CdpDomNode | undefined,
  attr: string,
  value: string,
): number | undefined {
  if (!node) return undefined;
  const attrs = node.attributes ?? [];
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    if (attrs[i] === attr && attrs[i + 1] === value && typeof node.nodeId === "number") {
      return node.nodeId;
    }
  }
  for (const child of node.children ?? []) {
    const hit = findMarkedNodeId(child, attr, value);
    if (hit !== undefined) return hit;
  }
  return findMarkedNodeId(node.contentDocument, attr, value);
}

// ---- browser.page.emulate (CDP Emulation tier) -------------------------
// Overrides are per-debugger-session; emulate holds the attach open.

interface EmulationHold { session: CdpSession; release: () => Promise<void> }
const emulationHolds = new Map<number, EmulationHold>();

/** Args applyEmulation understands — the persisted merged override
 *  set contains only these keys. */
const EMULATION_ARG_KEYS = [
  "width", "height", "deviceScaleFactor", "mobile", "screenWidth",
  "screenHeight", "userAgent", "timezoneId", "geolocation",
  "colorScheme", "reducedMotion", "cpuThrottle", "network",
] as const;
const emulationRestoreInflight = new Set<number>();

/** Merge this call's emulation args into the persisted override set —
 *  successive emulate calls accumulate (an unset field keeps its
 *  previous override), matching how applyEmulation layers them. */
async function persistEmulationArgs(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
): Promise<void> {
  if (!deps.emulationStore) return;
  const stored: Record<string, unknown> =
    (await deps.emulationStore.get(tabId).catch(() => undefined)) ?? {};
  for (const k of EMULATION_ARG_KEYS) {
    if (args[k] !== undefined) stored[k] = args[k];
  }
  await deps.emulationStore.set(tabId, stored).catch(() => {});
}

/** Re-apply persisted emulation after an SW restart. Called from
 *  cdpAcquire — the choke point every CDP tool passes through — so the
 *  NEXT debugger-touching call (screenshot, metrics, snapshot aria,
 *  page.cdp, …) restores the overrides instead of silently observing
 *  an un-emulated page. Uses its own acquire so callers keep their
 *  refcount; failures leave the caller's session untouched and the
 *  persisted state is dropped when re-apply itself fails. */
async function maybeRestoreEmulation(
  deps: ToolHostDeps,
  tabId: number,
): Promise<void> {
  if (
    !deps.emulationStore ||
    emulationHolds.has(tabId) ||
    emulationRestoreInflight.has(tabId)
  ) return;
  emulationRestoreInflight.add(tabId);
  try {
    const stored = await deps.emulationStore.get(tabId).catch(() => undefined);
    if (!stored || Object.keys(stored).length === 0 || emulationHolds.has(tabId)) return;
    const cdp = cdpRequired(deps);
    let session: CdpSession;
    try {
      session = await cdp.acquire(tabId);
    } catch {
      return; // transient attach failure — next CDP call retries
    }
    const hold: EmulationHold = { session, release: () => cdp.release(tabId) };
    emulationHolds.set(tabId, hold);
    try {
      await applyEmulation(session, stored);
    } catch {
      emulationHolds.delete(tabId);
      await hold.release().catch(() => {});
      await deps.emulationStore.delete(tabId).catch(() => {});
    }
  } finally {
    emulationRestoreInflight.delete(tabId);
  }
}

async function emulationHold(deps: ToolHostDeps, tabId: number): Promise<EmulationHold> {
  const existing = emulationHolds.get(tabId);
  if (existing) return existing;
  const { session, release } = await cdpAcquire(deps, tabId);
  // cdpAcquire may have just restored a persisted hold — prefer it
  // over stacking a second session on the same tab.
  const restored = emulationHolds.get(tabId);
  if (restored) {
    await release().catch(() => {});
    return restored;
  }
  const hold: EmulationHold = { session, release };
  emulationHolds.set(tabId, hold);
  return hold;
}

async function releaseEmulationHold(tabId: number): Promise<void> {
  const hold = emulationHolds.get(tabId);
  if (!hold) return;
  emulationHolds.delete(tabId);
  await hold.release().catch(() => {});
}

function numArg(v: unknown, name: string, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw toolError("proto.invalid", `args.${name} must be a number in [${min}, ${max}]`);
  }
  return v;
}

function strArg(v: unknown, name: string, max = 512): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length === 0 || v.length > max) {
    throw toolError("proto.invalid", `args.${name} must be a non-empty string ≤${max} chars`);
  }
  return v;
}

async function applyEmulation(session: CdpSession, args: Record<string, unknown>): Promise<string[]> {
  const applied: string[] = [];
  const width = numArg(args.width, "width", 100, 7680);
  const height = numArg(args.height, "height", 100, 7680);
  const dsf = numArg(args.deviceScaleFactor, "deviceScaleFactor", 0.5, 4);
  const mobile = typeof args.mobile === "boolean" ? args.mobile : undefined;
  if (width !== undefined || height !== undefined || dsf !== undefined || mobile !== undefined) {
    if (width === undefined || height === undefined) {
      throw toolError("proto.invalid", "emulate width/height must be provided together");
    }
    await session.send("Emulation.setDeviceMetricsOverride", {
      width, height,
      deviceScaleFactor: dsf ?? 1,
      mobile: mobile ?? false,
      ...(numArg(args.screenWidth, "screenWidth", 100, 7680) !== undefined
        ? { screenWidth: numArg(args.screenWidth, "screenWidth", 100, 7680) }
        : {}),
      ...(numArg(args.screenHeight, "screenHeight", 100, 7680) !== undefined
        ? { screenHeight: numArg(args.screenHeight, "screenHeight", 100, 7680) }
        : {}),
    });
    applied.push("viewport");
  }
  const ua = strArg(args.userAgent, "userAgent", 1024);
  if (ua !== undefined) {
    await session.send("Emulation.setUserAgentOverride", { userAgent: ua });
    applied.push("userAgent");
  }
  const tz = strArg(args.timezoneId, "timezoneId", 128);
  if (tz !== undefined) {
    await session.send("Emulation.setTimezoneOverride", { timezoneId: tz });
    applied.push("timezone");
  }
  const geo = args.geolocation as Record<string, unknown> | undefined;
  if (geo !== undefined) {
    const latitude = numArg(geo?.latitude, "geolocation.latitude", -90, 90);
    const longitude = numArg(geo?.longitude, "geolocation.longitude", -180, 180);
    const accuracy = numArg(geo?.accuracy, "geolocation.accuracy", 0, 100000);
    if (latitude === undefined || longitude === undefined) {
      throw toolError("proto.invalid", "args.geolocation requires latitude and longitude");
    }
    await session.send("Emulation.setGeolocationOverride", {
      latitude, longitude, accuracy: accuracy ?? 100,
    });
    applied.push("geolocation");
  }
  const features: Array<{ name: string; value: string }> = [];
  if (args.colorScheme !== undefined) {
    const v = strArg(args.colorScheme, "colorScheme", 32);
    if (!["light", "dark", "no-preference"].includes(v ?? "")) {
      throw toolError("proto.invalid", "args.colorScheme must be light|dark|no-preference");
    }
    features.push({ name: "prefers-color-scheme", value: v as string });
  }
  if (args.reducedMotion !== undefined) {
    const v = strArg(args.reducedMotion, "reducedMotion", 32);
    if (!["reduce", "no-preference"].includes(v ?? "")) {
      throw toolError("proto.invalid", "args.reducedMotion must be reduce|no-preference");
    }
    features.push({ name: "prefers-reduced-motion", value: v as string });
  }
  if (features.length > 0) {
    await session.send("Emulation.setEmulatedMedia", { features });
    applied.push("media");
  }
  const cpu = numArg(args.cpuThrottle, "cpuThrottle", 1, 20);
  if (cpu !== undefined) {
    await session.send("Emulation.setCPUThrottlingRate", { rate: cpu });
    applied.push("cpuThrottle");
  }
  const net = args.network as Record<string, unknown> | undefined;
  if (net !== undefined) {
    const offline = net.offline === true;
    const latency = numArg(net.latency, "network.latency", 0, 60000) ?? -1;
    const down = numArg(net.downloadThroughput, "network.downloadThroughput", -1, 1e10) ?? -1;
    const up = numArg(net.uploadThroughput, "network.uploadThroughput", -1, 1e10) ?? -1;
    await session.send("Network.emulateNetworkConditions", {
      offline, latency, downloadThroughput: down, uploadThroughput: up,
    });
    applied.push("network");
  }
  if (applied.length === 0) {
    throw toolError("proto.invalid", "browser.page.emulate requires at least one override arg (or args.reset)");
  }
  return applied;
}

async function applyEmulationReset(session: CdpSession): Promise<void> {
  await Promise.allSettled([
    session.send("Emulation.clearDeviceMetricsOverride"),
    session.send("Emulation.setTimezoneOverride", { timezoneId: "" }),
    session.send("Emulation.setGeolocationOverride", {}),
    session.send("Emulation.setEmulatedMedia", { features: [] }),
    session.send("Emulation.setCPUThrottlingRate", { rate: 1 }),
    session.send("Network.emulateNetworkConditions", {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }),
    session.send("Emulation.setUserAgentOverride", {}),
  ]);
}

// ---- browser.page.route / unroute (CDP Fetch tier) -------------------
// Request interception is session-scoped like emulation: the hold keeps
// the debugger attached while rules are registered. Fetch.enable sees
// EVERY request (pattern "*") and we continue non-matching ones — only
// requests after enable are intercepted, same honesty bound as the
// network tap. SW restart drops rules (module state + session).

interface RouteRule {
  id: string;
  match: string;
  action: "fulfill" | "abort" | "modify";
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
  /** Optional webNavigation frameId scope — the rule only fires for
   *  requests initiated inside that frame (OOPIF sessions match
   *  directly; the tab session resolves the paused CDP frameId through
   *  a fresh Page.getFrameTree ↔ webNavigation map). */
  frameId?: number;
  /** modify action: continueRequest overrides */
  url?: string;
  requestHeaders?: Record<string, string>;
  requestBodyBase64?: string;
}

interface RouteFrameTap {
  session: CdpSession;
  unsubs: Array<() => void>;
  release: (() => Promise<void>) | undefined;
  /** webNavigation frameId this target serves — frame-scoped rules
   *  match against it directly. */
  frameId: number | undefined;
}

interface RouteHold {
  session: CdpSession;
  release: () => Promise<void>;
  rules: Map<string, RouteRule>;
  /** session.on unsubscribe fns — chrome.debugger.onEvent listeners
   *  outlive the hold otherwise and stale rules keep firing. */
  unsubs: Array<() => void>;
  /** OOPIF frame-target Fetch taps — the tab session's Fetch domain
   *  cannot intercept out-of-process iframe requests (same blindness
   *  the Network tap had; verified on CfT). */
  frames: Map<string, RouteFrameTap>;
}
const routeHolds = new Map<number, RouteHold>();

const ROUTE_BODY_MAX = 256 * 1024;
const ROUTE_RULES_MAX = 50;

/** Persisted rules are plain JSON — RouteRule fields are all
 *  serializable. Restore validates the shape and skips malformed
 *  entries rather than crashing the hold. */
function routeRuleFromStored(raw: Record<string, unknown>): RouteRule | null {
  if (typeof raw.id !== "string" || typeof raw.match !== "string") return null;
  if (raw.action !== "fulfill" && raw.action !== "abort" && raw.action !== "modify") return null;
  if (typeof raw.status !== "number" || typeof raw.bodyBase64 !== "string") return null;
  if (typeof raw.headers !== "object" || raw.headers === null || Array.isArray(raw.headers)) return null;
  const rule: RouteRule = {
    id: raw.id,
    match: raw.match,
    action: raw.action,
    status: raw.status,
    headers: raw.headers as Record<string, string>,
    bodyBase64: raw.bodyBase64,
    ...(typeof raw.frameId === "number" ? { frameId: raw.frameId } : {}),
    ...(typeof raw.url === "string" ? { url: raw.url } : {}),
    ...(typeof raw.requestHeaders === "object" && raw.requestHeaders !== null
      ? { requestHeaders: raw.requestHeaders as Record<string, string> }
      : {}),
    ...(typeof raw.requestBodyBase64 === "string" ? { requestBodyBase64: raw.requestBodyBase64 } : {}),
  };
  return rule;
}

async function persistRouteRules(
  deps: ToolHostDeps,
  tabId: number,
  hold: RouteHold,
): Promise<void> {
  if (!deps.routeRulesStore) return;
  const rules = [...hold.rules.values()].map((r) => ({ ...r }));
  try {
    if (rules.length === 0) await deps.routeRulesStore.delete(tabId);
    else await deps.routeRulesStore.set(tabId, rules);
  } catch {
    // storage.session write failure must not break the live hold —
    // rules still work in memory until the next restart.
  }
}

/** Re-arm rules persisted before an SW restart. Called once per fresh
 *  hold; restored rules take effect immediately because Fetch.enable
 *  is already wired. Returns the number restored. */
async function restoreRouteRules(
  deps: ToolHostDeps,
  tabId: number,
  hold: RouteHold,
): Promise<number> {
  if (!deps.routeRulesStore || hold.rules.size > 0) return 0;
  const stored = await deps.routeRulesStore.get(tabId).catch(() => undefined);
  if (!stored || stored.length === 0) return 0;
  let restored = 0;
  for (const raw of stored) {
    if (hold.rules.size >= ROUTE_RULES_MAX) break;
    const rule = routeRuleFromStored(raw);
    if (!rule || hold.rules.has(rule.id)) continue;
    hold.rules.set(rule.id, rule);
    restored++;
  }
  return restored;
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Which frame scope a Fetch session serves: the tab session covers
 *  the top document + same-process subframes (resolved per-request via
 *  CDP frameId → webNavigation frameId); an OOPIF session serves
 *  exactly one webNavigation frame. */
type RouteScope = { type: "tab" } | { type: "frame"; frameId: number };

interface CdpFrameNode {
  id: string;
  url: string | undefined;
  parentId: string | undefined;
}

/** Flatten Page.getFrameTree's nested frameTree into a node list. */
function flattenCdpFrameTree(node: {
  frame?: { id?: string; url?: string };
  childFrames?: unknown[];
}): CdpFrameNode[] {
  const out: CdpFrameNode[] = [];
  const walk = (n: { frame?: { id?: string; url?: string }; childFrames?: unknown[] }, parentId?: string) => {
    const id = n.frame?.id;
    if (typeof id === "string") {
      out.push({ id, url: n.frame?.url, parentId });
    }
    for (const c of Array.isArray(n.childFrames) ? n.childFrames : []) {
      walk(c as typeof n, id);
    }
  };
  walk(node);
  return out;
}

/** Map a paused request's CDP frameId to the webNavigation frameId —
 *  the two id spaces differ. Matches frames by URL + parent URL
 *  (unambiguous pairs only; duplicate-url siblings stay unmapped so a
 *  frameId rule can never fire on the wrong frame). Returns undefined
 *  when the mapping can't be proven — the rule then doesn't apply. */
async function routeCdpToNavFrameId(
  hold: RouteHold,
  deps: ToolHostDeps,
  tabId: number,
  cdpFrameId: string,
): Promise<number | undefined> {
  if (!deps.listFrames || typeof cdpFrameId !== "string" || cdpFrameId === "") return undefined;
  try {
    const treeRes = (await hold.session.send("Page.getFrameTree")) as {
      frameTree?: { frame?: { id?: string; url?: string }; childFrames?: unknown[] };
    };
    const cdpNodes = treeRes?.frameTree ? flattenCdpFrameTree(treeRes.frameTree) : [];
    if (cdpNodes.length === 0) return undefined;
    const navFrames = await deps.listFrames(tabId);
    const cdpParentUrl = (n: CdpFrameNode): string | undefined =>
      n.parentId ? cdpNodes.find((p) => p.id === n.parentId)?.url : undefined;
    const navParentUrl = (f: { frameId?: number; parentFrameId?: number; url?: string }): string | undefined =>
      f.parentFrameId === undefined
        ? undefined
        : navFrames.find((p) => p.frameId === f.parentFrameId)?.url;
    // nav frameId → cdp frameId, then invert for the paused id.
    for (const f of navFrames) {
      if (typeof f.frameId !== "number" || !f.url) continue;
      const pUrl = navParentUrl(f);
      const candidates = cdpNodes.filter((n) => n.url === f.url && cdpParentUrl(n) === pUrl);
      if (candidates.length !== 1) continue;
      if (candidates[0]!.id === cdpFrameId) return f.frameId;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Wire Fetch.requestPaused/authRequired on ONE session — the tab
 *  session or an OOPIF frame target. Responses must go back through the
 *  same session that paused the request. */
function wireRouteFetch(
  hold: RouteHold,
  deps: ToolHostDeps,
  tabId: number,
  sess: CdpSession,
  scope: RouteScope,
): Array<() => void> {
  const unsubs: Array<() => void> = [];
  unsubs.push(sess.on("Fetch.requestPaused", (p) => {
    const requestId = typeof p.requestId === "string" ? p.requestId : "";
    const url = typeof (p.request as { url?: string } | undefined)?.url === "string"
      ? (p.request as { url: string }).url
      : "";
    const urlRules = requestId
      ? [...hold.rules.values()].filter((r) => url.includes(r.match))
      : [];
    if (!requestId) return;
    const finish = (rule: RouteRule | undefined): void => {
      if (!rule) {
        void sess.send("Fetch.continueRequest", { requestId }).catch(() => {});
        return;
      }
      if (rule.action === "abort") {
        void sess
          .send("Fetch.failRequest", { requestId, errorReason: "BlockedByClient" })
          .catch(() => {});
        return;
      }
      if (rule.action === "modify") {
        let rewritten: string | undefined;
        if (rule.url) {
          try {
            rewritten = new URL(rule.url, url).href;
          } catch {
            rewritten = undefined;
          }
        }
        void sess
          .send("Fetch.continueRequest", {
            requestId,
            ...(rewritten ? { url: rewritten } : {}),
            ...(rule.requestHeaders
              ? { headers: Object.entries(rule.requestHeaders).map(([name, value]) => ({ name, value })) }
              : {}),
            ...(rule.requestBodyBase64 ? { postData: rule.requestBodyBase64 } : {}),
          })
          .catch(() => {});
        return;
      }
      const responseHeaders = Object.entries(rule.headers).map(([name, value]) => ({ name, value }));
      void sess
        .send("Fetch.fulfillRequest", {
          requestId,
          responseCode: rule.status,
          responseHeaders,
          body: rule.bodyBase64,
        })
        .catch(() => {});
    };
    // Frame-scoped rules need the paused request's frame resolved —
    // OOPIF sessions know their frame directly; the tab session maps
    // the CDP frameId through Page.getFrameTree (fresh per pause so
    // navigations can't stale the map). Unscoped rules skip this.
    const scoped = urlRules.filter((r) => r.frameId !== undefined);
    if (scoped.length === 0) {
      finish(urlRules[0]);
      return;
    }
    void (async () => {
      const cdpFid = typeof p.frameId === "string" ? p.frameId : "";
      const resolved = cdpFid === ""
        ? undefined
        : scope.type === "frame"
          ? scope.frameId
          : await routeCdpToNavFrameId(hold, deps, tabId, cdpFid);
      // First URL-matching rule whose frame scope admits this request —
      // unscoped rules admit every frame, preserving insertion order.
      finish(urlRules.find((r) => r.frameId === undefined || r.frameId === resolved));
    })();
  }));
  unsubs.push(sess.on("Fetch.authRequired", (p) => {
    const requestId = typeof p.requestId === "string" ? p.requestId : "";
    if (!requestId) return;
    void sess
      .send("Fetch.continueWithAuth", {
        requestId,
        authChallengeResponse: { response: "Default" },
      })
      .catch(() => {});
  }));
  return unsubs;
}

async function routeHold(deps: ToolHostDeps, tabId: number): Promise<RouteHold> {
  const existing = routeHolds.get(tabId);
  if (existing) {
    await syncOopifRouteTargets(deps, tabId, existing);
    return existing;
  }
  const { session, release } = await cdpAcquire(deps, tabId);
  const hold: RouteHold = { session, release, rules: new Map(), unsubs: [], frames: new Map() };
  routeHolds.set(tabId, hold);
  // Pause every request at Request stage; non-matching requests are
  // continued untouched. Response-stage interception is not supported —
  // fulfill replaces the whole response.
  await session.send("Fetch.enable", {
    patterns: [{ urlPattern: "*", requestStage: "Request" }],
  });
  hold.unsubs.push(...wireRouteFetch(hold, deps, tabId, session, { type: "tab" }));
  await syncOopifRouteTargets(deps, tabId, hold);
  // Re-arm rules persisted across an SW restart — they take effect
  // immediately since Fetch.enable is already wired above.
  await restoreRouteRules(deps, tabId, hold);
  return hold;
}

/** Attach Fetch taps to this tab's out-of-process iframe targets so
 *  route rules apply to their requests too. Same discovery/prune
 *  lifecycle as the network tap; degrades to tab-only coverage when
 *  frame-target deps are missing. */
async function syncOopifRouteTargets(
  deps: ToolHostDeps,
  tabId: number,
  hold: RouteHold,
): Promise<void> {
  if (!deps.acquireCdpTarget) return;
  const matches = await matchOopifFrameTargets(deps, tabId);
  if (!matches) return;
  const liveTargetIds = new Set<string>();
  for (const { frame, target } of matches) {
    liveTargetIds.add(target.id);
    if (hold.frames.has(target.id)) continue;
    try {
      const fs = await deps.acquireCdpTarget(target.id);
      await fs.send("Fetch.enable", {
        patterns: [{ urlPattern: "*", requestStage: "Request" }],
      });
      const fUnsubs = wireRouteFetch(hold, deps, tabId, fs, {
        type: "frame",
        frameId: typeof frame.frameId === "number" ? frame.frameId : -1,
      });
      hold.frames.set(target.id, {
        session: fs,
        unsubs: fUnsubs,
        release: deps.releaseCdpTarget
          ? () => deps.releaseCdpTarget!(target.id)
          : undefined,
        frameId: typeof frame.frameId === "number" ? frame.frameId : undefined,
      });
    } catch {
      // frame target raced away — skip; next sync retries
    }
  }
  for (const [targetId, f] of hold.frames) {
    if (liveTargetIds.has(targetId)) continue;
    for (const un of f.unsubs) un();
    await f.session.send("Fetch.disable").catch(() => {});
    await f.release?.().catch(() => {});
    hold.frames.delete(targetId);
  }
}

async function releaseRouteHold(tabId: number): Promise<void> {
  const hold = routeHolds.get(tabId);
  if (!hold) return;
  routeHolds.delete(tabId);
  for (const un of hold.unsubs) un();
  await hold.session.send("Fetch.disable").catch(() => {});
  for (const f of hold.frames.values()) {
    for (const un of f.unsubs) un();
    await f.session.send("Fetch.disable").catch(() => {});
    await f.release?.().catch(() => {});
  }
  hold.frames.clear();
  await hold.release().catch(() => {});
}

async function addPageRoute(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const match = strArg(args.match, "match", 512);
  if (match === undefined) {
    throw toolError("proto.invalid", "browser.page.route requires args.match (URL substring)");
  }
  // Optional frame scope — a webNavigation frameId (see page.get
  // frames[]). Verified against the tab's live frames when the deps
  // allow; unresolvable scopes refuse honestly instead of silently
  // never firing.
  let ruleFrameId: number | undefined;
  if (args.frameId !== undefined) {
    const fid = numArg(args.frameId, "frameId", 0, Number.MAX_SAFE_INTEGER);
    if (fid === undefined || !Number.isInteger(fid)) {
      throw toolError("proto.invalid", "args.frameId must be a non-negative integer (webNavigation frameId)");
    }
    if (deps.listFrames) {
      const frames = await deps.listFrames(tabId).catch(() => null);
      if (frames && !frames.some((f) => f.frameId === fid)) {
        throw toolError("browser.not_found", `no webNavigation frame ${fid} on this tab`);
      }
    }
    ruleFrameId = fid;
  }
  const action = args.action === undefined ? "fulfill" : str(args.action);
  if (action !== "fulfill" && action !== "abort" && action !== "modify") {
    throw toolError("proto.invalid", "browser.page.route args.action must be fulfill|abort|modify");
  }
  // modify overrides — url rewrite, request header injection, body swap
  const modUrl = action === "modify" ? strArg(args.url, "url", 2048) : undefined;
  const modHeadersRaw = action === "modify" ? args.requestHeaders : undefined;
  const modHeaders: Record<string, string> = {};
  if (modHeadersRaw !== undefined) {
    if (typeof modHeadersRaw !== "object" || modHeadersRaw === null || Array.isArray(modHeadersRaw)) {
      throw toolError("proto.invalid", "args.requestHeaders must be an object of string values");
    }
    for (const [k, v] of Object.entries(modHeadersRaw as Record<string, unknown>)) {
      if (typeof v !== "string" || k.length === 0 || k.length > 100 || v.length > 8192) {
        throw toolError("proto.invalid", "args.requestHeaders values must be strings (name ≤100, value ≤8192 chars)");
      }
      modHeaders[k] = v;
    }
  }
  let modBodyBase64: string | undefined;
  if (action === "modify" && args.requestBody !== undefined) {
    if (typeof args.requestBody !== "string") {
      throw toolError("proto.invalid", "args.requestBody must be a string");
    }
    if (args.requestBody.length > ROUTE_BODY_MAX) {
      throw toolError("proto.payload_too_large", `args.requestBody exceeds ${ROUTE_BODY_MAX} chars`);
    }
    modBodyBase64 = utf8ToBase64(args.requestBody);
  }
  if (action === "modify" && modUrl === undefined && Object.keys(modHeaders).length === 0 && modBodyBase64 === undefined) {
    throw toolError("proto.invalid", "browser.page.route action:modify requires args.url, args.requestHeaders or args.requestBody");
  }
  const status = numArg(args.status, "status", 100, 599) ?? 200;
  const contentType = strArg(args.contentType, "contentType", 200);
  const headersRaw = args.headers;
  const headers: Record<string, string> = {};
  if (headersRaw !== undefined) {
    if (typeof headersRaw !== "object" || headersRaw === null || Array.isArray(headersRaw)) {
      throw toolError("proto.invalid", "args.headers must be an object of string values");
    }
    for (const [k, v] of Object.entries(headersRaw as Record<string, unknown>)) {
      if (typeof v !== "string" || k.length === 0 || k.length > 100 || v.length > 8192) {
        throw toolError("proto.invalid", "args.headers values must be strings (name ≤100, value ≤8192 chars)");
      }
      headers[k] = v;
    }
  }
  if (contentType !== undefined) headers["Content-Type"] = contentType;
  let bodyBase64 = "";
  if (args.body !== undefined) {
    if (typeof args.body !== "string") {
      throw toolError("proto.invalid", "args.body must be a string");
    }
    if (args.body.length > ROUTE_BODY_MAX) {
      throw toolError("proto.payload_too_large", `args.body exceeds ${ROUTE_BODY_MAX} chars`);
    }
    bodyBase64 = utf8ToBase64(args.body);
  }
  const hold = await routeHold(deps, tabId);
  if (hold.rules.size >= ROUTE_RULES_MAX) {
    throw toolError("proto.invalid", `route rule cap reached (${ROUTE_RULES_MAX}) — unroute first`);
  }
  const id = crypto.randomUUID();
  hold.rules.set(id, {
    id, match, action: action as "fulfill" | "abort" | "modify", status, headers, bodyBase64,
    ...(ruleFrameId !== undefined ? { frameId: ruleFrameId } : {}),
    ...(modUrl !== undefined ? { url: modUrl } : {}),
    ...(Object.keys(modHeaders).length > 0 ? { requestHeaders: modHeaders } : {}),
    ...(modBodyBase64 !== undefined ? { requestBodyBase64: modBodyBase64 } : {}),
  });
  await persistRouteRules(deps, tabId, hold);
  return {
    routeId: id, match, action, status, rules: hold.rules.size, resolvedTabId: tabId,
    ...(ruleFrameId !== undefined ? { frameId: ruleFrameId } : {}),
  };
}

async function removePageRoutes(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  let hold = routeHolds.get(tabId);
  // No live hold — but rules persisted before an SW restart would
  // silently re-arm on the next route call. Materialize the hold so
  // unroute can actually clear them instead of reporting removed:0
  // while mocks stay armed in storage.
  if (!hold && deps.routeRulesStore) {
    const stored = await deps.routeRulesStore.get(tabId).catch(() => undefined);
    if (stored && stored.length > 0) hold = await routeHold(deps, tabId);
  }
  const routeId = str(args.routeId);
  if (hold) await syncOopifRouteTargets(deps, tabId, hold);
  if (!hold || hold.rules.size === 0) {
    // A freshly materialized hold with nothing to remove must not
    // leak its debugger attach.
    if (hold) await releaseRouteHold(tabId);
    return { removed: 0, remaining: 0, resolvedTabId: tabId };
  }
  let removed = 0;
  if (routeId !== undefined) {
    removed = hold.rules.delete(routeId) ? 1 : 0;
    if (removed === 0) {
      throw toolError("browser.not_found", `no route rule ${routeId} on this tab`);
    }
  } else {
    removed = hold.rules.size;
    hold.rules.clear();
  }
  await persistRouteRules(deps, tabId, hold);
  if (hold.rules.size === 0) {
    await releaseRouteHold(tabId);
  }
  return { removed, remaining: routeId !== undefined ? hold.rules.size : 0, resolvedTabId: tabId };
}

/** OOPIF path for setInputFiles: locate the frame's debugger target by
 *  URL and run DOM.setFileInputFiles inside it. Returns nodeId used or
 *  undefined when no target matched / element absent. */
async function setInputFilesViaFrameTarget(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  frameId: number,
  files: string[],
  markerAttr: string,
  markerValue: string,
): Promise<boolean> {
  const frames = deps.listFrames ? await deps.listFrames(tabId) : [];
  const frame = frames.find((f) => f.frameId === frameId);
  if (!frame?.url) return false;
  const targets = await deps.listCdpTargets!();
  // OOPIF targets report type "iframe" on some builds and "other" on
  // others — URL equality with the webNavigation frame is the real key.
  const candidates = targets.filter(
    (t) => (t.type === "iframe" || t.type === "other") && t.url === frame.url,
  );
  if (candidates.length === 0) return false;
  for (const t of candidates) {
    const { session, release } = await cdpTargetAcquire(deps, t.id);
    try {
      await session.send("DOM.enable");
      const doc = (await session.send("DOM.getDocument", {
        depth: -1,
        pierce: true,
      })) as { root?: CdpDomNode };
      const nodeId = findMarkedNodeId(doc?.root, markerAttr, markerValue);
      if (typeof nodeId !== "number") continue;
      await session.send("DOM.setFileInputFiles", { nodeId, files });
      return true;
    } finally {
      await release();
    }
  }
  return false;
}

async function cdpTargetAcquire(
  deps: ToolHostDeps,
  targetId: string,
): Promise<{ session: CdpSession; release: () => Promise<void> }> {
  let session: CdpSession;
  try {
    session = await deps.acquireCdpTarget!(targetId);
  } catch {
    throw toolError("proto.unsupported", `debugger attach to frame target failed`);
  }
  return { session, release: () => deps.releaseCdpTarget!(targetId) };
}

/** Ownership proof for page.cdp {targetId}: the target's URL must be a
 *  webNavigation frame of this tab (iframe/other targets) OR a
 *  service-worker scriptURL registered by any of its frames. Anything
 *  else — another tab's page, an extension target, an unrelated
 *  worker — is out of scope. Missing deps degrade to "not owned"
 *  (refusal), never to allowed. */
async function cdpTargetOwnedByTab(
  deps: ToolHostDeps,
  tabId: number,
  url: string,
): Promise<boolean> {
  if (!url) return false;
  if (deps.listFrames) {
    try {
      const frames = await deps.listFrames(tabId);
      if (frames.some((f) => f.url === url)) return true;
    } catch {
      // frame enumeration failed — fall through to SW check
    }
  }
  if (deps.runInMainWorld) {
    const fids = (await consoleFrameIds(deps, tabId)) ?? [0];
    for (const fid of fids.slice(0, CONSOLE_MERGE_FRAME_CAP)) {
      try {
        const res = (await deps.runInMainWorld(
          tabId,
          chromexSwOp as (...fnArgs: unknown[]) => unknown,
          ["list", ""],
          [fid],
        )) as {
          result?: {
            registrations?: Array<{ scriptURL?: unknown }>;
            controllerScriptURL?: unknown;
          };
        } | undefined;
        const urls = (res?.result?.registrations ?? [])
          .map((r) => r.scriptURL)
          .concat([res?.result?.controllerScriptURL]);
        if (urls.includes(url)) return true;
      } catch {
        // frame gone or injection refused — try the next frame
      }
    }
  }
  return false;
}

async function setInputFiles(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  frameId = 0,
  taskId?: string,
): Promise<Record<string, unknown>> {
  const rawFiles = args.files;
  if (!Array.isArray(rawFiles) || rawFiles.length === 0 || rawFiles.length > 10) {
    throw toolError("proto.invalid", "browser.page.setInputFiles requires args.files[] of 1-10 absolute paths");
  }
  const files = rawFiles.map((f) => {
    if (typeof f !== "string" || f.length === 0 || !isAbsoluteLocalPath(f)) {
      throw toolError(
        "proto.invalid",
        "browser.page.setInputFiles file entries must be absolute local paths",
      );
    }
    return f;
  });
  // fileChooserId feeds an intercepted native chooser armed by
  // page.wait {fileChooser:true} — the chooser carries no selector, so
  // this is the only way to resolve it. backendNodeId is session-scoped:
  // reuse the session that observed fileChooserOpened, then release it.
  const chooserId = str(args.fileChooserId);
  if (chooserId !== undefined) {
    if (frameId !== 0) {
      throw toolError("proto.invalid", "fileChooserId carries its own frame — drop args.frameId");
    }
    if (str(args.ref) !== undefined || str(args.selector) !== undefined || str(args.label) !== undefined) {
      throw toolError("proto.invalid", "fileChooserId cannot be combined with ref/selector/label");
    }
    const pending = pendingFileChoosers.get(chooserId);
    if (!pending) {
      throw toolError(
        "proto.invalid",
        `unknown fileChooserId "${chooserId}" — it comes from a browser.page.wait {fileChooser:true} result and is consumed once`,
      );
    }
    if (tabId !== pending.tabId) {
      throw toolError(
        "proto.invalid",
        `fileChooserId "${chooserId}" belongs to tab ${pending.tabId}, not ${tabId}`,
      );
    }
    if (pending.taskId !== "" && taskId !== undefined && pending.taskId !== taskId) {
      throw toolError(
        "proto.invalid",
        `fileChooserId "${chooserId}" belongs to another task — re-arm via browser.page.wait {fileChooser:true}`,
      );
    }
    pendingFileChoosers.delete(chooserId);
    try {
      await pending.session.send("DOM.enable").catch(() => {});
      await pending.session.send("DOM.setFileInputFiles", {
        backendNodeId: pending.backendNodeId,
        files,
      });
    } catch (e) {
      throw toolError(
        "browser.action_failed",
        `file chooser feed failed: ${String((e as Error)?.message ?? e)}`,
      );
    } finally {
      await pending.release().catch(() => {});
    }
    return {
      ok: true,
      files: files.length,
      fileNames: files.map(pathBaseName),
      fileChooser: true,
      ...(pending.mode !== undefined ? { mode: pending.mode } : {}),
      resolvedTabId: pending.tabId,
    };
  }
  // pz refs resolve straight to a backendNodeId — no content-script
  // marker needed (it could never reach a closed shadow root anyway).
  const sifRef = str(args.ref);
  if (sifRef !== undefined && PIERCE_REF_RE.test(sifRef)) {
    if (frameId !== 0) {
      throw toolError("proto.invalid", "pierce refs carry their own frame — drop args.frameId");
    }
    if (str(args.selector) !== undefined || str(args.label) !== undefined) {
      throw toolError("proto.invalid", "a pierce ref cannot be combined with selector/label");
    }
    cdpRequired(deps);
    const hit = pierceHit(tabId, sifRef);
    const { session, release } = await pierceAcquire(deps, hit);
    try {
      await session.send("DOM.setFileInputFiles", { backendNodeId: hit.backendNodeId, files });
    } finally {
      await release();
    }
    return {
      ok: true,
      files: files.length,
      fileNames: files.map(pathBaseName),
      pierced: true,
      resolvedTabId: tabId,
    };
  }
  if (str(args.ref) === undefined && str(args.selector) === undefined && str(args.label) === undefined) {
    throw toolError("proto.invalid", "browser.page.setInputFiles requires args.ref, args.selector or args.label");
  }
  cdpRequired(deps); // fail proto.unsupported before any page work

  // The content script marks the resolved element with a unique
  // attribute, then the pierced DOM tree finds it — frame-scoped
  // selectors cannot cross document boundaries, and buildElementSelector
  // paths cannot cross shadow boundaries either. Works for same-process
  // iframes and shadow DOM; out-of-process frames are invisible to this
  // tab's DOM agent and fall through to their own debugger target.
  const markerAttr = "data-chromex-ftp";
  const markerValue = `ftp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  const markRes = (await deps.sendToTab(tabId, {
    type: "page.dom.mark",
    attr: markerAttr,
    value: markerValue,
    ...(str(args.ref) ? { targetRef: str(args.ref) } : {}),
    ...(str(args.selector) ? { selector: str(args.selector) } : {}),
    ...(str(args.label) ? { label: str(args.label) } : {}),
  }, { frameId })) as { found?: boolean; reason?: string; count?: number };
  if (markRes?.found !== true) {
    if (markRes?.reason === "ambiguous") {
      throw toolError("browser.ambiguous_target", `target matches ${markRes.count ?? "multiple"} elements`);
    }
    throw toolError("browser.element_not_found", "no element matched ref/selector/label — take a fresh browser.page.snapshot and target a returned ref/label instead of guessing selectors");
  }

  const { session, release } = await cdpAcquire(deps, tabId);
  try {
    await session.send("DOM.enable");
    const doc = (await session.send("DOM.getDocument", {
      depth: -1,
      pierce: true,
    })) as { root?: CdpDomNode };
    let nodeId = findMarkedNodeId(doc?.root, markerAttr, markerValue);
    let oopifHandled = false;
    if (nodeId === undefined && deps.acquireCdpTarget && deps.releaseCdpTarget && deps.listCdpTargets) {
      // Out-of-process iframe: invisible to the tab's DOM agent, but
      // it is its own debugger target whose DOM sees only its own
      // document. Match the frame's URL to an iframe target.
      oopifHandled = await setInputFilesViaFrameTarget(
        deps, tabId, args, frameId, files, markerAttr, markerValue,
      );
    }
    if (!oopifHandled && nodeId === undefined) {
      throw toolError(
        "browser.element_not_found",
        "marked element not visible to the DOM domain (out-of-process iframe?)",
      );
    }
    if (!oopifHandled) {
      await session.send("DOM.setFileInputFiles", { nodeId: nodeId as number, files });
    }
  } finally {
    await release();
    // best-effort cleanup — a leftover attribute is harmless but untidy
    try {
      await deps.sendToTab(tabId, {
        type: "page.dom.mark",
        attr: markerAttr,
        value: null,
        ...(str(args.ref) ? { targetRef: str(args.ref) } : {}),
        ...(str(args.selector) ? { selector: str(args.selector) } : {}),
        ...(str(args.label) ? { label: str(args.label) } : {}),
      }, { frameId });
    } catch {
      // ignore cleanup failure
    }
  }
  return {
    ok: true,
    files: files.length,
    fileNames: files.map(pathBaseName),
    resolvedTabId: tabId,
  };
}

// ---- browser.page.responseBody ----------------------------------------------

interface NetworkTapEntry {
  /** Public unique id — the session-namespaced key (`tab:<id>` /
   *  `f<target>:<id>`). Raw CDP requestIds collide across sessions, so
   *  the namespaced form is what callers must pass back. */
  requestId: string;
  /** Raw CDP requestId on the owning session — what
   *  Network.getResponseBody expects. */
  cdpId: string;
  method: string;
  url: string;
  type: string;
  status?: number;
  mimeType?: string;
  ts: number;
  finished: boolean;
  failed?: boolean;
  /** session that observed this request — OOPIF traffic lives on the
   *  frame target's own Network domain, not the tab session's. */
  owner?: CdpSession;
}

interface WsFrameEntry {
  dir: "sent" | "recv";
  /** text payload, or base64 when opcode is binary — truncated */
  data: string;
  binary: boolean;
  opcode?: number;
  truncated?: boolean;
  ts: number;
}

interface WsTapEntry {
  /** Public unique id — session-namespaced like NetworkTapEntry. */
  requestId: string;
  url: string;
  ts: number;
  closed: boolean;
  frames: WsFrameEntry[];
}

const NETWORK_TAP_CAP = 300;
const WS_TAP_CAP = 50;
const WS_FRAMES_PER_CONN_CAP = 200;
const WS_FRAME_MAX_BYTES = 8 * 1024;
const RESPONSE_BODY_DEFAULT_MAX = 64 * 1024;
const RESPONSE_BODY_MAX = 256 * 1024;

/** Per-tab CDP network tap. The session is held (never released) for the
 *  tab's lifetime: response bodies are only retrievable for requests the
 *  session observed, so the tap must stay attached to keep capturing.
 *  Cleared on SW restart (module state) — the next call re-taps and the
 *  buffer honestly restarts. Tab close is handled by cdp.ts state GC +
 *  the getTab liveness check in the tool case. */
interface NetworkTap {
  session: CdpSession;
  entries: NetworkTapEntry[];
  sockets: WsTapEntry[];
  since: number;
  /** session.on unsubscribe fns — chrome.debugger.onEvent listeners
   *  otherwise outlive the tab and accumulate per tap. */
  unsubs: Array<() => void>;
  /** OOPIF frame-target taps keyed by debugger targetId. The tab
   *  session's Network domain cannot see out-of-process iframe
   *  requests — each OOPIF has its own Network agent on its own
   *  target (verified: tab tap misses cross-origin frame fetches). */
  frames: Map<string, { session: CdpSession; unsubs: Array<() => void>; release: (() => Promise<void>) | undefined }>;
  /** wires one session's Network events into the shared buffers —
   *  stored so syncOopifNetTaps can attach late-discovered OOPIFs. */
  wireSession: (sess: CdpSession, tag: string) => Array<() => void>;
}
const networkTaps = new Map<number, NetworkTap>();

async function ensureNetworkTap(
  deps: ToolHostDeps,
  tabId: number,
): Promise<NetworkTap> {
  const existing = networkTaps.get(tabId);
  if (existing) {
    await syncOopifNetTaps(deps, tabId, existing);
    return existing;
  }
  const { session } = await cdpAcquire(deps, tabId);
  await session.send("Network.enable");
  const entries: NetworkTapEntry[] = [];
  const sockets: WsTapEntry[] = [];
  // requestIds are session-scoped — two CDP sessions can emit the
  // same id, so BOTH the internal maps and the public requestId key on
  // `${tag}:${requestId}`; the raw id is kept as cdpId for the
  // getResponseBody round-trip.
  const entryKeys = new Map<string, NetworkTapEntry>();
  const wsKeys = new Map<string, WsTapEntry>();

  /** Wire one session's Network events into the shared buffers.
   *  `tag` namespaces requestIds; `owner` stamps entries so
   *  getResponseBody goes back to the session that saw the request. */
  const wireSession = (sess: CdpSession, tag: string): Array<() => void> => {
    const key = (requestId: string) => `${tag}:${requestId}`;
    const unsubs: Array<() => void> = [];
    const upsert = (requestId: string, patch: Partial<NetworkTapEntry>) => {
      const k = key(requestId);
      let e = entryKeys.get(k);
      if (!e) {
        e = {
          requestId: k,
          cdpId: requestId,
          method: "",
          url: "",
          type: "",
          ts: Date.now(),
          finished: false,
          owner: sess,
          ...patch,
        };
        entryKeys.set(k, e);
        entries.push(e);
        if (entries.length > NETWORK_TAP_CAP) {
          const dropped = entries.splice(0, entries.length - NETWORK_TAP_CAP);
          for (const d of dropped) {
            for (const [ek, ev] of entryKeys) if (ev === d) entryKeys.delete(ek);
          }
        }
      } else {
        Object.assign(e, patch);
      }
    };
    unsubs.push(sess.on("Network.requestWillBeSent", (p) => {
      const req = (p.request ?? {}) as { method?: string; url?: string };
      const requestId = typeof p.requestId === "string" ? p.requestId : "";
      if (!requestId) return;
      upsert(requestId, {
        method: typeof req.method === "string" ? req.method : "",
        url: typeof req.url === "string" ? req.url : "",
        type: typeof p.type === "string" ? p.type : "",
      });
    }));
    unsubs.push(sess.on("Network.responseReceived", (p) => {
      const requestId = typeof p.requestId === "string" ? p.requestId : "";
      const resp = (p.response ?? {}) as { url?: string; status?: number; mimeType?: string };
      if (!requestId) return;
      upsert(requestId, {
        ...(typeof resp.url === "string" ? { url: resp.url } : {}),
        ...(typeof resp.status === "number" ? { status: resp.status } : {}),
        ...(typeof resp.mimeType === "string" ? { mimeType: resp.mimeType } : {}),
      });
    }));
    unsubs.push(sess.on("Network.loadingFinished", (p) => {
      const requestId = typeof p.requestId === "string" ? p.requestId : "";
      if (requestId) upsert(requestId, { finished: true });
    }));
    unsubs.push(sess.on("Network.loadingFailed", (p) => {
      const requestId = typeof p.requestId === "string" ? p.requestId : "";
      if (requestId) upsert(requestId, { finished: true, failed: true });
    }));
    // WebSocket connections + frames (browser.page.webSocket). CDP reports
    // opcode 1=text / 2=binary; `data` is the payload text (binary frames
    // arrive base64-encoded by the protocol). Bounded per-connection and
    // per-tap so a chatty socket cannot grow memory without limit.
    const wsUpsert = (requestId: string, url: string) => {
      const k = key(requestId);
      let s = wsKeys.get(k);
      if (!s) {
        s = { requestId: k, url, ts: Date.now(), closed: false, frames: [] };
        wsKeys.set(k, s);
        sockets.push(s);
        if (sockets.length > WS_TAP_CAP) {
          const dropped = sockets.splice(0, sockets.length - WS_TAP_CAP);
          for (const d of dropped) {
            for (const [wk, wv] of wsKeys) if (wv === d) wsKeys.delete(wk);
          }
        }
      } else if (url && !s.url) {
        s.url = url;
      }
      return s;
    };
    const wsFrame = (dir: "sent" | "recv") => (p: Record<string, unknown>) => {
      const requestId = typeof p.requestId === "string" ? p.requestId : "";
      if (!requestId) return;
      const resp = (p.response ?? {}) as { opcode?: number; payloadData?: string; data?: string };
      const s = wsKeys.get(key(requestId));
      if (!s || s.frames.length >= WS_FRAMES_PER_CONN_CAP) return;
      const raw = typeof resp.payloadData === "string" ? resp.payloadData
        : typeof resp.data === "string" ? resp.data : "";
      const truncated = raw.length > WS_FRAME_MAX_BYTES;
      s.frames.push({
        dir,
        data: truncated ? raw.slice(0, WS_FRAME_MAX_BYTES) : raw,
        binary: resp.opcode === 2,
        ...(typeof resp.opcode === "number" ? { opcode: resp.opcode } : {}),
        ts: Date.now(),
        ...(truncated ? { truncated: true } : {}),
      });
    };
    unsubs.push(sess.on("Network.webSocketCreated", (p) => {
      const requestId = typeof p.requestId === "string" ? p.requestId : "";
      const url = typeof p.url === "string" ? p.url : "";
      if (requestId) wsUpsert(requestId, url);
    }));
    unsubs.push(sess.on("Network.webSocketFrameSent", wsFrame("sent")));
    unsubs.push(sess.on("Network.webSocketFrameReceived", wsFrame("recv")));
    unsubs.push(sess.on("Network.webSocketClosed", (p) => {
      const requestId = typeof p.requestId === "string" ? p.requestId : "";
      const s = requestId ? wsKeys.get(key(requestId)) : undefined;
      if (s) s.closed = true;
    }));
    return unsubs;
  };

  const unsubs = wireSession(session, "tab");
  const tap: NetworkTap = {
    session, entries, sockets, since: Date.now(), unsubs,
    frames: new Map(),
    wireSession,
  };
  networkTaps.set(tabId, tap);
  await syncOopifNetTaps(deps, tabId, tap);
  return tap;
}

/** Match subframes to their OOPIF debugger targets by URL — the same
 *  association rule as cdpAcquireForFrame (webNavigation frame URL ===
 *  debugger target URL, type iframe/other). Returns null when
 *  frame/target listing is unavailable or fails — callers must NOT
 *  treat null as "no OOPIFs" (that would prune live taps). */
async function matchOopifFrameTargets(
  deps: ToolHostDeps,
  tabId: number,
): Promise<Array<{ frame: { frameId?: number; parentFrameId?: number; url?: string }; target: { id: string; type?: string; url?: string } }> | null> {
  if (!deps.listFrames || !deps.listCdpTargets) return null;
  const frames = await deps.listFrames(tabId).catch(() => null);
  const targets = await deps.listCdpTargets().catch(() => null);
  if (!frames || !targets) return null;
  const out: Array<{ frame: { frameId?: number; parentFrameId?: number; url?: string }; target: { id: string; type?: string; url?: string } }> = [];
  for (const frame of frames) {
    // main frame has no parentFrameId — subframes only
    if (frame.parentFrameId === undefined) continue;
    if (!frame.url) continue;
    const target = targets.find(
      (t) => (t.type === "iframe" || t.type === "other") && t.url === frame.url,
    );
    if (target) out.push({ frame, target });
  }
  return out;
}

/** Attach Network taps to this tab's out-of-process iframe targets.
 *  Same-process subframes share the tab session and need no extra tap.
 *  Called on tap creation and on every responseBody/webSocket read so
 *  late-mounting OOPIFs get covered. Missing frame-target deps degrade
 *  honestly to tab-only coverage. */
async function syncOopifNetTaps(
  deps: ToolHostDeps,
  tabId: number,
  tap: NetworkTap,
): Promise<void> {
  if (!deps.acquireCdpTarget) return;
  const matches = await matchOopifFrameTargets(deps, tabId);
  if (!matches) return;
  const liveTargetIds = new Set<string>();
  for (const { target } of matches) {
    liveTargetIds.add(target.id);
    if (tap.frames.has(target.id)) continue;
    try {
      const fs = await deps.acquireCdpTarget(target.id);
      await fs.send("Network.enable");
      const fUnsubs = tap.wireSession(fs, `f${target.id}`);
      tap.frames.set(target.id, {
        session: fs,
        unsubs: fUnsubs,
        release: deps.releaseCdpTarget
          ? () => deps.releaseCdpTarget!(target.id)
          : undefined,
      });
    } catch {
      // frame target raced away (navigation/close) — skip honestly;
      // the next sync retries if it reappears
    }
  }
  // Prune frame taps whose debugger target vanished (OOPIF navigated
  // cross-origin → new targetId, or frame removed). Re-acquire happens
  // on the next sync if the frame reappears under a new target.
  for (const [targetId, f] of tap.frames) {
    if (liveTargetIds.has(targetId)) continue;
    for (const un of f.unsubs) un();
    await f.session.send("Network.disable").catch(() => {});
    await f.release?.().catch(() => {});
    tap.frames.delete(targetId);
  }
}

function decodeBody(
  body: string,
  base64Encoded: boolean,
  maxBytes: number,
): { text: string; bytes: number; truncated: boolean } {
  if (!base64Encoded) {
    const truncated = body.length > maxBytes;
    return { text: truncated ? body.slice(0, maxBytes) : body, bytes: body.length, truncated };
  }
  try {
    // decode only the prefix needed — bodies can be large
    const neededChars = Math.ceil((maxBytes * 4) / 3) + 4;
    const slice = body.slice(0, Math.min(body.length, neededChars));
    const bin = atob(slice);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const truncated = body.length > neededChars;
    return {
      text: new TextDecoder("utf-8", { fatal: false }).decode(bytes),
      bytes: bytes.length,
      truncated,
    };
  } catch {
    return { text: "", bytes: 0, truncated: false };
  }
}

async function pageResponseBody(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tab = await deps.getTab(tabId);
  if (!tab) {
    networkTaps.delete(tabId);
    throw toolError("browser.no_tab", `tab ${tabId} not found`);
  }
  const tap = await ensureNetworkTap(deps, tabId);
  const requestId = str(args.requestId);
  const urlContains = str(args.urlContains);
  const maxBytes = clampMs(args.maxBytes, RESPONSE_BODY_DEFAULT_MAX, RESPONSE_BODY_MAX);

  const toPublic = (e: NetworkTapEntry) => ({
    requestId: e.requestId,
    method: e.method,
    url: urlOriginPath(e.url),
    ...(e.type ? { type: e.type } : {}),
    ...(typeof e.status === "number" ? { status: e.status } : {}),
    ...(e.mimeType ? { mimeType: e.mimeType } : {}),
    finished: e.finished,
    ...(e.failed ? { failed: true } : {}),
    ts: e.ts,
  });

  if (requestId !== undefined) {
    const entry = [...tap.entries].reverse().find((e) => e.requestId === requestId);
    if (!entry) {
      throw toolError("browser.not_found", `no captured request with requestId ${requestId}`);
    }
    if (entry.failed) {
      throw toolError("browser.action_failed", `request ${requestId} failed; no response body`);
    }
    if (!entry.finished) {
      throw toolError("browser.action_failed", `request ${requestId} has not finished loading`);
    }
    // OOPIF requests live on the frame target's session — getResponseBody
    // must go back to the session that observed them.
    const res = (await (entry.owner ?? tap.session).send("Network.getResponseBody", { requestId: entry.cdpId })) as {
      body?: string;
      base64Encoded?: boolean;
    };
    if (typeof res?.body !== "string") {
      throw toolError("browser.action_failed", `no response body available for ${requestId}`);
    }
    const decoded = decodeBody(res.body, res.base64Encoded === true, maxBytes);
    return {
      ...toPublic(entry),
      body: decoded.text,
      bodyBytes: decoded.bytes,
      truncated: decoded.truncated,
      resolvedTabId: tabId,
    };
  }

  const limit = clampMs(args.limit, 50, 200);
  const filtered = tap.entries.filter(
    (e) => urlContains === undefined || e.url.includes(urlContains),
  );
  return {
    requests: filtered.slice(-limit).map(toPublic),
    capturingSince: tap.since,
    resolvedTabId: tabId,
  };
}

// ---- browser.page.webSocket ----------------------------------------------

async function pageWebSocket(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tab = await deps.getTab(tabId);
  if (!tab) {
    networkTaps.delete(tabId);
    throw toolError("browser.no_tab", `tab ${tabId} not found`);
  }
  const tap = await ensureNetworkTap(deps, tabId);
  const urlContains = str(args.urlContains);
  const frameLimit = clampMs(args.frameLimit, 50, WS_FRAMES_PER_CONN_CAP);
  const requestId = str(args.requestId);

  const toPublic = (s: WsTapEntry, withFrames: boolean) => ({
    requestId: s.requestId,
    url: urlOriginPath(s.url),
    ts: s.ts,
    closed: s.closed,
    frameCount: s.frames.length,
    ...(withFrames
      ? {
          frames: s.frames.slice(-frameLimit).map((f) => ({
            dir: f.dir,
            data: f.data,
            binary: f.binary,
            ...(typeof f.opcode === "number" ? { opcode: f.opcode } : {}),
            ...(f.truncated ? { truncated: true } : {}),
            ts: f.ts,
          })),
        }
      : {}),
  });

  if (requestId !== undefined) {
    const s = [...tap.sockets].reverse().find((x) => x.requestId === requestId);
    if (!s) {
      throw toolError("browser.not_found", `no captured WebSocket with requestId ${requestId}`);
    }
    return { ...toPublic(s, true), capturingSince: tap.since, resolvedTabId: tabId };
  }

  const limit = clampMs(args.limit, 20, WS_TAP_CAP);
  const filtered = tap.sockets.filter(
    (s) => urlContains === undefined || s.url.includes(urlContains),
  );
  return {
    sockets: filtered.slice(-limit).map((s) => toPublic(s, false)),
    capturingSince: tap.since,
    resolvedTabId: tabId,
  };
}

// ---- browser.page.cookies (CDP Network cookie storage) -----------------
// Cookie storage is browser-level and includes HttpOnly cookies — the
// thing document.cookie can never see. list defaults to metadata only;
// values require the classifier's per-call approval (credential-grade).

interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires?: number;
  size?: number;
  httpOnly?: boolean;
  secure?: boolean;
  session?: boolean;
  sameSite?: string;
}

function cookieScopeUrl(tab: chrome.tabs.Tab, args: Record<string, unknown>): string {
  const explicit = str(args.url);
  if (explicit) return explicit;
  const pageUrl = typeof tab.url === "string" && tab.url ? tab.url : tab.pendingUrl;
  if (typeof pageUrl === "string" && /^https?:/.test(pageUrl)) return pageUrl;
  throw toolError("proto.invalid", "browser.page.cookies requires args.url (page URL is not http(s))");
}

function toPublicCookie(c: CdpCookie, includeValues: boolean): Record<string, unknown> {
  return {
    name: c.name,
    domain: c.domain,
    path: c.path,
    ...(typeof c.expires === "number" && c.expires > 0 ? { expires: c.expires } : { session: true }),
    ...(c.httpOnly ? { httpOnly: true } : {}),
    ...(c.secure ? { secure: true } : {}),
    ...(c.sameSite ? { sameSite: c.sameSite } : {}),
    ...(includeValues ? { value: c.value } : {}),
  };
}

async function pageCookies(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const tab = await deps.getTab(tabId);
  if (!tab) throw toolError("browser.no_tab", `tab ${tabId} not found`);
  const { session, release } = await cdpAcquire(deps, tabId);
  try {
    const action = str(args.action) ?? "list";
    if (!["list", "set", "delete", "clear"].includes(action)) {
      throw toolError("proto.invalid", "browser.page.cookies args.action must be list|set|delete|clear");
    }
    const domain = str(args.domain);
    const path = str(args.path);
    const name = str(args.name);

    if (action === "list") {
      const url = cookieScopeUrl(tab, args);
      const res = (await session.send("Network.getCookies", { urls: [url] })) as {
        cookies?: CdpCookie[];
      };
      const includeValues = args.includeValues === true;
      return {
        url,
        cookies: (res.cookies ?? []).map((c) => toPublicCookie(c, includeValues)),
        ...(includeValues ? {} : { valuesWithheld: true }),
        resolvedTabId: tabId,
      };
    }

    if (action === "set") {
      if (!name || typeof args.value !== "string") {
        throw toolError("proto.invalid", "browser.page.cookies set requires args.name and args.value");
      }
      const url = str(args.url) ?? (domain ? undefined : cookieScopeUrl(tab, args));
      if (!url && !domain) {
        throw toolError("proto.invalid", "browser.page.cookies set requires args.url or args.domain");
      }
      const sameSite = str(args.sameSite);
      if (sameSite && !["Strict", "Lax", "None"].includes(sameSite)) {
        throw toolError("proto.invalid", "browser.page.cookies args.sameSite must be Strict|Lax|None");
      }
      const expires = typeof args.expires === "number" && Number.isFinite(args.expires) && args.expires > 0
        ? args.expires
        : undefined;
      const res = (await session.send("Network.setCookie", {
        name,
        value: args.value,
        ...(url ? { url } : {}),
        ...(domain ? { domain } : {}),
        ...(path ? { path } : {}),
        ...(args.secure === true ? { secure: true } : {}),
        ...(args.httpOnly === true ? { httpOnly: true } : {}),
        ...(sameSite ? { sameSite } : {}),
        ...(expires !== undefined ? { expires } : {}),
      })) as { success?: boolean };
      if (res.success !== true) {
        throw toolError("browser.action_failed", "Network.setCookie reported failure");
      }
      return { set: true, name, resolvedTabId: tabId };
    }

    if (action === "delete") {
      if (!name) {
        throw toolError("proto.invalid", "browser.page.cookies delete requires args.name");
      }
      const url = str(args.url);
      if (!url && !domain) {
        throw toolError("proto.invalid", "browser.page.cookies delete requires args.url or args.domain");
      }
      await session.send("Network.deleteCookies", {
        name,
        ...(url ? { url } : {}),
        ...(domain ? { domain } : {}),
        ...(path ? { path } : {}),
      });
      return { deleted: name, resolvedTabId: tabId };
    }

    // clear — requires an explicit scope; never wipes the whole jar.
    if (!str(args.url) && !domain) {
      throw toolError("proto.invalid", "browser.page.cookies clear requires args.url or args.domain");
    }
    const scopeUrl = str(args.url);
    const listUrl = scopeUrl ?? (domain ? `https://${domain.replace(/^\./, "")}/` : undefined);
    if (!listUrl) {
      throw toolError("proto.invalid", "browser.page.cookies clear requires args.url or args.domain");
    }
    const res = (await session.send("Network.getCookies", { urls: [listUrl] })) as {
      cookies?: CdpCookie[];
    };
    const targets = (res.cookies ?? []).filter(
      (c) => !domain || c.domain.replace(/^\./, "").endsWith(domain.replace(/^\./, "")),
    );
    for (const c of targets) {
      await session.send("Network.deleteCookies", {
        name: c.name,
        domain: c.domain,
        path: c.path,
      });
    }
    return { cleared: targets.length, resolvedTabId: tabId };
  } finally {
    await release();
  }
}
