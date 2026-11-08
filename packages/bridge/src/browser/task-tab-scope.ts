/**
 * Runtime per-task tab scope — SEC chromex-9e3, plan §4.9 runtime binding.
 *
 * The tool token scopes task/profile/backend/tools but NOT tabs; without
 * this, any task could aim `args.tabId` (or the implicit active-tab
 * default) at another task's tab. This tracker is the Gateway-side
 * authority for which runtime tabIds a task may touch:
 *
 *  - A tabId binds to the FIRST task that legitimately uses it
 *    (explicit `args.tabId`, or the host-reported resolved tab after a
 *    successful call). While owned, other tasks get `browser.not_in_scope`.
 *  - A bound task may also use tabs it acquired via its own tool calls
 *    (e.g. navigate opened a new tab — reported in the tool result).
 *  - Scope is in-memory only: runtime binding is never persisted (§4.9),
 *    so a gateway/SW restart re-binds on next use.
 *
 * Namespaces (chromex-jtl): `tabId` is only meaningful inside
 * (profileId, browserInstanceId) — §3.2. Every scope operation takes an
 * `ns` string; ownership and foreign-tab reporting are keyed by it, so
 * the same numeric tabId under a different profile or Chrome instance is
 * a DIFFERENT tab and can never be silently adopted or falsely reported
 * foreign. A task whose namespace changes (proven Chrome restart → new
 * browserInstanceId) loses its runtime bindings and re-binds on next
 * use; a same-instance reconnect keeps the namespace and the bindings.
 *
 * Enforcement is two-layer: the tool server checks explicit `args.tabId`
 * pre-dispatch (and feeds `withinTabScope` honestly), then ships the
 * scope snapshot to the host in `browser.tool.request.tabScope`, which
 * re-checks the RESOLVED tabId — including the active-tab default the
 * gateway cannot see — and reports `resolvedTabId` back so the tracker
 * learns binds/acquisitions from successful results only.
 */

export interface TabScopePayload {
  /** first tab the task bound — the default target when args.tabId is absent */
  boundTabId: number | null;
  /** bound + acquired tabIds this task may use */
  allowedTabIds: number[];
  /** tabIds owned by OTHER tasks in the SAME namespace — never bindable/usable */
  foreignTabIds: number[];
}

interface OwnerEntry {
  taskId: string;
  ns: string;
  tabId: number;
}

export class TaskTabScope {
  /** taskId → in-scope tabIds (bound tab first, then acquired) */
  private readonly tabs = new Map<string, Set<number>>();
  /** taskId → first bound tabId (default resolution target) */
  private readonly bound = new Map<string, number>();
  /** taskId → browser-instance namespace its tabIds belong to */
  private readonly namespaces = new Map<string, string>();
  /** `${ns} ${tabId}` → owning task — exclusive while bound, per namespace */
  private readonly owner = new Map<string, OwnerEntry>();

