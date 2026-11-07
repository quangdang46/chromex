/**
 * content/actions.ts — DOM action executor + AI-control overlay
 * (plan §6.4 split). Element resolution/predicates live in refs.ts;
 * snapshot collection in snapshot.ts.
 */

import type {
  BrowserAutomationMode,
  BrowserDomActionResult,
  BrowserDomActionStep,
} from "@codex-sidepanel/shared";

import {
  collectInteractiveElements,
  getElementLabel,
  isDomActionElementDisabled,
  isTextEntryCandidate,
  normalizeDomActionText,
  resolveDirectEditableTarget,
  resolveDomActionTargetDetailed,
  resolveEditableTargetAfterActivation,
  safeRemoveElement,
  setNativeTextControlValue,
  sleepDomActionTick,
  waitForDomActionTick,
} from "./refs.js";
import { observePage, observeTarget, verifyDomAction } from "./verify.js";

let aiControlOverlayNode: HTMLDivElement | null = null;
let aiControlOverlayTimer: number | null = null;
let aiControlOverlayWatchdogTimer: number | null = null;
let aiControlCancelled = false;

export function setAiControlCancelled(value: boolean): void {
  aiControlCancelled = value;
}

const AI_CONTROL_OVERLAY_MAX_MS = 45_000;

export function showAiControlOverlay(mode: BrowserAutomationMode, label = "Codex is controlling this page"): void {
  clearAiControlOverlayTimers();
  ensureAiControlStyle();
  if (!aiControlOverlayNode) {
    removeStaleAiControlOverlays();
    aiControlOverlayNode = document.createElement("div");
    aiControlOverlayNode.className = "codex-ai-control-border";
    aiControlOverlayNode.setAttribute("aria-hidden", "true");
    const pill = document.createElement("div");
    pill.className = "codex-ai-control-pill";
    const modeLabel = document.createElement("span");
    modeLabel.className = "codex-ai-control-mode";
    const text = document.createElement("span");
    text.className = "codex-ai-control-label";
    pill.append(modeLabel, text);
    aiControlOverlayNode.append(pill);
    document.documentElement.append(aiControlOverlayNode);
  }

  aiControlOverlayNode.dataset.mode = mode;
  const modeLabel = aiControlOverlayNode.querySelector<HTMLElement>(".codex-ai-control-mode");
  const text = aiControlOverlayNode.querySelector<HTMLElement>(".codex-ai-control-label");
  if (modeLabel) {
    modeLabel.textContent = mode === "dom" ? "DOM" : mode === "playwright" ? "Playwright" : "Computer Use";
  }
  if (text) {
    text.textContent = label;
  }
  scheduleAiControlOverlayWatchdog();
}

export function removeStaleAiControlOverlays(): void {
  for (const node of Array.from(document.querySelectorAll(".codex-ai-control-border"))) {
    if (node !== aiControlOverlayNode) {
      safeRemoveElement(node);
    }
  }
}

export function hideAiControlOverlay(): void {
  clearAiControlOverlayTimers();
  safeRemoveElement(aiControlOverlayNode);
  aiControlOverlayNode = null;
}

export function scheduleHideAiControlOverlay(delayMs: number): void {
  clearAiControlOverlayTimers();
  if (delayMs <= 0) {
    hideAiControlOverlay();
    return;
  }
  aiControlOverlayTimer = window.setTimeout(() => {
    hideAiControlOverlay();
    aiControlOverlayTimer = null;
  }, Math.max(0, delayMs));
}

export function scheduleAiControlOverlayWatchdog(): void {
  if (aiControlOverlayWatchdogTimer !== null) {
    window.clearTimeout(aiControlOverlayWatchdogTimer);
  }
  aiControlOverlayWatchdogTimer = window.setTimeout(() => {
    aiControlOverlayWatchdogTimer = null;
    scheduleHideAiControlOverlay(0);
  }, AI_CONTROL_OVERLAY_MAX_MS);
}

export function clearAiControlOverlayTimers(): void {
  if (aiControlOverlayTimer !== null) {
    window.clearTimeout(aiControlOverlayTimer);
    aiControlOverlayTimer = null;
  }
  if (aiControlOverlayWatchdogTimer !== null) {
    window.clearTimeout(aiControlOverlayWatchdogTimer);
    aiControlOverlayWatchdogTimer = null;
  }
}

