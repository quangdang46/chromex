/**
 * P1.6 dispatch lifecycle: transport loss AFTER dispatch must surface
 * as `unknown` + browser.host_lost_after_dispatch — the action may
 * have run host-side, so a guessed `failed` invites a retry into a
 * double-submit. Only ipc.disconnected maps there; tool-level and
 * other transport errors stay `failed`.
 */

import { describe, expect, test } from "vitest";

import { ToolTokenManager } from "../../src/browser/tool-token.js";
import { BrowserToolServer } from "../../src/browser/tool-server.js";

const SECRET = "cd".repeat(32);
const NOW = 1_700_000_000_000;
const PROFILE = "p1";

function makeServer(send: () => Promise<unknown>) {
  const tokens = ToolTokenManager.forTest(SECRET);
  const { token } = tokens.issue({
    taskId: "t1",
    profileId: PROFILE,
    backendId: "chrome-extension",
    allowedTools: ["browser.page.click"],
    now: NOW,
  });
  const server = new BrowserToolServer({
    tokens,
    resolveHost: () => ({
      hostInstanceId: "h1",
      profileId: PROFILE,
      send,
      onDisconnect: () => {},
    }),
    requestApproval: async () => ({ verdict: "approved" }),
    now: () => NOW,
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

describe("host loss after dispatch (P1.6)", () => {
  test("ipc.disconnected → unknown + browser.host_lost_after_dispatch", async () => {
    const { server, token } = makeServer(() =>
      Promise.reject(Object.assign(new Error("connection closed"), { code: "ipc.disconnected" })),
    );
    const outcome = await server.execute(clickReq(token, "tc-lost"));
    expect(outcome.status).toBe("unknown");
    expect(outcome.error?.code).toBe("browser.host_lost_after_dispatch");
  });

  test("coded tool error stays failed with its own code", async () => {
    const { server, token } = makeServer(() =>
      Promise.reject(Object.assign(new Error("nope"), { code: "browser.backend_unavailable" })),
    );
    const outcome = await server.execute(clickReq(token, "tc-coded"));
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("browser.backend_unavailable");
  });

  test("uncoded transport error stays failed/browser.host_error", async () => {
    const { server, token } = makeServer(() => Promise.reject(new Error("socket hangup")));
    const outcome = await server.execute(clickReq(token, "tc-uncoded"));
    expect(outcome.status).toBe("failed");
    expect(outcome.error?.code).toBe("browser.host_error");
  });
});
