/**
 * content/verify.ts — post-action observation evidence (plan §6.3/§6.4).
 *
 * P2-01 split scaffold: defines the evidence shape the verify pass
 * consumes. Semantic `verified` decisions live in P2-02; this module
 * only collects raw observations from the live DOM.
 */

export interface DomActionEvidence {
  /** page URL changed since the action */
  urlChanged?: boolean;
  /** state fingerprint changed (same saltEpoch only — caller checks) */
  fingerprintChanged?: boolean;
  /** targeted field now reflects the submitted value */
  valueReflected?: boolean;
  /** scroll position delta in px */
  scrollDelta?: { x: number; y: number };
}

export interface DomActionObservation {
  before: {
    url: string;
    scrollX: number;
    scrollY: number;
  };
  after: {
    url: string;
    scrollX: number;
    scrollY: number;
  };
}

/** Cheap synchronous observation — fingerprint comparison needs the
 *  async hashing pass and is layered on by the caller (P2-02). */
export function observeDomAction(before: DomActionObservation["before"]): DomActionEvidence {
  const after = {
    url: window.location.href,
    scrollX: window.scrollX,
    scrollY: window.scrollY,
  };
  const evidence: DomActionEvidence = {};
  if (after.url !== before.url) evidence.urlChanged = true;
  const dx = after.scrollX - before.scrollX;
  const dy = after.scrollY - before.scrollY;
  if (dx !== 0 || dy !== 0) evidence.scrollDelta = { x: dx, y: dy };
  return evidence;
}
