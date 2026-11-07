import { describe, expect, it, vi } from "vitest";

import { ToolTokenManager } from "../../src/browser/tool-token.js";
import { DRAIN_GRACE_MS, REFRESH_LEAD_MS, ToolTokenRefresher } from "../../src/browser/tool-refresh.js";

const SECRET = "ef".repeat(32);
const NOW = 1_800_000_000_000;
const SCOPE = {
  taskId: "task-1",
  profileId: "prof-1",
  backendId: "chrome-extension" as const,
  allowedTools: ["browser.page.click"],
};

function harness() {
  const tokens = ToolTokenManager.forTest(SECRET);
  const notices: Array<{ token: string; expiresAt: number; drainDeadlineAt: number; type: string }> = [];
  let now = NOW;
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  const refresher = new ToolTokenRefresher({
    tokens,
    notify: (n) => notices.push(n),
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { fn, ms, cleared: false };
      timers.push(t);
      return t;
    },
    clearTimer: (h) => {
      (h as { cleared: boolean }).cleared = true;
    },
  });
  return { tokens, notices, timers, refresher, advance: (ms: number) => { now += ms; } };
}

describe("ToolTokenRefresher (P1-09 §9.1)", () => {
  it("issues token on track and schedules refresh at exp-2min", () => {
    const h = harness();
    const { token, expiresAt } = h.refresher.track(SCOPE);
    expect(token).toContain(".");
    expect(expiresAt).toBe(NOW + 15 * 60 * 1000);
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0].ms).toBe(15 * 60 * 1000 - REFRESH_LEAD_MS);
    expect(h.refresher.tokenFor("task-1")).toBe(token);
  });

  it("fires tool.token.refreshed with drain deadline; old token in grace", () => {
    const h = harness();
    const first = h.refresher.track(SCOPE);
    h.advance(13 * 60 * 1000);
    h.timers[0].fn(); // fire refresh

    expect(h.notices).toHaveLength(1);
    const n = h.notices[0];
    expect(n.type).toBe("tool.token.refreshed");
    expect(n.token).not.toBe(first.token);
    // scope preserved — new token verifies against same scope
    const payload = h.tokens.verify(n.token, {
      taskId: "task-1", profileId: "prof-1", backendId: "chrome-extension", tool: "browser.page.click",
    }, NOW + 13 * 60 * 1000);
    expect(payload.taskId).toBe("task-1");
    // jti rotated
    expect(payload.jti).not.toBe(
      h.tokens.verify(first.token, { taskId: "task-1", profileId: "prof-1", backendId: "chrome-extension", tool: "browser.page.click" }, NOW + 1000).jti,
    );
    // drain deadline = previous token exp + 60s grace = issue+TTL+60s
    expect(n.drainDeadlineAt).toBe(first.expiresAt + DRAIN_GRACE_MS);
    // re-armed for next cycle
    expect(h.timers.length).toBe(2);
    expect(h.refresher.tokenFor("task-1")).toBe(n.token);
  });

  it("untrack clears the pending refresh", () => {
    const h = harness();
    h.refresher.track(SCOPE);
    h.refresher.untrack("task-1");
    expect(h.timers[0].cleared).toBe(true);
    expect(h.refresher.tokenFor("task-1")).toBeNull();
  });
});
