/**
 * content/console-capture.ts — page MAIN-world console/error capture for
 * `browser.page.console` (chromex-nr8).
 *
 * Content scripts run in an isolated world: wrapping `console.*` there
 * only sees the content script's own calls, never the page's. The honest
 * path is `chrome.scripting.executeScript({ world: "MAIN" })`, which also
 * bypasses page CSP (unlike a <script> tag injection).
 *
 * `chromexConsoleCollect` is deliberately SELF-CONTAINED: chrome.scripting
 * serializes the function source and re-evaluates it in the page, so it
 * must not reference module scope — every literal is inlined below.
 * State persists on `window.__chromexConsoleBuffer` across calls until
 * navigation. Buffer is bounded (200 entries, ~1k chars each).
 *
 * Honest limits: capture starts at first call — console output emitted
 * before the first `browser.page.console` is NOT recorded. Errors thrown
 * before install are missed; `window.onerror`/`unhandledrejection` are
 * captured from install time onward.
 */

export interface ChromexConsoleEntry {
  level: string;
  text: string;
  ts: number;
}

export interface ChromexConsoleCollectResult {
  /** true once wrappers are installed in this page's main world */
  installed: boolean;
  entries: ChromexConsoleEntry[];
}

export function chromexConsoleCollect(
  limit?: unknown,
  level?: unknown,
): ChromexConsoleCollectResult {
  const w = window as unknown as Record<string, unknown>;
  // Literals duplicated from the module constants — this function is
  // stringified by chrome.scripting and cannot close over module scope.
  const BUFFER_KEY = "__chromexConsoleBuffer";
  const INSTALLED_KEY = "__chromexConsoleInstalled";
  const MAX_ENTRIES = 200;
  const MAX_ARG_CHARS = 300;
  const MAX_TEXT_CHARS = 1000;

  if (w[INSTALLED_KEY] !== true) {
    const buffer: ChromexConsoleEntry[] = [];
    w[BUFFER_KEY] = buffer;

    const formatArg = (value: unknown): string => {
      if (typeof value === "string") return value;
      if (value instanceof Error) return `${value.name}: ${value.message}`;
      try {
        const s = JSON.stringify(value);
        return typeof s === "string" ? s : String(value);
      } catch {
        return String(value);
      }
    };

    const push = (entryLevel: string, args: unknown[]): void => {
      const text = args
        .map((a) => formatArg(a).slice(0, MAX_ARG_CHARS))
        .join(" ")
        .slice(0, MAX_TEXT_CHARS);
      buffer.push({ level: entryLevel, text, ts: Date.now() });
      if (buffer.length > MAX_ENTRIES) {
        buffer.splice(0, buffer.length - MAX_ENTRIES);
      }
    };

    const consoleRecord = console as unknown as Record<string, unknown>;
    for (const name of ["log", "info", "warn", "error", "debug"] as const) {
      const original = consoleRecord[name];
      if (typeof original !== "function") continue;
      const originalFn = original as (...a: unknown[]) => unknown;
      consoleRecord[name] = (...args: unknown[]) => {
        push(name, args);
        return originalFn.apply(console, args);
      };
    }

    window.addEventListener("error", (event) => {
      push("error", [
        event.message || "window error",
        event.filename ? `${event.filename}:${event.lineno}` : "",
      ]);
    });
    window.addEventListener("unhandledrejection", (event) => {
      push("error", ["unhandledrejection", String((event as PromiseRejectionEvent).reason ?? "")]);
    });

    w[INSTALLED_KEY] = true;
  }

  const buffer = Array.isArray(w[BUFFER_KEY])
    ? (w[BUFFER_KEY] as ChromexConsoleEntry[])
    : [];
  const wantLevel = typeof level === "string" && level.length > 0 ? level : null;
  const lim =
    typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? Math.min(Math.floor(limit), MAX_ENTRIES)
      : 100;
  const filtered = wantLevel ? buffer.filter((e) => e && e.level === wantLevel) : buffer;
  return { installed: w[INSTALLED_KEY] === true, entries: filtered.slice(-lim) };
}
