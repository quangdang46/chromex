/**
 * content/refs.ts — element resolution + predicates for DOM snapshots
 * and actions (plan §6.4 split). Owns the snapshot-scoped ref→element
 * map and the editable-target discovery helpers shared by the fill
 * action and dictation.
 */

import type { BrowserDomActionStep } from "@codex-sidepanel/shared";

const domActionElementRefs = new Map<string, HTMLElement>();

export function registerDomActionElementRef(ref: string, element: HTMLElement): void {
  domActionElementRefs.set(ref, element);
}

export function clearDomActionElementRefs(): void {
  domActionElementRefs.clear();
}

export const EDITOR_LIKE_SELECTOR = [
  'input:not([type="hidden"])',
  "textarea",
  '[contenteditable="true"]',
  '[contenteditable="plaintext-only"]',
  '[role="textbox"]',
  '[aria-multiline="true"]',
  '[data-lexical-editor="true"]',
  '[data-slate-editor="true"]',
  ".ProseMirror",
  ".ql-editor",
].join(",");

export function waitForDomActionTick(): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, 0);
  });
}


export function collectInteractiveElements(): HTMLElement[] {
  const selectors = [
    "button",
    "a[href]",
    'input:not([type="hidden"])',
    "textarea",
    "select",
    "summary",
    '[role="button"]',
    '[role="link"]',
    '[role="menuitem"]',
    '[role="option"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="switch"]',
    '[role="tab"]',
    '[role="textbox"]',
    '[aria-haspopup]',
    '[aria-controls]',
    '[aria-expanded]',
    '[aria-multiline="true"]',
    '[contenteditable="true"]',
    '[contenteditable="plaintext-only"]',
    '[data-lexical-editor="true"]',
    '[data-slate-editor="true"]',
    "[data-placeholder]",
    ".ProseMirror",
    ".ql-editor",
    "[tabindex]",
  ];

  return Array.from(document.querySelectorAll<HTMLElement>(selectors.join(",")))
    .filter((element) => isDomActionElementVisible(element) && !isDomActionElementDisabled(element))
    .sort((left, right) => {
      const leftRect = left.getBoundingClientRect();
      const rightRect = right.getBoundingClientRect();
      return leftRect.top - rightRect.top || leftRect.left - rightRect.left;
    });
}


export type DomActionTargetResolution =
  | { status: "resolved"; element: HTMLElement }
  | { status: "ambiguous"; count: number }
  | { status: "none" };

/** Resolve a step's target AND detect ambiguity (chromex-ykj): a
 *  selector or label matching ≥2 elements must surface
 *  `browser.ambiguous_target` in the step result instead of silently
 *  acting on the first match. `targetRef` is snapshot-unique by
 *  construction. Selector matches count every HTMLElement the selector
 *  hits; label matches count visible interactive elements only. */
export function resolveDomActionTargetDetailed(step: BrowserDomActionStep): DomActionTargetResolution {
  if (step.targetRef) {
    const element = domActionElementRefs.get(step.targetRef);
    return element ? { status: "resolved", element } : { status: "none" };
  }
  if (step.selector) {
    const matches = Array.from(document.querySelectorAll(step.selector)).filter(
      (el): el is HTMLElement => el instanceof HTMLElement,
    );
    if (matches.length > 1) {
      return { status: "ambiguous", count: matches.length };
    }
    return matches.length === 1 ? { status: "resolved", element: matches[0]! } : { status: "none" };
  }
  if (step.label) {
    const normalizedLabel = normalizeDomActionText(step.label).toLowerCase();
    const matches = collectInteractiveElements().filter(
      (element) => getElementLabel(element).toLowerCase() === normalizedLabel,
    );
    if (matches.length > 1) {
      return { status: "ambiguous", count: matches.length };
    }
    return matches.length === 1 ? { status: "resolved", element: matches[0]! } : { status: "none" };
  }
  return { status: "none" };
}

export function resolveDomActionTarget(step: BrowserDomActionStep): HTMLElement | null {
  const resolved = resolveDomActionTargetDetailed(step);
  return resolved.status === "resolved" ? resolved.element : null;
}


