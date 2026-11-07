import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  MAX_ENVELOPE_BYTES_HARD,
  NM_TRANSPORT_LIMIT_BYTES,
  envelopeSchema,
  gatewaySyncRequestSchema,
  helloRequestSchema,
  taskSnapshotRequestSchema,
  taskSyncRequestSchema,
} from "@codex-sidepanel/shared";

import { GatewayIpcServer } from "../src/gateway/ipc-server.js";
import { taskSnapshotSchema as bridgeTaskSnapshotSchema } from "../src/gateway/schemas.js";

/**
 * Protocol fuzz — adversarial/malformed inputs against the wire schemas
 * (packages/shared/src/protocol/schemas.ts) and the Gateway IPC framing
 * layer (packages/bridge/src/gateway/ipc-server.ts).
 *
 * Companion to contracts.test.ts (happy-path invariants) and
 * protocol-errors.test.ts (error registry). This file pins down what the
 * validators do with inputs OUTSIDE the contract — including places where
 * "reject" is actually "silently drop" or "accept anyway".
 */

const VALID_HELLO = {
  clientVersion: "0.1.8",
  protocolVersion: 1,
  clientId: "c1",
  profileId: "p1",
  browserInstanceId: null,
  hostInstanceId: "h1",
};

function okParse(schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) {
  return schema.safeParse(v).success;
}

describe("envelope schema — malformed kinds and versions", () => {
  const request = { v: 1, kind: "request", id: "r1", method: "task.list" };

  test("rejects every non-1 version", () => {
    for (const v of [0, 2, -1, "1", 1.0 + 0.5, null, undefined]) {
      expect(okParse(envelopeSchema, { ...request, v }), `v=${String(v)}`).toBe(false);
    }
  });

  test("rejects missing v and missing kind", () => {
    const { v: _v, ...noV } = request;
    expect(okParse(envelopeSchema, noV)).toBe(false);
    const { kind: _k, ...noKind } = request;
    expect(okParse(envelopeSchema, noKind)).toBe(false);
  });

  test("rejects unknown kind values", () => {
    for (const kind of ["bogus", "ping", "event2", "REQUEST", "", "hello"]) {
      expect(okParse(envelopeSchema, { ...request, kind }), `kind=${kind}`).toBe(false);
    }
  });

  test("rejects kind=event without a valid reliability discriminator", () => {
    const base = { v: 1, kind: "event", seq: 1, ts: 0, type: "x.y", payload: { type: "x.y" } };
    expect(okParse(envelopeSchema, { ...base, reliability: "lossy" })).toBe(false);
    expect(okParse(envelopeSchema, { ...base })).toBe(false);
    expect(okParse(envelopeSchema, { ...base, reliability: "durable" })).toBe(false); // no stream
    expect(okParse(envelopeSchema, { ...base, reliability: "ephemeral" })).toBe(false); // no delta fields
  });

  test("rejects non-object envelopes", () => {
    for (const v of [null, undefined, 42, "str", [], true]) {
      expect(okParse(envelopeSchema, v)).toBe(false);
    }
  });
});

