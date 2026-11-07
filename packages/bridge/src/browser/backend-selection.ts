/**
 * Backend selection — plan §6.6 (M6).
 *
 * Intent-source priority (high → low):
 *   1. user instruction / explicit pin (pinnedBy "user"|"policy")
 *   2. task-creation options (pinnedBy "default" but explicitly passed)
 *   3. config browser.defaultBackend
 *   4. availability
 *
 * `auto` resolves ONCE here and the result is pinned on the task —
 * mid-task changes only via task.setBackend (user action, audited).
 * The model has no API to change backend; a tool that needs a
 * different backend than the pin gets browser.backend_mismatch.
 * A pinned backend that is unavailable fails — never silently falls
 * back to another backend.
 */

import { protocolError } from "@codex-sidepanel/shared";
import type { BrowserBackendId } from "@codex-sidepanel/shared";
import type { BackendBinding } from "@codex-sidepanel/shared";

export interface BackendSelectionInput {
  /** explicit backend requested at task.create / task.setBackend */
  requested?: { backendId: BrowserBackendId; pinnedBy: BackendBinding["pinnedBy"] } | null;
  /** resolved config values */
  defaultBackend: "auto" | BrowserBackendId;
  allowedBackends: readonly BrowserBackendId[];
  /** playwright.enabledByUser — gates playwright-isolated availability */
  playwrightEnabledByUser: boolean;
  /** runtime check: playwright-core + chromium actually installed */
  playwrightRuntimeAvailable: boolean;
}

export interface BackendSelection {
  backend: BackendBinding;
}

function unavailable(id: BrowserBackendId): never {
  throw protocolError(
    "browser.backend_unavailable",
    `backend ${id} is not available (not allowed, disabled, or runtime missing)`,
  );
}

function isAllowed(id: BrowserBackendId, input: BackendSelectionInput): boolean {
  return input.allowedBackends.includes(id);
}

function isAvailable(id: BrowserBackendId, input: BackendSelectionInput): boolean {
  if (id === "chrome-extension") return true; // host channel; absence → no_host at dispatch
  if (id === "playwright-isolated") {
    return input.playwrightEnabledByUser && input.playwrightRuntimeAvailable;
  }
  // playwright-cdp: research backlog — never selectable in MVP
  return false;
}

/** Resolve the effective backend binding for a task. Throws
 *  browser.backend_unavailable when an explicit pin cannot be
 *  honored — no silent fallback (§6.6). */
export function resolveBackendSelection(input: BackendSelectionInput): BackendSelection {
  const req = input.requested ?? null;

  // 1+2. explicit request (user instruction or task options) — pinned,
  //      validated, never downgraded.
  if (req) {
    if (!isAllowed(req.backendId, input) || !isAvailable(req.backendId, input)) {
      unavailable(req.backendId);
    }
    return { backend: { backendId: req.backendId, pinnedBy: req.pinnedBy } };
  }

  // 3. config default (non-auto) — same validation as explicit.
  if (input.defaultBackend !== "auto") {
    if (!isAllowed(input.defaultBackend, input) || !isAvailable(input.defaultBackend, input)) {
      unavailable(input.defaultBackend);
    }
    return { backend: { backendId: input.defaultBackend, pinnedBy: "default" } };
  }

  // 4. auto → availability order: extension first (real user session),
  //    then isolated playwright when the user enabled it.
  const candidates: BrowserBackendId[] = ["chrome-extension", "playwright-isolated"];
  for (const id of candidates) {
    if (isAllowed(id, input) && isAvailable(id, input)) {
      return { backend: { backendId: id, pinnedBy: "default" } };
    }
  }
  unavailable("chrome-extension");
}

/** §6.6 mismatch: a tool call whose required backend differs from the
 *  task pin. Today the only hard requirement is "needs the user's real
 *  tab/session" → chrome-extension; isolated backend can never serve
 *  tabIntent-bound (active_resolved/explicit) work. Returns the error
 *  code to use, or null when compatible. */
export function backendMismatchFor(
  pinned: BrowserBackendId,
  needsRealUserTab: boolean,
): "browser.backend_mismatch" | null {
  if (needsRealUserTab && pinned === "playwright-isolated") {
    return "browser.backend_mismatch";
  }
  return null;
}
