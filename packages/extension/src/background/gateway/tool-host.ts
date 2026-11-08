/**
 * Browser tool host — executes `browser.tool.request` envelopes that
 * the Gateway pushes to this extension (P1-09 §9.2 step 4).
 *
 * Maps the §9 tool surface onto existing primitives:
 *  - tabs.*        → chrome.tabs
 *  - page.snapshot/get → page.dom.snapshot / chrome.tabs.get
 *  - page.click/focus/fill/select/submit/type/scroll/navigate
 *                → page.dom.perform steps (same engine as planner path)
 *  - page.wait     → bounded sleep
 *  - extract/screenshot/upload → proto.unsupported (not yet implemented;
 *    never fake a result)
 *
 * Args convention: `tabId` optional → active tab of current window;
 * element targeting uses `ref` (from a prior page.snapshot) or
 * `selector`/`label`.
 */

import { SnapshotRegistry, urlOriginPath } from "@codex-sidepanel/shared";
import type {
  BrowserDomActionResult,
  BrowserDomSnapshot,
  BrowserExpectCondition,
} from "@codex-sidepanel/shared";

import { chromexConsoleCollect } from "../../content/console-capture.js";
import type { CdpSession } from "../cdp.js";

export interface ToolHostDeps {
  /** chrome.tabs.captureVisibleTab → data:image/...;base64 URL.
   *  `opts.quality` (jpeg only) lets the screenshot path retry at lower
   *  quality when the first capture exceeds the artifact byte cap. */
  captureVisibleTab?(windowId: number, opts?: { quality?: number }): Promise<string>;
  /** chrome.tabs.create — open a new tab (browser.tab.create, chromex-he2) */
  createTab?(opts: { url?: string; active?: boolean; windowId?: number; pinned?: boolean; muted?: boolean }): Promise<chrome.tabs.Tab>;
  /** chrome.tabs.update — tab.update tool (pinned/muted). */
  updateTab?(tabId: number, opts: { pinned?: boolean; muted?: boolean }): Promise<unknown>;
  /** chrome.tabs.discard — tab.discard tool (memory hygiene). */
  discardTab?(tabId: number): Promise<unknown>;
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
  /** chrome.tabs.goBack/goForward/reload (browser.page.history) */
  navigateHistory?(tabId: number, action: "back" | "forward" | "reload"): Promise<unknown>;
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
    tabs?: Array<{ id?: number | undefined; url?: string | undefined; title?: string | undefined; active?: boolean | undefined }> | undefined;
  }>;
  updateWindow?(windowId: number, opts: { focused?: boolean; state?: string }): Promise<unknown>;
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
  activateTab(tabId: number): Promise<void>;
  closeTab(tabId: number): Promise<void>;
  activeTabId(): Promise<number | null>;
  /** chrome.debugger CDP tier (docs/adr/debugger-tier.md). Absent dep →
   *  every CDP-backed path (click args.trusted, page.dialog,
   *  page.setInputFiles, page.responseBody, snapshot mode:"aria")
   *  fails proto.unsupported — never silently degrades to untrusted. */
  acquireCdp?(tabId: number): Promise<CdpSession>;
  releaseCdp?(tabId: number): Promise<void>;
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
]);

