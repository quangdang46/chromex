/**
 * Spawnable MCP stdio entrypoint — plan §9.3 / P1-09.
 *
 * Launched BY the provider (e.g. codex app-server mcp_servers config)
 * as: `node dist/browser/mcp-stdio.js` with env
 * CHROMEX_MCP_SCOPE_FILE=<path> (0600 JSON written by the Gateway).
 *
 * Scope file contents (never in argv/env — ps is world-readable),
 * re-read on every tools/call so `tool.token.refreshed` hot-updates:
 *   { taskId, token, tokenExpiresAt, profileId, backendId,
 *     allowedTools[], gatewayEndpoint, gatewayTokenFile }
 *
 * Tool calls are forwarded to the Gateway as `browser.tool.call` RPCs
 * over the IPC socket; the Gateway re-verifies token/scope/dedup —
 * this process is a thin transport, not a trust boundary.
 */

import net from "node:net";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

import { serveMcpStdio, type McpScope, type McpServerDeps } from "./mcp-server.js";
import type { ToolCallOutcome, ToolCallRequest } from "./tool-server.js";
import { readMcpScopeFile, type McpScopeFile } from "./mcp-scope.js";

function fail(msg: string): never {
  process.stderr.write(`chromex-browser-mcp: ${msg}\n`);
  process.exit(1);
}

const scopePath = process.env.CHROMEX_MCP_SCOPE_FILE;
if (!scopePath) fail("CHROMEX_MCP_SCOPE_FILE not set");

// Scope is re-read per tools/call — token refresh rewrites the file
// and the next call picks up the new generation without a restart.
let cachedIpc: { endpoint: string; tokenFile: string; ipc: GatewayIpc } | null = null;

async function currentScope(): Promise<McpScopeFile> {
  const scope = await readMcpScopeFile(scopePath!);
  if (
    !scope ||
    typeof scope.taskId !== "string" ||
    typeof scope.token !== "string" ||
    !scope.gatewayEndpoint ||
    !scope.gatewayTokenFile
  ) {
    fail("scope file missing required fields");
  }
  return scope;
}

function ipcFor(scope: McpScopeFile): GatewayIpc {
  if (
    !cachedIpc ||
    cachedIpc.endpoint !== scope.gatewayEndpoint ||
    cachedIpc.tokenFile !== scope.gatewayTokenFile
  ) {
    cachedIpc = {
      endpoint: scope.gatewayEndpoint,
      tokenFile: scope.gatewayTokenFile,
      ipc: new GatewayIpc(scope.gatewayEndpoint, scope.gatewayTokenFile),
    };
  }
  return cachedIpc.ipc;
}

// ---- minimal framed IPC client (uint32-LE length prefix, same as
// ipc-server/native-host framing) ----

const FRAME_HEADER = 4;

class GatewayIpc {
  #socket: net.Socket | null = null;
  #buf = Buffer.alloc(0);
  #pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout }
  >();
  // hello is per-CONNECTION: the gateway allows exactly one hello per
  // socket and demands it first. A cached promise is not enough — the
  // socket can die and reconnect underneath us (gateway restart), and
  // a rejected hello must not poison every later request.
  #helloedSocket: net.Socket | null = null;
  #helloInflight = new Map<net.Socket, Promise<void>>();
  readonly #tokenFile: string;
  currentTaskId = "";
  currentProfileId = "";

  constructor(
    private readonly endpoint: string,
    tokenFile: string,
  ) {
    this.#tokenFile = tokenFile;
  }

  #readToken(): string {
    try {
      return fs.readFileSync(this.#tokenFile, "utf8").trim();
    } catch {
      return "";
    }
  }

  #connect(): Promise<net.Socket> {
    if (this.#socket && !this.#socket.destroyed) return Promise.resolve(this.#socket);
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.endpoint);
      sock.once("error", reject);
      sock.once("connect", () => {
        sock.off("error", reject);
        sock.on("error", () => this.#failAll(new Error("ipc socket error")));
        sock.on("data", (d) => this.#onData(d));
        sock.on("close", () => this.#failAll(new Error("ipc socket closed")));
        this.#socket = sock;
        resolve(sock);
      });
    });
  }

