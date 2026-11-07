import type { BrowserToolName } from "./tool.js";

/**
 * Browser backend identifiers (plan §3.6).
 * `playwright-cdp` is research backlog only — not an MVP backend.
 */
export type BrowserBackendId = "chrome-extension" | "playwright-isolated" | "playwright-cdp";

export const BROWSER_BACKEND_IDS: readonly BrowserBackendId[] = [
  "chrome-extension",
  "playwright-isolated",
  "playwright-cdp",
];

/**
 * Capabilities a backend MAY truthfully claim (plan §4.5).
 * Every claim must be backed by test evidence or marked PROVISIONAL.
 * Do NOT advertise "supports every web operation" (§6.8).
 */
export interface BrowserBackendCapabilities {
  existingUserTabs: boolean;
  existingUserSession: boolean;
  isolatedProfile: boolean;
  multiTab: boolean;
  dom: boolean;
  accessibility: boolean;
  screenshot: boolean;
  /** browser.page.screenshot result carries bounded image bytes
   *  (`dataBase64`, ≤512KiB decoded — the gateway artifact cap) inline
   *  so the provider can consume them as image input; hosts that also
   *  persist an artifact return `artifactRef` alongside. Absent/false
   *  means the tool only yields a reference the provider cannot see. */
  screenshotImagePayload?: boolean;
  upload: boolean;
  /**
   * Proven iframe level. MVP chrome-extension = "none" (content script
   * not injected into ANY frame, incl. same-origin). `all_frames:false`
   * does NOT create capability by itself. "same-origin" only after
   * implementation + real tests.
   */
  iframe: "none" | "same-origin" | "all";
  /** every current backend */
  nativeDialogs: false;
  /** extension: only via real user gesture; playwright: setInputFiles path */
  filePicker: boolean;
  /** extension: partial — synthetic DOM click ≠ user gesture */
  trustedGesture: boolean;
  /** controlling browser chrome UI (address bar, menus) — always false */
  browserChrome: boolean;
  networkInspection?: boolean;
  attachToRunningChrome?: boolean;
  /** browser.tab.create — open a new tab inside the task's scope */
  tabCreate?: boolean;
  /** browser.page.console — buffered console/error capture per tab */
  consoleCapture?: boolean;
  /** browser.page.hover — untrusted pointer/mouse events; cannot force
   *  :hover CSS state or trusted listeners */
  pageHover?: boolean;
  /** browser.page.press — key events. Extension dispatches UNTRUSTED
   *  DOM KeyboardEvents: JS listeners see them, but browser default
   *  actions (e.g. Enter submitting a form) are not guaranteed. Only a
   *  real input path (chrome.debugger / CDP Input domain) is trusted. */
  pagePress?: boolean;
  /** browser.page.find — in-page text/DOM search returning bounded
   *  matches with selectors (and content-side refs on the extension) */
  pageFind?: boolean;
  /** browser.page.history — back/forward/reload on the task's tab */
  pageHistory?: boolean;
  /** browser.downloads.list — chrome.downloads listing (extension only;
   *  requires the "downloads" permission). Playwright-isolated does NOT
   *  claim it: download events are not wired. */
  downloadsList?: boolean;
}

/**
 * Truthful default capabilities per backend (plan §4.5/§6.5/§6.8).
 * chrome-extension MVP: iframe "none" for EVERY frame incl. same-origin;
 * nativeDialogs always false; trustedGesture partial; browserChrome false.
 * playwright-isolated: isolated profile, no user session/tabs; iframe "all"
 * stays PROVISIONAL until spike-B4 frame tests pass — default reported
 * conservatively as "none" until then? NO: plan marks it PROVISIONAL(spike-B4),
 * so we report the CLAIMED level but callers must treat it as unproven.
 * filePicker ≠ setInputFiles: playwright can setInputFiles by path but
 * cannot open the user's native picker — reflected in `filePicker`.
 */
