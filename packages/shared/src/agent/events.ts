import type { ProviderId } from "./provider-id.js";
import type { AgentPersistenceHandle } from "./persistence.js";
import type { TurnInput } from "./turn-input.js";
import type { PermissionRequest, PermissionDecision } from "./permission.js";
import type { Usage } from "./usage.js";
import type { ProtocolError } from "../protocol/errors.js";

export type ToolOutcome = "succeeded" | "failed" | "cancelled" | "unknown";
export type VerificationResult = boolean | "unknown";

/**
 * Normalized agent events — plan §4.4. This union is CLOSED: every event
 * type used in the spec must exist here.
 *
 * EPHEMERAL events (assistant.delta, reasoning.delta) carry no durable
 * seq and are never persisted. Everything else is durable.
 */
export type AgentEvent =
  // conversation
  | { type: "conversation.opened"; sessionKey: string; provider: ProviderId; persistence: AgentPersistenceHandle | null }
  | { type: "conversation.closed"; sessionKey: string; reason?: string }
  // user/turn lifecycle
  | { type: "user.message.created"; turnId: string; message: TurnInput; clientMessageId: string }
  | { type: "turn.started"; turnId: string; clientMessageId?: string }
  // EPHEMERAL — no seq, lossy, never persisted
  | { type: "assistant.delta"; turnId: string; text: string; deltaOffset?: number }
  | { type: "reasoning.delta"; turnId: string; text: string; deltaOffset?: number }
  // DURABLE final assistant message; oversized text → assistantMessageRef artifact
  | { type: "assistant.message"; turnId: string; text: string; assistantMessageRef?: string }
  // DURABLE summary only — never raw reasoning (storeReasoning=false default)
  | { type: "reasoning.summary"; turnId: string; summary: string }
  | {
      type: "tool.started";
      turnId: string;
      toolCallId: string;
      tool: string;
      /** BOUNDED + redacted; > MAX_EVENT_PAYLOAD_BYTES ⇒ inputArtifactRef instead */
      input?: unknown;
      inputArtifactRef?: string;
      source: "provider" | "browser";
    }
  | {
      type: "tool.completed";
      turnId: string;
      toolCallId: string;
      tool: string;
      outcome: ToolOutcome;
      /** same attribution as tool.started; absent ⇒ treat as provider */
      source?: "provider" | "browser";
      /** BOUNDED + redacted; large ⇒ outputArtifactRef */
      output?: unknown;
      outputArtifactRef?: string;
      verified?: VerificationResult;
    }
  // DURABLE amendment: a call recorded `unknown` (host/result lost) was
  // later reconciled against the host's outcome buffer — carries the
  // TRUE outcome so the snapshot/audit trail supersedes the guess.
  // Never emitted speculatively; only after host confirmation.
  | {
      type: "tool.reconciled";
      turnId: string;
      toolCallId: string;
      tool: string;
      /** always "browser" — only host-confirmed browser calls reconcile */
      source?: "provider" | "browser";
      outcome: Exclude<ToolOutcome, "unknown">;
      output?: unknown;
      verified?: VerificationResult;
    }
  | { type: "permission.requested"; turnId?: string; request: PermissionRequest }
  | { type: "permission.resolved"; requestId: string; decision: PermissionDecision }
  | { type: "permission.expired"; requestId: string; reason: "task_terminal" | "restart" | "provider_unavailable" | "timeout" }
  | { type: "usage"; turnId?: string; usage: Usage }
  | { type: "turn.completed"; turnId: string; stopReason?: string }
  | { type: "turn.failed"; turnId: string; error: ProtocolError }
  | { type: "turn.cancelled"; turnId: string; reason?: string }
  // DURABLE provider turn diff (codex turn/diff/updated) — the sidepanel
  // diff UI + deliverable extraction read this after restart/replay.
  | { type: "turn.diff.updated"; turnId: string; diff: string }
  // crash/reconnect with undetermined outcome — never pretend failed/succeeded
  | { type: "turn.unknown"; turnId: string; reason: string }
  // DURABLE (auditable) provider notice
  | { type: "provider.notice"; level: "info" | "warn"; message: string }
  // Thread-scoped Codex goal state (thread/goal/* notifications). Not
  // turn-bound: goal.set can precede the turn that consumes it, and the
  // goal survives across turns until cleared or completed.
  | { type: "goal.updated"; goal: AgentGoalState }
  | { type: "goal.cleared" };

export interface AgentGoalState {
  objective: string;
  status: string;
  /** provider-side thread id — goal.* feature RPCs are thread-scoped
   *  and need THIS, not the gateway taskId the events are attributed to */
  providerThreadId?: string;
  tokenBudget?: number | null;
  tokensUsed?: number | null;
  timeUsedSeconds?: number | null;
  budgetLimited?: boolean | null;
}

/** Classifies which AgentEvent types are ephemeral (no durable seq). */
export const EPHEMERAL_EVENT_TYPES = ["assistant.delta", "reasoning.delta"] as const;
export type EphemeralEventType = (typeof EPHEMERAL_EVENT_TYPES)[number];

/** AgentEvent minus ephemeral — the durable part of the task stream. */
export type DurableAgentEvent = Exclude<AgentEvent, { type: EphemeralEventType }>;
