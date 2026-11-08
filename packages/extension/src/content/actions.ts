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

    // Coordinate click — no DOM target to resolve; hit-test at the
    // point instead. Covers canvas/WebGL/map surfaces.
    if (step.action === "click" && typeof step.x === "number" && typeof step.y === "number") {
      const button = step.button === "right" || step.button === "middle" ? step.button : "left";
      dispatchClickAtPoint(step.x, step.y, {
        button,
        modifiers: step.modifiers,
        clickCount: step.clickCount,
      });
      return {
        step,
        ok: true,
        message: `Clicked at viewport coordinates (${Math.round(step.x)}, ${Math.round(step.y)}).`,
      };
    }

    // Coordinate hover — same non-DOM surface reach as coordinate click.
    if (step.action === "hover" && typeof step.x === "number" && typeof step.y === "number") {
      dispatchHoverAtPoint(step.x, step.y);
      return {
        step,
        ok: true,
        message: `Hovered viewport coordinates (${Math.round(step.x)}, ${Math.round(step.y)}).`,
      };
    }

    // Coordinate drag — x,y → dropX,dropY, for canvas/surface drags
    // with no DOM source or drop element.
    if (
      step.action === "drag" &&
      typeof step.x === "number" && typeof step.y === "number" &&
      typeof step.dropX === "number" && typeof step.dropY === "number"
    ) {
      dispatchDragAtPoints(step.x, step.y, step.dropX, step.dropY);
      return {
        step,
        ok: true,
        message: `Dragged from (${Math.round(step.x)}, ${Math.round(step.y)}) to (${Math.round(step.dropX)}, ${Math.round(step.dropY)}).`,
      };
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
    // press/selectAll may legitimately target the focused element when no
    // explicit target resolves (e.g. "press Enter" in a form field).
    const actionTarget =
      resolvedElement ??
      ((step.action === "press" || step.action === "selectAll") && document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null);
    if (!resolvedElement && step.action !== "scroll" && step.action !== "press" && step.action !== "selectAll") {
      return {
        step,
        ok: false,
        message:
          "Target element was not found — take a fresh browser.page.snapshot and target a returned ref/label instead of guessing selectors.",
        code: "browser.element_not_found",
      };
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
      // Instant, not smooth: the pointer-hit gate below runs
      // elementFromPoint immediately after this, and a smooth scroll
      // would still be animating — every hit test would lie.
      resolvedElement.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      await waitForDomActionTick();
    }

    // Pointer-hit fidelity: display:none / visibility:hidden / no-layout
    // elements cannot be reached by a real mouse, but synthetic dispatch
    // would still "succeed" — playwright refuses these via actionability.
    // opacity:0 stays reachable (real pointers hit it). Form actions
    // (fill/type/select/upload) are exempt — hidden inputs are legit.
    if (
      resolvedElement &&
      (step.action === "click" || step.action === "hover" || step.action === "drag") &&
      !isPointerReachableElement(resolvedElement)
    ) {
      return {
        step,
        ok: false,
        code: "browser.element_not_visible",
        message: "Target element is not visible — a real pointer could not reach it",
      };
    }

    // Occlusion gate: a modal/overlay painted over the target passes the
    // visibility check but a real click lands on the overlay — synthetic
    // dispatch would fire handlers on an element no pointer can reach.
    // Hit-test the element's center; descendant/ancestor hits still
    // resolve to the target through bubbling. Out-of-viewport or
    // undetermined hits stay lenient — scrollIntoView may still be
    // settling on heavy pages.
    if (
      resolvedElement &&
      (step.action === "click" || step.action === "hover" || step.action === "drag") &&
      !isPointerHitTarget(resolvedElement)
    ) {
      return {
        step,
        ok: false,
        code: "browser.element_not_visible",
        message: "Target element is covered by another element — a real pointer could not reach it",
      };
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
      case "click": {
        const button = typeof step.button === "string" ? step.button : "left";
        if (button === "right" || button === "middle") {
          // contextmenu / auxclick path — same untrusted-event caveat
          // as click; no default activation via .click().
          dispatchButtonSequence(element, button);
          message = `Clicked ${getElementLabel(element) || "the target element"} with the ${button} button.`;
          break;
        }
        // Full pointer/mouse sequence then HTMLElement.click() — bare
        // .click() only fires `click`, so components listening on
        // pointerdown/mousedown (menus, drag handles, press-and-hold
        // buttons) never see the action. .click() itself still runs so
        // default activation (checkbox toggle, label forwarding,
        // overridden click() methods) keeps working exactly once.
        const clickModifiers = Array.isArray(step.modifiers) ? step.modifiers : undefined;
        dispatchHoverSequence(element);
        dispatchClickSequence(element, clickModifiers);
        element.click();
        const clickCount = typeof step.clickCount === "number" ? step.clickCount : 1;
        if (clickCount === 2) {
          // Second full sequence then the dblclick event — same order
          // the browser produces (click, click, dblclick).
          dispatchClickSequence(element, clickModifiers);
          element.click();
          const rect = element.getBoundingClientRect();
          element.dispatchEvent(
            new MouseEvent("dblclick", {
              bubbles: true,
              cancelable: true,
              clientX: rect.left + rect.width / 2,
              clientY: rect.top + rect.height / 2,
              view: window,
              button: 0,
            }),
          );
          message = `Double-clicked ${getElementLabel(element) || "the target element"}.`;
        } else {
          message = `Clicked ${getElementLabel(element) || "the target element"}.`;
        }
        break;
      }
      case "focus":
        element.focus();
        message = `Focused ${getElementLabel(element) || "the target element"}.`;
        break;
      case "fill":
        await fillDomActionElement(element, step.value ?? "");
        message = `Filled ${getElementLabel(element) || "the target field"}.`;
        break;
      case "type":
        await typeDomActionElement(element, step.value ?? "");
        message = `Typed into ${getElementLabel(element) || "the target field"}.`;
        break;
      case "select":
        selectDomActionElement(element, step.value ?? "", step.values);
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
      case "selectAll": {
        // Selection is not the trusted part — the following CDP key
        // events are. input.select() is deterministic for form fields;
        // contenteditable falls back to execCommand.
        const selTarget = actionTarget ?? document.activeElement;
        if (selTarget instanceof HTMLInputElement || selTarget instanceof HTMLTextAreaElement) {
          selTarget.select();
        } else if (selTarget instanceof HTMLElement) {
          selTarget.focus();
          document.execCommand("selectAll");
        } else {
          return { step, ok: false, message: "No selectable element focused.", code: "browser.element_not_found" };
        }
        message = "Selected all content.";
        break;
      }
      case "press": {
        const pressTarget = actionTarget ?? document.body ?? document.documentElement;
        dispatchPressSequence(pressTarget, step);
        message = `Pressed ${step.key || "key"} ${actionTarget ? `on ${getElementLabel(actionTarget) || "the focused element"}` : "on the page"}.`;
        break;
      }
      case "drag": {
        // Destination resolves through the same ref/selector/label
        // machinery as the source — refs stay snapshot-bound.
        const dropStep: BrowserDomActionStep = {
          action: "click",
          reason: step.reason,
          ...(step.dropTargetRef ? { targetRef: step.dropTargetRef } : {}),
          ...(step.dropSelector ? { selector: step.dropSelector } : {}),
          ...(step.dropLabel ? { label: step.dropLabel } : {}),
        };
        const dropTarget = resolveDomActionTargetDetailed(dropStep);
        if (dropTarget.status === "ambiguous") {
          return {
            step,
            ok: false,
            code: "browser.ambiguous_target",
            message: `${dropTarget.count} elements match the drop target; use a snapshot ref or a more specific selector/label`,
          };
        }
        const dropElement = dropTarget.status === "resolved" ? dropTarget.element : null;
        if (!dropElement) {
          return { step, ok: false, message: "Drop target element was not found.", code: "browser.element_not_found" };
        }
        dispatchDragSequence(element, dropElement);
        message = `Dragged ${getElementLabel(element) || "the source element"} onto ${getElementLabel(dropElement) || "the drop target"}.`;
        break;
      }
      case "upload": {
        // DataTransfer bytes path — synthetic but functional: page JS
        // sees real File objects on input.files. NOT a trusted gesture;
        // sites checking event.isTrusted may still reject.
        const count = await performUploadAction(element, step.files ?? []);
        message = `Uploaded ${count} file(s) to ${getElementLabel(element) || "the target element"}.`;
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


/** Char-level key events for browser.page.type — same untrusted-event
 *  caveat as dispatchPressSequence: listeners observe them, browser
 *  default actions (Enter submit, Tab focus) do NOT run. */
function dispatchCharKeyEvents(target: EventTarget, ch: string): void {
  if (ch === "\n" || ch === "\r") {
    const init: KeyboardEventInit = { key: "Enter", code: "Enter", bubbles: true, cancelable: true };
    target.dispatchEvent(new KeyboardEvent("keydown", init));
    target.dispatchEvent(new KeyboardEvent("keyup", init));
    return;
  }
  const init: KeyboardEventInit = { key: ch, bubbles: true, cancelable: true };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keypress", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

/** browser.page.type — per-character insertion at the caret (moved to
 *  end first), matching playwright pressSequentially append semantics.
 *  Distinct from fill: never clears existing content, fires input per
 *  char so autocomplete/validation/masking handlers observe typing. */
export async function typeDomActionElement(element: HTMLElement, value: string): Promise<void> {
  const directTarget = resolveDirectEditableTarget(element);
  const target = directTarget ?? (await resolveEditableTargetAfterActivation(element));
  if (!target) {
    throw new Error("Target element cannot be typed into.");
  }
  target.focus();
  await waitForDomActionTick();

  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    try {
      const end = target.value.length;
      target.setSelectionRange(end, end);
    } catch {
      // input types without a text selection (number, date, …) — value
      // append still applies.
    }
    for (const ch of value) {
      dispatchCharKeyEvents(target, ch);
      setNativeTextControlValue(target, target.value + ch);
      target.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch === "\n" || ch === "\r" ? "\n" : ch }),
      );
    }
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (target.isContentEditable) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
    for (const ch of value) {
      dispatchCharKeyEvents(target, ch);
      if (!document.execCommand("insertText", false, ch === "\n" || ch === "\r" ? "\n" : ch)) {
        target.textContent = (target.textContent ?? "") + ch;
      }
      target.dispatchEvent(
        new InputEvent("input", { bubbles: true, inputType: "insertText", data: ch === "\n" || ch === "\r" ? "\n" : ch }),
      );
    }
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (isTextEntryCandidate(target)) {
    target.textContent = (target.textContent ?? "") + value;
    target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
    target.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  throw new Error("Target element cannot be typed into.");
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


export function selectDomActionElement(element: HTMLElement, value: string, values?: string[]): void {
  if (!(element instanceof HTMLSelectElement)) {
    throw new Error("Target element is not a select field.");
  }
  const wanted = values && values.length > 0 ? values : [value];
  const normalized = wanted.map((v) => normalizeDomActionText(v).toLowerCase());
  const matches = Array.from(element.options).filter((item) =>
    normalized.some(
      (n) =>
        item.value.toLowerCase() === n ||
        normalizeDomActionText(item.label || item.textContent || "").toLowerCase() === n,
    ),
  );
  if (matches.length !== normalized.length) {
    throw new Error("One or more requested select options were not found.");
  }
  if (!element.multiple && matches.length > 1) {
    throw new Error("Target select is single-choice; pass one value.");
  }
  for (const opt of Array.from(element.options)) opt.selected = matches.includes(opt);
  if (!element.multiple) element.value = matches[0]!.value;
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

/**
 * click (chromex-cly): pointerdown → mousedown → pointerup → mouseup,
 * then the caller runs element.click() for the click event + default
 * activation. Synthetic events are UNTRUSTED — isTrusted=false, so
 * trusted-gesture checks (popup blockers, some payment buttons) still
 * refuse; JS listeners see the full sequence.
 */
export function dispatchClickSequence(element: HTMLElement, modifiers?: readonly string[]): void {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const common = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    view: window,
    button: 0,
    ...pressModifierInit(modifiers),
  };
  element.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerType: "mouse" }));
  element.dispatchEvent(new MouseEvent("mousedown", common));
  element.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerType: "mouse" }));
  element.dispatchEvent(new MouseEvent("mouseup", common));
}