export function resolveDirectEditableTarget(element: HTMLElement): HTMLElement | HTMLInputElement | HTMLTextAreaElement | null {
  if (isTextEntryCandidate(element)) {
    return element;
  }
  const descendant = Array.from(element.querySelectorAll<HTMLElement | HTMLInputElement | HTMLTextAreaElement>(EDITOR_LIKE_SELECTOR))
    .find((candidate) => isTextEntryCandidate(candidate) && isDomActionElementVisible(candidate));
  return descendant ?? null;
}


export async function resolveEditableTargetAfterActivation(element: HTMLElement): Promise<HTMLElement | HTMLInputElement | HTMLTextAreaElement | null> {
  const before = new Set(collectVisibleEditableTargets());
  element.focus();
  element.click();
  await waitForDomActionTick();

  const deadline = Date.now() + EDITOR_DISCOVERY_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    const target = findNewEditableTarget(element, before);
    if (target) {
      return target;
    }
    await sleepDomActionTick(80);
  }
  return null;
}


export function findNewEditableTarget(
  activatedElement: HTMLElement,
  before: Set<HTMLElement | HTMLInputElement | HTMLTextAreaElement>,
): HTMLElement | HTMLInputElement | HTMLTextAreaElement | null {
  const activeElement = document.activeElement;
  if (activeElement instanceof HTMLElement && isTextEntryCandidate(activeElement) && isDomActionElementVisible(activeElement)) {
    return activeElement;
  }

  const directTarget = resolveDirectEditableTarget(activatedElement);
  if (directTarget) {
    return directTarget;
  }

  const candidates = collectVisibleEditableTargets();
  const newCandidate = candidates.find((candidate) => !before.has(candidate));
  if (newCandidate) {
    return newCandidate;
  }
  return candidates.find((candidate) => isLikelyEditorNearActivatedElement(candidate, activatedElement)) ?? null;
}


export function collectVisibleEditableTargets(): Array<HTMLElement | HTMLInputElement | HTMLTextAreaElement> {
  return Array.from(document.querySelectorAll<HTMLElement | HTMLInputElement | HTMLTextAreaElement>(EDITOR_LIKE_SELECTOR))
    .filter((candidate) => isTextEntryCandidate(candidate) && isDomActionElementVisible(candidate));
}


export function setNativeTextControlValue(element: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
  if (descriptor?.set) {
    descriptor.set.call(element, value);
    return;
  }
  element.value = value;
}


export function getElementLabel(element: HTMLElement): string {
  const labelledBy = element.getAttribute("aria-labelledby");
  const labelledByText = labelledBy
    ? labelledBy
        .split(/\s+/u)
        .map((id) => document.getElementById(id)?.innerText || document.getElementById(id)?.textContent || "")
        .join(" ")
    : "";
  const inputLabels = element.id
    ? Array.from(document.querySelectorAll<HTMLLabelElement>(`label[for="${cssEscapeCompat(element.id)}"]`))
        .map((label) => label.innerText || label.textContent || "")
        .join(" ")
    : "";
  return normalizeDomActionText(
    element.getAttribute("aria-label") ||
      labelledByText ||
      inputLabels ||
      element.getAttribute("placeholder") ||
      element.getAttribute("title") ||
      (element instanceof HTMLInputElement ? element.value : "") ||
      element.innerText ||
      element.textContent ||
      "",
  ).slice(0, 160);
}


export function getElementPlaceholder(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return normalizeDomActionText(element.placeholder || "");
  }
  return normalizeDomActionText(
    element.getAttribute("placeholder") ||
      element.getAttribute("aria-placeholder") ||
      element.getAttribute("data-placeholder") ||
      "",
  );
}


export function getElementValue(element: HTMLElement): string {
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement) {
    return element.value.slice(0, 200);
  }
  return "";
}


