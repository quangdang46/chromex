/**
 * content/verify.ts — post-action observation + semantic verification
 * (plan §6.3, P2-02).
 *
 * Two layers, never conflated:
 *  - observation: raw DOM facts captured before/after the action
 *    (url, scroll, target value/checked/expanded/connected).
 *  - semantic `verified`: true only with action-matched TARGETED
 *    evidence; a generic fingerprint/page change alone is "unknown".
 *    "unknown" must never trigger a mutating retry — callers treat
 *    it as unconfirmed, not failed.
 */

import type { BrowserDomActionStep } from "@codex-sidepanel/shared";

export interface PageObservation {
  url: string;
  scrollX: number;
  scrollY: number;
}

export interface TargetObservation {
  /** element still in the document */
  connected: boolean;
  /** input/textarea/select value ("" when not a value control) */
  value: string;
  /** checkbox/radio/switch state */
  checked: boolean | null;
  /** aria-expanded attribute value, null when absent */
  ariaExpanded: string | null;
  /** element is document.activeElement */
  focused: boolean;
}

export function observePage(): PageObservation {
  return {
    url: window.location.href,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
}

export function observeTarget(element: HTMLElement | null): TargetObservation {
  if (!element) {
    return { connected: false, value: "", checked: null, ariaExpanded: null, focused: false };
  }
  const valueEl =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
      ? element
      : null;
  const checkedEl =
    element instanceof HTMLInputElement &&
    ["checkbox", "radio"].includes((element.type || "").toLowerCase())
      ? element
      : null;
  const role = (element.getAttribute("role") ?? "").toLowerCase();
  return {
    connected: element.isConnected,
    value: valueEl ? valueEl.value.slice(0, 500) : "",
    checked: checkedEl ? checkedEl.checked : role === "checkbox" || role === "radio" || role === "switch"
      ? element.getAttribute("aria-checked") === "true"
      : null,
    ariaExpanded: element.getAttribute("aria-expanded"),
    focused: document.activeElement === element,
  };
}

function urlChanged(before: PageObservation, after: PageObservation): boolean {
  return before.url !== after.url;
}

function scrollDelta(before: PageObservation, after: PageObservation): { x: number; y: number } {
  return { x: after.scrollX - before.scrollX, y: after.scrollY - before.scrollY };
}

/**
 * Semantic verdict for one executed step. `expectedValue` is the fill/
 * select payload when the action sets a value.
 */
export function verifyDomAction(
  step: BrowserDomActionStep,
  before: { page: PageObservation; target: TargetObservation | null },
  after: { page: PageObservation; target: TargetObservation | null },
): boolean | "unknown" {
  const targetBefore = before.target;
  const targetAfter = after.target;
  const nav = urlChanged(before.page, after.page);
  const scroll = scrollDelta(before.page, after.page);
  const scrolled = scroll.x !== 0 || scroll.y !== 0;

  // Targeted evidence helpers — these are action-matched, not generic.
  const targetGone = targetBefore?.connected === true && targetAfter?.connected === false;
  const targetStateChanged =
    targetBefore != null &&
    targetAfter != null &&
    targetBefore.connected &&
    targetAfter.connected &&
    (targetBefore.value !== targetAfter.value ||
      (targetBefore.checked !== null && targetBefore.checked !== targetAfter.checked) ||
      targetBefore.ariaExpanded !== targetAfter.ariaExpanded ||
      targetBefore.focused !== targetAfter.focused);

  switch (step.action) {
    case "navigate":
      // Same-document SPA nav may keep the URL observer identical; only
      // a real URL change confirms. Anything else is unconfirmed.
      return nav ? true : "unknown";

    case "click":
      // §6.3: click needs TARGETED evidence — element gone, expanded
      // flipped, checked toggled, value changed, focus moved to it, or
      // URL changed. A generic page/fingerprint change is "unknown".
      if (nav || targetGone || targetStateChanged || targetAfter?.focused === true) return true;
      return "unknown";

    case "focus":
      return targetAfter?.focused === true ? true : "unknown";

    case "fill": {
      const expected = step.value ?? "";
      if (targetGone) return "unknown"; // can't confirm — element vanished mid-fill
      if (targetAfter && targetAfter.value === expected) return true;
      if (targetAfter && targetBefore && targetAfter.value !== targetBefore.value) return false;
      return "unknown";
    }

    case "select": {
      const expected = step.value ?? "";
      if (targetGone) return "unknown";
      if (targetAfter && targetAfter.value === expected) return true;
      if (targetAfter && targetBefore && targetAfter.value !== targetBefore.value) return false;
      return "unknown";
    }

    case "submit":
      if (nav || targetGone || targetStateChanged) return true;
      return "unknown";

    case "scroll":
      return scrolled ? true : "unknown";

    case "press":
      // Key events are untrusted: targeted evidence only — a URL change,
      // element removal, or observed target state change. Otherwise the
      // press is unconfirmed, never retried.
      if (nav || targetGone || targetStateChanged) return true;
      return "unknown";

    // hover dispatches untrusted pointer/mouse events with no observable
    // state contract — always "unknown" (falls through to default).

    default:
      return "unknown";
  }
}
