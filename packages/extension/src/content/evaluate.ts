/**
 * content/evaluate.ts — arbitrary JS evaluation in the page MAIN world
 * for `browser.page.evaluate`.
 *
 * Same delivery path as console-capture: `chrome.scripting.executeScript`
 * serializes this function and re-evaluates it in the page, so it must
 * stay SELF-CONTAINED (no module-scope references). MAIN world means the
 * expression sees real page globals (`window.app`, `document`, page
 * fetch with the page's credentials/CSP-bypassed-by-scripting).
 *
 * Semantics mirror a devtools console expression: the source is wrapped
 * as `return (<expr>)` inside an async function — a single expression,
 * `await` supported, and a returned Promise is unwrapped by the async
 * boundary. Multi-statement logic goes in an IIFE the caller writes.
 *
 * The result goes through chrome.scripting's structured clone — DOM
 * nodes, functions and other non-cloneables come back undefined; we
 * JSON-round-trip defensively and report `truncated` when the payload
 * exceeds the bound.
 */

export interface ChromexEvaluateResult {
  ok: boolean;
  value?: unknown;
  error?: string;
  truncated?: boolean;
}

export async function chromexEvaluate(expression: string): Promise<ChromexEvaluateResult> {
  try {
    // AsyncFunction constructor = eval in global scope without closing
    // over this function's scope; `return (expr)` keeps expression
    // semantics while the async boundary awaits promises.
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as FunctionConstructor;
    const fn = new AsyncFunction(`"use strict";\nreturn (\n${expression}\n);`);
    const value = await fn();
    // 256 KiB bound inlined — this function is stringified by
    // chrome.scripting and cannot close over module scope.
    const maxValueChars = 256 * 1024;
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = undefined;
    }
    if (serialized === undefined) {
      return { ok: true, value: null, truncated: true };
    }
    if (serialized.length > maxValueChars) {
      return { ok: true, value: serialized.slice(0, maxValueChars), truncated: true };
    }
    return { ok: true, value: JSON.parse(serialized) as unknown };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
