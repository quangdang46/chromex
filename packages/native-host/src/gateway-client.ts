/**
 * Gateway client — plan P1-03 / §3.3.1–§3.3.2.
 *
 * Native host acts as a Gateway CLIENT: discovers the atomic endpoint
 * (<dataDir>/run/gateway.json), connects over UDS/named-pipe, and
 * authenticates with hello{token} where the token is read from
 * <dataDir>/auth/token (0600) — never logged, never in argv/env.
 *
 * Framing matches the server: uint32 LE length + UTF-8 JSON envelope,
 * capped at the negotiated maxEnvelopeBytes.
 *
 * This module is transport+session only. NM↔Envelope translation
 * (legacy BridgeRequest compat) is P1-07's router layer.
 */

import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import type { Envelope, HelloResponse, HelloRequest, ProtocolError } from "@codex-sidepanel/shared";

const HEADER_BYTES = 4;
const DEFAULT_MAX_ENVELOPE = 768 * 1024;

export interface GatewayEndpointFile {
  transport: "unix" | "pipe";
  path: string;
  gatewayPid: number;
  startedAt: number;
  gatewayVersion: string;
  tokenRef: string;
}

export class GatewayClientError extends Error {
  constructor(
    message: string,
    readonly code:
      | "endpoint_missing"
      | "endpoint_stale"
      | "connect_failed"
      | "auth_failed"
      | "starting"
      | "not_ready"
      | "unresponsive"
      | "protocol",
    readonly retryable = true,
  ) {
    super(message);
    this.name = "GatewayClientError";
  }
}

/** Read the atomically-published endpoint; .tmp files are never read. */
export async function readGatewayEndpoint(dataDir: string): Promise<GatewayEndpointFile> {
  const file = path.join(dataDir, "run", "gateway.json");
  let raw: string;
  try {
    raw = await fs.readFile(file, "utf8");
  } catch {
    throw new GatewayClientError(`no gateway endpoint at ${file}`, "endpoint_missing");
  }
  try {
    const ep = JSON.parse(raw) as GatewayEndpointFile;
    if (!ep.path || (ep.transport !== "unix" && ep.transport !== "pipe")) {
      throw new Error("bad shape");
    }
    return ep;
  } catch {
    throw new GatewayClientError("gateway endpoint file corrupt", "endpoint_stale");
  }
}

/** Token lives in <dataDir>/auth/token — 64 hex chars, mode 0600. */
export async function readGatewayToken(dataDir: string): Promise<string> {
  try {
    const raw = (await fs.readFile(path.join(dataDir, "auth", "token"), "utf8")).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error("bad token shape");
    return raw;
  } catch {
    throw new GatewayClientError("gateway auth token unreadable", "auth_failed", false);
  }
}

/** True when the endpoint's pid is alive (guards stale PID reuse). */
export async function endpointPidAlive(ep: GatewayEndpointFile): Promise<boolean> {
  try {
    process.kill(ep.gatewayPid, 0);
    return true;
  } catch {
    return false;
  }
}

export interface GatewayConnectOptions {
  /** omit → connect WITHOUT the auth hello (caller hello's later, e.g. gateway-mode passthrough) */
  hello?: Omit<HelloRequest, "clientVersion"> & { clientVersion?: string };
  timeoutMs?: number;
  maxEnvelopeBytes?: number;
}

export class GatewayConnection {
  private socket: net.Socket;
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private eventListeners = new Set<(e: Envelope) => void>();
  private closed = false;
  hello!: HelloResponse;

  private constructor(socket: net.Socket, maxEnvelopeBytes: number) {
    this.socket = socket;
    socket.on("data", (chunk) => this.onData(chunk, maxEnvelopeBytes));
    socket.on("close", () => this.failAll(new GatewayClientError("gateway connection closed", "unresponsive")));
    socket.on("error", () => this.failAll(new GatewayClientError("gateway socket error", "connect_failed")));
  }

