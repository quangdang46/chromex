/**
 * ADR contract test — docs/adr/tool-token-refresh.md (DECIDED, P1-09).
 *
 * Pins the end-to-end composition the unit tests only cover in pieces:
 *   ToolTokenRefresher ──notify──▶ updateMcpScopeToken ──▶ scope file (0600)
 *        ▲                            │
 *        │                            └─▶ readMcpScopeFile per tools/call
 *        │                                 (mcp-stdio.ts hot-update path)
 *        └── drainDeadlineAt = oldGen.exp + 60s grace ──▶ old jti revoked
 *
 * The notify handler mirrors packages/bridge/src/gateway/main.ts:285-292.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  mcpScopeDir,
  mcpScopePath,
  readMcpScopeFile,
  updateMcpScopeToken,
  writeMcpScopeFile,
  type McpScopeFile,
} from "../../src/browser/mcp-scope.js";
import { DRAIN_GRACE_MS, REFRESH_LEAD_MS, ToolTokenRefresher, type RefreshNotice } from "../../src/browser/tool-refresh.js";
import { ToolTokenManager, TOOL_TOKEN_TTL_MS, type ToolTokenError } from "../../src/browser/tool-token.js";

const SECRET = "ef".repeat(32);
const NOW = 1_800_000_000_000;
const TASK_ID = "01JZZZZZZZZZZZZZZZZZZZZZZZ"; // ULID-shaped
const SCOPE = {
  taskId: TASK_ID,
  profileId: "prof-1",
  backendId: "chrome-extension" as const,
  allowedTools: ["browser.page.click", "browser.page.snapshot"],
};
const EXPECTED = {
  taskId: TASK_ID,
  profileId: "prof-1",
  backendId: "chrome-extension" as const,
  tool: "browser.page.click",
};

let dataDir: string;
beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "chromex-token-adr-"));
});
afterEach(async () => {
  await fs.rm(dataDir, { recursive: true, force: true });
});

interface Harness {
  tokens: ToolTokenManager;
  refresher: ToolTokenRefresher;
  notices: RefreshNotice[];
  timers: Array<{ fn: () => void; ms: number; cleared: boolean }>;
  now: () => number;
  advance: (ms: number) => void;
}

function harness(): Harness {
  const tokens = ToolTokenManager.forTest(SECRET);
  const notices: RefreshNotice[] = [];
  const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
  let now = NOW;
  const refresher = new ToolTokenRefresher({
    tokens,
    // mirrors gateway/main.ts: the ONLY thing the notify handler does is
    // rewrite the scope file — that rewrite IS the hot-update path.
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
  return { tokens, refresher, notices, timers, now: () => now, advance: (ms) => { now += ms; } };
}

/** Gateway spawn path (main.ts:304-319): track + write initial scope file. */
async function spawnScopeFile(h: Harness): Promise<string> {
  const issued = h.refresher.track(SCOPE);
  return writeMcpScopeFile(dataDir, {
    taskId: SCOPE.taskId,
    token: issued.token,
    tokenExpiresAt: issued.expiresAt,
    profileId: SCOPE.profileId,
    backendId: SCOPE.backendId,
    allowedTools: [...SCOPE.allowedTools],
    gatewayEndpoint: "/tmp/gw.sock",
    gatewayTokenFile: path.join(dataDir, "auth", "token"),
  });
}

/** The shim's per-tools/call read seam (mcp-stdio.ts currentScope). */
async function shimCallToken(file: string): Promise<{ token: string; scope: McpScopeFile }> {
  const scope = await readMcpScopeFile(file);
  if (!scope) throw new Error("scope file unreadable");
  return { token: scope.token, scope };
}

function authCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return (err as ToolTokenError).code ?? "unknown";
  }
}

describe("ADR tool-token-refresh: scope file contract", () => {
  it("scope file is 0600 inside a 0700 dir; contents carry token + IPC pointers, never argv", async () => {
    const h = harness();
    const file = await spawnScopeFile(h);

    const dirStat = await fs.stat(mcpScopeDir(dataDir));
    expect(dirStat.mode & 0o777).toBe(0o700);
    const fileStat = await fs.stat(file);
    expect(fileStat.mode & 0o777).toBe(0o600);
    expect(file).toBe(mcpScopePath(dataDir, TASK_ID));
    // filename is the taskId only — token material never appears in argv/path
    expect(path.basename(file)).toBe(`${TASK_ID}.json`);

    const scope = await readMcpScopeFile(file);
    expect(scope).not.toBeNull();
    expect(scope!.taskId).toBe(TASK_ID);
    expect(scope!.token).toContain("."); // signed token, base64url.sig
    expect(scope!.tokenExpiresAt).toBe(NOW + TOOL_TOKEN_TTL_MS);
    expect(scope!.profileId).toBe("prof-1");
    expect(scope!.backendId).toBe("chrome-extension");
    expect(scope!.allowedTools).toEqual([...SCOPE.allowedTools]);
    expect(scope!.gatewayEndpoint).toBe("/tmp/gw.sock");
    expect(scope!.gatewayTokenFile).toBe(path.join(dataDir, "auth", "token"));
    expect(typeof scope!.writtenAt).toBe("number");
  });

  it("updateMcpScopeToken restores 0600 if the file was loosened", async () => {
    const h = harness();
    const file = await spawnScopeFile(h);
    await fs.chmod(file, 0o644);
    expect(await updateMcpScopeToken(dataDir, TASK_ID, "gen-2", NOW + 1000)).toBe(true);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
  });
});

