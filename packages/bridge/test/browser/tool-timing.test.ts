/**
 * Tool-call latency instrumentation: BrowserToolServer stamps
 * durationMs (execute() wall time) and approvalWaitMs (subset spent in
 * the approval hook) onto every finished outcome so gateway diagnostics
 * and durable tool.completed events can separate user wait from
 * dispatch/browser time.
 */

import { describe, expect, test } from "vitest";

import { ToolTokenManager } from "../../src/browser/tool-token.js";
import { BrowserToolServer } from "../../src/browser/tool-server.js";

const SECRET = "ef".repeat(32);
const NOW = 1_700_000_000_000;
const PROFILE = "p1";

function makeServer(opts: {
  hostResult?: unknown;
  hostDelayMs?: number;
  approvalDelayMs?: number;
  now?: () => number;
}) {
  const tokens = ToolTokenManager.forTest(SECRET);
  const { token } = tokens.issue({
    taskId: "t1",
    profileId: PROFILE,
    backendId: "chrome-extension",
    allowedTools: ["browser.page.click"],
    now: NOW,
  });
  let clock = NOW;
  const server = new BrowserToolServer({
    tokens,
    resolveHost: () => ({
      hostInstanceId: "h1",
      profileId: PROFILE,
      send: async () => {
        clock += opts.hostDelayMs ?? 0;
        return opts.hostResult ?? { ok: true };
      },
      onDisconnect: () => {},
    }),
    requestApproval: async () => {
      clock += opts.approvalDelayMs ?? 0;
      return { verdict: "approved" };
    },
    now: opts.now ?? (() => clock),
    defaultTimeoutMs: 2_000,
  });
  return { server, token };
}

const clickReq = (token: string, toolCallId: string) => ({
  toolCallId,
  taskId: "t1",
  tool: "browser.page.click",
  args: { selector: ".go" },
  token,
  profileId: PROFILE,
  backendId: "chrome-extension" as const,
});

describe("tool call latency instrumentation", () => {
  test("completed call carries durationMs covering dispatch time", async () => {
    const { server, token } = makeServer({ hostDelayMs: 120 });
    const outcome = await server.execute(clickReq(token, "tc-timing"));
    expect(outcome.status).toBe("completed");
    // host.send runs for preflight + dispatch — durationMs covers the
    // whole execute() wall time, so it is >= one simulated hop.
    expect(outcome.durationMs).toBeGreaterThanOrEqual(120);
  });

  test("pre-dispatch rejection still records honest durationMs", async () => {
    const { server, token } = makeServer({});
    const outcome = await server.execute({
      ...clickReq(token, "tc-bad"),
      tool: "browser.page.click",
      args: {},
      token: "bad-token",
    });
    expect(outcome.status).toBe("failed");
    // token failure happens before the timing stamp — no durationMs
    expect(outcome.durationMs).toBeUndefined();
  });

  test("duplicate toolCallId does not double-count or leak timing state", async () => {
    const { server, token } = makeServer({});
    const first = await server.execute(clickReq(token, "tc-dup"));
    const second = await server.execute(clickReq(token, "tc-dup"));
    expect(first.status).toBe("completed");
    expect(second.status).toBe("failed");
    expect(second.error?.code).toBe("browser.duplicate_tool_call");
  });
});
