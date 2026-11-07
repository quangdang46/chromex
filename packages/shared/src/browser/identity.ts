/**
 * Browser identity model — plan §3.2/§4.9.
 *
 * Five IDs total (profileId/clientId/browserInstanceId/hostInstanceId/
 * connectionId); this file covers the browser-instance side.
 *
 * HARD RULES:
 * - `browserInstanceId` is `string | null` in EVERY contract.
 * - null ⇒ degraded mode ⇒ binding `needs_confirmation`, NEVER `stale`.
 * - `hostInstanceId` is per-process, NEVER an affinity key.
 * - `tabId` is only meaningful within (profileId, browserInstanceId, connectionId).
 * - These IDs are namespace, NOT security identity (§3.4.3).
 */

export type BrowserBindingState = "ok" | "needs_confirmation" | "stale" | "none";

export type HostIdentityConfidence = "known" | "degraded";

/**
 * Durable, privacy-safe tab descriptor (plan §4.9).
 * Stores origin + path pattern + title HASH — never query strings or
 * full URLs. `originBrowserInstanceId` is immutable: it records which
 * Chrome run the task was created on and is NOT overwritten on reconnect.
 */
export interface DurableTabDescriptor {
  profileId: string;
  origin: string;
  /** e.g. "/inbox/*" */
  pathPattern: string;
  /** hash, not plaintext */
  titleHash?: string;
  resolvedAt: number;
  originBrowserInstanceId?: string | null;
}

/**
 * Durable user intent for tab targeting (plan §4.9).
 * `active_resolved` = resolved ONCE at task.create — never re-resolve
 * to whatever tab is active after restart.
 */
export type TabIntent =
  | { scope: "active_resolved"; resolved: DurableTabDescriptor }
  | { scope: "explicit"; refs: DurableTabDescriptor[] }
  | { scope: "untitled" };