describe("ADR tool-token-refresh: propagation + drain deadline + revocation", () => {
  it("refresh notice rewrites the scope file; next shim call uses the new generation", async () => {
    const h = harness();
    const file = await spawnScopeFile(h);

    // call 1 (before refresh): reads gen-1 token from the file
    const call1 = await shimCallToken(file);
    expect(h.tokens.verify(call1.token, EXPECTED, NOW + 1000).jti).toBeTruthy();

    // advance to refresh lead: exp - 2min
    h.advance(TOOL_TOKEN_TTL_MS - REFRESH_LEAD_MS);
    const refreshTimer = h.timers[0];
    expect(refreshTimer.ms).toBe(TOOL_TOKEN_TTL_MS - REFRESH_LEAD_MS);
    refreshTimer.fn();

    expect(h.notices).toHaveLength(1);
    const notice = h.notices[0];
    expect(notice.type).toBe("tool.token.refreshed");
    expect(notice.taskId).toBe(TASK_ID);
    // drain deadline = previous generation expiry + 60s grace (§9.1)
    expect(notice.drainDeadlineAt).toBe(NOW + TOOL_TOKEN_TTL_MS + DRAIN_GRACE_MS);

    // gateway notify handler: the file rewrite IS the hot-update
    expect(await updateMcpScopeToken(dataDir, TASK_ID, notice.token, notice.expiresAt)).toBe(true);

    // call 2 (after refresh): re-reads the file, picks up gen-2 — no restart
    const call2 = await shimCallToken(file);
    expect(call2.token).toBe(notice.token);
    expect(call2.scope.tokenExpiresAt).toBe(notice.expiresAt);
    // scope fields untouched by the token rewrite
    expect(call2.scope.profileId).toBe("prof-1");
    expect(call2.scope.allowedTools).toEqual([...SCOPE.allowedTools]);
    expect(call2.scope.gatewayEndpoint).toBe("/tmp/gw.sock");
    const payload2 = h.tokens.verify(call2.token, EXPECTED, h.now());
    expect(payload2.jti).not.toBe(h.tokens.verify(call1.token, EXPECTED, NOW + 1000).jti);
    // refresher tracks the new generation for the next cycle
    expect(h.refresher.tokenFor(TASK_ID)).toBe(notice.token);
    expect(h.timers).toHaveLength(2);
    expect(h.timers[0].cleared).toBe(true); // old timer re-armed
  });

  it("drain deadline coincides with old-generation revocation", async () => {
    const h = harness();
    const file = await spawnScopeFile(h);
    const call1 = await shimCallToken(file);
    const gen1Jti = h.tokens.verify(call1.token, EXPECTED, NOW).jti;

    h.advance(TOOL_TOKEN_TTL_MS - REFRESH_LEAD_MS);
    h.timers[0].fn();
    const notice = h.notices[0];
    await updateMcpScopeToken(dataDir, TASK_ID, notice.token, notice.expiresAt);

    // just inside the grace window: old gen still verifies (in-flight drain)
    const insideGrace = notice.drainDeadlineAt - 1;
    h.advance(insideGrace - h.now());
    expect(h.tokens.verify(call1.token, EXPECTED, h.now()).jti).toBe(gen1Jti);

    // at/past drainDeadlineAt the old generation is revoked
    const code = authCode(() => h.tokens.verify(call1.token, EXPECTED, notice.drainDeadlineAt + 1));
    expect(code).toBe("proto.auth_failed");

    // new generation unaffected — hot-update path never interrupted service
    expect(h.tokens.verify(notice.token, EXPECTED, notice.drainDeadlineAt + 1).jti).not.toBe(gen1Jti);
  });

  it("a second refresh propagates again; each call sees the latest file contents", async () => {
    const h = harness();
    const file = await spawnScopeFile(h);

    const tokensSeen: string[] = [];
    for (let cycle = 0; cycle < 2; cycle++) {
      // ride each generation to its refresh point
      const scope = await readMcpScopeFile(file);
      const remaining = (scope!.tokenExpiresAt - REFRESH_LEAD_MS) - h.now();
      h.advance(remaining);
      const pending = h.timers.filter((t) => !t.cleared).at(-1)!;
      pending.fn();
      const notice = h.notices.at(-1)!;
      await updateMcpScopeToken(dataDir, TASK_ID, notice.token, notice.expiresAt);
      tokensSeen.push((await shimCallToken(file)).token);
    }
    expect(h.notices).toHaveLength(2);
    expect(tokensSeen[0]).not.toBe(tokensSeen[1]);
    expect(tokensSeen[1]).toBe(h.refresher.tokenFor(TASK_ID));
    // both generations verify for their own scopes at issue time
    expect(h.tokens.verify(tokensSeen[1], EXPECTED, h.now())).toBeTruthy();
  });

  it("untrack stops refresh notices — revoked task gets no further generations", async () => {
    const h = harness();
    const file = await spawnScopeFile(h);
    h.refresher.untrack(TASK_ID);
    h.advance(TOOL_TOKEN_TTL_MS + 1); // past expiry; no successor → no grace
    // no pending timer fired: file still holds the original (now stale) token
    const scope = await readMcpScopeFile(file);
    expect(scope!.token).toContain(".");
    expect(h.notices).toHaveLength(0);
    // and the stale token is dead — no grace without a successor generation
    expect(authCode(() => h.tokens.verify(scope!.token, EXPECTED, h.now()))).toBe("proto.auth_failed");
  });

  it("scope file rejects malformed contents — shim fails closed", async () => {
    const h = harness();
    const file = await spawnScopeFile(h);
    await fs.writeFile(file, JSON.stringify({ taskId: TASK_ID }), { mode: 0o600 });
    expect(await readMcpScopeFile(file)).toBeNull();
    // mcp-stdio.ts currentScope() exits the process on this; here we pin
    // the read-side contract that makes that fail-closed. The tool set is
    // fixed at spawn — refresh never changes allowedTools.
  });
});
