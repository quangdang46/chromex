import type { DurableTaskEvent } from "../tasks/events.js";
import type { DurableGatewayEvent, GatewayNotice } from "../tasks/events.js";
import type { ProtocolError } from "./errors.js";

/**
 * Wire envelope — plan §4.1.
 *
 * Two channels, strictly separated:
 * - DURABLE: carries `seq`, written to the event log, replayable.
 * - EPHEMERAL: no seq, lossy, never persisted (assistant.delta,
 *   reasoning.delta, gateway.notice).
 *
 * Durable envelopes are DISTRIBUTIVE MAPPED UNIONS over the event unions,
 * so `type` and `payload.type` can never diverge at compile time.
 */

/** Durable task-stream envelope — one variant per DurableTaskEvent type. */
export type DurableTaskEventEnvelope = {
  [E in DurableTaskEvent as E["type"]]: {
    v: 1;
    kind: "event";
    reliability: "durable";
    stream: "task";
    taskId: string;
    seq: number;
    ts: number;
    type: E["type"];
    payload: E;
  };
}[DurableTaskEvent["type"]];

/** Durable gateway-stream envelope — one variant per DurableGatewayEvent type. */
export type DurableGatewayEventEnvelope = {
  [E in DurableGatewayEvent as E["type"]]: {
    v: 1;
    kind: "event";
    reliability: "durable";
    stream: "gateway";
    seq: number;
    ts: number;
    type: E["type"];
    payload: E;
  };
}[DurableGatewayEvent["type"]];

/** Ephemeral assistant/reasoning delta — no seq, never persisted. */
export interface EphemeralDeltaEnvelope {
  v: 1;
  kind: "event";
  reliability: "ephemeral";
  taskId: string;
  turnId: string;
  type: "assistant.delta" | "reasoning.delta";
  /** total chars of this turn BEFORE this chunk — gap detection */
  deltaOffset: number;
  text: string;
  ts: number;
}

/** Ephemeral gateway notice — no seq, no persist, no replay. */
export interface EphemeralGatewayNoticeEnvelope {
  v: 1;
  kind: "event";
  reliability: "ephemeral";
  stream: "gateway";
  type: "gateway.notice";
  payload: GatewayNotice;
  ts: number;
}

export type Envelope =
  | { v: 1; kind: "request"; id: string; method: string; taskId?: string; payload?: unknown }
  // XOR: exactly one of result|error — enforced by Zod at runtime (§4.1)
  | { v: 1; kind: "response"; id: string; result: unknown }
  | { v: 1; kind: "response"; id: string; error: ProtocolError }
  | DurableTaskEventEnvelope
  | DurableGatewayEventEnvelope
  | EphemeralDeltaEnvelope
  | EphemeralGatewayNoticeEnvelope
  // ack = client rendered up to seq — NOT a persistence signal
  | { v: 1; kind: "ack"; stream: "task"; taskId: string; seq: number; renderedAt?: number }
  | { v: 1; kind: "ack"; stream: "gateway"; seq: number; renderedAt?: number };

// ---- size limits (plan §4.1) — hard caps, not configurable beyond ----

/** Chrome Native Messaging transport limit: native host → extension. */
export const NM_TRANSPORT_LIMIT_BYTES = 1024 * 1024;
/** Internal hard cap = default; operator cannot raise toward transport. */
export const MAX_ENVELOPE_BYTES_HARD = 768 * 1024; // 786432
export const MAX_ENVELOPE_BYTES_DEFAULT = 768 * 1024;
export const MAX_EVENT_PAYLOAD_BYTES = 256 * 1024; // 262144
export const MAX_SNAPSHOT_CHUNK_BYTES = 256 * 1024;
