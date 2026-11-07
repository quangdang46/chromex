/**
 * AcpClient — Agent Client Protocol transport (JSON-RPC 2.0, ndjson over
 * stdio). Mechanism per docs/adr/acp-provider.md (spike-verified against
 * `opencode acp`).
 *
 * - requests: {jsonrpc,id,method,params} → matching {id,result|error}
 * - notifications: {jsonrpc,method,params} (no id)
 * - agent→client requests (session/request_permission, fs/*, terminal/*)
 *   arrive as {id,method,params} and MUST be answered or the agent stalls.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface AcpClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  /** per-request timeout; 0 disables */
  requestTimeoutMs?: number;
  onStderr?: (chunk: string) => void;
}

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(error: JsonRpcError) {
    super(`ACP ${error.code}: ${error.message}`);
    this.name = "AcpRpcError";
    this.code = error.code;
    this.data = error.data;
  }
}

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout | null;
};

type AgentRequestHandler = (
  params: unknown,
) => Promise<unknown> | unknown;

export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new Map<string, Set<(params: unknown) => void>>();
  private readonly agentRequests = new Map<string, AgentRequestHandler>();
  private closed = false;
  private readonly opts: AcpClientOptions & { command: string; args: string[]; requestTimeoutMs: number };

  constructor(options: AcpClientOptions) {
    this.opts = {
      command: options.command,
      args: options.args ?? [],
      requestTimeoutMs: options.requestTimeoutMs ?? 120_000,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.onStderr !== undefined ? { onStderr: options.onStderr } : {}),
    };
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): void {
    if (this.child) return;
    this.child = spawn(this.opts.command, this.opts.args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      env: this.opts.env ? { ...process.env, ...this.opts.env } : process.env,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (d: string) => this.#onData(d));
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (d: string) => this.opts.onStderr?.(d));
    this.child.on("exit", () => this.#onExit());
    this.child.on("error", () => this.#onExit());
  }

  #onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue; // non-JSON noise on stdout — ignore
      }
      this.#dispatch(msg);
    }
  }

  #dispatch(msg: Record<string, unknown>): void {
    const hasId = msg.id !== undefined && msg.id !== null;
    const method = typeof msg.method === "string" ? msg.method : null;
    if (hasId && method) {
      // agent→client request — must respond
      void this.#handleAgentRequest(Number.isInteger(msg.id) ? (msg.id as number) : String(msg.id), method, msg.params);
      return;
    }
    if (hasId) {
      const id = typeof msg.id === "number" ? msg.id : Number(msg.id);
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      if (msg.error && typeof msg.error === "object") {
        p.reject(new AcpRpcError(msg.error as JsonRpcError));
      } else {
        p.resolve(msg.result);
      }
      return;
    }
    if (method) {
      const set = this.notifications.get(method);
      if (set) for (const cb of set) cb(msg.params);
    }
  }

  async #handleAgentRequest(id: number | string, method: string, params: unknown): Promise<void> {
    const handler = this.agentRequests.get(method);
    if (!handler || this.closed) {
      this.#write({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
      return;
    }
    try {
      const result = await handler(params);
      this.#write({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (error) {
      this.#write({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  #write(msg: Record<string, unknown>): void {
    const child = this.child;
    if (!child || child.stdin.destroyed) return;
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed || !this.child) return Promise.reject(new Error("ACP client not started"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer =
        this.opts.requestTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new Error(`ACP request timeout: ${method}`));
            }, this.opts.requestTimeoutMs)
          : null;
      timer?.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      this.#write({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) });
    });
  }

  notify(method: string, params?: unknown): void {
    this.#write({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) });
  }

  onNotification(method: string, cb: (params: unknown) => void): () => void {
    let set = this.notifications.get(method);
    if (!set) {
      set = new Set();
      this.notifications.set(method, set);
    }
    set.add(cb);
    return () => set!.delete(cb);
  }

  /** Register a handler for agent→client requests (e.g. session/request_permission). */
  onAgentRequest(method: string, handler: AgentRequestHandler): void {
    this.agentRequests.set(method, handler);
  }

  #onExit(): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error("ACP process exited");
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    if (this.closed && !this.child) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(new Error("ACP client closed"));
    }
    this.pending.clear();
    const child = this.child;
    this.child = null;
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* already gone */
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          try {
            child.kill("SIGKILL");
          } catch {
            /* gone */
          }
          resolve();
        }, 3_000);
        t.unref?.();
        child.once("exit", () => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  }
}