/**
 * click with a non-primary button: right → contextmenu sequence,
 * middle → auxclick. button 2/1 in MouseEventInit; pointer events
 * carry the same button. UNTRUSTED — page JS sees them, browser
 * chrome (native context menu) does NOT open.
 */
export function dispatchButtonSequence(element: HTMLElement, button: "right" | "middle"): void {
  const buttonCode = button === "right" ? 2 : 1;
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const common = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, button: buttonCode };
  element.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerType: "mouse" }));
  element.dispatchEvent(new MouseEvent("mousedown", common));
  if (button === "right") {
    element.dispatchEvent(new PointerEvent("contextmenu", { ...common, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("contextmenu", common));
  } else {
    element.dispatchEvent(new PointerEvent("auxclick", { ...common, pointerType: "mouse" }));
    element.dispatchEvent(new MouseEvent("auxclick", common));
  }
  element.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerType: "mouse" }));
  element.dispatchEvent(new MouseEvent("mouseup", common));
}

/**
 * drag: pointer-based move from source center to target center, then
 * elementFromPoint-targeted up events. When the source is HTML5
 * draggable, also fires the DragEvent sequence (dragstart →
 * dragenter/dragover → drop → dragend) with a real DataTransfer so
 * sortable lists and drop zones see it. All events UNTRUSTED —
 * isTrusted=false; JS listeners observe them, trusted-gesture-gated
 * drop handlers may still refuse.
 */
