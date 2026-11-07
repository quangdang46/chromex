/**
 * MCP stdio server for browser tools — plan §9.3 / P1-09, ADR
 * docs/adr/mcp-endpoint.md.
 *
 * One MCP process per provider session. Speaks newline-delimited
 * JSON-RPC 2.0 over stdio: initialize / notifications/initialized /
 * ping / tools/list / tools/call.
 *
 * Scope is fixed at spawn: the Gateway passes taskId/profileId/
 * backendId + the signed tool token via environment (documented
 * limitation — argv is world-readable; env is redacted in diagnostics).
 * Every tools/call re-verifies the token signature/scope/expiry inside
 * BrowserToolServer before dispatch.
 *
 * Tool name map (one-directional, tested):
 *   browser.page.click → browser_page_click  (dots → underscores)
 */

import type { BrowserBackendId } from "@codex-sidepanel/shared";

import type { BrowserToolServer, ToolCallOutcome, ToolCallRequest } from "./tool-server.js";
import { BROWSER_TOOL_NAMES, type BrowserToolName } from "@codex-sidepanel/shared";

export const MCP_SERVER_NAME = "chromex-browser-tools";
export const MCP_SERVER_VERSION = "0.1.0";

export function mcpToolName(internal: BrowserToolName): string {
  return internal.replace(/\./g, "_");
}

export function internalToolName(mcp: string): BrowserToolName | null {
  const candidate = mcp.replace(/_/g, ".") as BrowserToolName;
  return (BROWSER_TOOL_NAMES as readonly string[]).includes(candidate) ? candidate : null;
}

export interface McpScope {
  taskId: string;
  profileId: string;
  backendId: BrowserBackendId;
  token: string;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

export interface McpStdio {
  onLine: (cb: (line: string) => void) => void;
  write: (line: string) => void;
}

export interface McpServerDeps {
  scope: McpScope;
  server: Pick<BrowserToolServer, "execute">;
  /** tool names the session's token allows (from token payload) */
  allowedTools: ReadonlySet<string>;
}

const PROTOCOL_VERSION = "2024-11-05";

export class BrowserMcpServer {
  readonly #deps: McpServerDeps;
  #nextId = 1;

  constructor(deps: McpServerDeps) {
    this.#deps = deps;
  }

  /** Handle one JSON-RPC message line; resolves to a response line or
   *  null (notifications get no response). Async because tools/call
   *  awaits the tool server. */
  async handleLine(line: string): Promise<string | null> {
    let msg: JsonRpcRequest;
    try {
      msg = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return this.#err(null, -32700, "parse error");
    }
    if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      return this.#err(msg.id ?? null, -32600, "invalid request");
    }
    const isNotification = msg.id === undefined || msg.id === null;

    switch (msg.method) {
      case "initialize":
        return this.#ok(msg.id ?? null, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        });
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        return isNotification ? null : this.#ok(msg.id ?? null, {});
      case "tools/list":
        return this.#ok(msg.id ?? null, {
          tools: [...this.#deps.allowedTools]
            .map(internalToolName)
            .filter((t): t is BrowserToolName => t !== null)
            .map((t) => ({
              name: mcpToolName(t),
              description: `Chromex browser tool: ${t}`,
              inputSchema: { type: "object", additionalProperties: true },
            })),
        });
      case "tools/call":
        return await this.#toolCall(msg);
      default:
        return isNotification ? null : this.#err(msg.id ?? null, -32601, `method not found: ${msg.method}`);
    }
  }

  async #toolCall(msg: JsonRpcRequest): Promise<string | null> {
    const params = msg.params ?? {};
    const name = typeof params.name === "string" ? params.name : "";
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const internal = internalToolName(name);
    if (!internal) {
      return this.#toolError(msg.id ?? null, `unknown tool: ${name}`);
    }
    const toolCallId = `mcp-${this.#nextId++}-${Date.now()}`;
    const req: ToolCallRequest = {
      toolCallId,
      taskId: this.#deps.scope.taskId,
      tool: internal,
      args,
      token: this.#deps.scope.token,
      profileId: this.#deps.scope.profileId,
      backendId: this.#deps.scope.backendId,
    };
    const outcome: ToolCallOutcome = await this.#deps.server.execute(req);
    if (outcome.status === "completed") {
      return this.#ok(msg.id ?? null, {
        content: [{ type: "text", text: JSON.stringify(outcome.result ?? null) }],
        isError: false,
      });
    }
    return this.#toolError(
      msg.id ?? null,
      `${outcome.error?.code ?? outcome.status}: ${outcome.error?.message ?? outcome.status}`,
    );
  }

  #ok(id: string | number | null, result: unknown): string {
    return JSON.stringify({ jsonrpc: "2.0", id, result });
  }

  #err(id: string | number | null, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
  }

  #toolError(id: string | number | null, message: string): string {
    return this.#ok(id, {
      content: [{ type: "text", text: message }],
      isError: true,
    });
  }
}

/** Wire a BrowserMcpServer to real stdio (line-delimited JSON-RPC). */
export function serveMcpStdio(deps: McpServerDeps): void {
  const server = new BrowserMcpServer(deps);
  let buf = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      void server.handleLine(line).then((resp) => {
        if (resp !== null) process.stdout.write(resp + "\n");
      });
    }
  });
}