  static async connect(
    dataDir: string,
    opts: GatewayConnectOptions,
  ): Promise<GatewayConnection> {
    const ep = await readGatewayEndpoint(dataDir);
    if (!(await endpointPidAlive(ep))) {
      throw new GatewayClientError(`gateway pid ${ep.gatewayPid} not alive`, "endpoint_stale");
    }
    const token = await readGatewayToken(dataDir);
    const maxEnvelope = Math.min(opts.maxEnvelopeBytes ?? DEFAULT_MAX_ENVELOPE, DEFAULT_MAX_ENVELOPE);
    const timeoutMs = opts.timeoutMs ?? 15_000;

    const socket = await new Promise<net.Socket>((resolve, reject) => {
      const s = net.connect(ep.path, () => resolve(s));
      const timer = setTimeout(() => {
        s.destroy();
        reject(new GatewayClientError("gateway connect timed out", "unresponsive"));
      }, timeoutMs);
      s.once("error", (err) => {
        clearTimeout(timer);
        reject(new GatewayClientError(`connect failed: ${err.message}`, "connect_failed"));
      });
      s.once("connect", () => clearTimeout(timer));
    });

    const conn = new GatewayConnection(socket, maxEnvelope);
    if (!opts.hello) {
      // passthrough mode: extension supplies the auth hello itself
      return conn;
    }
    const helloPayload: HelloRequest & { token: string } = {
      ...opts.hello,
      clientVersion: opts.hello.clientVersion ?? "native-host",
      token,
    };
    try {
      const result = (await conn.request("hello", helloPayload, timeoutMs)) as HelloResponse;
      conn.hello = result;
      return conn;
    } catch (err) {
      socket.destroy();
      if (err instanceof GatewayClientError && err.code === "starting") {
        throw new GatewayClientError("gateway still starting", "starting");
      }
      throw err;
    }
  }

  onEvent(listener: (e: Envelope) => void): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  request(method: string, payload?: unknown, timeoutMs = 30_000): Promise<unknown> {
    if (this.closed) return Promise.reject(new GatewayClientError("connection closed", "unresponsive"));
    const id = `c${this.nextId++}-${randomUUID().slice(0, 8)}`;
    const envelope: Envelope = { v: 1, kind: "request", id, method, ...(payload !== undefined ? { payload } : {}) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayClientError(`request ${method} timed out`, "unresponsive"));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.writeRaw(envelope);
    });
  }

  /** Forward an envelope verbatim (e.g. extension's response to a
   *  server-initiated request). Used only for kind:"response". */
  sendEnvelope(envelope: Envelope): void {
    if (this.closed) return;
    this.writeRaw(envelope);
  }

  sendAck(stream: "task" | "gateway", seq: number, taskId?: string): void {
    this.writeRaw(
      stream === "task"
        ? { v: 1, kind: "ack", stream, taskId: taskId ?? "", seq }
        : { v: 1, kind: "ack", stream, seq },
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.failAll(new GatewayClientError("closed by client", "unresponsive", false));
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private writeRaw(envelope: Envelope): void {
    const body = Buffer.from(JSON.stringify(envelope), "utf8");
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32LE(body.length, 0);
    this.socket.write(Buffer.concat([header, body]));
  }

  private onData(chunk: Buffer, maxEnvelopeBytes: number): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < HEADER_BYTES) return;
      const len = this.buffer.readUInt32LE(0);
      if (len > maxEnvelopeBytes) {
        this.failAll(new GatewayClientError("envelope exceeds cap", "protocol", false));
        this.socket.destroy();
        return;
      }
      if (this.buffer.length < HEADER_BYTES + len) return;
      const body = this.buffer.subarray(HEADER_BYTES, HEADER_BYTES + len);
      this.buffer = this.buffer.subarray(HEADER_BYTES + len);
      let env: Envelope;
      try {
        env = JSON.parse(body.toString("utf8")) as Envelope;
      } catch {
        continue; // malformed frame — skip, never crash the host
      }
      if (env.kind === "response") {
        const p = this.pending.get(env.id);
        if (p) {
          this.pending.delete(env.id);
          if ("error" in env && env.error) {
            p.reject(errorFromProtocol(env.error));
          } else {
            p.resolve((env as { result?: unknown }).result);
          }
        }
      } else if (env.kind === "event" || env.kind === "ack" || env.kind === "request") {
        // request = server→client call (browser.tool.*) — relay to
        // the extension; its response comes back as kind:"response".
        for (const l of this.eventListeners) l(env);
      }
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }
}

