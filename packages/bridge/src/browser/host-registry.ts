/**
 * Browser host registry — plan §6.1, P2-03.
 *
 * Affinity model:
 *  - known mode  (browserInstanceId != null):
 *      `profileId:browserInstanceId:backendId:tabId → hostInstanceId`
 *  - degraded mode (browserInstanceId == null):
 *      `connectionId:tabId → hostInstanceId` — never persisted, dies
 *      with the connection.
 *
 * Privacy-first (§6.1.1): registration carries identity only — no tab
 * list, no URLs. `browser.tabs.list` is an on-demand tool call.
 *
 * Disconnect semantics:
 *  - affinity entries are NOT deleted on host disconnect; tabs become
 *    "stranded" until a host with the SAME browserInstanceId
 *    reconnects (SW restart) — then binding resumes automatically.
 *  - a host with a DIFFERENT browserInstanceId never inherits
 *    stranded affinity (Chrome restart ⇒ stale, user re-confirms).
 */

export interface HostRegistration {
  /** per-process id injected by native host (hello.hostInstanceId) */
  hostInstanceId: string;
  /** IPC connection id — runtime only, never persisted */
  connectionId: string;
  /** null ⇒ degraded mode */
  browserInstanceId: string | null;
  /** profile this host serves, when declared */
  profileId?: string;
  /** backend this host implements, when declared */
  backendId?: string;
}

export interface HostAffinityKey {
  profileId: string;
  browserInstanceId: string | null;
  backendId: string;
  /** runtime tabId when known; scope-level routing omits it */
  tabId?: number;
}

export type HostResolveResult =
  | { kind: "host"; hostInstanceId: string }
  | { kind: "no_host" }
  | { kind: "stranded"; lastHostInstanceId: string }
  | { kind: "wrong_profile"; expected: string; got: string }
  | { kind: "not_in_scope" };

interface AffinityEntry {
  hostInstanceId: string;
  browserInstanceId: string | null;
  connectionId: string;
}

export class BrowserHostRegistry {
  private readonly hosts = new Map<string, HostRegistration>(); // hostInstanceId → reg
  private readonly byConnection = new Map<string, string>(); // connectionId → hostInstanceId
  /** known-mode affinity */
  private readonly affinity = new Map<string, AffinityEntry>();
  /** degraded-mode affinity (connectionId-scoped) */
  private readonly degradedAffinity = new Map<string, AffinityEntry>();

  register(reg: HostRegistration): void {
    this.hosts.set(reg.hostInstanceId, reg);
    this.byConnection.set(reg.connectionId, reg.hostInstanceId);
  }

  /** Connection dropped — hosts entry removed; affinity kept (stranded). */
  unregisterByConnection(connectionId: string): void {
    const hostInstanceId = this.byConnection.get(connectionId);
    if (!hostInstanceId) return;
    this.byConnection.delete(connectionId);
    this.hosts.delete(hostInstanceId);
    // affinity entries stay — resolveHost reports "stranded" until a
    // same-browserInstanceId host reconnects.
  }

  unregisterHost(hostInstanceId: string): void {
    const reg = this.hosts.get(hostInstanceId);
    if (reg) this.byConnection.delete(reg.connectionId);
    this.hosts.delete(hostInstanceId);
  }

  /** Record that `tabId` was served by `hostInstanceId` for this scope. */
  noteTabAffinity(key: HostAffinityKey, hostInstanceId: string): void {
    const reg = this.hosts.get(hostInstanceId);
    const entry: AffinityEntry = {
      hostInstanceId,
      browserInstanceId: reg?.browserInstanceId ?? key.browserInstanceId,
      connectionId: reg?.connectionId ?? "",
    };
    const mapKey = this.#affinityKey(key);
    if (key.browserInstanceId === null) {
      // degraded: scope by connectionId — never persisted, dies with conn
      this.degradedAffinity.set(`${entry.connectionId}:${key.tabId ?? "*"}`, entry);
    } else {
      this.affinity.set(mapKey, entry);
    }
  }

  #affinityKey(key: HostAffinityKey): string {
    return `${key.profileId}${key.browserInstanceId}${key.backendId}${key.tabId ?? "*"}`;
  }

  /**
   * Resolve the host for a task+tab scope.
   * Order: live affinity → live host matching scope → stranded report.
   */
  resolveHost(key: HostAffinityKey): HostResolveResult {
    const live = this.#liveHostFor(key);
    if (live) return { kind: "host", hostInstanceId: live };

    // stranded? affinity exists but its host is gone.
    const stranded = this.#strandedEntry(key);
    if (stranded) return { kind: "stranded", lastHostInstanceId: stranded.hostInstanceId };

    // hosts exist but none serve this profile → wrong_profile
    // (§4.8); hosts exist for other scopes → not_in_scope.
    const anyHost = [...this.hosts.values()];
    if (anyHost.some((r) => r.profileId && r.profileId !== key.profileId)) {
      const other = anyHost.find((r) => r.profileId && r.profileId !== key.profileId)!;
      return { kind: "wrong_profile", expected: key.profileId, got: other.profileId! };
    }
    if (anyHost.length > 0) return { kind: "not_in_scope" };
    return { kind: "no_host" };
  }

  /** Live host matching the task scope (no affinity needed). */
  #liveHostFor(key: HostAffinityKey): string | null {
    let fallback: string | null = null;
    for (const reg of this.hosts.values()) {
      if (reg.profileId && reg.profileId !== key.profileId) continue;
      if (key.browserInstanceId !== null) {
        if (reg.browserInstanceId !== key.browserInstanceId) continue;
      } else if (reg.browserInstanceId !== null) {
        // task degraded but host knows its instance — still usable;
        // binding state machine decides confirmation, not routing.
      }
      if (reg.backendId && key.backendId !== "auto" && reg.backendId !== key.backendId) continue;
      if (fallback === null) fallback = reg.hostInstanceId;
      // prefer a host that already served this tab
      const affKey = this.#affinityKey(key);
      if (this.affinity.get(affKey)?.hostInstanceId === reg.hostInstanceId) {
        return reg.hostInstanceId;
      }
    }
    return fallback;
  }

  #strandedEntry(key: HostAffinityKey): AffinityEntry | null {
    if (key.browserInstanceId === null) {
      // degraded affinity is connection-scoped; a dead connection's
      // entries are unreachable by definition → no_host.
      return null;
    }
    const entry = this.affinity.get(this.#affinityKey(key));
    if (!entry) return null;
    if (this.hosts.has(entry.hostInstanceId)) return null; // live — handled above
    // Same-browserInstanceId host reconnect? Then it's live again via
    // #liveHostFor; reaching here means truly stranded.
    return entry;
  }

  /** Hosts currently registered (diagnostics only — no tab data). */
  listHosts(): HostRegistration[] {
    return [...this.hosts.values()];
  }
}
