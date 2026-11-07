/**
 * content/fingerprint.ts — §6.2 fingerprint computation for DOM
 * snapshots. Runs in the content script (has DOM access); the salt is
 * delivered per-request by the background (`page.fingerprint.context`)
 * because chrome.storage.local is TRUSTED_CONTEXTS.
 *
 * Privacy contract: field values are read here, HMAC'd, and NEVER
 * leave this module in plaintext. Password/payment fields get
 * valueHash "[redacted]" and are excluded from StateInputs entirely.
 */

import {
  boundsBucket,
  fieldIdentity,
  fieldValueHash,
  scrollBucket,
  stateFingerprint,
  structuralFingerprint,
  urlOriginPath,
  type StateInputs,
  type StructuralInputs,
} from "@codex-sidepanel/shared";
import type { BrowserDomElementSnapshot } from "@codex-sidepanel/shared";

export interface SnapshotFingerprintContext {
  salt: string;
  epoch: number;
}

export interface FingerprintComputation {
  structuralFingerprint: string;
  stateFingerprint: string;
  saltEpoch: number;
}

interface ElementFingerprintSource {
  ref: string;
  descriptor: BrowserDomElementSnapshot;
  element: HTMLElement;
}

/** tag + index-among-element-siblings path, e.g. "html>body>form[0]>input[2]". */
function structuralPathOf(element: HTMLElement): string {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node && node !== document.documentElement.parentElement) {
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const tag = node.tagName.toLowerCase();
    const siblings = Array.from(parent.children).filter((c) => c.tagName === node!.tagName);
    const index = siblings.indexOf(node);
    parts.unshift(`${tag}[${Math.max(index, 0)}]`);
    node = parent;
    if (node === document.documentElement) {
      parts.unshift("html[0]");
      break;
    }
  }
  return parts.join(">");
}

function formIndexOf(element: HTMLElement): number {
  const form = element.closest("form");
  if (!form) return -1;
  return Array.from(document.forms).indexOf(form);
}

/** password / payment fields — never hashed, never contribute (§6.2). */
export function isSensitiveField(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement) {
    const type = (element.type || "").toLowerCase();
    if (type === "password") return true;
    const ac = (element.autocomplete || "").toLowerCase();
    if (ac.startsWith("cc-") || ac.includes("password")) return true;
    const hay = `${element.name} ${element.id} ${element.getAttribute("aria-label") ?? ""}`.toLowerCase();
    if (/\b(card|ccnum|cc-number|cvv|cvc|creditcard|cardnumber)\b/.test(hay)) return true;
  }
  return false;
}

function isCheckable(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement) {
    const t = (element.type || "").toLowerCase();
    return t === "checkbox" || t === "radio";
  }
  const role = element.getAttribute("role") ?? "";
  return role === "checkbox" || role === "radio" || role === "switch";
}

function isChecked(element: HTMLElement): boolean {
  if (element instanceof HTMLInputElement) return element.checked;
  const aria = element.getAttribute("aria-checked");
  return aria === "true";
}

function fieldValueOf(element: HTMLElement): string {
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    return element.value.slice(0, 200);
  }
  return "";
}

/**
 * Compute both fingerprints for one snapshot. `sources` pairs each
 * serialized descriptor with its live element (for values/checked/
 * structural path that the descriptor deliberately omits).
 */
export async function computeSnapshotFingerprints(
  sources: ElementFingerprintSource[],
  ctx: SnapshotFingerprintContext,
): Promise<FingerprintComputation> {
  const interactive = sources.filter((s) => s.descriptor.isTextEntryCandidate || fieldValueOf(s.element) !== "" || isCheckable(s.element));
  const structural: StructuralInputs = {
    version: 1,
    elementCount: sources.length,
    interactiveCount: interactive.length,
    elements: sources.map((s) => ({
      role: s.descriptor.role || "generic",
      ...(s.descriptor.label ? { name: s.descriptor.label.slice(0, 120) } : {}),
      tag: s.descriptor.tagName,
      ...(s.descriptor.inputType ? { type: s.descriptor.inputType } : {}),
      boundsBucket: boundsBucket(s.descriptor.viewportRect),
    })),
  };
  const sfp = await structuralFingerprint(structural);

  const tabOrigin = window.location.origin;
  const fieldEntries: StateInputs["fieldValueHashes"] = [];
  const sensitiveEntries: Array<{ ref: string; valueHash: string; sensitive: boolean }> = [];
  const checked: StateInputs["checkedRoles"] = [];

  for (const s of sources) {
    const { element, ref, descriptor } = s;
    if (isCheckable(element)) {
      checked.push({ ref, checked: isChecked(element) });
    }
    const hasValue = fieldValueOf(element) !== "" || descriptor.isTextEntryCandidate === true;
    if (!hasValue) continue;
    if (isSensitiveField(element)) {
      // "[redacted]" marker kept for observability; excluded from the hash below
      sensitiveEntries.push({ ref, valueHash: "[redacted]", sensitive: true });
      continue;
    }
    const value = fieldValueOf(element);
    const [identity, vhash] = await Promise.all([
      fieldIdentity({
        structuralPath: structuralPathOf(element),
        role: descriptor.role || "generic",
        ...(descriptor.label ? { name: descriptor.label.slice(0, 120) } : {}),
        ...(descriptor.inputType ? { type: descriptor.inputType } : {}),
        formIndex: formIndexOf(element),
      }),
      fieldValueHash(ctx.salt, tabOrigin, ref, value),
    ]);
    fieldEntries.push({ fieldIdentity: identity, valueHash: vhash });
  }

  const state: StateInputs = {
    version: 1,
    structural: sfp,
    urlOriginPath: urlOriginPath(window.location.href),
    readyState: document.readyState,
    scrollBucket: scrollBucket(window.scrollX, window.scrollY),
    fieldValueHashes: fieldEntries,
    ...(checked.length ? { checkedRoles: checked } : {}),
  };
  const tfp = await stateFingerprint(state);
  void sensitiveEntries; // redaction markers are diagnostic-only, not hashed
  return { structuralFingerprint: sfp, stateFingerprint: tfp, saltEpoch: ctx.epoch };
}
