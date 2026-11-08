/**
 * chromexSwOp — fixed-shape Service Worker helper run in the page MAIN
 * world via chrome.scripting. The agent supplies an action and optional
 * scope — never code.
 *
 * Actions: list | unregister | update.
 */
export function chromexSwOp(
  action: string,
  scope: string,
): Promise<Record<string, unknown>> {
  return (async () => {
    try {
      if (action === "list") {
        if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
          return { ok: false, error: "serviceWorker API unavailable (insecure context?)" };
        }
        const regs = await navigator.serviceWorker.getRegistrations();
        const sw = navigator.serviceWorker;
        const describe = (r: ServiceWorkerRegistration) => ({
          scope: r.scope,
          scriptURL:
            r.active?.scriptURL ?? r.waiting?.scriptURL ?? r.installing?.scriptURL ?? null,
          state: r.active ? "active" : r.waiting ? "waiting" : r.installing ? "installing" : "none",
          activeState: r.active?.state ?? null,
        });
        return {
          ok: true,
          result: {
            registrations: regs.map(describe),
            count: regs.length,
            controlled: sw.controller !== null,
            controllerScriptURL: sw.controller?.scriptURL ?? null,
          },
        };
      }
      if (action === "unregister") {
        if (!scope) return { ok: false, error: "unregister requires scope" };
        const regs = await navigator.serviceWorker.getRegistrations();
        const target = regs.find((r) => r.scope === scope);
        if (!target) {
          return { ok: true, result: { scope, unregistered: false, found: false } };
        }
        const ok = await target.unregister();
        return { ok: true, result: { scope, unregistered: ok, found: true } };
      }
      if (action === "update") {
        // registration.update() re-checks the script URL for a newer
        // worker — resolves when the CHECK completes, not when a new
        // worker installs (honest: we report the check, not adoption).
        if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
          return { ok: false, error: "serviceWorker API unavailable (insecure context?)" };
        }
        const regs = await navigator.serviceWorker.getRegistrations();
        const targets = scope ? regs.filter((r) => r.scope === scope) : regs;
        if (scope && targets.length === 0) {
          return { ok: true, result: { scope, found: false, updated: [] } };
        }
        const updated: Array<Record<string, unknown>> = [];
        for (const r of targets) {
          try {
            await r.update();
            updated.push({ scope: r.scope, ok: true });
          } catch (e) {
            updated.push({
              scope: r.scope, ok: false,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }
        return {
          ok: true,
          result: {
            updated,
            count: updated.length,
            ...(scope ? { scope, found: true } : {}),
          },
        };
      }
      return { ok: false, error: `unknown action: ${action}` };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })();
}