function errorFromProtocol(pe: ProtocolError): Error {
  const msg = `${pe.code}: ${pe.message ?? ""}`;
  switch (pe.code) {
    case "proto.auth_failed":
    case "proto.auth_expired":
      return new GatewayClientError(msg, "auth_failed", false);
    case "gateway.starting":
      return new GatewayClientError(msg, "starting");
    case "gateway.not_ready":
      return new GatewayClientError(msg, "not_ready");
    case "gateway.unresponsive":
      return new GatewayClientError(msg, "unresponsive");
    default:
      return new GatewayClientError(msg, "protocol");
  }
}

// ---------- auto-start (§3.3.1) ----------

export interface EnsureGatewayOptions extends Omit<GatewayConnectOptions, "hello"> {
  hello?: GatewayConnectOptions["hello"];
  /** path to bridge gateway bin (dist/gateway/bin.js); null disables spawn */
  gatewayBin?: string | null;
  /** total deadline covering connect-attempt + spawn + ready (default 15s) */
  startupTimeoutMs?: number;
  /** gateway data dir override → CHROMEX_GATEWAY_HOME for the child */
  env?: NodeJS.ProcessEnv;
  log?: (msg: string) => void;
}

function resolveGatewayBin(override?: string | null): string | null {
  if (override === null) return null;
  if (override) return override;
  const configured = process.env.GATEWAY_ENTRY?.trim();
  if (configured) return configured;
  // sibling package layout: native-host/dist → bridge/dist/gateway/bin.js
  const here = path.dirname(new URL(import.meta.url).pathname);
  return path.resolve(here, "../../bridge/dist/gateway/bin.js");
}

/**
 * Connect to the gateway, spawning it detached if no healthy endpoint
 * answers within the deadline. §3.3.1: single startupTimeoutMs covers
 * discovery + spawn + endpoint-publish; backoff 250ms→5s jittered.
 *
 * Concurrent spawners are safe WITHOUT a client-side startup lock: the
 * gateway's own LIFETIME flock admits exactly one process — losers exit
 * during boot. (Client-side startup-lock serialization is a later
 * refinement if spawn storms prove costly.)
 */
export async function ensureGateway(
  dataDir: string,
  opts: EnsureGatewayOptions,
): Promise<GatewayConnection> {
  const deadline = Date.now() + (opts.startupTimeoutMs ?? 15_000);
  const bin = resolveGatewayBin(opts.gatewayBin);
  let spawned = false;
  let backoff = 250;

  for (;;) {
    try {
      return await GatewayConnection.connect(dataDir, {
        ...(opts.hello ? { hello: opts.hello } : {}),
        timeoutMs: Math.min(5_000, Math.max(500, deadline - Date.now())),
        ...(opts.maxEnvelopeBytes !== undefined ? { maxEnvelopeBytes: opts.maxEnvelopeBytes } : {}),
      });
    } catch (err) {
      const code = err instanceof GatewayClientError ? err.code : "connect_failed";
      const retryable = err instanceof GatewayClientError ? err.retryable : true;
      if (!retryable || Date.now() >= deadline) throw err;

      if (!spawned && bin && (code === "endpoint_missing" || code === "endpoint_stale" || code === "connect_failed")) {
        spawned = true;
        opts.log?.(`spawning gateway: ${bin}`);
        const { spawn } = await import("node:child_process");
        const { appendFileSync, openSync } = await import("node:fs");
        // stderr → gateway.log: the gateway is detached, so without this
        // a crash is undiagnosable (stdio:"ignore" leaves no trace).
        const logPath = path.join(dataDir, "gateway.log");
        const logFd = openSync(logPath, "a");
        const child = spawn(process.execPath, [bin], {
          detached: true,
          stdio: ["ignore", logFd, logFd],
          windowsHide: true,
          env: {
            ...process.env,
            CHROMEX_GATEWAY_HOME: dataDir,
            ...(opts.env ?? {}),
          },
        });
        child.unref();
        appendFileSync(logPath, `\n--- spawn ${new Date().toISOString()} pid=${child.pid ?? "?"} ---\n`);
      }

      const wait = Math.min(backoff + Math.floor(Math.random() * 100), 5_000);
      backoff = Math.min(backoff * 2, 5_000);
      await new Promise((r) => setTimeout(r, Math.min(wait, Math.max(50, deadline - Date.now()))));
    }
  }
}
