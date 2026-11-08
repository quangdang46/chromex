/**
 * content/find.ts — browser.page.find (chromex tier-1 gap).
 *
 * In-page text/DOM search. Returns bounded matches with a CSS selector
 * AND a content-side ref registered in the same map snapshots use, so a
 * follow-up browser.page.* call can target the match by `ref` or
 * `selector`. Read-only: never mutates the page.
 */

import {
  buildElementSelector,
  collectOpenShadowRoots,
  normalizeDomActionText,
  registerDomActionElementRef,
} from "./refs.js";

export interface PageFindOptions {
  /** literal substring (ignored when `regex` is set) */
  text?: string;
  /** regex pattern string — compiled with "i" unless caseSensitive */
  regex?: string;
  caseSensitive?: boolean;
  /** max matches returned (clamped 1..200, default 50) */
  limit?: number;
  /** restrict the search root (invalid selector → whole document) */
  scopeSelector?: string;
}

export interface PageFindMatch {
  ref: string;
  selector: string;
  tagName: string;
  /** role/aria role when present — cheap context for the caller */
  role: string;
  /** matched element's visible text, bounded */
  text: string;
}

export interface PageFindResult {
  ok: boolean;
  matches: PageFindMatch[];
  /** total candidate elements inspected (bounded) */
  scanned: number;
  /** true when the scan hit the element cap before finishing */
  truncated: boolean;
}

const MAX_MATCH_TEXT = 240;
const MAX_SCAN_ELEMENTS = 5000;

function compileMatcher(opts: PageFindOptions): ((haystack: string) => boolean) | null {
  const flags = opts.caseSensitive === true ? "" : "i";
  if (typeof opts.regex === "string" && opts.regex.length > 0) {
    let re: RegExp;
    try {
      re = new RegExp(opts.regex, flags);
    } catch {
      return null;
    }
    return (haystack) => re.test(haystack);
  }
  if (typeof opts.text === "string" && opts.text.length > 0) {
    if (opts.caseSensitive === true) {
      return (haystack) => haystack.includes(opts.text!);
    }
    const needle = opts.text.toLowerCase();
    return (haystack) => haystack.toLowerCase().includes(needle);
  }
  return null;
}

function resolveScope(scopeSelector: string | undefined): ParentNode {
  if (scopeSelector) {
    try {
      const el = document.querySelector(scopeSelector);
      if (el) return el;
    } catch {
      // invalid selector → fall back to the document
    }
  }
  return document;
}

/**
 * Find elements whose text matches. Ancestor dedupe: when an element's
 * ancestor was already recorded as a match, the descendant is skipped —
 * the caller can always narrow with scopeSelector/selector.
 */
export function findInPage(opts: PageFindOptions): PageFindResult {
  const match = compileMatcher(opts);
  if (!match) {
    return { ok: false, matches: [], scanned: 0, truncated: false };
  }
  const limit = Math.min(Math.max(Math.floor(opts.limit ?? 50), 1), 200);
  const scope = resolveScope(opts.scopeSelector);
  // querySelectorAll does not cross shadow boundaries — scan every open
  // shadow root under the scope too, or shadow-DOM apps look empty.
  const candidates = [
    ...Array.from(scope.querySelectorAll("*")),
    ...collectOpenShadowRoots(scope).flatMap((sr) => Array.from(sr.querySelectorAll("*"))),
  ];
  const scanned = Math.min(candidates.length, MAX_SCAN_ELEMENTS);
  const truncated = candidates.length > MAX_SCAN_ELEMENTS;
  const matches: PageFindMatch[] = [];
  const matchedElements: HTMLElement[] = [];
  let refSeq = 0;

  for (let i = 0; i < scanned && matches.length < limit; i++) {
    const el = candidates[i];
    if (!(el instanceof HTMLElement)) continue;
    const raw = el.textContent ?? "";
    if (!raw || raw.length > 200_000) continue;
    const haystack = normalizeDomActionText(raw);
    if (!haystack || !match(haystack)) continue;
    // skip when a previously recorded ancestor already covers this match
    if (matchedElements.some((prev) => prev.contains(el))) continue;
    const ref = `find-${++refSeq}`;
    registerDomActionElementRef(ref, el);
    matchedElements.push(el);
    matches.push({
      ref,
      selector: buildElementSelector(el),
      tagName: el.tagName.toLowerCase(),
      role: el.getAttribute("role") ?? "",
      text: haystack.slice(0, MAX_MATCH_TEXT),
    });
  }
  return { ok: true, matches, scanned, truncated };
}
