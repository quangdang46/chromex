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
import type { BrowserDomActionResult, BrowserDomSnapshot } from "@codex-sidepanel/shared";

import { chromexConsoleCollect } from "../../content/console-capture.js";

export interface ToolHostDeps {
  /** chrome.tabs.captureVisibleTab → data:image/...;base64 URL */
  captureVisibleTab?(windowId: number): Promise<string>;
  /** chrome.tabs.create — open a new tab (browser.tab.create, chromex-he2) */
  createTab?(opts: { url?: string; active?: boolean }): Promise<chrome.tabs.Tab>;
  /** chrome.scripting.executeScript world:"MAIN" — runs `func` in the
   *  page's main world and resolves its return value (browser.page.console,
   *  chromex-nr8). `func` must be self-contained (serialized source). */
  runInMainWorld?(tabId: number, func: (...fnArgs: unknown[]) => unknown, args?: unknown[]): Promise<unknown>;
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
    }>
  >;
  /** gateway artifact.upload — returns {artifactRef, sha256, bytes} */
  uploadArtifact?(input: {
    taskId: string;
    kind: string;
    mimeType: string;
    dataBase64: string;
  }): Promise<{ artifactRef: string; sha256: string; bytes: number }>;
  /** chrome.tabs.sendMessage with content-script ensure (index.ts helper) */
  sendToTab(tabId: number, message: Record<string, unknown>): Promise<unknown>;
  getTab(tabId: number): Promise<chrome.tabs.Tab | undefined>;
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
  "browser.page.find",
  "browser.page.history",
  "browser.downloads.list",
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

/** §6.2 snapshot metadata: TTL 5min, LRU 32/task — used by P2-02
 *  stale/verify semantics. Registry is per-extension-install. */
const snapshotRegistry = new SnapshotRegistry();

export function toolHostSnapshotRegistry(): SnapshotRegistry {
  return snapshotRegistry;
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
        const tab = await deps.createTab({ ...(url ? { url } : {}), active });
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
        const res = (await deps.runInMainWorld(tabId, chromexConsoleCollect, [limit, level])) as
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
        return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "", active: tab.active === true, resolvedTabId: tabId };
      }
      case "browser.page.snapshot": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const snap = (await deps.sendToTab(tabId, { type: "page.dom.snapshot" })) as BrowserDomSnapshot;
        if (
          snap.snapshotId &&
          snap.structuralFingerprint &&
          snap.stateFingerprint &&
          typeof snap.saltEpoch === "number"
        ) {
          // §6.2: a structural change on this tab stales every older
          // snapshot's refs — drop them before registering the new one.
          const prior = snapshotRegistry.latestForTab(tabId);
          if (prior && prior.structuralFingerprint !== snap.structuralFingerprint) {
            snapshotRegistry.invalidateTab(tabId);
          }
          snapshotRegistry.put({
            snapshotId: snap.snapshotId,
            tabId,
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
          str(args.urlContains) !== undefined;
        if (!hasCondition) {
          const ms = Math.min(Math.max(typeof args.ms === "number" ? args.ms : 1000, 0), 30_000);
          await new Promise((r) => setTimeout(r, ms));
          return { ok: true, waitedMs: ms };
        }
        const tabId = await resolveScopedTabId(deps, args, tabScope);
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
          timeoutMs,
        })) as { ok?: boolean; timedOut?: boolean; elapsedMs?: number; error?: string };
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
        })) as { ok?: boolean; matches?: unknown[]; scanned?: number; truncated?: boolean };
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
          })),
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
        const dataUrl = await deps.captureVisibleTab(tab.windowId);
        const m = /^data:(image\/[a-z]+);base64,(.+)$/s.exec(dataUrl);
        if (!m) throw toolError("browser.action_failed", "captureVisibleTab returned unexpected format");
        const mimeType = m[1]!;
        const dataBase64 = m[2]!;
        if (!deps.uploadArtifact) {
          // no artifact channel → bounded inline fallback is NOT allowed
          // for screenshots (egress risk) — fail honestly.
          throw toolError("proto.unsupported", "artifact upload channel unavailable");
        }
        const art = await deps.uploadArtifact({
          taskId: req.taskId ?? "",
          kind: "screenshot",
          mimeType,
          dataBase64,
        });
        return { artifactRef: art.artifactRef, sha256: art.sha256, bytes: art.bytes, mimeType, resolvedTabId: tabId };
      }
      case "browser.page.extract": {
        const tabId = await resolveScopedTabId(deps, args, tabScope);
        const maxChars = typeof args.maxChars === "number" ? Math.min(args.maxChars, 50_000) : 12_000;
        const res = (await deps.sendToTab(tabId, {
          type: "page.extract",
          maxChars,
        })) as { text?: string; truncated?: boolean; url?: string; title?: string };
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
          if (meta.urlOriginPath) {
            const tab = await deps.getTab(tabId);
            const current = typeof tab?.url === "string" && tab.url ? urlOriginPath(tab.url) : null;
            if (current && current !== meta.urlOriginPath) {
              throw toolError("browser.navigated", "page navigated since the snapshot; call browser.page.snapshot again");
            }
          }
        }
        const step = domStepFor(tool, args);
        const result = (await deps.sendToTab(tabId, {
          type: "page.dom.perform",
          steps: [step],
        })) as BrowserDomActionResult;
        const first = result.results?.[0];
        if (!result.ok || first?.ok === false) {
          const code = typeof first?.code === "string" && first.code.startsWith("browser.") ? first.code : "browser.action_failed";
          throw toolError(code, first?.message ?? result.summary ?? "browser action failed");
        }
        return {
          ok: true,
          summary: result.summary,
          step: first,
          ...(first?.verified !== undefined ? { verified: first.verified } : {}),
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
