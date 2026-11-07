/**
 * S7 regression — approval-gated browser action must resume the SAME
 * pending tool call after `permission.respond`, execute on the host,
 * and leave the host usable for subsequent calls. Denial must fail
 * promptly with browser.approval_denied and never reach the host.
 *
 * The host-selection half of the bug (zombie native-host conn winning
 * resolveHost after an SW restart) is covered in host-registry.test.ts.
 */

import { describe, expect, test } from "vitest";

import { ToolTokenManager } from "../../src/browser/tool-token.js";
import { BrowserToolServer } from "../../src/browser/tool-server.js";
import type { ToolHostChannel } from "../../src/browser/tool-server.js";

const SECRET = "ef".repeat(32);
const NOW = 1_700_000_000_000;

const GATED_URL = "https://auth.example.com/accounts"; // financial origin → needsApproval

function makeServer(opts: { approvalVerdicts: Array<"approved" | "denied"> }) {
  const tokens = ToolTokenManager.forTest(SECRET);
  const { token } = tokens.issue({
    taskId: "task-1",
    profileId: "profile-1",
    backendId: "chrome-extension",
    allowedTools: ["browser.page.navigate", "browser.tabs.list"],
    now: NOW,
  });
  const sent: Array<{ method: string; payload: unknown }> = [];
  const host: ToolHostChannel = {
    hostInstanceId: "h1",
    send: (method, payload) => {
      sent.push({ method, payload });
      return Promise.resolve({ ok: true, resolvedTabId: 3 });
    },
    onDisconnect: () => {},
  };
  const approvalCalls: string[] = [];
  let i = 0;
  const server = new BrowserToolServer({
    tokens,
    resolveHost: () => host,
    requestApproval: async (ctx) => {
      approvalCalls.push(ctx.tool);
      const verdict = opts.approvalVerdicts[Math.min(i++, opts.approvalVerdicts.length - 1)]!;
      return { verdict };
    },
    now: () => NOW,
    defaultTimeoutMs: 2_000,
  });
  return { server, token, sent, approvalCalls };
}

const navigateReq = (token: string, toolCallId: string) => ({
  toolCallId,
  taskId: "task-1",
  tool: "browser.page.navigate",
  args: { url: GATED_URL },
  token,
  profileId: "profile-1",
  backendId: "chrome-extension" as const,
});

const tabsListReq = (token: string, toolCallId: string) => ({
  toolCallId,
  taskId: "task-1",
  tool: "browser.tabs.list",
  args: {},
  token,
  profileId: "profile-1",
  backendId: "chrome-extension" as const,
});

describe("S7 approval resume (browser_action)", () => {
  test("deny → browser.approval_denied, host never dispatched", async () => {
    const { server, token, sent, approvalCalls } = makeServer({ approvalVerdicts: ["denied"] });
    const out = await server.execute(navigateReq(token, "tc-deny"));
    expect(out.status).toBe("failed");
    expect(out.error?.code).toBe("browser.approval_denied");
    expect(approvalCalls).toEqual(["browser.page.navigate"]);
    expect(sent).toHaveLength(0);
  });

  test("allow_once → original call resumes, executes, returns result", async () => {
    const { server, token, sent } = makeServer({ approvalVerdicts: ["approved"] });
    const out = await server.execute(navigateReq(token, "tc-allow"));
    expect(out.status).toBe("completed");
    expect(out.result).toMatchObject({ ok: true });
    // exactly one dispatch — the SAME toolCallId, no duplicate execution
    expect(sent).toHaveLength(1);
    expect(sent[0]!.method).toBe("browser.tool.request");
    expect((sent[0]!.payload as { toolCallId: string }).toolCallId).toBe("tc-allow");
    expect((sent[0]!.payload as { tool: string }).tool).toBe("browser.page.navigate");
  });

  test("allow on one call does not break subsequent host calls", async () => {
    const { server, token, sent } = makeServer({ approvalVerdicts: ["approved"] });
    const first = await server.execute(navigateReq(token, "tc-1"));
    expect(first.status).toBe("completed");
    // host must still answer after the approved call resolved
    const second = await server.execute(tabsListReq(token, "tc-2"));
    expect(second.status).toBe("completed");
    expect(sent.map((s) => (s.payload as { tool: string }).tool)).toEqual([
      "browser.page.navigate",
      "browser.tabs.list",
    ]);
  });

  test("deny then allow: denied call stays failed, approved call still executes", async () => {
    const { server, token, sent } = makeServer({ approvalVerdicts: ["denied", "approved"] });
    const denied = await server.execute(navigateReq(token, "tc-d"));
    expect(denied.error?.code).toBe("browser.approval_denied");
    const allowed = await server.execute(navigateReq(token, "tc-a"));
    expect(allowed.status).toBe("completed");
    expect(sent).toHaveLength(1);
  });
});
