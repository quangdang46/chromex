import type { RiskLevel } from "../browser/risk.js";
import type { ProtocolError } from "../protocol/errors.js";

/**
 * Permission/approval contracts — plan §4.8 + §5.7.
 *
 * Approval is bound to (action, target, data) via `actionDigest`:
 * hash(canonical(tool, args, target ref, snapshotId, url, origin, dataEgress)).
 * Any change to those inputs invalidates the approval.
 */

export type PermissionKind =
  | "browser_action"
  | "provider_permission"
  | "data_entry_sensitive"
  | "agent_egress";

export type PermissionOptionKind = "allow_once" | "allow_task" | "deny";

export interface PermissionRequest {
  requestId: string;
  taskId: string;
  turnId?: string;
  kind: PermissionKind;
  risk: RiskLevel;
  /** user-facing summary, redacted */
  summary: string;
  /** binds approval to exactly this action — see module doc */
  actionDigest: string;
  details: {
    tool: string;
    /** bounded + redacted preview */
    argsPreview: unknown;
    origin: string;
    targetLabel?: string;
  };
  options: Array<{ id: string; label: string; kind: PermissionOptionKind }>;
}

/** Recorded decision on a PermissionRequest. */
export interface PermissionDecision {
  optionId: string;
  kind: PermissionOptionKind;
  decidedAt: number;
  /** who decided — "user" in MVP */
  decidedBy?: string;
}

/** User response to a permission.requested event / permission.respond RPC. */
export interface PermissionResponse {
  requestId: string;
  optionId: string;
}

export type { RiskLevel, ProtocolError };
