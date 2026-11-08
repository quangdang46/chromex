/**
 * Protocol error registry — plan §4.2.
 *
 * Every code used anywhere in the spec MUST exist here. No section may
 * invent new codes. The classification table below is the single source
 * for retryable / requiresUserAction / sideEffectState.
 */

export type ProtocolErrorCode =
  // protocol / transport
  | "proto.invalid"
  | "proto.unsupported"
  | "proto.auth_failed"
  | "proto.auth_expired"
  | "proto.version_mismatch"
  | "proto.unknown_method"
  | "proto.payload_too_large"
  | "proto.forbidden"
  // gateway lifecycle
  | "gateway.starting"
  | "gateway.unresponsive"
  | "gateway.not_ready"
  | "gateway.shutting_down"
  // task / conversation / turn
  | "task.not_found"
  | "task.busy"
  | "task.invalid_state"
  | "task.cancelled"
  | "task.paused"
  | "task.queue_full"
  | "task.backend_locked"
  | "conversation.not_resumable"
  | "turn.not_found"
  | "turn.not_active"
  | "turn.already_running"
  | "turn.interrupt_timeout"
  // provider
  | "provider.unavailable"
  | "provider.auth_required"
  | "provider.spawn_failed"
  | "provider.model_invalid"
  | "provider.turn_failed"
  | "provider.turn_timeout"
  | "provider.steer_unavailable"
  | "provider.interrupt_failed"
  | "provider.not_resumable"
  // browser
  | "browser.no_host"
  | "browser.backend_unavailable"
  | "browser.backend_mismatch"
  | "browser.wrong_profile"
  | "browser.confirmation_required"
  | "browser.tab_not_found"
  | "browser.tab_closed"
  | "browser.not_in_scope"
  | "browser.stale_snapshot"
  | "browser.stale_binding"
  | "browser.element_not_found"
  | "browser.element_not_visible"
  | "browser.navigated"
  | "browser.timeout"
  | "browser.action_failed"
  | "browser.denied"
  | "browser.ambiguous_target"
  | "browser.host_lost_after_dispatch"
  | "browser.result_lost"
  | "browser.unsupported_command"
  | "browser.verification_failed"
  | "browser.gesture_required"
  // approval / artifacts
  | "approval.not_found"
  | "approval.expired"
  | "approval.already_decided"
  | "artifact.missing"
  | "artifact.too_large"
  | "internal";

export type SideEffectState = "none" | "known" | "unknown";

export interface ProtocolError {
  code: ProtocolErrorCode;
  /** user-facing, already redacted */
  message: string;
  retryable: boolean;
  requiresUserAction: boolean;
  /** critical for browser actions already dispatched */
  sideEffectState: SideEffectState;
  /** bounded + redacted */
  details?: Record<string, unknown>;
}

export interface ProtocolErrorClassification {
  retryable: boolean;
  requiresUserAction: boolean;
  sideEffectState: SideEffectState;
}

/**
 * Classification table from plan §4.2.
 *
 * "⚠️" rows in the plan mean "conditionally retryable" — encoded as
 * retryable:true; the CALLER decides based on context (e.g. whether a
 * mutating side effect may have happened, see sideEffectState).
 *
 * Codes not listed in the plan table use conservative defaults:
 * not retryable, no user action required, sideEffectState "none".
 * `browser.*` dispatch-related codes are the exception — see below.
 */
const CLASSIFICATION: Partial<Record<ProtocolErrorCode, ProtocolErrorClassification>> = {
  "gateway.starting": { retryable: true, requiresUserAction: false, sideEffectState: "none" },
  "gateway.not_ready": { retryable: true, requiresUserAction: false, sideEffectState: "none" },
  "gateway.unresponsive": { retryable: true, requiresUserAction: true, sideEffectState: "none" },
  "proto.auth_expired": { retryable: true, requiresUserAction: false, sideEffectState: "none" },
  "proto.forbidden": { retryable: false, requiresUserAction: false, sideEffectState: "none" },
  "browser.confirmation_required": { retryable: false, requiresUserAction: true, sideEffectState: "none" },
  "browser.ambiguous_target": { retryable: false, requiresUserAction: true, sideEffectState: "none" },
  "browser.stale_binding": { retryable: true, requiresUserAction: false, sideEffectState: "none" },
  "browser.stale_snapshot": { retryable: true, requiresUserAction: false, sideEffectState: "none" },
  // Detected before dispatch (re-resolve target / re-snapshot) — safe to retry.
  "browser.element_not_found": { retryable: true, requiresUserAction: false, sideEffectState: "none" },
  // Pointer-hit gate fires before dispatch — page may just be mid-render;
  // wait/re-snapshot then retry is safe.
  "browser.element_not_visible": { retryable: true, requiresUserAction: false, sideEffectState: "none" },
  "browser.navigated": { retryable: true, requiresUserAction: false, sideEffectState: "none" },
  "browser.timeout": { retryable: true, requiresUserAction: false, sideEffectState: "unknown" },
  // Page-side action failed mid-execution — partial side effects
  // possible, so not retryable by default.
  "browser.action_failed": { retryable: false, requiresUserAction: false, sideEffectState: "unknown" },
  // BEFORE dispatch: nothing was sent — safe to retry.
  "browser.no_host": { retryable: true, requiresUserAction: false, sideEffectState: "none" },
  // AFTER dispatch, no result: do NOT retry mutating actions.
  "browser.host_lost_after_dispatch": { retryable: false, requiresUserAction: true, sideEffectState: "unknown" },
  // Host returned a result but connection dropped before Gateway persisted:
  // outcome known per result but must be reconciled.
  "browser.result_lost": { retryable: true, requiresUserAction: true, sideEffectState: "known" },
  "browser.denied": { retryable: false, requiresUserAction: true, sideEffectState: "none" },
  "provider.turn_failed": { retryable: true, requiresUserAction: false, sideEffectState: "unknown" },
  "artifact.missing": { retryable: false, requiresUserAction: false, sideEffectState: "none" },
};

const DEFAULT_CLASSIFICATION: ProtocolErrorClassification = {
  retryable: false,
  requiresUserAction: false,
  sideEffectState: "none",
};

export function classifyProtocolError(code: ProtocolErrorCode): ProtocolErrorClassification {
  return CLASSIFICATION[code] ?? DEFAULT_CLASSIFICATION;
}

/** Build a ProtocolError with registry-driven classification fields. */
export function protocolError(
  code: ProtocolErrorCode,
  message: string,
  details?: Record<string, unknown>,
): ProtocolError {
  const c = classifyProtocolError(code);
  return {
    code,
    message,
    retryable: c.retryable,
    requiresUserAction: c.requiresUserAction,
    sideEffectState: c.sideEffectState,
    ...(details ? { details } : {}),
  };
}