  #failAll(err: Error): void {
    for (const p of this.#pending.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.reject(err);
    }
    this.#pending.clear();
    this.#socket = null;
    this.#helloedSocket = null;
  }

  #onData(d: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, d]);
    for (;;) {
      if (this.#buf.length < FRAME_HEADER) return;
      const len = this.#buf.readUInt32LE(0);
      if (this.#buf.length < FRAME_HEADER + len) return;
      const body = this.#buf.subarray(FRAME_HEADER, FRAME_HEADER + len);
      this.#buf = this.#buf.subarray(FRAME_HEADER + len);
      let env: { kind?: string; id?: string; result?: unknown; error?: { code?: string; message?: string } };
      try {
        env = JSON.parse(body.toString("utf8"));
      } catch {
        continue;
      }
      if (env.kind === "response" && typeof env.id === "string") {
        const p = this.#pending.get(env.id);
        if (!p) continue;
        this.#pending.delete(env.id);
        if (p.timer) clearTimeout(p.timer);
        if (env.error) {
          p.reject(new Error(`${env.error.code ?? "error"}: ${env.error.message ?? ""}`));
        } else {
          p.resolve(env.result);
        }
      }
    }
  }

  #send(sock: net.Socket, env: unknown): void {
    const body = Buffer.from(JSON.stringify(env), "utf8");
    const frame = Buffer.alloc(FRAME_HEADER + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, FRAME_HEADER);
    sock.write(frame);
  }

  #helloOnce(sock: net.Socket): Promise<void> {
    let p = this.#helloInflight.get(sock);
    if (!p) {
      p = (async () => {
        const id = `hello-${randomUUID()}`;
        await new Promise<void>((resolve, reject) => {
          this.#pending.set(id, {
            resolve: () => resolve(),
            reject,
          });
          this.#send(sock, {
            v: 1,
            kind: "request",
            id,
            method: "hello",
            payload: {
              protocolVersion: 1,
              clientVersion: "chromex-browser-mcp/0.1.0",
              clientId: `mcp-${this.currentTaskId}`,
              profileId: this.currentProfileId,
              browserInstanceId: null,
              hostInstanceId: "",
              token: this.#readToken(),
            },
          });
        });
        this.#helloedSocket = sock;
      })().finally(() => {
        this.#helloInflight.delete(sock);
      });
      this.#helloInflight.set(sock, p);
    }
    return p;
  }

  async #ensureHello(): Promise<void> {
    for (;;) {
      const sock = await this.#connect();
      if (this.#helloedSocket === sock) return;
      try {
        await this.#helloOnce(sock);
        return;
      } catch (err) {
        // Socket died mid-hello → loop re-hellos on the new conn.
        // A live socket that rejected hello is a real error — surface it.
        if (this.#socket === sock && !sock.destroyed) throw err;
      }
    }
  }

  async request(method: string, payload: unknown, timeoutMs = 120_000): Promise<unknown> {
    await this.#ensureHello();
    const sock = await this.#connect();
    const id = `req-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      const entry: { resolve: (v: unknown) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout } = {
        resolve,
        reject,
      };
      // Gateway-side calls have their own timeouts, but a wedged gateway
      // must not hang the MCP child forever — bound the wait and free
      // the pending slot.
      entry.timer = setTimeout(() => {
        if (this.#pending.delete(id)) {
          reject(new Error(`ipc request ${method} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);
      entry.timer.unref?.();
      this.#pending.set(id, entry);
      this.#send(sock, { v: 1, kind: "request", id, method, payload });
    });
  }
}

// McpServerDeps.scope is fixed at construction, but our scope file can
// be rewritten by token refresh — wrap execute so each call re-reads
// scope and rebuilds the request. tools/list uses the initial scope's
// allowedTools (refresh never changes the tool set).
const initialScope = await currentScope();
const ipc = ipcFor(initialScope);
ipc.currentTaskId = initialScope.taskId;
ipc.currentProfileId = initialScope.profileId;

const deps: McpServerDeps = {
  scope: {
    taskId: initialScope.taskId,
    token: initialScope.token,
    profileId: initialScope.profileId,
    backendId: initialScope.backendId,
  },
  allowedTools: new Set(initialScope.allowedTools),
  server: {
    async execute(req: ToolCallRequest): Promise<ToolCallOutcome> {
      try {
        const scope = await currentScope();
        ipc.currentTaskId = scope.taskId;
        ipc.currentProfileId = scope.profileId;
        const result = (await ipcFor(scope).request("browser.tool.call", {
          taskId: scope.taskId,
          toolCallId: req.toolCallId,
          tool: req.tool,
          args: req.args,
          token: scope.token,
        })) as ToolCallOutcome;
        return result;
      } catch (err) {
        return {
          status: "failed",
          toolCallId: req.toolCallId,
          tool: req.tool,
          error: {
            code: "gateway.unavailable",
            message: err instanceof Error ? err.message : String(err),
          },
        };
      }
    },
  },
};

serveMcpStdio(deps);
