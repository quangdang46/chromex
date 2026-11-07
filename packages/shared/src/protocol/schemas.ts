import { z } from "zod";
import type { Envelope } from "./envelope.js";

/**
 * Runtime validation for wire payloads — plan §4.1/§4.6.
 * Violation ⇒ `proto.invalid`.
 *
 * Scope note: durable event PAYLOADS are validated structurally here
 * (envelope shape, seq/stream rules). Per-event-field deep validation
 * lands with the Gateway event log (P1-02) where payloads are persisted.
 */

export const protocolErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  requiresUserAction: z.boolean(),
  sideEffectState: z.enum(["none", "known", "unknown"]),
  details: z.record(z.unknown()).optional(),
});

/** Response envelope: EXACTLY ONE of result|error (XOR). */
export const responseEnvelopeSchema = z
  .object({
    v: z.literal(1),
    kind: z.literal("response"),
    id: z.string(),
    result: z.unknown().optional(),
    error: protocolErrorSchema.optional(),
  })
  .refine((r) => (r.result === undefined) !== (r.error === undefined), {
    message: "response must contain exactly one of result|error",
  }) as z.ZodType<Extract<Envelope, { kind: "response" }>>;

export const requestEnvelopeSchema = z.object({
  v: z.literal(1),
  kind: z.literal("request"),
  id: z.string(),
  method: z.string(),
  taskId: z.string().optional(),
  payload: z.unknown().optional(),
});

const ackSchema = z.discriminatedUnion("stream", [
  z.object({
    v: z.literal(1),
    kind: z.literal("ack"),
    stream: z.literal("task"),
    taskId: z.string(),
    seq: z.number().int().nonnegative(),
    renderedAt: z.number().optional(),
  }),
  z.object({
    v: z.literal(1),
    kind: z.literal("ack"),
    stream: z.literal("gateway"),
    seq: z.number().int().nonnegative(),
    renderedAt: z.number().optional(),
  }),
]);

const ephemeralDeltaSchema = z.object({
  v: z.literal(1),
  kind: z.literal("event"),
  reliability: z.literal("ephemeral"),
  taskId: z.string(),
  turnId: z.string(),
  type: z.enum(["assistant.delta", "reasoning.delta"]),
  deltaOffset: z.number().int().nonnegative(),
  text: z.string(),
  ts: z.number(),
});

const ephemeralGatewayNoticeSchema = z.object({
  v: z.literal(1),
  kind: z.literal("event"),
  reliability: z.literal("ephemeral"),
  stream: z.literal("gateway"),
  type: z.literal("gateway.notice"),
  payload: z.object({
    type: z.literal("gateway.notice"),
    level: z.enum(["info", "warn"]),
    message: z.string(),
    backpressure: z.literal("deltas_dropped").optional(),
  }),
  ts: z.number(),
});

const ephemeralDiagnosticsSchema = z.object({
  v: z.literal(1),
  kind: z.literal("event"),
  reliability: z.literal("ephemeral"),
  stream: z.literal("gateway"),
  type: z.literal("gateway.diagnostics"),
  diagnostics: z.unknown(),
  ts: z.number(),
});

const durableEventBase = {
  v: z.literal(1),
  kind: z.literal("event"),
  reliability: z.literal("durable"),
  seq: z.number().int().positive(),
  ts: z.number(),
};

const durableTaskEventSchema = z
  .object({
    ...durableEventBase,
    stream: z.literal("task"),
    taskId: z.string().min(1),
    type: z.string(),
    payload: z.object({ type: z.string() }).passthrough(),
  })
  .refine((e) => e.payload.type === e.type, {
    message: "envelope type must equal payload.type",
  });

const durableGatewayEventSchema = z
  .object({
    ...durableEventBase,
    stream: z.literal("gateway"),
    type: z.string(),
    payload: z.object({ type: z.string() }).passthrough(),
  })
  .refine((e) => e.payload.type === e.type, {
    message: "envelope type must equal payload.type",
  });

/** Structural envelope validation — kind-level dispatch + invariants. */
export const envelopeSchema = z.union([
  requestEnvelopeSchema,
  responseEnvelopeSchema,
  ackSchema,
  ephemeralDeltaSchema,
  ephemeralGatewayNoticeSchema,
  ephemeralDiagnosticsSchema,
  durableTaskEventSchema,
  durableGatewayEventSchema,
]) as z.ZodType<Envelope>;

// ---- handshake payloads (plan §4.6) ----

export const helloRequestSchema = z.object({
  clientVersion: z.string(),
  protocolVersion: z.literal(1),
  clientId: z.string(),
  profileId: z.string(),
  browserInstanceId: z.string().nullable(),
  hostInstanceId: z.string(),
  lastSeqByTask: z.record(z.number().int().nonnegative()).optional(),
  lastSeqByGateway: z.number().int().nonnegative().optional(),
});

export const taskSyncRequestSchema = z.object({
  taskId: z.string(),
  fromSeq: z.number().int().nonnegative(),
  maxEvents: z.number().int().positive().optional(),
});

export const gatewaySyncRequestSchema = z.object({
  fromSeq: z.number().int().nonnegative(),
  maxEvents: z.number().int().positive().optional(),
});

export const taskSnapshotRequestSchema = z.object({
  taskId: z.string(),
});