export function dispatchDragSequence(source: HTMLElement, target: HTMLElement): void {
  const sourceRect = source.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const sx = sourceRect.left + sourceRect.width / 2;
  const sy = sourceRect.top + sourceRect.height / 2;
  const tx = targetRect.left + targetRect.width / 2;
  const ty = targetRect.top + targetRect.height / 2;
  const common = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };

  dispatchHoverSequence(source);
  source.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerType: "mouse", clientX: sx, clientY: sy }));
  source.dispatchEvent(new MouseEvent("mousedown", { ...common, clientX: sx, clientY: sy }));

  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = sx + ((tx - sx) * i) / steps;
    const y = sy + ((ty - sy) * i) / steps;
    const under = (document.elementFromPoint(x, y) as HTMLElement | null) ?? source;
    under.dispatchEvent(new PointerEvent("pointermove", { ...common, pointerType: "mouse", clientX: x, clientY: y }));
    under.dispatchEvent(new MouseEvent("mousemove", { ...common, clientX: x, clientY: y }));
  }

  const dropUnder = (document.elementFromPoint(tx, ty) as HTMLElement | null) ?? target;
  dropUnder.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerType: "mouse", buttons: 0, clientX: tx, clientY: ty }));
  dropUnder.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0, clientX: tx, clientY: ty }));

  // HTML5 drag-and-drop path — only when the source opted into it.
  const dragSource = (source.closest("[draggable='true']") as HTMLElement | null) ?? (source.draggable ? source : null);
  if (dragSource) {
    try {
      const dataTransfer = new DataTransfer();
      const dragInit = { bubbles: true, cancelable: true, view: window, dataTransfer };
      dragSource.dispatchEvent(new DragEvent("dragstart", dragInit));
      dropUnder.dispatchEvent(new DragEvent("dragenter", dragInit));
      dropUnder.dispatchEvent(new DragEvent("dragover", dragInit));
      dropUnder.dispatchEvent(new DragEvent("drop", dragInit));
      dragSource.dispatchEvent(new DragEvent("dragend", dragInit));
    } catch {
      // DataTransfer/DragEvent unavailable — pointer path already ran.
    }
  }
}

