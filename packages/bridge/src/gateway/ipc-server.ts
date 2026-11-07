/**
 * Gateway IPC server — plan §3.4/§4.1.
 *
 * Transport (provisional pending spike-B5 / docs/adr/ipc-transport.md):
 *  - POSIX: Unix domain socket at <dataDir>/run/gateway.sock
 *  - Windows: named pipe \\.\pipe\chromex-gateway-<hash>
 *
 * Framing: uint32 LE length + UTF-8 JSON, hard-capped at
 * config.gateway.maxEnvelopeBytes (≤ MAX_ENVELOPE_BYTES_HARD). Auth:
 * first request on a connection MUST be method "hello" carrying the
 * 32-byte token from <dataDir>/auth/token (0600). Wrong/missing token →
 * connection closed, never logged.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";

import { MAX_ENVELOPE_BYTES_HARD, protocolError } from "@codex-sidepanel/shared";
import type { Envelope, ProtocolError } from "@codex-sidepanel/shared";

export interface GatewayEndpoint {
  transport: "unix" | "pipe";
  /** socket path (POSIX) or pipe name (Windows) */
  path: string;
  gatewayPid: number;
  startedAt: number;
  gatewayVersion: string;
  /** reference to the token file — never the raw token */
  tokenRef: string;
}

export interface IpcAuthResult {
  ok: boolean;
  clientId?: string;
}

export type IpcRequestHandler = (
  envelope: Extract<Envelope, { kind: "request" }>,
  conn: IpcConnection,
) => Promise<unknown>;

export interface IpcConnection {
  readonly authed: boolean;
  readonly remoteAddress: string;
  send(envelope: Envelope): void;
  close(): void;
}

interface ConnState {
  socket: net.Socket;
  authed: boolean;
  buffer: Buffer;
  helloSeen: boolean;
}

const HEADER_BYTES = 4;

export class GatewayIpcServer {
  private server: net.Server | null = null;
  private connections = new Set<ConnState>();
  private token: Buffer;
  private ready = false;
  private starting = true;

  constructor(
    private readonly dataDir: string,
    private readonly maxEnvelopeBytes: number,
    private readonly handler: IpcRequestHandler,
    token?: Buffer,
  ) {
    this.token = token ?? randomBytes(32);
    this.maxEnvelopeBytes = Math.min(maxEnvelopeBytes, MAX_ENVELOPE_BYTES_HARD);
  }

  get tokenBytes(): Buffer {
    return this.token;
  }

