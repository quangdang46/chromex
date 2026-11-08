import { describe, expect, it } from "vitest";
import {
  classifyProtocolError,
  protocolError,
  type ProtocolErrorCode,
} from "../src/protocol/errors.js";

/**
 * Registry completeness — plan §4.2 classification table + §4.11 check #1:
 * every code used in the spec must exist in the union, and the codes the
 * plan classifies explicitly must carry the right flags.
 */

const PLAN_CLASSIFIED: Array<
  [ProtocolErrorCode, { retryable: boolean; requiresUserAction: boolean; sideEffectState: string }]
> = [
  ["gateway.starting", { retryable: true, requiresUserAction: false, sideEffectState: "none" }],
  ["gateway.not_ready", { retryable: true, requiresUserAction: false, sideEffectState: "none" }],
  ["gateway.unresponsive", { retryable: true, requiresUserAction: true, sideEffectState: "none" }],
  ["proto.auth_expired", { retryable: true, requiresUserAction: false, sideEffectState: "none" }],
  ["browser.confirmation_required", { retryable: false, requiresUserAction: true, sideEffectState: "none" }],
  ["browser.ambiguous_target", { retryable: false, requiresUserAction: true, sideEffectState: "none" }],
  ["browser.stale_binding", { retryable: true, requiresUserAction: false, sideEffectState: "none" }],
  ["browser.stale_snapshot", { retryable: true, requiresUserAction: false, sideEffectState: "none" }],
  // §4.8 dispatch binding — pre-dispatch drift check; re-snapshot + retry.
  ["browser.target_changed", { retryable: true, requiresUserAction: false, sideEffectState: "none" }],
  // ⚠️ rows → retryable:true (conditional; caller decides via sideEffectState)
  ["browser.timeout", { retryable: true, requiresUserAction: false, sideEffectState: "unknown" }],
  ["browser.no_host", { retryable: true, requiresUserAction: false, sideEffectState: "none" }],
  ["browser.host_lost_after_dispatch", { retryable: false, requiresUserAction: true, sideEffectState: "unknown" }],
  ["browser.result_lost", { retryable: true, requiresUserAction: true, sideEffectState: "known" }],
  ["browser.denied", { retryable: false, requiresUserAction: true, sideEffectState: "none" }],
  ["provider.turn_failed", { retryable: true, requiresUserAction: false, sideEffectState: "unknown" }],
  ["artifact.missing", { retryable: false, requiresUserAction: false, sideEffectState: "none" }],
];

describe("ProtocolErrorCode registry", () => {
  it.each(PLAN_CLASSIFIED)("%s classification matches plan §4.2", (code, expected) => {
    expect(classifyProtocolError(code)).toEqual(expected);
  });

  it("covers every code the plan requires", () => {
    // spot-check codes that MUST exist (union members — compile-time) + runtime sanity
    const required: ProtocolErrorCode[] = [
      "proto.invalid",
      "proto.version_mismatch",
      "proto.payload_too_large",
      "gateway.starting",
      "gateway.unresponsive",
      "gateway.not_ready",
      "gateway.shutting_down",
      "task.not_found",
      "task.queue_full",
      "task.backend_locked",
      "conversation.not_resumable",
      "turn.interrupt_timeout",
      "provider.not_resumable",
      "browser.wrong_profile",
      "browser.gesture_required",
      "browser.host_lost_after_dispatch",
      "browser.result_lost",
      "approval.already_decided",
      "artifact.too_large",
      "internal",
    ];
    for (const code of required) {
      const c = classifyProtocolError(code);
      expect(c.sideEffectState).toMatch(/none|known|unknown/);
    }
  });

  it("protocolError() fills classification from registry", () => {
    const e = protocolError("browser.no_host", "no host", { tabId: 1 });
    expect(e.retryable).toBe(true);
    expect(e.sideEffectState).toBe("none");
    expect(e.details).toEqual({ tabId: 1 });
  });
});