export const DEFAULT_BACKEND_CAPABILITIES: Record<BrowserBackendId, BrowserBackendCapabilities> = {
  "chrome-extension": {
    existingUserTabs: true,
    existingUserSession: true,
    isolatedProfile: false,
    multiTab: true,
    dom: true,
    accessibility: false,
    screenshot: true,
    screenshotImagePayload: true,
    // DataTransfer bytes path (browser.page.upload) — synthetic, not a
    // trusted gesture; filePicker stays false for the native picker.
    upload: true,
    iframe: "none",
    nativeDialogs: false,
    filePicker: false,
    trustedGesture: false,
    browserChrome: false,
    tabCreate: true,
    consoleCapture: true,
    pageHover: true,
    pagePress: true,
    pageFind: true,
    pageHistory: true,
    downloadsList: true,
  },
  "playwright-isolated": {
    existingUserTabs: false,
    existingUserSession: false,
    isolatedProfile: true,
    multiTab: true,
    dom: true,
    accessibility: true,
    screenshot: true,
    screenshotImagePayload: true,
    upload: true,
    // page.locator does not pierce frame boundaries — DOM actions and
    // frame-scoped args.frameId are refused proto.unsupported until
    // frameLocator support lands. ariaSnapshot may still surface iframe
    // content for observation, but the proven action level is "none".
    iframe: "none",
    nativeDialogs: false,
    filePicker: false, // setInputFiles works; native picker does not
    trustedGesture: false,
    browserChrome: false,
    tabCreate: true,
    consoleCapture: true,
    pageHover: true,
    pagePress: true,
    pageFind: true,
    pageHistory: true,
    // downloadsList intentionally absent — not implemented on this backend.
  },
  "playwright-cdp": {
    existingUserTabs: false,
    existingUserSession: false,
    isolatedProfile: true,
    multiTab: true,
    dom: true,
    accessibility: true,
    screenshot: true,
    upload: true,
    iframe: "all",
    nativeDialogs: false,
    filePicker: false,
    trustedGesture: false,
    browserChrome: false,
    attachToRunningChrome: true,
  },
};

/**
 * Effective capabilities for a backend: defaults ∩ runtime-reported
 * overrides. Runtime may only NARROW claims, never widen them.
 */
export function effectiveBackendCapabilities(
  id: BrowserBackendId,
  runtime?: Partial<BrowserBackendCapabilities>,
): BrowserBackendCapabilities {
  const base = DEFAULT_BACKEND_CAPABILITIES[id];
  if (!runtime) return base;
  const merged = { ...base };
  for (const key of Object.keys(runtime) as Array<keyof BrowserBackendCapabilities>) {
    const v = runtime[key];
    if (v === undefined) continue;
    // runtime can only narrow boolean claims to false; iframe stays as base
    // unless runtime explicitly reports a LOWER level — widening is ignored.
    if (key === "iframe") continue;
    if (typeof base[key] === "boolean" && v === false) {
      (merged as Record<string, unknown>)[key] = false;
    }
  }
  return merged;
}

/** iframe capability ordering for narrowing comparisons. */
const IFRAME_RANK: Record<BrowserBackendCapabilities["iframe"], number> = {
  none: 0,
  "same-origin": 1,
  all: 2,
};

export function minIframeCapability(
  a: BrowserBackendCapabilities["iframe"],
  b: BrowserBackendCapabilities["iframe"],
): BrowserBackendCapabilities["iframe"] {
  return IFRAME_RANK[a] <= IFRAME_RANK[b] ? a : b;
}

/**
 * Runtime handle for a browser backend inside the Gateway.
 * Implemented by chrome-extension host channel and playwright backend.
 */
export interface BrowserBackend {
  readonly id: BrowserBackendId;
  readonly capabilities: BrowserBackendCapabilities;
  readonly supportedTools: readonly BrowserToolName[];
}