export function ensureAiControlStyle(): void {
  if (document.getElementById("codex-ai-control-style")) {
    return;
  }
  const style = document.createElement("style");
  style.id = "codex-ai-control-style";
  style.textContent = `
    @keyframes codexAiControlPulse {
      0%, 100% {
        box-shadow: 0 0 0 1px rgba(84, 155, 255, 0.46), 0 0 30px rgba(84, 155, 255, 0.22), inset 0 0 22px rgba(84, 155, 255, 0.1);
      }
      50% {
        box-shadow: 0 0 0 2px rgba(84, 155, 255, 0.62), 0 0 58px rgba(84, 155, 255, 0.36), inset 0 0 34px rgba(84, 155, 255, 0.16);
      }
    }
    @keyframes codexAiControlAura {
      0%, 100% {
        opacity: 0.46;
        transform: scale(1);
      }
      50% {
        opacity: 0.82;
        transform: scale(1.012);
      }
    }
    .codex-ai-control-border {
      position: fixed;
      inset: 6px;
      z-index: 2147483647;
      pointer-events: none;
      border: 1px solid rgba(84, 155, 255, 0.78);
      border-radius: 16px;
      animation: codexAiControlPulse 2.8s ease-in-out infinite;
      box-sizing: border-box;
    }
    .codex-ai-control-border::before {
      content: "";
      position: fixed;
      inset: 0;
      pointer-events: none;
      border-radius: 20px;
      background:
        radial-gradient(circle at 12% 8%, rgba(84, 155, 255, 0.32), transparent 28%),
        radial-gradient(circle at 88% 12%, rgba(90, 200, 255, 0.22), transparent 30%),
        radial-gradient(circle at 50% 100%, rgba(84, 155, 255, 0.24), transparent 36%);
      filter: blur(18px);
      animation: codexAiControlAura 3.6s ease-in-out infinite;
    }
    .codex-ai-control-pill {
      position: absolute;
      z-index: 1;
      left: 50%;
      bottom: 18px;
      transform: translateX(-50%);
      display: inline-flex;
      align-items: center;
      gap: 10px;
      max-width: min(720px, calc(100vw - 48px));
      padding: 10px 14px;
      border-radius: 16px;
      background: rgba(15, 23, 42, 0.94);
      color: #f8fafc;
      font: 600 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      box-shadow: 0 16px 44px rgba(15, 23, 42, 0.34);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .codex-ai-control-mode {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 44px;
      padding: 5px 8px;
      border-radius: 10px;
      background: rgba(59, 130, 246, 0.95);
      color: #ffffff;
      font-size: 12px;
      letter-spacing: 0.01em;
    }
    .codex-ai-control-label {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
  `;
  document.documentElement.append(style);
}


export async function performBrowserDomActions(steps: BrowserDomActionStep[]): Promise<BrowserDomActionResult> {
  aiControlCancelled = false;
  showAiControlOverlay("dom", "Codex is controlling this page");
  const results: BrowserDomActionResult["results"] = [];
  try {
    for (const step of steps.slice(0, 4)) {
      await waitForDomActionTick();
      if (aiControlCancelled) {
        results.push({
          step,
          ok: false,
          message: "Browser control was stopped by the user.",
        });
        return {
          ok: false,
          summary: "Browser control was stopped.",
          results,
          controlMode: "dom",
          cancelled: true,
        };
      }
      results.push(await performBrowserDomAction(step));
    }
    return {
      ok: results.every((result) => result.ok),
      summary: summarizeDomActionResults(results),
      results,
      controlMode: "dom",
    };
  } finally {
    scheduleHideAiControlOverlay(0);
  }
}


