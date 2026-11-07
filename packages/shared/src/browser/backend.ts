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