describe("envelope schema — boundary values", () => {
  const durableBase = {
    v: 1,
    kind: "event",
    reliability: "durable",
    stream: "task",
    taskId: "t1",
    ts: 0,
    type: "turn.started",
    payload: { type: "turn.started", turnId: "tu1" },
  };

  test("durable seq must be a positive integer", () => {
    for (const seq of [0, -1, 1.5, NaN, Infinity, -Infinity, "1"]) {
      expect(okParse(envelopeSchema, { ...durableBase, seq }), `seq=${String(seq)}`).toBe(false);
    }
    expect(okParse(envelopeSchema, { ...durableBase, seq: 1 })).toBe(true);
    expect(okParse(envelopeSchema, { ...durableBase, seq: Number.MAX_SAFE_INTEGER })).toBe(true);
  });

  test("ack seq accepts 0, rejects negative/non-integer/NaN", () => {
    const ack = { v: 1, kind: "ack", stream: "task", taskId: "t1" };
    expect(okParse(envelopeSchema, { ...ack, seq: 0 })).toBe(true);
    for (const seq of [-1, 0.5, NaN, Infinity]) {
      expect(okParse(envelopeSchema, { ...ack, seq }), `seq=${String(seq)}`).toBe(false);
    }
  });

  test("durable taskId rejects empty string; request taskId does not", () => {
    // Inconsistency pinned: durable events require taskId min(1), and
    // the bridge dispatch schema (taskSnapshotSchema) also enforces
    // min(1) — but the SHARED taskSnapshotRequestSchema does not.
    expect(okParse(envelopeSchema, { ...durableBase, taskId: "" })).toBe(false);
    expect(okParse(envelopeSchema, { v: 1, kind: "request", id: "r", method: "m", taskId: "" })).toBe(true);
    expect(okParse(bridgeTaskSnapshotSchema, { taskId: "" })).toBe(false);
    expect(okParse(taskSnapshotRequestSchema, { taskId: "" })).toBe(true); // shared schema: no min
  });

  test("cursor fields have no upper bound — overflow values parse", () => {
    // z.number().int() accepts any integer-valued float, including
    // beyond MAX_SAFE_INTEGER. Documented behaviour, not an error:
    // downstream treats fromSeq > lastSeq as "jump to head".
    expect(okParse(helloRequestSchema, { ...VALID_HELLO, lastSeqByGateway: Number.MAX_SAFE_INTEGER + 1 })).toBe(true);
    expect(okParse(taskSyncRequestSchema, { taskId: "t", fromSeq: 2 ** 53 })).toBe(true);
    expect(okParse(gatewaySyncRequestSchema, { fromSeq: Number.MAX_VALUE })).toBe(true);
  });

  test("cursor fields reject non-integer/negative/NaN", () => {
    expect(okParse(helloRequestSchema, { ...VALID_HELLO, lastSeqByGateway: -1 })).toBe(false);
    expect(okParse(helloRequestSchema, { ...VALID_HELLO, lastSeqByGateway: 1.5 })).toBe(false);
    expect(okParse(helloRequestSchema, { ...VALID_HELLO, lastSeqByGateway: NaN })).toBe(false);
    expect(okParse(helloRequestSchema, { ...VALID_HELLO, lastSeqByTask: { t1: -1 } })).toBe(false);
    expect(okParse(helloRequestSchema, { ...VALID_HELLO, lastSeqByTask: { t1: NaN } })).toBe(false);
    expect(okParse(helloRequestSchema, { ...VALID_HELLO, lastSeqByTask: "not-a-record" })).toBe(false);
    expect(okParse(taskSyncRequestSchema, { taskId: "t", fromSeq: -0.5 })).toBe(false);
    expect(okParse(taskSyncRequestSchema, { taskId: "t", fromSeq: 0, maxEvents: 0 })).toBe(false);
    expect(okParse(taskSyncRequestSchema, { taskId: "t", fromSeq: 0, maxEvents: -3 })).toBe(false);
    expect(okParse(taskSyncRequestSchema, { taskId: "t", fromSeq: 0, maxEvents: 1.5 })).toBe(false);
  });
});

