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

export interface ToolHostDeps {
  /** chrome.tabs.captureVisibleTab → data:image/...;base64 URL.
   *  `opts.quality` (jpeg only) lets the screenshot path retry at lower
   *  quality when the first capture exceeds the artifact byte cap. */
  captureVisibleTab?(windowId: number, opts?: { quality?: number }): Promise<string>;
  /** chrome.tabs.create — open a new tab (browser.tab.create, chromex-he2) */
  createTab?(opts: { url?: string; active?: boolean; windowId?: number }): Promise<chrome.tabs.Tab>;
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
  /** chrome.downloads.download (browser.downloads.save) — starts a
   *  download into the profile's download dir; absent dep →
   *  proto.unsupported. */
  downloadFile?(input: { url: string; filename?: string }): Promise<{
    id?: number;
    filename?: string;
  }>;
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
}

function toolError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e;
}

/** Tools whose work happens inside one frame's DOM — these accept
 *  args.frameId. Tab-level tools (tabs.*, page.get/screenshot/history,
 *  downloads) reject it. */
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
]);

const SUPPORTED = new Set([
  "browser.tabs.list",
  "browser.tab.activate",
  "browser.tab.close",
  "browser.tab.create",
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
        return {
          id: tab.id,
          url: tab.url ?? "",
          title: tab.title ?? "",
          active: tab.active === true,
          resolvedTabId: tabId,
          ...(frames ? { frames } : {}),
        };
      }
      case "browser.page.snapshot": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const frameId = frameIdArg(args);
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
        return { ...snap, resolvedTabId: tabId };
      }
      case "browser.page.wait": {
        // Conditional wait (text/textGone/selector/urlContains) polls in
        // the content script; bare `ms` stays a bounded host-side sleep.
        const hasCondition =
          str(args.text) !== undefined ||
          str(args.textGone) !== undefined ||
          str(args.selector) !== undefined ||
          str(args.urlContains) !== undefined ||
          str(args.readyState) !== undefined;
        if (str(args.readyState) !== undefined &&
            !["loading", "interactive", "complete"].includes(str(args.readyState)!)) {
          throw toolError("proto.invalid", "browser.page.wait args.readyState must be loading|interactive|complete");
        }
        if (!hasCondition) {
          const ms = Math.min(Math.max(typeof args.ms === "number" ? args.ms : 1000, 0), 30_000);
          await new Promise((r) => setTimeout(r, ms));
          return { ok: true, waitedMs: ms };
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const frameId = frameIdArg(args);
        const timeoutMs = Math.min(
          Math.max(typeof args.timeoutMs === "number" ? args.timeoutMs : 10_000, 0),
          30_000,
        );
        const res = (await deps.sendToTab(tabId, {
          type: "page.dom.wait",
          ...(str(args.text) ? { text: str(args.text) } : {}),
          ...(str(args.textGone) ? { textGone: str(args.textGone) } : {}),
          ...(str(args.selector) ? { selector: str(args.selector) } : {}),
          ...(str(args.urlContains) ? { urlContains: str(args.urlContains) } : {}),
          ...(str(args.readyState) ? { readyState: str(args.readyState) } : {}),
          timeoutMs,
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
        return {
          downloadId: typeof res?.id === "number" ? res.id : undefined,
          filename: res?.filename,
          note: "Download started — call browser.downloads.list to resolve the final on-disk path.",
        };
      }
      case "browser.page.screenshot": {
        if (!deps.captureVisibleTab) {
          throw toolError("proto.unsupported", "screenshot capture is not available on this host");
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);
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
        const shot = await captureScreenshotWithinArtifactCap(deps.captureVisibleTab, tab.windowId);
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
        const res = (await deps.sendToTab(tabId, {
          type: "page.extract",
          maxChars,
        }, { frameId })) as { text?: string; truncated?: boolean; url?: string; title?: string };
        return {
          text: res.text ?? "",
          truncated: res.truncated === true,
          url: res.url ?? "",
          title: res.title ?? "",
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
        const step = domStepFor(tool, args);
        // chromex-0fza: validate args.expect BEFORE dispatch — a
        // malformed expectation must not run the action and then fail.
        const expectCond = parseExpectCondition(args.expect);
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
    case "browser.page.click":
      return { ...base, action: "click" };
    case "browser.page.focus":
      return { ...base, action: "focus" };
    case "browser.page.fill":
    case "browser.page.type":
      return { ...base, action: "fill", value: typeof args.text === "string" ? args.text : typeof args.value === "string" ? args.value : "" };
    case "browser.page.select":
      return { ...base, action: "select", value: typeof args.value === "string" ? args.value : "" };
    case "browser.page.submit":
      return { ...base, action: "submit" };
    case "browser.page.hover":
      return { ...base, action: "hover" };
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
  const timeoutMs =
    typeof o.timeoutMs === "number" && Number.isFinite(o.timeoutMs)
      ? Math.min(Math.max(Math.floor(o.timeoutMs), 0), EXPECT_MAX_TIMEOUT_MS)
      : undefined;
  const cond: BrowserExpectCondition = {
    ...(selector ? { selector } : {}),
    ...(text ? { text } : {}),
    ...(urlContains ? { urlContains } : {}),
    ...(goneSelector ? { goneSelector } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  return cond.selector || cond.text || cond.urlContains || cond.goneSelector ? cond : null;
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