  #ownerKey(ns: string, tabId: number): string {
    return `${ns} ${tabId}`;
  }

  /** Adopt `ns` for the task; a namespace CHANGE invalidates every
   *  runtime binding the task held (new Chrome run ⇒ §4.9 re-bind). */
  #ensureNamespace(taskId: string, ns: string): void {
    const prior = this.namespaces.get(taskId);
    if (prior === ns) return;
    if (prior !== undefined) this.releaseTask(taskId);
    this.namespaces.set(taskId, ns);
  }

  /** May `taskId` target `tabId` right now? In-scope → yes; unbound task
   *  → yes iff the tab is unowned in this namespace or already its own
   *  (first bind). */
  permits(taskId: string, tabId: number, ns: string): boolean {
    this.#ensureNamespace(taskId, ns);
    const scope = this.tabs.get(taskId);
    if (scope?.has(tabId)) return true;
    if (scope && scope.size > 0) return false;
    const o = this.owner.get(this.#ownerKey(ns, tabId));
    return o === undefined || o.taskId === taskId;
  }

  /** Record a bind/acquisition from a host-reported resolved tab. The
   *  host already enforced scope before acting, so the only rejection
   *  is foreign ownership in this namespace. A task that already holds
   *  tabs still acquires the new one here — `permits()`' first-bind
   *  rule is for pre-dispatch targeting, not post-success recording
   *  (chromex: tab.create on a scoped task was reported not_in_scope
   *  even though the tab entered scope via acquire). */
  bind(taskId: string, tabId: number, ns: string): boolean {
    this.#ensureNamespace(taskId, ns);
    const key = this.#ownerKey(ns, tabId);
    const o = this.owner.get(key);
    if (o !== undefined && o.taskId !== taskId) return false;
    let scope = this.tabs.get(taskId);
    if (!scope) {
      scope = new Set();
      this.tabs.set(taskId, scope);
    }
    scope.add(tabId);
    if (o === undefined) this.owner.set(key, { taskId, ns, tabId });
    if (!this.bound.has(taskId)) this.bound.set(taskId, tabId);
    return true;
  }

  /** Add tabs the task acquired through its own tool results. Tabs owned
   *  by another task in the same namespace are skipped — a result cannot
   *  grant foreign scope. */
  acquire(taskId: string, tabIds: Iterable<number>, ns: string): void {
    this.#ensureNamespace(taskId, ns);
    for (const tabId of tabIds) {
      const key = this.#ownerKey(ns, tabId);
      const o = this.owner.get(key);
      if (o !== undefined && o.taskId !== taskId) continue;
      let scope = this.tabs.get(taskId);
      if (!scope) {
        scope = new Set();
        this.tabs.set(taskId, scope);
      }
      scope.add(tabId);
      if (o === undefined) this.owner.set(key, { taskId, ns, tabId });
    }
  }

  /** Drop one tab from the task's scope (e.g. browser.tab.close). */
  release(taskId: string, tabId: number): void {
    this.tabs.get(taskId)?.delete(tabId);
    const ns = this.namespaces.get(taskId);
    if (ns !== undefined) {
      const key = this.#ownerKey(ns, tabId);
      if (this.owner.get(key)?.taskId === taskId) this.owner.delete(key);
    }
    if (this.bound.get(taskId) === tabId) this.bound.delete(taskId);
  }

  /** Task ended/purged — release every tab it owned. */
  releaseTask(taskId: string): void {
    const scope = this.tabs.get(taskId);
    const ns = this.namespaces.get(taskId);
    if (scope && ns !== undefined) {
      for (const tabId of scope) {
        const key = this.#ownerKey(ns, tabId);
        if (this.owner.get(key)?.taskId === taskId) this.owner.delete(key);
      }
    }
    this.tabs.delete(taskId);
    this.bound.delete(taskId);
    this.namespaces.delete(taskId);
  }

  /** chromex-ykj: an IMPLICIT target (no args.tabId) is ambiguous when
   *  the task holds multiple in-scope tabs but no bound default — the
   *  caller must pass args.tabId; never silently pick one. */
  implicitTargetAmbiguous(taskId: string, ns: string): boolean {
    this.#ensureNamespace(taskId, ns);
    const scope = this.tabs.get(taskId);
    return this.bound.get(taskId) === undefined && (scope?.size ?? 0) > 1;
  }

  /** Scope snapshot shipped inside browser.tool.request for host-side
   *  enforcement of the RESOLVED tabId. `foreignTabIds` only lists tabs
   *  owned in THIS namespace — other profiles/instances are invisible
   *  to the host and their numeric ids are not comparable (§3.2). */
  payloadFor(taskId: string, ns: string): TabScopePayload {
    this.#ensureNamespace(taskId, ns);
    const scope = this.tabs.get(taskId);
    return {
      boundTabId: this.bound.get(taskId) ?? null,
      allowedTabIds: scope ? [...scope] : [],
      foreignTabIds: [...this.owner.values()]
        .filter((e) => e.ns === ns && e.taskId !== taskId)
        .map((e) => e.tabId),
    };
  }
}