describe("envelope schema — response XOR and unknown fields", () => {
  const err = {
    code: "internal",
    message: "x",
    retryable: false,
    requiresUserAction: false,
    sideEffectState: "none",
  };

  test("result:undefined counts as absent — error-only still valid", () => {
    expect(
      okParse(envelopeSchema, { v: 1, kind: "response", id: "r", result: undefined, error: err }),
    ).toBe(true);
    expect(okParse(envelopeSchema, { v: 1, kind: "response", id: "r", result: undefined })).toBe(false);
  });

  test("unknown top-level fields are stripped, not rejected (zod default)", () => {
    const parsed = envelopeSchema.safeParse({
      ...{ v: 1, kind: "request", id: "r", method: "m" },
      surprise: { nested: true },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("surprise" in parsed.data).toBe(false);
    }
  });

  test("durable payload is passthrough — unknown payload fields survive", () => {
    const parsed = envelopeSchema.safeParse({
      v: 1,
      kind: "event",
      reliability: "durable",
      stream: "task",
      taskId: "t1",
      seq: 1,
      ts: 0,
      type: "turn.started",
      payload: { type: "turn.started", turnId: "tu1", futureField: 42 },
    });
    expect(parsed.success).toBe(true);
    if (parsed.success && parsed.data.kind === "event") {
      expect((parsed.data.payload as Record<string, unknown>).futureField).toBe(42);
    }
  });

  test("protocolErrorSchema inside response.error rejects bad sideEffectState", () => {
    const bad = { ...err, sideEffectState: "maybe" };
    expect(okParse(envelopeSchema, { v: 1, kind: "response", id: "r", error: bad })).toBe(false);
    const badCode = { ...err, code: "not.a.real.code" };
    // code is z.string() — registry membership is NOT enforced at schema level
    expect(okParse(envelopeSchema, { v: 1, kind: "response", id: "r", error: badCode })).toBe(true);
  });
});

describe("helloRequestSchema — required fields", () => {
  test("each required field is mandatory", () => {
    const required = [
      "clientVersion",
      "protocolVersion",
      "clientId",
      "profileId",
      "browserInstanceId",
      "hostInstanceId",
    ] as const;
    for (const key of required) {
      const partial = { ...VALID_HELLO } as Record<string, unknown>;
      delete partial[key];
      expect(okParse(helloRequestSchema, partial), `missing ${key}`).toBe(false);
    }
  });

  test("protocolVersion must be literal 1", () => {
    for (const v of [0, 2, "1", 1.5, null]) {
      expect(okParse(helloRequestSchema, { ...VALID_HELLO, protocolVersion: v }), `pv=${String(v)}`).toBe(false);
    }
  });

  test("browserInstanceId must be string|null, never undefined/number", () => {
    expect(okParse(helloRequestSchema, { ...VALID_HELLO, browserInstanceId: 7 })).toBe(false);
    expect(okParse(helloRequestSchema, { ...VALID_HELLO, browserInstanceId: undefined })).toBe(false);
    expect(okParse(helloRequestSchema, { ...VALID_HELLO, browserInstanceId: "" })).toBe(true);
  });

  test("empty strings pass z.string() — no min length on hello fields", () => {
    // parseHelloRequest (bridge hello.ts) only typeof-checks, so "" is
    // a valid clientId/profileId/hostInstanceId end-to-end. Pinned here
    // so a future min(1) tightening is a deliberate change.
    expect(
      okParse(helloRequestSchema, { ...VALID_HELLO, clientId: "", profileId: "", hostInstanceId: "" }),
    ).toBe(true);
  });

  test("unknown hello fields are stripped", () => {
    const parsed = helloRequestSchema.safeParse({ ...VALID_HELLO, evil: "x" });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect("evil" in parsed.data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// IPC framing layer — real GatewayIpcServer on a tmp socket.
// ---------------------------------------------------------------------------

const IPC_TOKEN = Buffer.alloc(32, 7);

function frameBytes(payload: unknown, declaredLen?: number): Buffer {
  const body = Buffer.from(typeof payload === "string" ? payload : JSON.stringify(payload), "utf8");
  const len = declaredLen ?? body.length;
  const header = Buffer.alloc(4);
  header.writeUInt32LE(len, 0);
  return Buffer.concat([header, body]);
}

/** Minimal frame reader: resolves with each parsed envelope in order. */
function makeReader(socket: net.Socket) {
  let buf = Buffer.alloc(0);
  const queue: unknown[] = [];
  const waiters: Array<(v: unknown) => void> = [];
  socket.on("data", (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      let env: unknown;
      try {
        env = JSON.parse(body.toString("utf8"));
      } catch {
        env = { kind: "__unparseable__", raw: body.toString("utf8").slice(0, 80) };
      }
      const w = waiters.shift();
      if (w) w(env);
      else queue.push(env);
    }
  });
  return {
    next(timeoutMs = 2000): Promise<unknown> {
      const q = queue.shift();
      if (q !== undefined) return Promise.resolve(q);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("frame timeout")), timeoutMs);
        waiters.push((v) => {
          clearTimeout(t);
          resolve(v);
        });
      });
    },
    /** resolves true if ANY frame arrives within timeoutMs */
    any(timeoutMs = 300): Promise<boolean> {
      if (queue.length > 0) return Promise.resolve(true);
      return new Promise((resolve) => {
        const waiter = (v: unknown) => {
          clearTimeout(t);
          void v;
          resolve(true);
        };
        const t = setTimeout(() => {
          const i = waiters.indexOf(waiter);
          if (i >= 0) waiters.splice(i, 1);
          resolve(false);
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
  };
}

describe("GatewayIpcServer framing fuzz", () => {
  let dir: string;
  let server: GatewayIpcServer;
  const sockets: net.Socket[] = [];
  const SMALL_MAX = 4096;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-fuzz-"));
    server = new GatewayIpcServer(dir, SMALL_MAX, async () => ({ stub: "ok" }), IPC_TOKEN);
    await server.listen();
    server.markReady();
  });

  afterAll(async () => {
    for (const s of sockets) s.destroy();
    await server.close();
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function connect(): Promise<{ socket: net.Socket; reader: ReturnType<typeof makeReader> }> {
    const ep = server.endpointPath();
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(ep.path, () => resolve(s));
      s.once("error", reject);
    });
    sockets.push(socket);
    return { socket, reader: makeReader(socket) };
  }

  test("declared length > maxEnvelopeBytes → proto.payload_too_large + close", async () => {
    const { socket, reader } = await connect();
    socket.write(frameBytes({ v: 1, kind: "request", id: "x", method: "m" }, SMALL_MAX + 1));
    const env = (await reader.next()) as { kind: string; error?: { code: string } };
    expect(env.kind).toBe("response");
    expect(env.error?.code).toBe("proto.payload_too_large");
    // socket is destroyed after the error
    await new Promise<void>((resolve) => socket.once("close", resolve));
  });

  test("frame at exactly maxEnvelopeBytes is accepted (padded JSON)", async () => {
    const { socket } = await connect();
    const helloEnv = {
      v: 1,
      kind: "request",
      id: "h",
      method: "hello",
      payload: {
        token: IPC_TOKEN.toString("hex"),
        clientVersion: "t",
        protocolVersion: 1,
        clientId: "c",
        profileId: "p",
        browserInstanceId: null,
        hostInstanceId: "",
      },
    };
    const body = JSON.stringify(helloEnv);
    const pad = SMALL_MAX - Buffer.byteLength(body);
    expect(pad).toBeGreaterThanOrEqual(0);
    // JSON.parse tolerates trailing whitespace — pad to exactly the cap
    const padded = body + " ".repeat(pad);
    expect(Buffer.byteLength(padded)).toBe(SMALL_MAX);
    socket.write(frameBytes(padded));
    const reader = makeReader(socket);
    const env = (await reader.next()) as { kind: string; result?: unknown; error?: { code: string } };
    expect(env.kind).toBe("response");
    expect(env.error).toBeUndefined();
  });

  test("malformed JSON body → proto.invalid", async () => {
    const { socket, reader } = await connect();
    socket.write(frameBytes("{not json!!!"));
    const env = (await reader.next()) as { error?: { code: string; message: string } };
    expect(env.error?.code).toBe("proto.invalid");
    expect(env.error?.message).toMatch(/Malformed JSON/);
  });

  test("v !== 1 → proto.invalid 'Unsupported envelope version'", async () => {
    const { socket, reader } = await connect();
    socket.write(frameBytes({ v: 2, kind: "request", id: "x", method: "hello" }));
    const env = (await reader.next()) as { error?: { code: string; message: string } };
    expect(env.error?.code).toBe("proto.invalid");
    expect(env.error?.message).toMatch(/version/i);
  });

  test("unknown kind with v:1 is SILENTLY DROPPED — no schema check inbound", async () => {
    // dispatch() only checks envelope.v and kind∈{request,response,ack};
    // envelopeSchema is never applied to inbound frames. An unknown kind
    // produces no response at all (not even proto.invalid). Pinned as
    // current behaviour — a proto.invalid here would be a fix, not a
    // regression of this test's intent.
    const { socket, reader } = await connect();
    socket.write(frameBytes({ v: 1, kind: "bogus", id: "z", method: "m" }));
    expect(await reader.any(300)).toBe(false);
  });

  test("non-hello request before auth → proto.auth_failed + close", async () => {
    const { socket, reader } = await connect();
    socket.write(frameBytes({ v: 1, kind: "request", id: "a", method: "task.list" }));
    const env = (await reader.next()) as { error?: { code: string } };
    expect(env.error?.code).toBe("proto.auth_failed");
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  });

  test("hello with wrong token → proto.auth_failed + close", async () => {
    const { socket, reader } = await connect();
    socket.write(
      frameBytes({
        v: 1,
        kind: "request",
        id: "h",
        method: "hello",
        payload: { token: "00".repeat(32), clientVersion: "t", protocolVersion: 1 },
      }),
    );
    const env = (await reader.next()) as { error?: { code: string } };
    expect(env.error?.code).toBe("proto.auth_failed");
    await new Promise<void>((resolve) => socket.once("close", () => resolve()));
  });

  test("outbound envelope over maxEnvelopeBytes → proto.payload_too_large", async () => {
    const big = new GatewayIpcServer(dir, SMALL_MAX, async () => ({ blob: "x".repeat(SMALL_MAX * 2) }), IPC_TOKEN);
    try {
      await big.listen();
      big.markReady();
      const ep = big.endpointPath();
      const socket = await new Promise<net.Socket>((resolve, reject) => {
        const s = net.createConnection(ep.path, () => resolve(s));
        s.once("error", reject);
      });
      sockets.push(socket);
      const reader = makeReader(socket);
      socket.write(
        frameBytes({
          v: 1,
          kind: "request",
          id: "big1",
          method: "hello",
          payload: {
            token: IPC_TOKEN.toString("hex"),
            clientVersion: "t",
            protocolVersion: 1,
            clientId: "c",
            profileId: "p",
            browserInstanceId: null,
            hostInstanceId: "",
          },
        }),
      );
      await reader.next(); // hello auth response (stub result — small)
      socket.write(frameBytes({ v: 1, kind: "request", id: "big2", method: "anything" }));
      const env = (await reader.next()) as { error?: { code: string; message: string }; id?: string };
      expect(env.error?.code).toBe("proto.payload_too_large");
      expect(env.error?.message).toMatch(/Outbound/);
      // sendError uses id:"" — the oversize response is NOT correlated
      // to the request id. Pinned as current behaviour.
      expect(env.id).toBe("");
    } finally {
      await big.close();
    }
  });

  test("maxEnvelopeBytes clamps to MAX_ENVELOPE_BYTES_HARD", async () => {
    // constructor: Math.min(maxEnvelopeBytes, MAX_ENVELOPE_BYTES_HARD) —
    // a frame between the hard cap and the requested max must be
    // rejected on the header alone (no body needed).
    const huge = new GatewayIpcServer(dir, Number.MAX_SAFE_INTEGER, async () => ({}), IPC_TOKEN);
    await huge.listen();
    huge.markReady();
    const ep = huge.endpointPath();
    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.createConnection(ep.path, () => resolve(s));
      s.once("error", reject);
    });
    sockets.push(socket);
    const reader = makeReader(socket);
    try {
      const header = Buffer.alloc(4);
      header.writeUInt32LE(MAX_ENVELOPE_BYTES_HARD + 1, 0);
      socket.write(header);
      const env = (await reader.next()) as { error?: { code: string } };
      expect(env.error?.code).toBe("proto.payload_too_large");
    } finally {
      socket.destroy();
      await huge.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Gateway dispatch (real startGateway) — typed errors for unknown method
// and malformed hello payloads.
// ---------------------------------------------------------------------------

describe("gateway dispatch — typed errors", () => {
  let dir: string;
  let gw: {
    ipc: GatewayIpcServer;
    shutdown: (reason?: string) => Promise<void>;
  } | null = null;

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-fuzz-dispatch-"));
    const { startGateway } = await import("../src/gateway/main.js");
    gw = (await startGateway({ dataDir: dir, log: () => {} })) as typeof gw;
  });

  afterAll(async () => {
    await gw?.shutdown("test").catch(() => {});
    gw = null;
    await fs.rm(dir, { recursive: true, force: true });
  });

  function rpc(socket: net.Socket, id: string, method: string, payload?: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const body = Buffer.from(
        JSON.stringify({ v: 1, kind: "request", id, method, ...(payload !== undefined ? { payload } : {}) }),
      );
      const header = Buffer.alloc(4);
      header.writeUInt32LE(body.length, 0);
      let buf = Buffer.alloc(0);
      const timer = setTimeout(() => reject(new Error("rpc timeout")), 5000);
      const onData = (chunk: Buffer) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          if (buf.length < 4) return;
          const len = buf.readUInt32LE(0);
          if (buf.length < 4 + len) return;
          const env = JSON.parse(buf.subarray(4, 4 + len).toString("utf8")) as {
            kind?: string;
            id?: string;
            error?: { code?: string };
          };
          buf = buf.subarray(4 + len);
          if (env.kind === "response" && env.id === id) {
            clearTimeout(timer);
            socket.off("data", onData);
            if (env.error) reject(env.error);
            else resolve(env);
            return;
          }
        }
      };
      socket.on("data", onData);
      socket.write(Buffer.concat([header, body]));
    });
  }

  async function authedConn(): Promise<net.Socket> {
    const ep = gw!.ipc.endpointPath();
    const s = await new Promise<net.Socket>((resolve, reject) => {
      const c = net.createConnection(ep.path, () => resolve(c));
      c.once("error", reject);
    });
    const token = gw!.ipc.tokenBytes.toString("hex");
    await rpc(s, "hello", "hello", {
      token,
      ...VALID_HELLO,
      clientVersion: "test",
    });
    return s;
  }

  test("unknown method → proto.unknown_method typed error", async () => {
    const s = await authedConn();
    try {
      await expect(rpc(s, "u1", "definitely.not.a.method", {})).rejects.toMatchObject({
        code: "proto.unknown_method",
      });
      await expect(rpc(s, "u2", "", {})).rejects.toMatchObject({ code: "proto.unknown_method" });
      await expect(rpc(s, "u3", "task.send.extra.dots", {})).rejects.toMatchObject({
        code: "proto.unknown_method",
      });
    } finally {
      s.destroy();
    }
  });

  test("retired legacy methods → proto.unsupported (not unknown_method)", async () => {
    const s = await authedConn();
    try {
      await expect(rpc(s, "r1", "route.plan", {})).rejects.toMatchObject({
        code: "proto.unsupported",
      });
    } finally {
      s.destroy();
    }
  });

  test("hello with missing required fields → proto.invalid (each field)", async () => {
    const ep = gw!.ipc.endpointPath();
    const token = gw!.ipc.tokenBytes.toString("hex");
    for (const missing of [
      "protocolVersion",
      "clientId",
      "profileId",
      "hostInstanceId",
      "clientVersion",
    ]) {
      const s = await new Promise<net.Socket>((resolve, reject) => {
        const c = net.createConnection(ep.path, () => resolve(c));
        c.once("error", reject);
      });
      const payload: Record<string, unknown> = {
        token,
        clientVersion: "test",
        protocolVersion: 1,
        clientId: "c",
        profileId: "p",
        browserInstanceId: null,
        hostInstanceId: "h",
      };
      delete payload[missing];
      try {
        await expect(
          rpc(s, `hm-${missing}`, "hello", payload),
          `missing ${missing}`,
        ).rejects.toMatchObject({ code: "proto.invalid" });
      } finally {
        s.destroy();
      }
    }
  });

  test("hello with missing browserInstanceId SUCCEEDS — coerced to null", async () => {
    // FINDING: parseHelloRequest (hello.ts:61-63) treats
    // browserInstanceId===undefined as null, while helloRequestSchema
    // requires the key. The wire path is more permissive than the
    // declared contract. Pinned as current behaviour.
    const ep = gw!.ipc.endpointPath();
    const token = gw!.ipc.tokenBytes.toString("hex");
    const s = await new Promise<net.Socket>((resolve, reject) => {
      const c = net.createConnection(ep.path, () => resolve(c));
      c.once("error", reject);
    });
    const payload: Record<string, unknown> = {
      token,
      clientVersion: "test",
      protocolVersion: 1,
      clientId: "c",
      profileId: "p",
      hostInstanceId: "h",
    };
    try {
      const res = (await rpc(s, "hm-bi", "hello", payload)) as { result?: { protocolVersion?: number } };
      expect(res.result?.protocolVersion).toBe(1);
    } finally {
      s.destroy();
    }
  });

  test("hello protocolVersion=2 → proto.invalid, NOT proto.version_mismatch", async () => {
    // FINDING: handleGatewayRequest's proto.version_mismatch branch is
    // unreachable — parseHelloRequest rejects any protocolVersion !== 1
    // first and helloError() maps it to proto.invalid. Pinned here.
    // (Fresh conn: a second hello on an authed conn → proto.invalid
    // "hello already completed".)
    const ep = gw!.ipc.endpointPath();
    const token = gw!.ipc.tokenBytes.toString("hex");
    const s2 = await new Promise<net.Socket>((resolve, reject) => {
      const c = net.createConnection(ep.path, () => resolve(c));
      c.once("error", reject);
    });
    try {
      await expect(
        rpc(s2, "hv", "hello", {
          token,
          clientVersion: "test",
          protocolVersion: 2,
          clientId: "c",
          profileId: "p",
          browserInstanceId: null,
          hostInstanceId: "h",
        }),
      ).rejects.toMatchObject({ code: "proto.invalid" });
    } finally {
      s2.destroy();
    }
  });
});
