/**
 * Gateway client — plan §11 / P1-08.
 *
 * Speaks Envelope JSON over the SAME Native Messaging port as the
 * legacy bridge (the native host relays to the Gateway IPC socket in
 * gatewayMode). The extension never sees the gateway token — the host
 * injects it into `hello`.
 *
 * Reconnect model: chrome.runtime.Port dies with the service worker or
 * native host; the next request lazily reconnects + re-hellos with
 * persisted cursors (lastSeqByTask / lastSeqByGateway). SW sleep is
 * expected — there is no keepalive hack.
 */

import type {
  Envelope,
  HelloRequest,
  HelloResponse,
  ProtocolError,
} from "@codex-sidepanel/shared";

const NATIVE_HOST_NAME = "com.codex.sidepanel.bridge";

export type GatewayConnectionState =
  | "disconnected"
  | "connecting"
  | "ready"
  | "starting" // gateway.starting / not_ready → retryable
  | "unresponsive";

export interface GatewayClientOptions {
  /** identity + cursors provider */
  hello: () => Promise<Omit<HelloRequest, "clientVersion"> & { clientVersion?: string }>;
  onStateChange?: (state: GatewayConnectionState) => void;
  onEvent?: (env: Envelope) => void;
  /** reconnect backoff bounds */
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  requestTimeoutMs?: number;
}

interface PendingRequest {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

export class GatewayClient {
  #port: chrome.runtime.Port | null = null;
  #pending = new Map<string, PendingRequest>();
  #state: GatewayConnectionState = "disconnected";
  #helloResponse: HelloResponse | null = null;
  #connectPromise: Promise<void> | null = null;
  readonly #opts: GatewayClientOptions;

  constructor(opts: GatewayClientOptions) {
    this.#opts = opts;
  }

  get state(): GatewayConnectionState {
    return this.#state;
  }

  get hello(): HelloResponse | null {
    return this.#helloResponse;
  }

  #setState(s: GatewayConnectionState): void {
    if (this.#state === s) return;
    this.#state = s;
    this.#opts.onStateChange?.(s);
  }

  /** Ensure port + hello completed. Idempotent; concurrent callers share one connect. */
  async connect(): Promise<HelloResponse> {
    if (this.#helloResponse && this.#port) return this.#helloResponse;
    if (this.#connectPromise) {
      await this.#connectPromise;
      if (this.#helloResponse) return this.#helloResponse;
    }
    this.#connectPromise = this.#doConnect().finally(() => {
      this.#connectPromise = null;
    });
    await this.#connectPromise;
    if (!this.#helloResponse) throw new Error("gateway connect failed");
    return this.#helloResponse;
  }

  async #doConnect(): Promise<void> {
    this.#setState("connecting");
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    this.#port = port;
    port.onMessage.addListener((message: unknown) => this.#handleMessage(message as Envelope));
    port.onDisconnect.addListener(() => {
      this.#teardown(new Error(chrome.runtime.lastError?.message ?? "native host disconnected"));
    });

    const helloPayload = await this.#opts.hello();
    try {
      // send hello directly on the port — this.request() would deadlock
      // on the in-flight #connectPromise.
      const result = (await this.#send("hello", {
        ...helloPayload,
        clientVersion: helloPayload.clientVersion ?? "extension",
      })) as HelloResponse;
      this.#helloResponse = result;
      this.#setState("ready");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/starting|not_ready/i.test(msg)) this.#setState("starting");
      else this.#setState("unresponsive");
      this.#teardown(err instanceof Error ? err : new Error(msg));
      throw err;
    }
  }

  /** RPC — auto-connects; returns the response `result`. */
  async request(method: string, payload?: unknown): Promise<unknown> {
    await this.connect();
    const port = this.#port;
    if (!port) throw new Error("gateway port unavailable");
    return this.#send(method, payload, port);
  }

  #send(method: string, payload: unknown, port: chrome.runtime.Port | null = this.#port): Promise<unknown> {
    if (!port) return Promise.reject(new Error("gateway port unavailable"));
    const id = crypto.randomUUID();
    const envelope: Envelope = {
      v: 1,
      kind: "request",
      id,
      method,
      ...(payload !== undefined ? { payload } : {}),
    };
    const timeoutMs = this.#opts.requestTimeoutMs ?? 30_000;
    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { resolve, reject };
      pending.timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new Error(`gateway request ${method} timed out`));
        }
      }, timeoutMs);
      this.#pending.set(id, pending);
      try {
        port.postMessage(envelope);
      } catch (err) {
        this.#pending.delete(id);
        if (pending.timer) clearTimeout(pending.timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** fire-and-forget ack (render signal) */
  ack(stream: "task" | "gateway", seq: number, taskId?: string): void {
    if (!this.#port) return;
    const env =
      stream === "task"
        ? ({ v: 1, kind: "ack", stream, taskId: taskId ?? "", seq } as const)
        : ({ v: 1, kind: "ack", stream, seq } as const);
    try {
      this.#port.postMessage(env);
    } catch {
      // port dying — reconnect path handles it
    }
  }

  #handleMessage(env: Envelope): void {
    if (env.kind === "event") {
      this.#opts.onEvent?.(env);
      return;
    }
    if (env.kind !== "response") return;
    const pending = this.#pending.get(env.id);
    if (!pending) return;
    this.#pending.delete(env.id);
    if (pending.timer) clearTimeout(pending.timer);
    if ("error" in env && env.error) {
      pending.reject(protocolErrorToError(env.error));
    } else {
      pending.resolve((env as { result?: unknown }).result);
    }
  }

  #teardown(err: Error): void {
    for (const [, p] of this.#pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
    this.#port = null;
    this.#helloResponse = null;
    this.#setState("disconnected");
  }

  close(): void {
    this.#teardown(new Error("closed"));
  }
}

function protocolErrorToError(pe: ProtocolError): Error {
  const e = new Error(`${pe.code}: ${pe.message ?? ""}`);
  (e as Error & { code?: string }).code = pe.code;
  return e;
}
