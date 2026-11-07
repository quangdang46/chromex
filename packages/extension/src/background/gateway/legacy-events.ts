/**
 * Gateway → legacy bridge.event translation — P1-10 interim path.
 *
 * The sidepanel still consumes the legacy event vocabulary
 * (message.delta/message.completed/turn.*). Until the UI migrates to
 * task.* envelopes natively, durable task events and ephemeral deltas
 * are translated here so existing rendering keeps working in
 * gatewayMode. Unmapped events return null (dropped, never faked).
 *
 * threadId === taskId (compat layer maps session.open→task.create and
 * returns taskId as threadId); turnId === gatewayTurnId.
 */

import type { Envelope } from "@codex-sidepanel/shared";

interface EnvPayload {
  type?: string;
  turnId?: string;
  text?: string;
  deltaOffset?: number;
  stopReason?: string;
  error?: { code?: string; message?: string };
  request?: { requestId?: string; kind?: string; summary?: string; risk?: string };
  decision?: { kind?: string };
  [k: string]: unknown;
}

function envOf(env: Envelope): { taskId: string; payload: EnvPayload } | null {
  if (env.kind !== "event") return null;
  const e = env as {
    taskId?: string;
    payload?: EnvPayload;
    type?: string;
    turnId?: string;
    text?: string;
    deltaOffset?: number;
  };
  const taskId = typeof e.taskId === "string" ? e.taskId : "";
  const payload = (e.payload ?? {}) as EnvPayload;
  // durable: type/payload.type mirror; ephemeral: fields are top-level
  if (!payload.type && typeof e.type === "string") payload.type = e.type;
  if (typeof e.turnId === "string" && !payload.turnId) payload.turnId = e.turnId;
  if (typeof e.text === "string" && payload.text === undefined) payload.text = e.text;
  if (typeof e.deltaOffset === "number" && payload.deltaOffset === undefined)
    payload.deltaOffset = e.deltaOffset;
  return taskId ? { taskId, payload } : null;
}

/** Translate one gateway envelope to a legacy bridge.event, or null. */
export function gatewayEventToLegacy(env: Envelope): Record<string, unknown> | null {
  const parsed = envOf(env);
  if (!parsed) return null;
  const { taskId, payload } = parsed;
  const turnId = typeof payload.turnId === "string" ? payload.turnId : "";
  const base = { threadId: taskId, ...(turnId ? { turnId } : {}) };

  // ephemeral deltas — reliability:"ephemeral", no seq
  if ((env as { reliability?: string }).reliability === "ephemeral") {
    if (payload.type === "assistant.delta") {
      return {
        type: "message.delta",
        ...base,
        itemId: `gw-${turnId}`,
        delta: typeof payload.text === "string" ? payload.text : "",
      };
    }
    if (payload.type === "reasoning.delta") {
      return {
        type: "reasoning.delta",
        ...base,
        delta: typeof payload.text === "string" ? payload.text : "",
      };
    }
    return null;
  }

  switch (payload.type) {
    case "assistant.message":
      return {
        type: "message.completed",
        ...base,
        itemId: `gw-${turnId}`,
        text: typeof payload.text === "string" ? payload.text : "",
      };
    case "turn.started":
      return { type: "turn.started", ...base, activeTurn: { turnId, threadId: taskId } };
    case "turn.completed":
      return { type: "turn.completed", ...base, stopReason: payload.stopReason };
    case "turn.failed":
      return {
        type: "turn.failed",
        ...base,
        error: payload.error?.message ?? payload.error?.code ?? "turn failed",
      };
    case "turn.cancelled":
      return { type: "turn.completed", ...base, stopReason: "cancelled" };
    case "turn.unknown":
      return { type: "turn.failed", ...base, error: "turn outcome unknown after restart" };
    case "permission.requested": {
      const req = payload.request as
        | { requestId?: string; kind?: string; details?: { argsPreview?: { questions?: unknown[] } } }
        | undefined;
      const questions = req?.details?.argsPreview?.questions;
      if (req?.kind === "provider_permission" && Array.isArray(questions) && questions.length > 0) {
        // legacy UI renders provider questions via plan.user_input.*
        return {
          type: "plan.user_input.requested",
          ...base,
          requestId: req.requestId ?? "",
          itemId: `perm-${req.requestId ?? ""}`,
          questions,
        };
      }
      return {
        type: "permission.requested",
        ...base,
        requestId: req?.requestId ?? "",
        request: req,
      };
    }
    case "permission.resolved":
      return {
        type: "plan.user_input.resolved",
        requestId: (payload as { requestId?: string }).requestId ?? "",
      };
    case "tool.started":
      return { type: "tool.started", ...base, toolCallId: payload.toolCallId, tool: payload.tool };
    case "tool.completed":
      return {
        type: "tool.completed",
        ...base,
        toolCallId: payload.toolCallId,
        tool: payload.tool,
        outcome: payload.outcome,
      };
    default:
      return null;
  }
}
