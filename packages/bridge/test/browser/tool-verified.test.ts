/**
 * chromex-0fza: BrowserToolServer must propagate the host/backend's
 * honest `verified` verdict (true | false | "unknown") into the
 * ToolCallOutcome — and must NOT optimistically mark every completed
 * call verified:true. Absent verdict → undefined → tool.completed
 * records "unknown" downstream (gateway/main.ts).
 */

import { describe, expect, test } from "vitest";

import { ToolTokenManager } from "../../src/browser/tool-token.js";
import { BrowserToolServer } from "../../src/browser/tool-server.js";

const SECRET = "cd".repeat(32);
const NOW = 1_700_000_000_000;
const PROFILE = "p1";

function makeServer(hostResult: unknown) {
  const tokens = ToolTokenManager.forTest(SECRET);
  const { token } = tokens.issue({
    taskId: "t1",
    profileId: PROFILE,
    backendId: "chrome-extension",
    allowedTools: ["browser.page.click", "browser.page.snapshot"],
    now: NOW,
  });
  const server = new BrowserToolServer({
    tokens,
    resolveHost: () => ({
      hostInstanceId: "h1",
      profileId: PROFILE,
      send: async () => hostResult,
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

describe("tool server verified passthrough (chromex-0fza)", () => {
  test("host verified:true/false/\"unknown\" reach the outcome unchanged", async () => {
    for (const [i, verdict] of [true, false, "unknown"].entries()) {
      const { server, token } = makeServer({ ok: true, verified: verdict });
      const outcome = await server.execute(clickReq(token, `tc-${i}`));
      expect(outcome.status).toBe("completed");
      expect(outcome.verified).toBe(verdict);
    }
  });

  test("no verified field → outcome.verified stays undefined (recorded unknown, not true)", async () => {
    const { server, token } = makeServer({ ok: true, resolvedTabId: 7 });
    const outcome = await server.execute(clickReq(token, "tc-none"));
    expect(outcome.status).toBe("completed");
    expect(outcome.verified).toBeUndefined();
  });
});
