import type { BrowserBackendCapabilities } from "./backend.js";

/**
 * Canonical browser tool names (dotted). MCP exposure may map these to
 * snake_case (`browser.page.click` → `browser_page_click`) — decided at
 * MCP endpoint implementation, recorded in ADR (plan §3.6/§9.3).
 */
export type BrowserToolName =
  | "browser.tabs.list"
  | "browser.tab.activate"
  | "browser.tab.close"
  | "browser.page.snapshot"
  | "browser.page.get"
  | "browser.page.extract"
  | "browser.page.screenshot"
  | "browser.page.click"
  | "browser.page.focus"
  | "browser.page.type"
  | "browser.page.fill"
  | "browser.page.select"
  | "browser.page.submit"
  | "browser.page.scroll"
  | "browser.page.navigate"
  | "browser.page.wait"
  | "browser.page.upload";

export const BROWSER_TOOL_NAMES: readonly BrowserToolName[] = [
  "browser.tabs.list",
  "browser.tab.activate",
  "browser.tab.close",
  "browser.page.snapshot",
  "browser.page.get",
  "browser.page.extract",
  "browser.page.screenshot",
  "browser.page.click",
  "browser.page.focus",
  "browser.page.type",
  "browser.page.fill",
  "browser.page.select",
  "browser.page.submit",
  "browser.page.scroll",
  "browser.page.navigate",
  "browser.page.wait",
  "browser.page.upload",
];

/** Per-call context handed to the browser tool server (plan §9.2). */
export interface BrowserToolContext {
  taskId: string;
  turnId?: string;
  /** provider-side call id — dedup/duplicate-execution protection */
  toolCallId: string;
  profileId: string;
  backendId: import("./backend.js").BrowserBackendId;
  /** signed tool token claims already validated by Gateway */
  tokenJti?: string;
}

export interface BrowserActionRequest {
  tool: BrowserToolName;
  /** tool arguments — validated per-tool schema before dispatch */
  args: Record<string, unknown>;
  /** snapshotId binding the action to a specific page state */
  snapshotId?: string;
  /** expected structuralFingerprint for stale detection */
  expectedStructuralFingerprint?: string;
}

export interface BrowserObservation {
  urlChanged?: boolean;
  fingerprintChanged?: boolean;
  valueReflected?: boolean;
  scrollDelta?: number;
}

export interface BrowserActionResult {
  /** tool-level outcome before semantic verification */
  ok: boolean;
  output?: unknown;
  observation?: BrowserObservation;
  /** semantic verification verdict (plan §6.3) — set by verifier, not host */
  verified?: boolean | "unknown";
  error?: import("../protocol/errors.js").ProtocolError;
  /** true when the host could not confirm whether the action executed */
  sideEffectUnknown?: boolean;
}

export type { BrowserBackendCapabilities };
