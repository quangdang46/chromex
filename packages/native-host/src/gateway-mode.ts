/**
 * Gateway mode relay — plan §11 / P1-03.
 *
 * When `gatewayMode` is on, the native host is a Gateway CLIENT:
 * the extension speaks Envelope JSON over Native Messaging and the
 * host forwards it to the Gateway IPC socket. The host owns the
 * token (injected into `hello`, never exposed to the extension) and
 * supplies hostInstanceId + browserInstanceId (B6 mechanism).
 *
 * Flow:
 *  - NM stdin frame → JSON
 *    - Envelope (v:1 + kind) → Gateway IPC socket:
 *      - kind "request"  → conn.request(method, payload) → response env → NM stdout
 *        - method "hello" gets token + host/browser ids injected first
 *      - kind "ack"      → conn.sendAck
 *      - kind "response" → conn.sendEnvelope (extension answering a
 *        server-initiated request, e.g. browser.tool.*)
 *    - legacy BridgeRequest ({id,method,params}, no v/kind) → bridge
 *      sidecar child (chromex-rzf dual-channel): the Gateway does not
 *      serve non-agent domains, so they keep flowing to
 *      bridge/dist/cli.js exactly like the pre-gateway relay.
 *  - Gateway events    → conn.onEvent → NM stdout (as-is)
 *  - Gateway connect   → LAZY: first Envelope message triggers
 *    ensureGateway(); sidecar traffic never needs the gateway, so
 *    runtime.config/image/voice keep working while it is down.
 */

import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import readline from "node:readline";

import type { Envelope, HelloRequest, HelloResponse } from "@codex-sidepanel/shared";

import { resolveBrowserInstanceId } from "./browser-instance.js";
import {
  encodeNativeMessage,
  MAX_NATIVE_MESSAGE_BYTES,
  NativeMessageStreamDecoder,
} from "./framing.js";
import {
  ensureGateway,
  GatewayClientError,
  readGatewayToken,
  type GatewayConnection,
} from "./gateway-client.js";
import { LegacyBridgeSidecar } from "./legacy-sidecar.js";

export interface GatewayModeOptions {
  dataDir: string;
  gatewayBin?: string | null;
  startupTimeoutMs?: number;
  /** extension-facing identity is supplied per-hello; these are host-side */
  log?: (msg: string) => void;
  onHello?: (hello: HelloResponse) => void;
  /** tests set false to avoid process.exit inside vitest */
  exitProcess?: boolean;
  /** sidecar bridge entry override (tests); default resolveBridgeEntryPath() */
  bridgeEntry?: string | null;
}

const HOST_INSTANCE_ID = randomUUID();

export class GatewayModeRelay {
  readonly #decoder = new NativeMessageStreamDecoder();
  #conn: GatewayConnection | null = null;
  #gatewayPromise: Promise<GatewayConnection> | null = null;
  #token: string | null = null;
  #browserInstanceId: string | null = null;
  #shuttingDown = false;
  // S5 self-healing: cache the extension's raw hello payload and which
  // conn it was hellod on. When the gateway conn dies, the relay
  // reconnects proactively and re-hellos — otherwise the host stays
  // unregistered forever because the extension's NM port never drops.
  #lastHelloPayload: unknown = null;
  #connWithHello: GatewayConnection | null = null;
  #reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  #reconnectAttempt = 0;
  readonly #opts: GatewayModeOptions;
  readonly #sidecar: LegacyBridgeSidecar;

