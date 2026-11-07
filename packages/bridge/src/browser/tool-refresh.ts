/**
 * Tool token refresh scheduler — plan §9.1 / P1-09.
 *
 * Gateway proactively refreshes 2 minutes before expiry by emitting
 * `tool.token.refreshed` on the session control channel. The adapter
 * either hot-updates its MCP config or is drained (in-flight calls
 * finish/timeout) before the MCP connection restarts — never mid-call.
 *
 * Old token stays valid for a 60s grace window (handled inside
 * ToolTokenManager.previousGenerations).
 */

import { ToolTokenManager } from "./tool-token.js";
import type { BrowserBackendId } from "@codex-sidepanel/shared";

export const REFRESH_LEAD_MS = 2 * 60 * 1000;
/** in-flight calls get this long to finish before drain forces restart */
export const DRAIN_GRACE_MS = 60 * 1000;

export interface RefreshNotice {
  type: "tool.token.refreshed";
  taskId: string;
  token: string;
  expiresAt: number;
  /** adapter must hot-update or confirm drain before this deadline */
  drainDeadlineAt: number;
}

export interface TokenRefresherOptions {
  tokens: ToolTokenManager;
  /** deliver the refresh notice on the session control channel */
  notify: (notice: RefreshNotice) => void;
  now?: () => number;
  refreshLeadMs?: number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

interface ScopeIdentity {
  taskId: string;
  profileId: string;
  backendId: BrowserBackendId;
  allowedTools: string[];
  token: string;
}

interface TrackedScope extends ScopeIdentity {
  timer: unknown;
  expiresAt: number;
}

export class ToolTokenRefresher {
  readonly #opts: Required<Omit<TokenRefresherOptions, "notify">> & { notify: TokenRefresherOptions["notify"] };
  readonly #scopes = new Map<string, TrackedScope>(); // key = taskId

  constructor(opts: TokenRefresherOptions) {
    this.#opts = {
      tokens: opts.tokens,
      notify: opts.notify,
      now: opts.now ?? (() => Date.now()),
      refreshLeadMs: opts.refreshLeadMs ?? REFRESH_LEAD_MS,
      setTimer: opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: opts.clearTimer ?? ((h) => clearTimeout(h as NodeJS.Timeout)),
    };
  }

  /** Register a task scope; issues the first token and schedules refresh. */
  track(scope: {
    taskId: string;
    profileId: string;
    backendId: BrowserBackendId;
    allowedTools: string[];
  }): { token: string; expiresAt: number } {
    const now = this.#opts.now();
    const issued = this.#opts.tokens.issue({ taskId: scope.taskId, profileId: scope.profileId, backendId: scope.backendId, allowedTools: scope.allowedTools, now });
    this.#arm(scope.taskId, { ...scope, token: issued.token }, issued.expiresAt);
    return { token: issued.token, expiresAt: issued.expiresAt };
  }

  /** Live token for a tracked scope (latest generation). */
  tokenFor(taskId: string): string | null {
    return this.#scopes.get(taskId)?.token ?? null;
  }

  #arm(taskId: string, scope: ScopeIdentity, expiresAt: number): void {
    const existing = this.#scopes.get(taskId);
    if (existing) this.#opts.clearTimer(existing.timer);
    const delay = Math.max(0, expiresAt - this.#opts.now() - this.#opts.refreshLeadMs);
    const timer = this.#opts.setTimer(() => this.#refresh(taskId, scope, expiresAt), delay);
    this.#scopes.set(taskId, { ...scope, timer, expiresAt });
  }

  #refresh(taskId: string, scope: ScopeIdentity, previousExpiresAt: number): void {
    const now = this.#opts.now();
    const issued = this.#opts.tokens.issue({ taskId: scope.taskId, profileId: scope.profileId, backendId: scope.backendId, allowedTools: scope.allowedTools, now });
    // old generation dies at previousExpiresAt + 60s grace — in-flight
    // calls must drain before then if the adapter cannot hot-update.
    const drainDeadlineAt = previousExpiresAt + DRAIN_GRACE_MS;
    this.#opts.notify({
      type: "tool.token.refreshed",
      taskId,
      token: issued.token,
      expiresAt: issued.expiresAt,
      drainDeadlineAt,
    });
    this.#arm(taskId, { ...scope, token: issued.token }, issued.expiresAt);
  }

  untrack(taskId: string): void {
    const s = this.#scopes.get(taskId);
    if (s) this.#opts.clearTimer(s.timer);
    this.#scopes.delete(taskId);
  }

  dispose(): void {
    for (const id of [...this.#scopes.keys()]) this.untrack(id);
  }
}