export function isTextEntryCandidate(element: HTMLElement): boolean {
  if (element instanceof HTMLTextAreaElement) {
    return true;
  }
  if (element instanceof HTMLInputElement) {
    const type = (element.type || "text").toLowerCase();
    return !["button", "checkbox", "color", "file", "hidden", "image", "radio", "range", "reset", "submit"].includes(type);
  }
  return (
    element.isContentEditable ||
    element.getAttribute("contenteditable") === "plaintext-only" ||
    element.getAttribute("role") === "textbox" ||
    element.getAttribute("aria-multiline") === "true" ||
    element.getAttribute("data-lexical-editor") === "true" ||
    element.getAttribute("data-slate-editor") === "true" ||
    element.classList.contains("ProseMirror") ||
    element.classList.contains("ql-editor")
  );
}


export function opensEditableSurface(element: HTMLElement): boolean {
  if (isTextEntryCandidate(element)) {
    return false;
  }
  return (
    element instanceof HTMLButtonElement ||
    element.getAttribute("role") === "button" ||
    element.getAttribute("aria-haspopup") === "dialog" ||
    element.getAttribute("aria-haspopup") === "menu" ||
    Boolean(element.getAttribute("aria-controls")) ||
    Boolean(element.getAttribute("aria-expanded")) ||
    element.tabIndex >= 0
  );
}


export function isLikelyEditorNearActivatedElement(candidate: HTMLElement, activatedElement: HTMLElement): boolean {
  if (activatedElement.contains(candidate)) {
    return true;
  }
  const candidateRect = candidate.getBoundingClientRect();
  const activatedRect = activatedElement.getBoundingClientRect();
  const candidateCenterX = candidateRect.left + candidateRect.width / 2;
  const candidateCenterY = candidateRect.top + candidateRect.height / 2;
  const activatedCenterX = activatedRect.left + activatedRect.width / 2;
  const activatedCenterY = activatedRect.top + activatedRect.height / 2;
  return Math.hypot(candidateCenterX - activatedCenterX, candidateCenterY - activatedCenterY) < Math.max(window.innerHeight, 720);
}


export function inferDomActionRole(element: HTMLElement): string {
  if (element instanceof HTMLButtonElement) {
    return "button";
  }
  if (element instanceof HTMLAnchorElement) {
    return "link";
  }
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    return "textbox";
  }
  if (element instanceof HTMLSelectElement) {
    return "combobox";
  }
  return element.isContentEditable ? "textbox" : element.tagName.toLowerCase();
}


export function isDomActionElementDisabled(element: HTMLElement): boolean {
  return (
    element.getAttribute("aria-disabled") === "true" ||
    (element instanceof HTMLButtonElement && element.disabled) ||
    (element instanceof HTMLInputElement && element.disabled) ||
    (element instanceof HTMLTextAreaElement && element.disabled) ||
    (element instanceof HTMLSelectElement && element.disabled)
  );
}


export function isDomActionElementVisible(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 && rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
}


export function buildElementSelector(element: HTMLElement): string {
  if (element.id) {
    return `#${cssEscapeCompat(element.id)}`;
  }
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current instanceof HTMLElement && current !== document.body && parts.length < 5) {
    const tag = current.tagName.toLowerCase();
    const parent: HTMLElement | null = current.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const currentTagName = current.tagName;
    const siblings = (Array.from(parent.children) as Element[]).filter((child) => child.tagName === currentTagName);
    const index = siblings.indexOf(current) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    current = parent;
  }
  return parts.join(" > ");
}


export function cssEscapeCompat(value: string): string {
  if (typeof CSS !== "undefined" && typeof CSS.escape === "function") {
    return CSS.escape(value);
  }
  return value.replace(/["\\#.:,[\]>+~*]/gu, "\\$&");
}


export function normalizeDomActionText(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}


export const EDITOR_DISCOVERY_TIMEOUT_MS = 900;

export function sleepDomActionTick(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

export function safeRemoveElement(element: Element | null | undefined): void {
  if (!element) {
    return;
  }
  try {
    element.remove();
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") {
      return;
    }
    throw error;
  }
}
