/**
 * content/wait.ts — browser.page.wait conditional mode.
 *
 * The host sends `page.dom.wait` when the caller passed a condition
 * (text / textGone / selector / urlContains) instead of a bare `ms`
 * sleep. Polls the DOM + URL until every specified condition holds or
 * the deadline passes. Never navigates or mutates the page.
 */

import { isPointerReachableElement } from "./actions.js";
import { collectOpenShadowRoots, querySelectorAllDeep } from "./refs.js";

export interface PageWaitConditions {
  /** substring that must appear in the page's visible text */
  text?: string;
  /** substring that must DISAPPEAR from the page's visible text */
  textGone?: string;
  /** CSS selector that must match at least one element */
  selector?: string;
  /** CSS selector that must match NO element (chromex-0fza expect.goneSelector) */
  selectorGone?: string;
  /** substring that must appear in window.location.href */
  urlContains?: string;
  /** minimum document.readyState — "interactive" | "complete" */
  readyState?: string;
  /** CSS selector that must match at least one VISIBLE element —
   *  display:none/visibility:hidden don't count (mirrors playwright
   *  waitForSelector state:"visible"). */
  visibleSelector?: string;
}

export interface PageWaitResult {
  ok: boolean;
  /** which condition class was satisfied first ("conditions" | "timeout") */
  matched?: string;
  elapsedMs: number;
  timedOut?: boolean;
}

const POLL_INTERVAL_MS = 100;

/** innerText does not cross shadow boundaries — body.innerText alone
 *  leaves web-component UIs invisible to text/textGone waits. Each
 *  open shadow root contributes its top-level children's innerText;
 *  nested roots are covered by their own entries in the root list. */
function pageText(): string {
  const parts: string[] = [];
  const bodyText = document.body?.innerText ?? "";
  if (bodyText) parts.push(bodyText);
  for (const sr of collectOpenShadowRoots(document)) {
    for (const child of Array.from(sr.children)) {
      if (child instanceof HTMLElement && child.innerText) {
        parts.push(child.innerText);
      }
    }
  }
  return parts.join("\n").slice(0, 500_000);
}

function conditionsMet(conds: Required<PageWaitConditions>): boolean {
  if (conds.text && !pageText().includes(conds.text)) return false;
  if (conds.textGone && pageText().includes(conds.textGone)) return false;
  if (conds.selector) {
    let found = false;
    try {
      found = querySelectorAllDeep(conds.selector).length > 0;
    } catch {
      found = false; // invalid selector can never be satisfied
    }
    if (!found) return false;
  }
  if (conds.selectorGone) {
    let present = true;
    try {
      present = querySelectorAllDeep(conds.selectorGone).length > 0;
    } catch {
      // invalid selector: fail closed — the "gone" claim is unproven,
      // same as an unsatisfiable `selector` condition.
      present = true;
    }
    if (present) return false;
  }
  if (conds.urlContains && !window.location.href.includes(conds.urlContains)) return false;
  if (conds.visibleSelector) {
    let satisfied = false;
    try {
      satisfied = querySelectorAllDeep(conds.visibleSelector).some(
        (el) => el instanceof HTMLElement && isPointerReachableElement(el),
      );
    } catch {
      satisfied = false; // invalid selector can never be satisfied
    }
    if (!satisfied) return false;
  }
  if (conds.readyState) {
    const order = ["loading", "interactive", "complete"];
    const want = order.indexOf(conds.readyState);
    const have = order.indexOf(document.readyState);
    // unknown requested state can never be satisfied — fail closed
    if (want < 0 || have < want) return false;
  }
  return true;
}

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms));

/**
 * Poll until all given conditions hold. `timeoutMs` is clamped by the
 * caller (host caps at ~30s); returns timedOut rather than throwing so
 * the host can map it to the typed browser.timeout error.
 */
export async function waitForPageConditions(
  conds: PageWaitConditions,
  timeoutMs: number,
): Promise<PageWaitResult> {
  const started = Date.now();
  const deadline = started + Math.max(0, timeoutMs);
  const normalized: Required<PageWaitConditions> = {
    text: typeof conds.text === "string" ? conds.text : "",
    textGone: typeof conds.textGone === "string" ? conds.textGone : "",
    selector: typeof conds.selector === "string" ? conds.selector : "",
    selectorGone: typeof conds.selectorGone === "string" ? conds.selectorGone : "",
    urlContains: typeof conds.urlContains === "string" ? conds.urlContains : "",
    readyState: typeof conds.readyState === "string" ? conds.readyState : "",
    visibleSelector: typeof conds.visibleSelector === "string" ? conds.visibleSelector : "",
  };
  for (;;) {
    if (conditionsMet(normalized)) {
      return { ok: true, matched: "conditions", elapsedMs: Date.now() - started };
    }
    if (Date.now() >= deadline) {
      return { ok: false, timedOut: true, elapsedMs: Date.now() - started };
    }
    await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}
