import { describe, expect, it } from "vitest";
import {
  envelopeSchema,
  helloRequestSchema,
  taskSyncRequestSchema,
  gatewaySyncRequestSchema,
  responseEnvelopeSchema,
  MAX_ENVELOPE_BYTES_HARD,
  MAX_EVENT_PAYLOAD_BYTES,
  MAX_SNAPSHOT_CHUNK_BYTES,
  NM_TRANSPORT_LIMIT_BYTES,
  type Envelope,
  type DurableTaskEventEnvelope,
} from "../src/index.js";
import { GATEWAY_EVENT_REPLAYABLE } from "../src/tasks/events.js";

/**
 * Contract tests — plan §4.1/§4.4/§4.6/§4.11.
 */

describe("size limits", () => {
  it("hard caps match plan values and stay under transport", () => {
    expect(NM_TRANSPORT_LIMIT_BYTES).toBe(1024 * 1024);
    expect(MAX_ENVELOPE_BYTES_HARD).toBe(786432);
    expect(MAX_EVENT_PAYLOAD_BYTES).toBe(262144);
    expect(MAX_SNAPSHOT_CHUNK_BYTES).toBe(262144);
    expect(MAX_ENVELOPE_BYTES_HARD).toBeLessThan(NM_TRANSPORT_LIMIT_BYTES);
  });
});

describe("envelope schema", () => {
  it("accepts a request envelope", () => {
    const env = { v: 1, kind: "request", id: "r1", method: "task.list" };
    expect(envelopeSchema.safeParse(env).success).toBe(true);
  });

  it("rejects response with BOTH result and error", () => {
    const env = {
      v: 1,
      kind: "response",
      id: "r1",
      result: {},
      error: { code: "internal", message: "x", retryable: false, requiresUserAction: false, sideEffectState: "none" },
    };
    expect(responseEnvelopeSchema.safeParse(env).success).toBe(false);
  });

  it("rejects response with NEITHER result nor error", () => {
    expect(responseEnvelopeSchema.safeParse({ v: 1, kind: "response", id: "r1" }).success).toBe(false);
  });

  it("accepts response with only result", () => {
    expect(responseEnvelopeSchema.safeParse({ v: 1, kind: "response", id: "r1", result: { ok: true } }).success).toBe(true);
  });

  it("rejects durable event where type != payload.type", () => {
    const env = {
      v: 1, kind: "event", reliability: "durable", stream: "task", taskId: "t1",
      seq: 1, ts: 0, type: "turn.started",
      payload: { type: "turn.completed", turnId: "x" },
    };
    expect(envelopeSchema.safeParse(env).success).toBe(false);
  });

  it("accepts durable task event with matching type", () => {
    const env = {
      v: 1, kind: "event", reliability: "durable", stream: "task", taskId: "t1",
      seq: 1, ts: 0, type: "turn.started",
      payload: { type: "turn.started", turnId: "tu1" },
    };
    expect(envelopeSchema.safeParse(env).success).toBe(true);
  });

  it("accepts ephemeral delta (no seq)", () => {
    const env = {
      v: 1, kind: "event", reliability: "ephemeral", taskId: "t1", turnId: "tu1",
      type: "assistant.delta", deltaOffset: 0, text: "hi", ts: 1,
    };
    const parsed = envelopeSchema.safeParse(env);
    expect(parsed.success).toBe(true);
  });

  it("rejects ack with negative seq", () => {
    const env = { v: 1, kind: "ack", stream: "task", taskId: "t1", seq: -1 };
    expect(envelopeSchema.safeParse(env).success).toBe(false);
  });
});

describe("handshake schemas", () => {
  it("hello requires browserInstanceId key (nullable)", () => {
    const base = {
      clientVersion: "0.1.8", protocolVersion: 1, clientId: "c", profileId: "p",
      hostInstanceId: "h", lastSeqByTask: {}, lastSeqByGateway: 0,
    };
    expect(helloRequestSchema.safeParse({ ...base, browserInstanceId: null }).success).toBe(true);
    expect(helloRequestSchema.safeParse({ ...base, browserInstanceId: "bi-1" }).success).toBe(true);
    // missing key entirely → invalid
    expect(helloRequestSchema.safeParse(base).success).toBe(false);
  });

  it("task.sync request validates", () => {
    expect(taskSyncRequestSchema.safeParse({ taskId: "t", fromSeq: 0 }).success).toBe(true);
    expect(taskSyncRequestSchema.safeParse({ taskId: "t", fromSeq: -1 }).success).toBe(false);
  });

  it("gateway.sync request validates", () => {
    expect(gatewaySyncRequestSchema.safeParse({ fromSeq: 3, maxEvents: 100 }).success).toBe(true);
  });
});

describe("gateway event replay set", () => {
  it("includes exactly the durable replayable types, excludes notice", () => {
    expect(GATEWAY_EVENT_REPLAYABLE.has("gateway.task_purged")).toBe(true);
    expect(GATEWAY_EVENT_REPLAYABLE.has("gateway.started")).toBe(true);
    expect(GATEWAY_EVENT_REPLAYABLE.has("gateway.notice")).toBe(false);
  });
});

// ---- compile-time assertions (type-level, no runtime cost) ----

describe("type-level contracts", () => {
  it("durable task envelope binds type to payload.type", () => {
    // This only compiles if the mapped union works: a mismatched
    // type/payload pair must be a type error. We assert the positive
    // case here; the negative case is enforced by tsc (see below).
    const env: DurableTaskEventEnvelope = {
      v: 1,
      kind: "event",
      reliability: "durable",
      stream: "task",
      taskId: "t1",
      seq: 1,
      ts: 0,
      type: "turn.started",
      payload: { type: "turn.started", turnId: "tu1" },
    };
    const asEnvelope: Envelope = env;
    expect(asEnvelope.kind).toBe("event");
  });

  it("rejects mismatched type/payload at compile time", () => {
    // The distributive mapped union must make this a type error:
    // type:"turn.started" cannot carry a turn.completed payload.
    const bad: DurableTaskEventEnvelope = {
      v: 1,
      kind: "event",
      reliability: "durable",
      stream: "task",
      taskId: "t1",
      seq: 1,
      ts: 0,
      type: "turn.started",
      // @ts-expect-error — payload.type does not match envelope type
      payload: { type: "turn.completed", turnId: "tu1" },
    };
    void bad;
    expect(true).toBe(true);
  });
});