/**
 * click at raw viewport coordinates — the only way to reach canvas,
 * WebGL, map tiles and other non-DOM surfaces. Events target
 * document.elementFromPoint(x, y) so hit-testing matches what a real
 * pointer would hit; falls back to <body> outside the viewport content.
 * UNTRUSTED like every synthetic event here.
 */
export function dispatchClickAtPoint(
  x: number,
  y: number,
  opts: { button?: "left" | "right" | "middle"; modifiers?: readonly string[] | undefined; clickCount?: number | undefined } = {},
): void {
  const button = opts.button ?? "left";
  const buttonCode = button === "right" ? 2 : button === "middle" ? 1 : 0;
  const el =
    (document.elementFromPoint(x, y) as HTMLElement | null) ??
    document.body ??
    document.documentElement;
  const common = {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    view: window,
    button: buttonCode,
    ...pressModifierInit(opts.modifiers),
  };
  // Pointer arrival first — :hover styles, mouseover listeners and
  // tooltip triggers observe the same sequence a real mouse produces.
  el.dispatchEvent(new PointerEvent("pointerover", { ...common, pointerType: "mouse" }));
  el.dispatchEvent(new MouseEvent("mouseover", common));
  el.dispatchEvent(new PointerEvent("pointermove", { ...common, pointerType: "mouse" }));
  el.dispatchEvent(new MouseEvent("mousemove", common));

  const fire = (): void => {
    el.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mousedown", common));
    if (button === "right") {
      el.dispatchEvent(new PointerEvent("contextmenu", { ...common, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("contextmenu", common));
    }
    el.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerType: "mouse" }));
    el.dispatchEvent(new MouseEvent("mouseup", common));
    if (button === "left") {
      el.dispatchEvent(new PointerEvent("click", { ...common, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("click", common));
    } else {
      el.dispatchEvent(new PointerEvent("auxclick", { ...common, pointerType: "mouse" }));
      el.dispatchEvent(new MouseEvent("auxclick", common));
    }
  };
  fire();
  if ((opts.clickCount ?? 1) === 2) {
    fire();
    el.dispatchEvent(new MouseEvent("dblclick", { ...common, detail: 2 }));
  }
}

/**
 * drag between raw viewport coordinates — canvas drawing surfaces,
 * map panning, slider widgets with no DOM handles. Pointer-only path:
 * no HTML5 DragEvent sequence (there is no draggable source element
 * to anchor dragstart to). UNTRUSTED like every synthetic event.
 */
export function dispatchDragAtPoints(
  sx: number,
  sy: number,
  tx: number,
  ty: number,
): void {
  const common = { bubbles: true, cancelable: true, view: window, button: 0, buttons: 1 };
  const at = (x: number, y: number): HTMLElement =>
    (document.elementFromPoint(x, y) as HTMLElement | null) ?? document.body ?? document.documentElement;

  const startEl = at(sx, sy);
  startEl.dispatchEvent(new PointerEvent("pointerover", { ...common, pointerType: "mouse", clientX: sx, clientY: sy }));
  startEl.dispatchEvent(new PointerEvent("pointerdown", { ...common, pointerType: "mouse", clientX: sx, clientY: sy }));
  startEl.dispatchEvent(new MouseEvent("mousedown", { ...common, clientX: sx, clientY: sy }));

  const steps = 12;
  for (let i = 1; i <= steps; i++) {
    const x = sx + ((tx - sx) * i) / steps;
    const y = sy + ((ty - sy) * i) / steps;
    const under = at(x, y);
    under.dispatchEvent(new PointerEvent("pointermove", { ...common, pointerType: "mouse", clientX: x, clientY: y }));
    under.dispatchEvent(new MouseEvent("mousemove", { ...common, clientX: x, clientY: y }));
  }

  const endEl = at(tx, ty);
  endEl.dispatchEvent(new PointerEvent("pointerup", { ...common, pointerType: "mouse", buttons: 0, clientX: tx, clientY: ty }));
  endEl.dispatchEvent(new MouseEvent("mouseup", { ...common, buttons: 0, clientX: tx, clientY: ty }));
}

/** Real-pointer reachability for hit-test actions (click/hover/drag).
 *  display:none and visibility:hidden/collapse are unreachable; opacity:0
 *  and off-viewport elements remain reachable — same rule a real mouse
 *  follows. checkVisibility covers content-visibility skipped subtrees
 *  on engines that support it; the manual fallback covers the rest. */
export function isPointerReachableElement(element: HTMLElement): boolean {
  if (typeof element.checkVisibility === "function") {
    try {
      return element.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
    } catch {
      // fall through to the manual check
    }
  }
  if (element.getClientRects().length === 0) return false;
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse";
}

/** Occlusion check for hit-test actions: elementFromPoint at the
 *  element's center must resolve to the element itself or a descendant
 *  (events bubble up to it). An ANCESTOR hit means the target is painted
 *  under its own parent at that point — a real click lands on the
 *  ancestor and the target's handlers never fire, so that counts as
 *  obscured (same strictness as playwright's hit-target check).
 *  Returns true when the hit test cannot prove occlusion — off-viewport,
 *  zero-size, or no hit — so the gate only fires on a definitive
 *  "something else is on top". */
export function isPointerHitTarget(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return true;
  const hit = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!hit) return true;
  return hit === element || element.contains(hit);
}

