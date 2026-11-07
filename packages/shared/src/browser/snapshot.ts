/**
 * DOM snapshot types — plan §6.2/§4.5.
 * Two fingerprints: structural (ref validity) vs state (verify).
 * See browser/risk + P2-01 bead for implementation contract.
 */

export interface BrowserElement {
  /** stable ref within this snapshot, e.g. "e12" */
  ref: string;
  role?: string;
  name?: string;
  tag: string;
  type?: string;
  /** [x, y, width, height] bucketed */
  bounds?: [number, number, number, number];
  /** iframe path for nested frames (model only — iframe capability is "none" in MVP) */
  framePath?: string[];
}

export interface SnapshotFingerprints {
  /** "sfp1:" + sha256(canonical(StructuralInputs)) — changes on DOM structure */
  structuralFingerprint: string;
  /** "tfp1:" + sha256(canonical(StateInputs)) — changes on values/scroll/url */
  stateFingerprint: string;
  /** salt epoch the stateFingerprint was computed under */
  saltEpoch: number;
}

export interface BrowserSnapshot extends SnapshotFingerprints {
  /** "snap:" + ulid */
  snapshotId: string;
  tabId: number | string;
  url: string;
  origin: string;
  title?: string;
  elements: BrowserElement[];
  interactiveCount?: number;
  elementCount?: number;
  readyState?: string;
  capturedAt: number;
  /** true when snapshot hit caps (maxElements/maxTextChars) */
  truncated?: boolean;
}

export interface SnapshotRequest {
  tabId?: number | string;
  /** max elements — config default 80 */
  maxElements?: number;
  /** max extracted text chars — config default 12000 */
  maxTextChars?: number;
  /** include interactive-only subset */
  interactiveOnly?: boolean;
}
