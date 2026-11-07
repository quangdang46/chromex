/**
 * Tab binding resolution — plan §4.9 (P2-02).
 *
 * Pure function: given a durable TabIntent, the tabs the host
 * currently reports, and the live browserInstanceId, decide the
 * runtime binding state. No I/O — the caller supplies candidates.
 *
 * Rules (§4.9 restart table):
 *  - SW restart / native-host reconnect (same browserInstanceId):
 *    binding was never lost — descriptor is not needed; unique
 *    re-resolution is allowed automatically.
 *  - Chrome restart (proven different browserInstanceId): NEVER
 *    auto-bind — `stale`, user must confirm. The descriptor is a
 *    suggestion only.
 *  - degraded identity (browserInstanceId null): `needs_confirmation`,
 *    never `stale`.
 *  - ≥2 matching tabs → `needs_confirmation` (ambiguous) — never
 *    auto-pick, in every branch.
 */

import type { BrowserBindingState, DurableTabDescriptor, TabIntent } from "@codex-sidepanel/shared";

export interface BindingCandidate {
  tabId: number;
  url: string;
  title?: string;
  /** browserInstanceId of the Chrome run that owns this tab, if known */
  browserInstanceId?: string | null;
}

export interface BindingResolution {
  state: BrowserBindingState;
  /** runtime tabId when state === "ok" */
  tabId?: number;
  /** descriptor that matched (for explicit re-resolve / UI suggestion) */
  matched?: DurableTabDescriptor;
  /** machine-readable reason for tests/UI */
  reason:
    | "bound"
    | "ambiguous"
    | "no_match"
    | "stale_instance"
    | "degraded_identity"
    | "untitled"
    | "tab_closed";
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function pathOf(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return "";
  }
}

/** pathPattern "/inbox/*" matches "/inbox/123"; "/a/b" exact. */
export function pathPatternMatches(pattern: string, path: string): boolean {
  if (pattern === path) return true;
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -1); // keeps trailing "/"
    return path.startsWith(prefix);
  }
  return false;
}

function descriptorMatches(desc: DurableTabDescriptor, tab: BindingCandidate): boolean {
  const origin = originOf(tab.url);
  if (!origin || origin !== desc.origin) return false;
  if (!pathPatternMatches(desc.pathPattern, pathOf(tab.url))) return false;
  // titleHash comparison is the caller's job (hash function lives
  // extension-side); when provided we only filter on origin+path here.
  return true;
}

function pickUnique(
  candidates: BindingCandidate[],
): { state: BrowserBindingState; tabId?: number; reason: BindingResolution["reason"] } {
  const only = candidates[0];
  if (!only) return { state: "stale", reason: "no_match" };
  if (candidates.length > 1) return { state: "needs_confirmation", reason: "ambiguous" };
  return { state: "ok", tabId: only.tabId, reason: "bound" };
}

/**
 * Resolve a task's durable tab intent against live host tabs.
 *
 * @param intent        durable intent stored on the task
 * @param candidates    tabs reported by the connected host(s)
 * @param browserInstanceId  live browserInstanceId (null = degraded)
 */
export function resolveTabBinding(
  intent: TabIntent,
  candidates: BindingCandidate[],
  browserInstanceId: string | null,
): BindingResolution {
  if (intent.scope === "untitled") {
    return { state: "needs_confirmation", reason: "untitled" };
  }

  if (browserInstanceId === null) {
    // degraded mode — never stale (§4.9)
    return { state: "needs_confirmation", reason: "degraded_identity" };
  }

  if (intent.scope === "explicit") {
    const matched = candidates.filter((tab) =>
      intent.refs.some((ref) => descriptorMatches(ref, tab)),
    );
    const unique = [...new Map(matched.map((t) => [t.tabId, t])).values()];
    const picked = pickUnique(unique);
    if (picked.state !== "ok") return { ...picked };
    // Chrome-restart guard: if the tab's owning instance is KNOWN and
    // differs from every ref's originBrowserInstanceId → stale.
    const tab = unique[0];
    if (!tab) return { state: "stale", reason: "no_match" };
    const ref = intent.refs.find((r) => descriptorMatches(r, tab));
    if (
      ref?.originBrowserInstanceId &&
      tab.browserInstanceId &&
      tab.browserInstanceId !== ref.originBrowserInstanceId &&
      tab.browserInstanceId !== browserInstanceId
    ) {
      return { state: "stale", reason: "stale_instance" };
    }
    return {
      state: "ok",
      tabId: picked.tabId ?? tab.tabId,
      ...(ref ? { matched: ref } : {}),
      reason: "bound",
    };
  }

  // active_resolved
  const resolved = intent.resolved;
  const originInstance = resolved.originBrowserInstanceId ?? null;

  if (originInstance === null) {
    // Task was created in degraded mode — cannot prove same Chrome
    // run, so auto-binding is not allowed (§4.9 degraded row).
    return { state: "needs_confirmation", reason: "degraded_identity" };
  }
  if (originInstance !== browserInstanceId) {
    // Proven Chrome restart — descriptor is suggestion only.
    return { state: "stale", reason: "stale_instance" };
  }

  const matched = candidates.filter((tab) => descriptorMatches(resolved, tab));
  const unique = [...new Map(matched.map((t) => [t.tabId, t])).values()];
  if (unique.length === 0) {
    return { state: "stale", reason: "tab_closed" };
  }
  const picked = pickUnique(unique);
  if (picked.state !== "ok") return { ...picked };
  return {
    state: "ok",
    tabId: picked.tabId ?? unique[0]!.tabId,
    matched: resolved,
    reason: "bound",
  };
}