  /** Publish auth token to <dataDir>/auth/token with 0600 perms. */
  async writeTokenFile(): Promise<string> {
    const dir = path.join(this.dataDir, "auth");
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "token");
    await fs.writeFile(file, this.token.toString("hex"), { mode: 0o600 });
    await fs.chmod(file, 0o600).catch(() => {});
    return file;
  }

  static async readToken(dataDir: string): Promise<Buffer | null> {
    try {
      const raw = await fs.readFile(path.join(dataDir, "auth", "token"), "utf8");
      const hex = raw.trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) return null;
      return Buffer.from(hex, "hex");
    } catch {
      return null;
    }
  }

  endpointPath(): { transport: "unix" | "pipe"; path: string } {
    if (process.platform === "win32") {
      const hash = createHash("sha256").update(this.dataDir).digest("hex").slice(0, 16);
      return { transport: "pipe", path: `\\\\.\\pipe\\chromex-gateway-${hash}` };
    }
    const hash = createHash("sha256").update(this.dataDir).digest("hex").slice(0, 16);
    return { transport: "unix", path: path.join(this.dataDir, "run", `gw-${hash}.sock`) };
  }

  /** Atomic endpoint publish: gateway.json.tmp → rename. */
  async publishEndpoint(gatewayVersion: string): Promise<GatewayEndpoint> {
    const ep = this.endpointPath();
    const endpoint: GatewayEndpoint = {
      transport: ep.transport,
      path: ep.path,
      gatewayPid: process.pid,
      startedAt: Date.now(),
      gatewayVersion,
      tokenRef: "auth/token",
    };
    const dir = path.join(this.dataDir, "run");
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(dir, "gateway.json.tmp");
    const final = path.join(dir, "gateway.json");
    await fs.writeFile(tmp, JSON.stringify(endpoint, null, 2), { mode: 0o600 });
    await fs.rename(tmp, final);
    return endpoint;
  }

  async listen(): Promise<GatewayEndpoint> {
    const ep = this.endpointPath();
    if (ep.transport === "unix") {
      await fs.mkdir(path.dirname(ep.path), { recursive: true });
      await fs.rm(ep.path, { force: true }); // stale socket file only — OS socket, not lock
    }
    this.server = net.createServer((socket) => this.onConnection(socket));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(ep.path, () => resolve());
    });
    return this.publishEndpoint("0.0.0-gateway");
  }

  markReady(): void {
    this.ready = true;
    this.starting = false;
  }

  markStarting(): void {
    this.starting = true;
    this.ready = false;
  }

  private onConnection(socket: net.Socket): void {
    const state: ConnState = {
      socket,
      authed: false,
      buffer: Buffer.alloc(0),
      helloSeen: false,
    };
    this.connections.add(state);
    socket.on("data", (chunk) => this.onData(state, chunk));
    socket.on("close", () => this.connections.delete(state));
    socket.on("error", () => this.connections.delete(state));
  }

  private onData(state: ConnState, chunk: Buffer): void {
    state.buffer = Buffer.concat([state.buffer, chunk]);
    for (;;) {
      if (state.buffer.length < HEADER_BYTES) return;
      const len = state.buffer.readUInt32LE(0);
      if (len > this.maxEnvelopeBytes) {
        this.sendError(state, protocolError("proto.payload_too_large", "Envelope exceeds maxEnvelopeBytes"));
        state.socket.destroy();
        return;
      }
      if (state.buffer.length < HEADER_BYTES + len) return;
      const body = state.buffer.subarray(HEADER_BYTES, HEADER_BYTES + len);
      state.buffer = state.buffer.subarray(HEADER_BYTES + len);
      void this.dispatch(state, body).catch(() => {
        state.socket.destroy();
      });
    }
  }

  private async dispatch(state: ConnState, body: Buffer): Promise<void> {
    let envelope: Envelope;
    try {
      envelope = JSON.parse(body.toString("utf8")) as Envelope;
    } catch {
      this.sendError(state, protocolError("proto.invalid", "Malformed JSON envelope"));
      return;
    }
    if (!envelope || typeof envelope !== "object" || envelope.v !== 1) {
      this.sendError(state, protocolError("proto.invalid", "Unsupported envelope version"));
      return;
    }

    if (envelope.kind === "request") {
      await this.handleRequest(state, envelope);
      return;
    }
    // responses/acks/events from client: only ack is meaningful; ignore rest
    if (envelope.kind === "ack") {
      /* routed to store layer in later beads */
    }
  }

  private async handleRequest(
    state: ConnState,
    req: Extract<Envelope, { kind: "request" }>,
  ): Promise<void> {
    // Auth gate: first request must be hello{token}
    if (!state.authed) {
      if (req.method !== "hello") {
        this.sendResponse(state, req.id, null, protocolError("proto.auth_failed", "hello required first"));
        state.socket.destroy();
        return;
      }
      const payload = req.payload as { token?: unknown } | undefined;
      const token = typeof payload?.token === "string" ? payload.token : "";
      // token on the wire is the hex encoding written to auth/token
      const provided = /^[0-9a-fA-F]{64}$/.test(token)
        ? Buffer.from(token, "hex")
        : Buffer.from(token, "utf8");
      const ok =
        provided.length === this.token.length && timingSafeEqual(provided, this.token);
      if (!ok) {
        // never log the token
        this.sendResponse(state, req.id, null, protocolError("proto.auth_failed", "invalid token"));
        state.socket.destroy();
        return;
      }
      state.authed = true;
      state.helloSeen = true;
    } else if (req.method === "hello") {
      this.sendResponse(state, req.id, null, protocolError("proto.invalid", "hello already completed"));
      return;
    }

    if (this.starting) {
      this.sendResponse(state, req.id, null, protocolError("gateway.starting", "Gateway is starting"));
      return;
    }
    if (!this.ready) {
      this.sendResponse(state, req.id, null, protocolError("gateway.not_ready", "Gateway not ready"));
      return;
    }

    try {
      const result = await this.handler(req, this.connFor(state));
      this.sendResponse(state, req.id, result, null);
    } catch (err) {
      const pe = err as ProtocolError;
      this.sendResponse(
        state,
        req.id,
        null,
        pe && typeof pe.code === "string" ? pe : protocolError("internal", String(err)),
      );
    }
  }

  private connFor(state: ConnState): IpcConnection {
    return {
      authed: state.authed,
      remoteAddress: state.socket.remoteAddress ?? "unknown",
      send: (envelope) => this.sendRaw(state, envelope),
      close: () => state.socket.destroy(),
    };
  }

  private sendResponse(
    state: ConnState,
    id: string,
    result: unknown,
    error: ProtocolError | null,
  ): void {
    const envelope: Envelope = error
      ? { v: 1, kind: "response", id, error }
      : { v: 1, kind: "response", id, result };
    this.sendRaw(state, envelope);
  }

  private sendError(state: ConnState, error: ProtocolError): void {
    this.sendRaw(state, { v: 1, kind: "response", id: "", error });
  }

  private sendRaw(state: ConnState, envelope: Envelope): void {
    if (state.socket.destroyed) return;
    const body = Buffer.from(JSON.stringify(envelope), "utf8");
    if (body.length > this.maxEnvelopeBytes) {
      this.sendError(state, protocolError("proto.payload_too_large", "Outbound envelope too large"));
      return;
    }
    const header = Buffer.allocUnsafe(HEADER_BYTES);
    header.writeUInt32LE(body.length, 0);
    state.socket.write(Buffer.concat([header, body]));
  }

  async close(): Promise<void> {
    for (const c of this.connections) c.socket.destroy();
    this.connections.clear();
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    const ep = this.endpointPath();
    if (ep.transport === "unix") {
      await fs.rm(ep.path, { force: true }).catch(() => {});
      await fs.rm(path.join(this.dataDir, "run", "gateway.json"), { force: true }).catch(() => {});
    }
  }
}