const SUPPORTED = new Set([
  "browser.tabs.list",
  "browser.tab.activate",
  "browser.tab.close",
  "browser.tab.create",
  "browser.tab.duplicate",
  "browser.tab.update",
  "browser.tab.discard",
  "browser.page.snapshot",
  "browser.page.get",
  "browser.page.console",
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
  "browser.page.history",
  "browser.downloads.list",
  "browser.downloads.save",
  "browser.downloads.cancel",
  "browser.windows.list",
  "browser.windows.create",
  "browser.windows.update",
  "browser.page.network",
  "browser.page.dialog",
  "browser.page.setInputFiles",
  "browser.page.responseBody",
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

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
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

/** §6.2 snapshot metadata: TTL 5min, LRU 32/task — used by P2-02
 *  stale/verify semantics. Registry is per-extension-install. */
const snapshotRegistry = new SnapshotRegistry();

export function toolHostSnapshotRegistry(): SnapshotRegistry {
  return snapshotRegistry;
}

/** Mirrors the gateway artifact.upload decoded cap (512KiB) — keep in
 *  sync with packages/bridge/src/gateway/main.ts. */
const SCREENSHOT_MAX_DECODED_BYTES = 512 * 1024;
/** jpeg quality ladder tried after the dep's default capture. */
const SCREENSHOT_QUALITY_RETRY = [45, 25] as const;

function base64DecodedBytes(dataBase64: string): number {
  const padding = dataBase64.endsWith("==") ? 2 : dataBase64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((dataBase64.length * 3) / 4) - padding);
}

async function captureScreenshotWithinArtifactCap(
  capture: (windowId: number, opts?: { quality?: number }) => Promise<string>,
  windowId: number,
): Promise<{ mimeType: string; dataBase64: string }> {
  const attempt = async (quality?: number) => {
    const dataUrl = await capture(windowId, quality === undefined ? undefined : { quality });
    const m = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(dataUrl);
    if (!m) throw toolError("browser.action_failed", "captureVisibleTab returned unexpected format");
    return { mimeType: m[1]!, dataBase64: m[2]! };
  };
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

export function createToolHostHandler(deps: ToolHostDeps) {
  return async function handleToolRequest(payload: unknown): Promise<unknown> {
    const req = (payload ?? {}) as {
      toolCallId?: string;
      taskId?: string;
      turnId?: string;
      tool?: string;
      args?: Record<string, unknown>;
    };
    const tool = req.tool ?? "";
    const args = req.args ?? {};
    const tabScope = parseTabScope(payload);
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
            };
          }),
        };
      }
      case "browser.tab.activate": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        await deps.activateTab(tabId);
        return { activated: tabId, resolvedTabId: tabId };
      }
      case "browser.tab.close": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        await deps.closeTab(tabId);
        return { closed: tabId, resolvedTabId: tabId };
      }
      case "browser.tab.update": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const pinned = typeof args.pinned === "boolean" ? args.pinned : undefined;
        const muted = typeof args.muted === "boolean" ? args.muted : undefined;
        const zoomFactor =
          typeof args.zoomFactor === "number" && Number.isFinite(args.zoomFactor)
            ? args.zoomFactor
            : undefined;
        if (args.zoomFactor !== undefined && (zoomFactor === undefined || zoomFactor < 0.25 || zoomFactor > 5)) {
          throw toolError("proto.invalid", "browser.tab.update args.zoomFactor must be a number in [0.25, 5]");
        }
        if (pinned === undefined && muted === undefined && zoomFactor === undefined) {
          throw toolError("proto.invalid", "browser.tab.update requires args.pinned, args.muted and/or args.zoomFactor");
        }
        if ((pinned !== undefined || muted !== undefined) && !deps.updateTab) {
          throw toolError("proto.unsupported", "tab update is not available on this host");
        }
        if (zoomFactor !== undefined && !deps.setTabZoom) {
          throw toolError("proto.unsupported", "tab zoom is not available on this host");
        }
        if (pinned !== undefined || muted !== undefined) {
          await deps.updateTab!(tabId, {
            ...(pinned !== undefined ? { pinned } : {}),
            ...(muted !== undefined ? { muted } : {}),
          });
        }
        if (zoomFactor !== undefined) {
          await deps.setTabZoom!(tabId, zoomFactor);
        }
        return {
          updated: tabId,
          resolvedTabId: tabId,
          ...(pinned !== undefined ? { pinned } : {}),
          ...(muted !== undefined ? { muted } : {}),
          ...(zoomFactor !== undefined ? { zoomFactor } : {}),
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
          // CDP Accessibility.getFullAXTree — whole-page tree (all frames);
          // no DOM refs are minted, so args.frameId is meaningless here.
          if (frameId !== 0) {
            throw toolError("proto.invalid", "args.frameId is meaningless for snapshot mode aria");
          }
          const { session, release } = await cdpAcquire(deps, tabId);
          try {
            const res = (await session.send("Accessibility.getFullAXTree")) as { nodes?: AxNode[] };
            const formatted = formatAxTree(Array.isArray(res?.nodes) ? res.nodes : []);
            return {
              mode: "aria",
              tree: formatted.tree,
              nodeCount: formatted.nodeCount,
              truncated: formatted.truncated,
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
        const networkIdle = args.networkIdle === true;
        const hasCondition =
          str(args.text) !== undefined ||
          str(args.textGone) !== undefined ||
          str(args.selector) !== undefined ||
          str(args.selectorGone) !== undefined ||
          str(args.urlContains) !== undefined ||
          str(args.readyState) !== undefined ||
          str(args.visibleSelector) !== undefined;
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
          if (!hasCondition) {
            return { ok: true, matched: "networkIdle", resolvedTabId: tabId };
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
        const res = (await deps.sendToTab(tabId, {
          type: "page.dom.find",
          ...(text ? { text } : {}),
          ...(regex ? { regex } : {}),
          ...(args.caseSensitive === true ? { caseSensitive: true } : {}),
          limit,
          ...(str(args.scopeSelector) ? { scopeSelector: str(args.scopeSelector) } : {}),
        }, { frameId: frameIdArg(args) })) as { ok?: boolean; matches?: unknown[]; scanned?: number; truncated?: boolean };
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
      case "browser.page.dialog": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        return await handlePageDialog(deps, tabId, args);
      }
      case "browser.page.setInputFiles": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        return await setInputFiles(deps, tabId, args, frameIdArg(args));
      }
      case "browser.page.responseBody": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        return await pageResponseBody(deps, tabId, args);
      }
      case "browser.page.history": {
        const action = str(args.action);
        if (action !== "back" && action !== "forward" && action !== "reload") {
          throw toolError("proto.invalid", "browser.page.history requires args.action back|forward|reload");
        }
        if (!deps.navigateHistory) {
          throw toolError("proto.unsupported", "history navigation is not available on this host");
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        await deps.navigateHistory(tabId, action);
        return { navigated: action, resolvedTabId: tabId };
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
      case "browser.windows.list": {
        // Not tab-scoped: chrome.windows.getAll across normal windows.
        if (!deps.listWindows) {
          throw toolError("proto.unsupported", "window listing is not available on this host");
        }
        const windows = await deps.listWindows();
        return {
          windows: (Array.isArray(windows) ? windows : [])
            .filter((w) => w.id !== undefined)
            .map((w) => ({
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
            })),
        };
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
        const numArg = (key: string): number | undefined => {
          const v = args[key];
          return typeof v === "number" && Number.isFinite(v) ? v : undefined;
        };
        const win = await deps.createWindow({
          ...(url ? { url } : {}),
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
          tabs,
          ...(typeof firstTabId === "number" ? { openedTabId: firstTabId, tabId: firstTabId, resolvedTabId: firstTabId } : {}),
        };
      }
      case "browser.windows.update": {
        // Not tab-scoped: focus/state on an existing window.
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
        if (focused === undefined && state === undefined) {
          throw toolError("proto.invalid", "browser.windows.update requires args.focused or args.state");
        }
        await deps.updateWindow(windowId, {
          ...(focused !== undefined ? { focused } : {}),
          ...(state ? { state } : {}),
        });
        return { updated: windowId };
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
        let shot: { mimeType: string; dataBase64: string };
        if (hasElementTarget) {
          // Element clip via CDP Page.captureScreenshot — works on
          // chrome-extension only; subframe targets resolve through the
          // geometry chain. Element is scrolled into view first.
          shot = await captureElementScreenshot(deps, tabId, args, frameIdArg(args));
        } else {
          if (frameIdArg(args) !== 0) {
            // whole-tab capture is frame-agnostic — refuse rather than
            // silently ignore the scope the caller asked for
            throw toolError("proto.invalid", "args.frameId requires an element target (ref/selector/label) on browser.page.screenshot");
          }
          if (!deps.captureVisibleTab) {
            throw toolError("proto.unsupported", "screenshot capture is not available on this host");
          }
          const tab = await deps.getTab(tabId);
          if (typeof tab?.windowId !== "number") {
            throw toolError("browser.no_tab", `tab ${tabId} has no window`);
          }
          // chromex-22wi: the artifact store caps uploads at 512KiB decoded
          // (gateway artifact.upload). Retry at lower jpeg quality until
          // the capture fits — the same bytes are returned inline as
          // dataBase64 so the provider receives image input, not just a
          // reference it cannot resolve. Bounded egress: the tool is
          // already classified agentEgress "screenshot" upstream.
          shot = await captureScreenshotWithinArtifactCap(deps.captureVisibleTab, tab.windowId);
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
        const res = (await deps.sendToTab(tabId, {
          type: "page.extract",
          maxChars,
          ...(str(args.selector) ? { selector: str(args.selector) } : {}),
          ...(format ? { format } : {}),
        }, { frameId })) as { text?: string; truncated?: boolean; url?: string; title?: string; error?: string };
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
        if (tool === "browser.page.click" && args.trusted === true) {
          return await trustedClick(deps, tabId, args, expectCond, frameId);
        }
        // Keyboard trusted ops work in subframes too: the element is
        // focused through that frame's content script and CDP key
        // events follow the focused frame. Pointer ops also work in
        // subframes — element targets resolve to absolute viewport
        // coordinates via CDP DOM quads before dispatch.
        if (tool === "browser.page.press" && args.trusted === true) {
          return await trustedPress(deps, tabId, args, expectCond, frameId);
        }
        if (tool === "browser.page.type" && args.trusted === true) {
          return await trustedType(deps, tabId, args, expectCond, frameId);
        }
        if (tool === "browser.page.fill" && args.trusted === true) {
          return await trustedFill(deps, tabId, args, expectCond, frameId);
        }
        if (tool === "browser.page.hover" && args.trusted === true) {
          return await trustedHover(deps, tabId, args, expectCond, frameId);
        }
        if (tool === "browser.page.drag" && args.trusted === true) {
          return await trustedDrag(deps, tabId, args, expectCond, frameId);
        }
        // args.trusted is a CDP-tier opt-in — never silently ignored on
        // tools that have no trusted path.
        if (args.trusted === true) {
          throw toolError(
            "proto.unsupported",
            `args.trusted is not supported for ${tool} (trusted input exists only for click, press, type, fill, hover and drag)`,
          );
        }
        const step = domStepFor(tool, args);
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
        return {
          ok: true,
          summary: result.summary,
          step: first,
          ...(verified !== undefined ? { verified } : {}),
          ...(expectInfo ? { expect: expectInfo } : {}),
          resolvedTabId: tabId,
        };
      }
    }
  };
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
  return { session, release: () => cdp.release(tabId) };
}

interface AxNode {
  nodeId?: string;
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
  childIds?: string[];
}

const AX_MAX_LINES = 400;
const AX_SKIP_ROLES = new Set(["none", "generic", "InlineTextBox"]);

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

/** Locate an element target in the top frame via the content script and
 *  return its viewport-center point + a querySelector-able selector. */
async function cdpLocatePoint(
  deps: ToolHostDeps,
  tabId: number,
  target: { ref?: string | undefined; selector?: string | undefined; label?: string | undefined },
  frameId = 0,
  scrollIntoView = false,
): Promise<{ x: number; y: number; width?: number; height?: number; selector: string }> {
  const loc = (await deps.sendToTab(tabId, {
    type: "page.dom.locate",
    ...(target.ref ? { targetRef: target.ref } : {}),
    ...(target.selector ? { selector: target.selector } : {}),
    ...(target.label ? { label: target.label } : {}),
    ...(scrollIntoView ? { scrollIntoView: true } : {}),
  }, { frameId })) as {
    found?: boolean; reason?: string; count?: number;
    x?: number; y?: number; width?: number; height?: number; selector?: string;
  };
  if (loc?.found !== true || typeof loc.x !== "number" || typeof loc.y !== "number" || typeof loc.selector !== "string") {
    if (loc?.reason === "ambiguous") {
      throw toolError("browser.ambiguous_target", `target matches ${loc.count ?? "multiple"} elements`);
    }
    throw toolError("browser.element_not_found", "no element matched ref/selector/label");
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
): Promise<{ x: number; y: number; width?: number; height?: number; selector: string }> {
  return cdpLocatePoint(deps, tabId, {
    ref: str(args.ref),
    selector: str(args.selector),
    label: str(args.label),
  }, frameId, scrollIntoView);
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
): Promise<{ x: number; y: number; width?: number; height?: number; selector?: string }> {
  const res = (await deps.sendToTab(tabId, {
    type: "page.geom.absolute",
    ...(target.ref ? { targetRef: target.ref } : {}),
    ...(target.selector ? { selector: target.selector } : {}),
    ...(target.label ? { label: target.label } : {}),
    ...(scrollIntoView ? { scrollIntoView: true } : {}),
  }, { frameId })) as {
    found?: boolean; reason?: string; count?: number;
    x?: number; y?: number; width?: number; height?: number; selector?: string;
  };
  if (res?.found !== true || typeof res.x !== "number" || typeof res.y !== "number") {
    if (res?.reason === "ambiguous") {
      throw toolError("browser.ambiguous_target", `target matches ${res.count ?? "multiple"} elements`);
    }
    if (res?.reason === "frame_geometry_unavailable") {
      throw toolError("browser.timeout", "could not resolve iframe geometry for trusted dispatch");
    }
    throw toolError("browser.element_not_found", "no element matched ref/selector/label");
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

  const point = xArg !== undefined
    ? { x: xArg, y: yArg! }
    : frameId !== 0
      ? await frameAbsolutePoint(deps, tabId, {
          ref: str(args.ref), selector: str(args.selector), label: str(args.label),
        }, frameId)
      : await cdpLocateElement(deps, tabId, args);

  const { session, release } = await cdpAcquire(deps, tabId);
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
  return {
    ok: true,
    summary: `trusted click at ${Math.round(point.x)},${Math.round(point.y)}`,
    step: { action: "click", trusted: true, x: point.x, y: point.y, ok: true, frameId },
    ...(verified !== undefined ? { verified } : {}),
    ...(expectInfo ? { expect: expectInfo } : {}),
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
  const point = xArg !== undefined
    ? { x: xArg, y: yArg! }
    : frameId !== 0
      ? await frameAbsolutePoint(deps, tabId, {
          ref: str(args.ref), selector: str(args.selector), label: str(args.label),
        }, frameId)
      : await cdpLocateElement(deps, tabId, args);

  const { session, release } = await cdpAcquire(deps, tabId);
  try {
    await session.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
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
    summary: `trusted hover at ${Math.round(point.x)},${Math.round(point.y)}`,
    step: { action: "hover", trusted: true, x: point.x, y: point.y, ok: true, frameId },
    ...(verified !== undefined ? { verified } : {}),
    ...(expectInfo ? { expect: expectInfo } : {}),
    resolvedTabId: tabId,
  };
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
): Promise<Record<string, unknown>> {
  const coordFields = [args.x, args.y, args.dropX, args.dropY];
  const coordCount = coordFields.filter((v) => v !== undefined && v !== null).length;
  let from: { x: number; y: number };
  let to: { x: number; y: number };
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
    if (frameId !== 0) {
      from = await frameAbsolutePoint(deps, tabId, srcTarget, frameId);
      to = await frameAbsolutePoint(deps, tabId, dstTarget, frameId);
    } else {
      const src = await cdpLocatePoint(deps, tabId, srcTarget);
      const dst = await cdpLocatePoint(deps, tabId, dstTarget);
      from = { x: src.x, y: src.y };
      to = { x: dst.x, y: dst.y };
    }
  }
  cdpRequired(deps);

  const { session, release } = await cdpAcquire(deps, tabId);
  try {
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
): Promise<void> {
  const hasTarget = str(args.ref) !== undefined || str(args.selector) !== undefined || str(args.label) !== undefined;
  if (!hasTarget) return;
  const loc = await cdpLocateElement(deps, tabId, args, frameId);
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
  await cdpFocusTarget(deps, tabId, args, frameId);

  const { session, release } = await cdpAcquire(deps, tabId);
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
): Promise<Record<string, unknown>> {
  const text = str(args.text) ?? str(args.value);
  if (text === undefined || text.length === 0) {
    throw toolError("proto.invalid", "browser.page.type requires args.text");
  }
  const keys = cdpResolveTypeText("browser.page.type", text);
  cdpRequired(deps);
  await cdpFocusTarget(deps, tabId, args, frameId);

  const { session, release } = await cdpAcquire(deps, tabId);
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
): Promise<Record<string, unknown>> {
  const text = str(args.text) ?? str(args.value);
  if (text === undefined) {
    throw toolError("proto.invalid", "browser.page.fill requires args.text");
  }
  const keys = cdpResolveTypeText("browser.page.fill", text);
  const del = CDP_NAMED_KEYS["backspace"];
  if (!del) throw toolError("proto.invalid", "internal: fill key definitions missing");
  cdpRequired(deps);
  // fill always targets an element — focus is mandatory, not optional
  const loc = await cdpLocateElement(deps, tabId, args, frameId);
  await cdpFocusTarget(deps, tabId, args, frameId);
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

  const { session, release } = await cdpAcquire(deps, tabId);
  try {
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

async function setInputFiles(
  deps: ToolHostDeps,
  tabId: number,
  args: Record<string, unknown>,
  frameId = 0,
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
  if (str(args.ref) === undefined && str(args.selector) === undefined && str(args.label) === undefined) {
    throw toolError("proto.invalid", "browser.page.setInputFiles requires args.ref, args.selector or args.label");
  }
  cdpRequired(deps); // fail proto.unsupported before any page work

  // Subframe targets: the content script marks the resolved element
  // with a unique attribute, then the pierced DOM tree finds it —
  // frame-scoped selectors cannot cross document boundaries. Works for
  // same-process iframes; out-of-process frames are invisible to this
  // tab's DOM agent and fail browser.element_not_found honestly.
  const markerAttr = "data-chromex-ftp";
  const markerValue = frameId !== 0
    ? `ftp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
    : null;
  if (markerValue !== null) {
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
      throw toolError("browser.element_not_found", "no element matched ref/selector/label");
    }
  }

  const { session, release } = await cdpAcquire(deps, tabId);
  try {
    await session.send("DOM.enable");
    let nodeId: number | undefined;
    if (markerValue !== null) {
      const doc = (await session.send("DOM.getDocument", {
        depth: -1,
        pierce: true,
      })) as { root?: CdpDomNode };
      nodeId = findMarkedNodeId(doc?.root, markerAttr, markerValue);
      if (nodeId === undefined) {
        throw toolError(
          "browser.element_not_found",
          "marked element not visible to the DOM domain (out-of-process iframe?)",
        );
      }
    } else {
      const target = await cdpLocateElement(deps, tabId, args);
      const doc = (await session.send("DOM.getDocument", { depth: 1 })) as { root?: { nodeId?: number } };
      const rootId = doc?.root?.nodeId;
      if (typeof rootId !== "number") {
        throw toolError("browser.action_failed", "DOM.getDocument returned no root node");
      }
      const q = (await session.send("DOM.querySelector", {
        nodeId: rootId,
        selector: target.selector,
      })) as { nodeId?: number };
      if (typeof q?.nodeId !== "number") {
        throw toolError("browser.element_not_found", "target selector did not resolve in the DOM domain");
      }
      nodeId = q.nodeId;
    }
    await session.send("DOM.setFileInputFiles", { nodeId, files });
  } finally {
    await release();
    if (markerValue !== null) {
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
  requestId: string;
  method: string;
  url: string;
  type: string;
  status?: number;
  mimeType?: string;
  ts: number;
  finished: boolean;
  failed?: boolean;
}

const NETWORK_TAP_CAP = 300;
const RESPONSE_BODY_DEFAULT_MAX = 64 * 1024;
const RESPONSE_BODY_MAX = 256 * 1024;

/** Per-tab CDP network tap. The session is held (never released) for the
 *  tab's lifetime: response bodies are only retrievable for requests the
 *  session observed, so the tap must stay attached to keep capturing.
 *  Cleared on SW restart (module state) — the next call re-taps and the
 *  buffer honestly restarts. Tab close is handled by cdp.ts state GC +
 *  the getTab liveness check in the tool case. */
const networkTaps = new Map<number, { session: CdpSession; entries: NetworkTapEntry[]; since: number }>();

async function ensureNetworkTap(
  deps: ToolHostDeps,
  tabId: number,
): Promise<{ session: CdpSession; entries: NetworkTapEntry[]; since: number }> {
  const existing = networkTaps.get(tabId);
  if (existing) return existing;
  const { session } = await cdpAcquire(deps, tabId);
  await session.send("Network.enable");
  const entries: NetworkTapEntry[] = [];
  const upsert = (requestId: string, patch: Partial<NetworkTapEntry>) => {
    let e = [...entries].reverse().find((x) => x.requestId === requestId);
    if (!e) {
      e = {
        requestId,
        method: "",
        url: "",
        type: "",
        ts: Date.now(),
        finished: false,
        ...patch,
      };
      entries.push(e);
      if (entries.length > NETWORK_TAP_CAP) entries.splice(0, entries.length - NETWORK_TAP_CAP);
    } else {
      Object.assign(e, patch);
    }
  };
  session.on("Network.requestWillBeSent", (p) => {
    const req = (p.request ?? {}) as { method?: string; url?: string };
    const requestId = typeof p.requestId === "string" ? p.requestId : "";
    if (!requestId) return;
    upsert(requestId, {
      method: typeof req.method === "string" ? req.method : "",
      url: typeof req.url === "string" ? req.url : "",
      type: typeof p.type === "string" ? p.type : "",
    });
  });
  session.on("Network.responseReceived", (p) => {
    const requestId = typeof p.requestId === "string" ? p.requestId : "";
    const resp = (p.response ?? {}) as { url?: string; status?: number; mimeType?: string };
    if (!requestId) return;
    upsert(requestId, {
      ...(typeof resp.url === "string" ? { url: resp.url } : {}),
      ...(typeof resp.status === "number" ? { status: resp.status } : {}),
      ...(typeof resp.mimeType === "string" ? { mimeType: resp.mimeType } : {}),
    });
  });
  session.on("Network.loadingFinished", (p) => {
    const requestId = typeof p.requestId === "string" ? p.requestId : "";
    if (requestId) upsert(requestId, { finished: true });
  });
  session.on("Network.loadingFailed", (p) => {
    const requestId = typeof p.requestId === "string" ? p.requestId : "";
    if (requestId) upsert(requestId, { finished: true, failed: true });
  });
  const tap = { session, entries, since: Date.now() };
  networkTaps.set(tabId, tap);
  return tap;
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
    const res = (await tap.session.send("Network.getResponseBody", { requestId })) as {
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