export async function performBrowserDomAction(step: BrowserDomActionStep): Promise<BrowserDomActionResult["results"][number]> {
  try {
    if (step.action === "navigate") {
      performNavigateAction(step);
      return { step, ok: true, message: "Navigated the current page." };
    }

    const target = resolveDomActionTargetDetailed(step);
    // chromex-ykj: ≥2 matches → typed ambiguous_target, never first-match.
    if (target.status === "ambiguous") {
      return {
        step,
        ok: false,
        code: "browser.ambiguous_target",
        message: `${target.count} elements match the target; use a snapshot ref or a more specific selector/label`,
      };
    }
    const resolvedElement = target.status === "resolved" ? target.element : null;
    // press may legitimately target the focused element when no explicit
    // target resolves (e.g. "press Enter" in a form field).
    const actionTarget =
      resolvedElement ??
      (step.action === "press" && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    if (!resolvedElement && step.action !== "scroll" && step.action !== "press") {
      return { step, ok: false, message: "Target element was not found.", code: "browser.element_not_found" };
    }

    if (step.action === "scroll") {
      const before = { page: observePage(), target: observeTarget(resolvedElement) };
      performScrollAction(resolvedElement, step);
      await waitForDomActionTick();
      const verified = verifyDomAction(step, before, { page: observePage(), target: observeTarget(resolvedElement) });
      return { step, ok: true, message: "Scrolled the page.", verified };
    }

    if (resolvedElement && isDomActionElementDisabled(resolvedElement)) {
      return { step, ok: false, message: "Target element is unavailable.", code: "browser.element_not_found" };
    }

    if (resolvedElement) {
      resolvedElement.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
      await waitForDomActionTick();
    }

    // Every action reaching the switch below has a resolved element except
    // press, which uses actionTarget (explicit target or focused element).
    const element = resolvedElement as HTMLElement;

    // §6.3 two-layer verify: observe before dispatch, observe after,
    // then reduce to a semantic verdict. "unknown" is reported, never
    // retried — the caller decides.
    const before = { page: observePage(), target: observeTarget(actionTarget) };
    let ok = true;
    let message = "";
    switch (step.action) {
      case "click":
        element.click();
        message = `Clicked ${getElementLabel(element) || "the target element"}.`;
        break;
      case "focus":
        element.focus();
        message = `Focused ${getElementLabel(element) || "the target element"}.`;
        break;
      case "fill":
        await fillDomActionElement(element, step.value ?? "");
        message = `Filled ${getElementLabel(element) || "the target field"}.`;
        break;
      case "select":
        selectDomActionElement(element, step.value ?? "");
        message = `Selected a value for ${getElementLabel(element) || "the target field"}.`;
        break;
      case "submit":
        submitDomActionElement(element);
        message = "Submitted the nearest form.";
        break;
      case "hover":
        // element is guaranteed non-null here (hover without a resolved
        // target returns element_not_found above). Synthetic events are
        // untrusted: JS listeners fire, but :hover CSS state and trusted
        // gesture checks do not — verify reports "unknown" honestly.
        dispatchHoverSequence(element);
        message = `Hovered ${getElementLabel(element) || "the target element"}.`;
        break;
      case "press": {
        const pressTarget = actionTarget ?? document.body ?? document.documentElement;
        dispatchPressSequence(pressTarget, step);
        message = `Pressed ${step.key || "key"} ${actionTarget ? `on ${getElementLabel(actionTarget) || "the focused element"}` : "on the page"}.`;
        break;
      }
      default:
        ok = false;
        message = "Unsupported action.";
    }
    if (!ok) {
      return { step, ok: false, message };
    }
    await waitForDomActionTick();
    const verified = verifyDomAction(step, before, { page: observePage(), target: observeTarget(element) });
    return { step, ok: true, message, verified };
  } catch (error) {
    return { step, ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}


export function performNavigateAction(step: BrowserDomActionStep): void {
  const url = step.url || step.value || "";
  if (!url) {
    throw new Error("No navigation URL was provided.");
  }
  const destination = new URL(url, window.location.href);
  if (destination.protocol !== "http:" && destination.protocol !== "https:") {
    throw new Error("Only http and https page navigation is supported.");
  }
  window.location.assign(destination.href);
}


export async function fillDomActionElement(element: HTMLElement, value: string): Promise<void> {
  const directTarget = resolveDirectEditableTarget(element);
  if (directTarget) {
    setEditableTargetValue(directTarget, value);
    return;
  }

  const activatedTarget = await resolveEditableTargetAfterActivation(element);
  if (activatedTarget) {
    setEditableTargetValue(activatedTarget, value);
    return;
  }

  throw new Error("Target element cannot be filled.");
}


export function setEditableTargetValue(element: HTMLElement | HTMLInputElement | HTMLTextAreaElement, value: string): void {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    element.focus();
    setNativeTextControlValue(element, value);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (isTextEntryCandidate(element)) {
    element.focus();
    if (element.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection?.removeAllRanges();
      selection?.addRange(range);
      if (!document.execCommand("insertText", false, value)) {
        element.textContent = value;
      }
    } else {
      element.textContent = value;
    }
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  throw new Error("Target element cannot be filled.");
}


export function selectDomActionElement(element: HTMLElement, value: string): void {
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error("Target element is not a select field.");
  }
  const normalizedValue = normalizeDomActionText(value).toLowerCase();
  const option = Array.from(element.options).find(
    (item) =>
      item.value.toLowerCase() === normalizedValue ||
      normalizeDomActionText(item.label || item.textContent || "").toLowerCase() === normalizedValue,
  );
  if (!option) {
    throw new Error("Requested select option was not found.");
  }
  element.value = option.value;
  element.dispatchEvent(new Event("input", { bubbles: true }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}


export function submitDomActionElement(element: HTMLElement): void {
  const form = element instanceof HTMLFormElement ? element : element.closest("form");
  if (!form) {
    throw new Error("No form was found near the target element.");
  }
  if (typeof form.requestSubmit === "function") {
    form.requestSubmit();
    return;
  }
  form.submit();
}


export function performScrollAction(element: HTMLElement | null, step: BrowserDomActionStep): void {
  const amount = step.amountPx ?? Math.round((window.innerHeight || 800) * 0.75);
  const target = element ?? window;
  const direction = step.direction ?? "down";
  if (target === window) {
    if (direction === "top") {
      window.scrollTo({ top: 0, behavior: "smooth" });
      return;
    }
    if (direction === "bottom") {
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "smooth" });
      return;
    }
    window.scrollBy({
      left: direction === "left" ? -amount : direction === "right" ? amount : 0,
      top: direction === "up" ? -amount : direction === "down" ? amount : 0,
      behavior: "smooth",
    });
    return;
  }

  target.scrollBy({
    left: direction === "left" ? -amount : direction === "right" ? amount : 0,
    top: direction === "up" ? -amount : direction === "down" ? amount : 0,
    behavior: "smooth",
  });
}


/**
 * hover (chromex-cly): pointer/mouse event sequence. Synthetic events are
 * UNTRUSTED — isTrusted=false, so :hover CSS and trusted-gesture checks do
 * not engage; JS listeners do. verifyDomAction reports "unknown".
 */
export function dispatchHoverSequence(element: HTMLElement): void {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const common = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window };
  element.dispatchEvent(new PointerEvent("pointerover", { ...common, pointerType: "mouse" }));
  element.dispatchEvent(new PointerEvent("pointerenter", { ...common, pointerType: "mouse" }));
  element.dispatchEvent(new MouseEvent("mouseover", common));
  element.dispatchEvent(new MouseEvent("mouseenter", common));
  element.dispatchEvent(new MouseEvent("mousemove", common));
}

/** Normalize step.modifiers → KeyboardEventInit modifier flags. */
export function pressModifierInit(modifiers: readonly string[] | undefined): KeyboardEventInit {
  const init: KeyboardEventInit = {};
  for (const m of modifiers ?? []) {
    switch (m.toLowerCase()) {
      case "control":
        init.ctrlKey = true;
        break;
      case "alt":
        init.altKey = true;
        break;
      case "shift":
        init.shiftKey = true;
        break;
      case "meta":
        init.metaKey = true;
        break;
      default:
        break; // unknown modifiers are dropped
    }
  }
  return init;
}

/**
 * press (chromex-cly): keydown → (keypress for printable keys) → keyup on
 * the target. Synthetic events are UNTRUSTED: page JS listeners observe
 * them, but browser default actions (Enter submitting a form, Tab moving
 * focus, shortcuts) do NOT run — a trusted path needs chrome.debugger or
 * CDP Input.dispatchKeyEvent, neither of which this backend has.
 */
export function dispatchPressSequence(target: EventTarget, step: BrowserDomActionStep): void {
  const key = typeof step.key === "string" ? step.key : "";
  if (!key) {
    throw new Error("browser.page.press requires a key.");
  }
  const init: KeyboardEventInit = {
    key,
    bubbles: true,
    cancelable: true,
    ...pressModifierInit(step.modifiers),
  };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  if (key.length === 1) {
    target.dispatchEvent(new KeyboardEvent("keypress", init));
  }
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

export function summarizeDomActionResults(results: BrowserDomActionResult["results"]): string {
  const okCount = results.filter((result) => result.ok).length;
  if (okCount === results.length) {
    return "Requested browser action completed.";
  }
  if (okCount > 0) {
    return `Partially completed ${okCount} of ${results.length} browser actions.`;
  }
  return "No browser action was completed.";
}