  constructor(opts: GatewayModeOptions) {
    this.#opts = opts;
    this.#sidecar = new LegacyBridgeSidecar({
      emit: (message) => this.#writeNativeMessage(message),
      ...(opts.bridgeEntry !== undefined ? { bridgeEntry: opts.bridgeEntry } : {}),
      ...(opts.log ? { log: opts.log } : {}),
    });
  }

  async start(input: Readable): Promise<void> {
    // NO eager gateway connect and NO hello here: the server allows
    // exactly one hello per connection and it must be the EXTENSION's
    // (with host-injected token + ids). The gateway connection is
    // established lazily on the first Envelope message so sidecar
    // traffic works even while the gateway is down (chromex-rzf).
    this.#wireStdin(input);
    process.on("SIGTERM", () => this.#shutdown());
    process.on("SIGINT", () => this.#shutdown());
    input.on("end", () => this.#shutdown());
    process.stdout.on("error", () => this.#shutdown());
  }

  #wireStdin(input: NodeJS.ReadableStream): void {
    // stdin arrives as Native Messaging frames; decode incrementally.
    input.on("data", (chunk: Buffer) => {
      let messages: unknown[];
      try {
        messages = this.#decoder.push(chunk);
      } catch (error) {
        this.#fail(`stdin frame rejected: ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      for (const message of messages) {
        void this.#handleMessage(message);
      }
    });
    // NM "end" arrives via the Readable 'end' listener registered in start().
  }

  /** Lazily establish the gateway connection on first Envelope traffic.
   *  Rejections clear #gatewayPromise so a later message retries —
   *  e.g. the gateway was still spawning when the first request landed. */
  #ensureGatewayConn(): Promise<GatewayConnection> {
    if (this.#conn) {
      if (!this.#conn.isClosed) return Promise.resolve(this.#conn);
      // Dead conn (gateway restarted/crashed): drop it AND the stale
      // resolved promise — otherwise every later call returns the same
      // corpse and the host never re-hellos into the host registry.
      this.#conn = null;
      this.#gatewayPromise = null;
    }
    if (!this.#gatewayPromise) {
      this.#gatewayPromise = this.#connectGateway().catch((err) => {
        this.#gatewayPromise = null;
        throw err;
      });
    }
    return this.#gatewayPromise;
  }

  async #connectGateway(): Promise<GatewayConnection> {
    this.#token = await readGatewayToken(this.#opts.dataDir);
    this.#browserInstanceId = await resolveBrowserInstanceId({ dataDir: this.#opts.dataDir });
    const conn = await ensureGateway(this.#opts.dataDir, {
      ...(this.#opts.gatewayBin !== undefined ? { gatewayBin: this.#opts.gatewayBin } : {}),
      ...(this.#opts.startupTimeoutMs !== undefined
        ? { startupTimeoutMs: this.#opts.startupTimeoutMs }
        : {}),
      ...(this.#opts.log ? { log: this.#opts.log } : {}),
    });
    conn.onEvent((env) => this.#writeEnvelope(env));
    conn.onClose(() => this.#onGatewayConnClosed(conn));
    this.#conn = conn;
    return conn;
  }

  #onGatewayConnClosed(conn: GatewayConnection): void {
    if (this.#shuttingDown || conn !== this.#conn) return;
    this.#conn = null;
    this.#gatewayPromise = null;
    this.#connWithHello = null;
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    if (this.#shuttingDown || this.#reconnectTimer) return;
    const delay = Math.min(30_000, 1_000 * 2 ** this.#reconnectAttempt);
    this.#reconnectAttempt += 1;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      void this.#reconnect();
    }, delay);
    this.#reconnectTimer.unref?.();
  }

  async #reconnect(): Promise<void> {
    if (this.#shuttingDown) return;
    try {
      const conn = await this.#ensureGatewayConn();
      await this.#rehelloIfNeeded(conn);
      this.#reconnectAttempt = 0;
    } catch {
      this.#scheduleReconnect();
    }
  }

  /** The gateway allows exactly one hello per conn and it must carry
   *  host-injected token + ids. Re-send the cached extension hello so
   *  the host re-registers without waiting for extension traffic. */
  async #rehelloIfNeeded(conn: GatewayConnection): Promise<void> {
    if (this.#lastHelloPayload === null || this.#connWithHello === conn) return;
    const payload = this.#injectHostFields("hello", this.#lastHelloPayload);
    const res = (await conn.request("hello", payload)) as HelloResponse;
    this.#connWithHello = conn;
    this.#opts.onHello?.(res);
  }

  async #handleMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null) return;
    // chromex-rzf dual-channel demux: legacy BridgeRequest shape
    // ({id,method,params}, no v/kind) goes to the bridge sidecar
    // child; Envelope-shaped messages go to the gateway.
    if (isLegacyBridgeRequest(raw)) {
      this.#sidecar.handleRequest(raw);
      return;
    }
    const env = raw as Envelope;
    try {
      const conn = await this.#ensureGatewayConn();
      if (conn.isClosed) {
        throw new GatewayClientError("gateway connection closed", "unresponsive");
      }
      if (env.kind === "request") {
        if (env.method === "hello") this.#lastHelloPayload = env.payload;
        const payload = this.#injectHostFields(env.method, env.payload);
        const result = await conn.request(env.method, payload);
        if (env.method === "hello") this.#connWithHello = conn;
        this.#writeEnvelope({ v: 1, kind: "response", id: env.id, result } as Envelope);
      } else if (env.kind === "ack") {
        conn.sendAck(env.stream, env.seq, env.stream === "task" ? env.taskId : undefined);
      } else if (env.kind === "response") {
        // extension answering a server-initiated request (browser.tool.*)
        conn.sendEnvelope(env);
      }
      // gateway→extension event envelopes never arrive from the client
    } catch (err) {
      const pe =
        err instanceof GatewayClientError
          ? {
              code:
                err.code === "auth_failed"
                  ? ("proto.auth_failed" as const)
                  : err.code === "starting"
                    ? ("gateway.starting" as const)
                    : err.code === "not_ready"
                      ? ("gateway.not_ready" as const)
                      : err.code === "unresponsive"
                        ? ("gateway.unresponsive" as const)
                        : ("proto.invalid" as const),
              message: err.message,
              retryable: err.retryable,
              requiresUserAction: false,
              sideEffectState: "none" as const,
            }
          : {
              code: "proto.invalid" as const,
              message: err instanceof Error ? err.message : String(err),
              retryable: false,
              requiresUserAction: false,
              sideEffectState: "none" as const,
            };
      this.#writeEnvelope({ v: 1, kind: "response", id: (env as { id?: string }).id ?? "?", error: pe } as Envelope);
    }
  }

  /** hello gets host-side identity + token injected; other payloads pass through. */
  #injectHostFields(method: string, payload: unknown): unknown {
    if (method !== "hello" || typeof payload !== "object" || payload === null) return payload;
    const p = payload as Partial<HelloRequest>;
    return {
      ...p,
      token: this.#token,
      clientVersion: p.clientVersion ?? "extension",
      hostInstanceId: HOST_INSTANCE_ID,
      browserInstanceId: this.#browserInstanceId,
      // extension-supplied cursors (lastSeqByTask/lastSeqByGateway) pass through
    };
  }

  #writeNativeMessage(message: unknown): void {
    try {
      process.stdout.write(encodeNativeMessage(message));
    } catch {
      // oversized or stdout closed — shutdown handles it
    }
  }

  #writeEnvelope(env: Envelope): void {
    try {
      const body = JSON.stringify(env);
      if (body.length > MAX_NATIVE_MESSAGE_BYTES) {
        this.#opts.log?.(`dropping oversized envelope to extension: ${body.length}B`);
        return;
      }
      process.stdout.write(encodeNativeMessage(JSON.parse(body)));
    } catch {
      // stdout closed — shutdown handles it
    }
  }

  #fail(reason: string): void {
    console.error(`chromex-native-host[gateway]: ${reason}`);
    this.#shutdown(1);
  }

  #shutdown(exitCode = 0): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    if (this.#reconnectTimer) {
      clearTimeout(this.#reconnectTimer);
      this.#reconnectTimer = null;
    }
    this.#sidecar.shutdown();
    this.#conn?.close();
    if (this.#opts.exitProcess !== false) process.exit(exitCode);
  }
}

/** Legacy BridgeRequest ({id,method,params}) vs Envelope ({v:1,kind,...}).
 *  Envelopes always carry `v`/`kind`; the legacy shape carries neither. */
function isLegacyBridgeRequest(raw: unknown): raw is { id: string; method: string; params?: unknown } {
  if (typeof raw !== "object" || raw === null) return false;
  const m = raw as Record<string, unknown>;
  if (m.v !== undefined || m.kind !== undefined) return false;
  return typeof m.id === "string" && typeof m.method === "string";
}