/**
 * hover at raw viewport coordinates — pointer arrival only (over/move,
 * no down/up), for canvas tooltips and surface hover states. UNTRUSTED.
 */
export function dispatchHoverAtPoint(x: number, y: number): void {
  const el =
    (document.elementFromPoint(x, y) as HTMLElement | null) ??
    document.body ??
    document.documentElement;
  const common = { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window, button: 0 };
  el.dispatchEvent(new PointerEvent("pointerover", { ...common, pointerType: "mouse" }));
  el.dispatchEvent(new MouseEvent("mouseover", common));
  el.dispatchEvent(new PointerEvent("pointermove", { ...common, pointerType: "mouse" }));
  el.dispatchEvent(new MouseEvent("mousemove", common));
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

const UPLOAD_MAX_FILES = 8;
const UPLOAD_MAX_BASE64_CHARS = 48 * 1024 * 1024; // ~36MB decoded total

function decodeUploadBase64(base64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Resolve the file input for an upload step: the element itself, a
 *  file input inside it, or the control a <label> points at. */
function resolveUploadFileInput(element: HTMLElement): HTMLInputElement | null {
  const isFileInput = (el: unknown): el is HTMLInputElement =>
    el instanceof HTMLInputElement && (el.type || "").toLowerCase() === "file";
  if (isFileInput(element)) return element;
  const nested = element.querySelector('input[type="file"]');
  if (isFileInput(nested)) return nested;
  if (element instanceof HTMLLabelElement && isFileInput(element.control)) {
    return element.control;
  }
  return null;
}

/**
 * upload: build File objects from base64 bytes, attach via DataTransfer,
 * then dispatch input+change so page listeners observe the selection.
 * Returns the number of files attached.
 */
export async function performUploadAction(
  element: HTMLElement,
  files: ReadonlyArray<{ name: string; mimeType: string; base64: string }>,
): Promise<number> {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("browser.page.upload requires at least one file.");
  }
  if (files.length > UPLOAD_MAX_FILES) {
    throw new Error(`browser.page.upload accepts at most ${UPLOAD_MAX_FILES} files.`);
  }
  const input = resolveUploadFileInput(element);
  if (!input) {
    throw new Error("Target element is not a file input.");
  }
  let totalBase64 = 0;
  for (const f of files) {
    if (typeof f?.name !== "string" || typeof f?.base64 !== "string" || !f.base64) {
      throw new Error("upload file entries require {name, mimeType, base64}.");
    }
    totalBase64 += f.base64.length;
  }
  if (totalBase64 > UPLOAD_MAX_BASE64_CHARS) {
    throw new Error("browser.page.upload payload exceeds the size limit.");
  }
  const dataTransfer = new DataTransfer();
  for (const f of files) {
    const bytes = decodeUploadBase64(f.base64);
    dataTransfer.items.add(new File([bytes], f.name, { type: typeof f.mimeType === "string" ? f.mimeType : "" }));
  }
  input.files = dataTransfer.files;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  return files.length;
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

