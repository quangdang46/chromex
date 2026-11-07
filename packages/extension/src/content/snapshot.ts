/**
 * content/snapshot.ts — collectBrowserDomSnapshot + element
 * descriptors (plan §6.4 split). Fingerprints per §6.2 are computed
 * in fingerprint.ts; refs live in refs.ts.
 */

import type {
  BrowserDomElementSnapshot,
  BrowserDomSnapshot,
} from "@codex-sidepanel/shared";

import { computeSnapshotFingerprints, isSensitiveField } from "./fingerprint.js";
import { PAGE_MESSAGE } from "./transport.js";
import {
  buildElementSelector,
  clearDomActionElementRefs,
  collectInteractiveElements,
  getElementLabel,
  getElementPlaceholder,
  getElementValue,
  inferDomActionRole,
  isDomActionElementDisabled,
  isDomActionElementVisible,
  isTextEntryCandidate,
  normalizeDomActionText,
  opensEditableSurface,
  registerDomActionElementRef,
} from "./refs.js";

export async function collectBrowserDomSnapshot(): Promise<BrowserDomSnapshot> {
  clearDomActionElementRefs();
  const sources = collectInteractiveElements()
    .slice(0, 80)
    .map((element, index) => {
      const ref = `dom-${index + 1}`;
      registerDomActionElementRef(ref, element);
      return { ref, descriptor: describeDomActionElement(ref, element), element };
    });
  const elements = sources.map((s) => s.descriptor);

  // §6.2 fingerprints: salt comes from the background per snapshot —
  // content scripts cannot read TRUSTED_CONTEXTS storage directly.
  let fingerprints: Awaited<ReturnType<typeof computeSnapshotFingerprints>> | null = null;
  try {
    const ctx = (await chrome.runtime.sendMessage({ type: PAGE_MESSAGE.fingerprintContext })) as
      | { salt?: string; epoch?: number }
      | undefined;
    if (ctx?.salt && typeof ctx.epoch === "number") {
      fingerprints = await computeSnapshotFingerprints(sources, { salt: ctx.salt, epoch: ctx.epoch });
    }
  } catch {
    fingerprints = null; // fingerprint is best-effort; snapshot still usable
  }

  return {
    snapshotId: `snap:${crypto.randomUUID()}`,
    ...(fingerprints
      ? {
          structuralFingerprint: fingerprints.structuralFingerprint,
          stateFingerprint: fingerprints.stateFingerprint,
          saltEpoch: fingerprints.saltEpoch,
        }
      : {}),
    metadata: {
      url: window.location.href,
      title: document.title,
      domain: window.location.hostname,
    },
    elements,
    capabilities: {
      supportsDomAutomation: true,
      supportsVisualControlIndicator: true,
      preferredAutomationMode: "dom",
    },
  };
}


export function describeDomActionElement(ref: string, element: HTMLElement): BrowserDomElementSnapshot {
  const rect = element.getBoundingClientRect();
  const input = element instanceof HTMLInputElement ? element : null;
  const anchor = element instanceof HTMLAnchorElement ? element : null;
  const rawValue = getElementValue(element);
  const value = isSensitiveField(element) ? "" : rawValue;
  const placeholder = getElementPlaceholder(element);
  const ariaExpanded = element.getAttribute("aria-expanded") || "";
  const ariaHasPopup = element.getAttribute("aria-haspopup") || "";
  const ariaControls = element.getAttribute("aria-controls") || "";
  return {
    ref,
    role: element.getAttribute("role") || inferDomActionRole(element),
    tagName: element.tagName.toLowerCase(),
    label: getElementLabel(element),
    text: normalizeDomActionText(element.innerText || element.textContent || "").slice(0, 180),
    selector: buildElementSelector(element),
    ...(value ? { value } : {}),
    ...(anchor?.href ? { href: anchor.href } : {}),
    ...(input?.type ? { inputType: input.type } : {}),
    ...(placeholder ? { placeholder } : {}),
    ...(element.getAttribute("contenteditable") ? { contentEditable: element.getAttribute("contenteditable") ?? "" } : {}),
    ...(ariaExpanded ? { ariaExpanded } : {}),
    ...(ariaHasPopup ? { ariaHasPopup } : {}),
    ...(ariaControls ? { ariaControls } : {}),
    ...(element.tabIndex >= 0 ? { tabIndex: element.tabIndex } : {}),
    isTextEntryCandidate: isTextEntryCandidate(element),
    opensEditableSurface: opensEditableSurface(element),
    disabled: isDomActionElementDisabled(element),
    viewportRect: {
      left: Math.round(rect.left),
      top: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    },
  };
}

