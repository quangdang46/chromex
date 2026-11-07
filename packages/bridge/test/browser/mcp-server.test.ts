import { describe, expect, it } from "vitest";

import {
  BrowserMcpServer,
  internalToolName,
  mcpToolName,
  type McpScope,
} from "../../src/browser/mcp-server.js";
import { ToolTokenManager } from "../../src/browser/tool-token.js";
import type { ToolCallOutcome, ToolCallRequest } from "../../src/browser/tool-server.js";
import { BROWSER_TOOL_NAMES } from "@codex-sidepanel/shared";

const SECRET = "12".repeat(32);
const NOW = 1_800_000_000_000;

function setup(allowed: string[]) {
  const tokens = ToolTokenManager.forTest(SECRET);
  const scope: McpScope = {
    taskId: "task-1",
    profileId: "prof-1",
    backendId: "chrome-extension",
    token: tokens.issue({
      taskId: "task-1",
      profileId: "prof-1",
      backendId: "chrome-extension",
      allowedTools: allowed,
      now: NOW,
    }).token,
  };
  const calls: ToolCallRequest[] = [];
  const server = new BrowserMcpServer({
    scope,
    allowedTools: new Set(allowed),
    server: {
      execute: async (req: ToolCallRequest): Promise<ToolCallOutcome> => {
        calls.push(req);
        if (!allowed.includes(req.tool)) {
          return { toolCallId: req.toolCallId, tool: req.tool, status: "failed", error: { code: "browser.tool_not_allowed", message: "out of scope" } };
        }
        return { toolCallId: req.toolCallId, tool: req.tool, status: "completed", result: { ok: true }, verified: true };
      },
    },
  });
  return { server, calls, scope };
}

const rpc = (id: number, method: string, params?: unknown) =>
  JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });

describe("BrowserMcpServer (P1-09 §9.3)", () => {
  it("name map is one-directional and total", () => {
    for (const t of BROWSER_TOOL_NAMES) {
      expect(internalToolName(mcpToolName(t))).toBe(t);
      expect(mcpToolName(t)).not.toContain(".");
    }
    expect(internalToolName("browser_evaluate")).toBeNull();
    expect(mcpToolName("browser.page.click")).toBe("browser_page_click");
  });

  it("initialize + tools/list advertises only allowed tools", async () => {
    const { server } = setup(["browser.page.click", "browser.page.snapshot"]);
    const init = JSON.parse((await server.handleLine(rpc(1, "initialize", { protocolVersion: "2024-11-05" })))!) as {
      result: { serverInfo: { name: string } };
    };
    expect(init.result.serverInfo.name).toBe("chromex-browser-tools");

    const list = JSON.parse((await server.handleLine(rpc(2, "tools/list")))!) as {
      result: { tools: Array<{ name: string }> };
    };
    expect(list.result.tools.map((t) => t.name).sort()).toEqual([
      "browser_page_click",
      "browser_page_snapshot",
    ]);
    // notifications get no response
    expect(await server.handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }))).toBeNull();
  });

  it("tools/call maps name, forwards scope, returns result", async () => {
    const { server, calls, scope } = setup(["browser.page.click"]);
    const resp = JSON.parse(
      (await server.handleLine(rpc(3, "tools/call", { name: "browser_page_click", arguments: { ref: "e1" } })))!,
    ) as { result: { content: Array<{ text: string }>; isError: boolean } };
    expect(resp.result.isError).toBe(false);
    expect(JSON.parse(resp.result.content[0].text)).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].tool).toBe("browser.page.click");
    expect(calls[0].taskId).toBe(scope.taskId);
    expect(calls[0].token).toBe(scope.token);
    expect(calls[0].profileId).toBe("prof-1");
  });

  it("unknown tool and disallowed tool produce isError, not protocol error", async () => {
    const { server } = setup(["browser.page.click"]);
    const bad = JSON.parse(
      (await server.handleLine(rpc(4, "tools/call", { name: "browser_evaluate", arguments: {} })))!,
    ) as { result: { isError: boolean } };
    expect(bad.result.isError).toBe(true);
    const denied = JSON.parse(
      (await server.handleLine(rpc(5, "tools/call", { name: "browser_page_fill", arguments: {} })))!,
    ) as { result: { isError: boolean; content: Array<{ text: string }> } };
    // browser_page_fill IS a valid internal name; server.execute will
    // reject via token scope (allowedTools) — surfaced as isError.
    expect(denied.result.isError).toBe(true);
  });

  it("invalid JSON → parse error; unknown method → method not found", async () => {
    const { server } = setup([]);
    const parseErr = JSON.parse((await server.handleLine("not json"))!) as { error: { code: number } };
    expect(parseErr.error.code).toBe(-32700);
    const nf = JSON.parse((await server.handleLine(rpc(9, "bogus/method")))!) as { error: { code: number } };
    expect(nf.error.code).toBe(-32601);
  });
});
