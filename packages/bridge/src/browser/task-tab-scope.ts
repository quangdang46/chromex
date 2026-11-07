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
  /** tabIds owned by OTHER tasks — never bindable/usable */
  foreignTabIds: number[];
}

export class TaskTabScope {
  /** taskId → in-scope tabIds (bound tab first, then acquired) */
  private readonly tabs = new Map<string, Set<number>>();
  /** taskId → first bound tabId (default resolution target) */
  private readonly bound = new Map<string, number>();
  /** tabId → owning taskId (exclusive while bound) */
  private readonly owner = new Map<number, string>();

  /** May `taskId` target `tabId` right now? In-scope → yes; unbound task
   *  → yes iff the tab is unowned or already its own (first bind). */
  permits(taskId: string, tabId: number): boolean {
    const scope = this.tabs.get(taskId);
    if (scope?.has(tabId)) return true;
    if (scope && scope.size > 0) return false;
    const o = this.owner.get(tabId);
    return o === undefined || o === taskId;
  }

  /** Record a bind/acquisition. Returns false when the tab belongs to
   *  another task — callers treat that as not_in_scope. */
  bind(taskId: string, tabId: number): boolean {
    if (!this.permits(taskId, tabId)) return false;
    let scope = this.tabs.get(taskId);
    if (!scope) {
      scope = new Set();
      this.tabs.set(taskId, scope);
    }
    scope.add(tabId);
    if (!this.owner.has(tabId)) this.owner.set(tabId, taskId);
    if (!this.bound.has(taskId)) this.bound.set(taskId, tabId);
    return true;
  }

  /** Add tabs the task acquired through its own tool results. Tabs owned
   *  by another task are skipped — a result cannot grant foreign scope. */
  acquire(taskId: string, tabIds: Iterable<number>): void {
    for (const tabId of tabIds) {
      const o = this.owner.get(tabId);
      if (o !== undefined && o !== taskId) continue;
      let scope = this.tabs.get(taskId);
      if (!scope) {
        scope = new Set();
        this.tabs.set(taskId, scope);
      }
      scope.add(tabId);
      if (o === undefined) this.owner.set(tabId, taskId);
    }
  }

  /** Drop one tab from the task's scope (e.g. browser.tab.close). */
  release(taskId: string, tabId: number): void {
    this.tabs.get(taskId)?.delete(tabId);
    if (this.owner.get(tabId) === taskId) this.owner.delete(tabId);
    if (this.bound.get(taskId) === tabId) this.bound.delete(taskId);
  }

  /** Task ended/purged — release every tab it owned. */
  releaseTask(taskId: string): void {
    const scope = this.tabs.get(taskId);
    if (scope) {
      for (const tabId of scope) {
        if (this.owner.get(tabId) === taskId) this.owner.delete(tabId);
      }
    }
    this.tabs.delete(taskId);
    this.bound.delete(taskId);
  }

  /** Scope snapshot shipped inside browser.tool.request for host-side
   *  enforcement of the RESOLVED tabId. */
  payloadFor(taskId: string): TabScopePayload {
    const scope = this.tabs.get(taskId);
    return {
      boundTabId: this.bound.get(taskId) ?? null,
      allowedTabIds: scope ? [...scope] : [],
      foreignTabIds: [...this.owner.entries()]
        .filter(([, t]) => t !== taskId)
        .map(([tabId]) => tabId),
    };
  }
}
