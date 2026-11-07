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
 *  - NM stdin frame → JSON Envelope
 *    - kind "request"  → conn.request(method, payload) → response env → NM stdout
 *      - method "hello" gets token + host/browser ids injected first
 *    - kind "ack"      → conn.sendAck
 *  - Gateway events    → conn.onEvent → NM stdout (as-is)
 *  - Reconnect          → ensureGateway() again; the extension re-hellos
 *    with its lastSeqByTask cursors and pulls task.sync itself.
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

export interface GatewayModeOptions {
  dataDir: string;
  gatewayBin?: string | null;
  startupTimeoutMs?: number;
  /** extension-facing identity is supplied per-hello; these are host-side */
  log?: (msg: string) => void;
  onHello?: (hello: HelloResponse) => void;
  /** tests set false to avoid process.exit inside vitest */
  exitProcess?: boolean;
}

const HOST_INSTANCE_ID = randomUUID();

export class GatewayModeRelay {
  readonly #decoder = new NativeMessageStreamDecoder();
  #conn: GatewayConnection | null = null;
  #token: string | null = null;
  #browserInstanceId: string | null = null;
  #shuttingDown = false;
  readonly #opts: GatewayModeOptions;

  constructor(opts: GatewayModeOptions) {
    this.#opts = opts;
  }

  async start(input: Readable): Promise<void> {
    this.#token = await readGatewayToken(this.#opts.dataDir);
    this.#browserInstanceId = await resolveBrowserInstanceId({ dataDir: this.#opts.dataDir });
    // NO hello here: the server allows exactly one hello per connection
    // and it must be the EXTENSION's (with host-injected token + ids).
    this.#conn = await ensureGateway(this.#opts.dataDir, {
      ...(this.#opts.gatewayBin !== undefined ? { gatewayBin: this.#opts.gatewayBin } : {}),
      ...(this.#opts.startupTimeoutMs !== undefined
        ? { startupTimeoutMs: this.#opts.startupTimeoutMs }
        : {}),
      ...(this.#opts.log ? { log: this.#opts.log } : {}),
    });
    this.#conn.onEvent((env) => this.#writeEnvelope(env));
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

  async #handleMessage(raw: unknown): Promise<void> {
    if (typeof raw !== "object" || raw === null) return;
    const env = raw as Envelope;
    const conn = this.#conn;
    if (!conn || conn.isClosed) {
      this.#writeEnvelope({
        v: 1,
        kind: "response",
        id: (env as { id?: string }).id ?? "?",
        error: {
          code: "gateway.unresponsive",
          message: "gateway connection not established",
          retryable: true,
          requiresUserAction: false,
          sideEffectState: "none",
        },
      } as Envelope);
      return;
    }
    try {
      if (env.kind === "request") {
        const payload = this.#injectHostFields(env.method, env.payload);
        const result = await conn.request(env.method, payload);
        this.#writeEnvelope({ v: 1, kind: "response", id: env.id, result } as Envelope);
      } else if (env.kind === "ack") {
        conn.sendAck(env.stream, env.seq, env.stream === "task" ? env.taskId : undefined);
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
    this.#conn?.close();
    if (this.#opts.exitProcess !== false) process.exit(exitCode);
  }
}
