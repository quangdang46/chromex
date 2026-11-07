import { describe, expect, it } from "vitest";

import { canonicalJson, ToolTokenError, ToolTokenManager, TOOL_TOKEN_TTL_MS } from "../../src/browser/tool-token.js";
import { BrowserToolServer, buildActionContext, browserActionDigest, HARD_BLOCKED_TOOLS } from "../../src/browser/tool-server.js";
import { classifyActionRisk } from "@codex-sidepanel/shared";
import type { ToolHostChannel } from "../../src/browser/tool-server.js";

const SECRET = "ab".repeat(32);
const NOW = 1_700_000_000_000;

function issue(tokens: ToolTokenManager, over: Partial<Parameters<ToolTokenManager["issue"]>[0]> = {}) {
  return tokens.issue({
    taskId: "task-1",
    profileId: "profile-1",
    backendId: "chrome-extension",
    allowedTools: ["browser.page.click", "browser.page.snapshot"],
    now: NOW,
    ...over,
  });
}

const EXPECTED = { taskId: "task-1", profileId: "profile-1", backendId: "chrome-extension" as const, tool: "browser.page.click" };

describe("canonicalJson", () => {
  it("sorts keys by codepoint and strips whitespace", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it("normalizes strings to NFC", () => {
    const nfd = "é"; // e + combining acute
    expect(canonicalJson({ s: nfd })).toBe(canonicalJson({ s: nfd.normalize("NFC") }));
  });
});

describe("ToolTokenManager", () => {
  it("issues a verifiable signed token", () => {
    const tokens = ToolTokenManager.forTest(SECRET);
    const { token } = issue(tokens);
    const payload = tokens.verify(token, EXPECTED, NOW + 1000);
    expect(payload.taskId).toBe("task-1");
    expect(payload.jti).toBeTruthy();
  });

  it("rejects tampered payload and wrong secret", () => {
    const tokens = ToolTokenManager.forTest(SECRET);
    const { token } = issue(tokens);
    const [body, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ v: 1, taskId: "task-2", profileId: "p", backendId: "chrome-extension", allowedTools: ["browser.page.click"], iat: NOW, exp: NOW + TOOL_TOKEN_TTL_MS, jti: "x" })).toString("base64url");
    expect(() => tokens.verify(`${forged}.${sig}`, EXPECTED, NOW)).toThrow(ToolTokenError);
    expect(() => ToolTokenManager.forTest("cd".repeat(32)).verify(token, EXPECTED, NOW)).toThrow(ToolTokenError);
    void body;
  });

  it("rejects expired token; previous generation survives grace window", () => {
    const tokens = ToolTokenManager.forTest(SECRET);
    const first = issue(tokens);
    const second = issue(tokens, { now: NOW + TOOL_TOKEN_TTL_MS + 30_000 }); // rotates jti, fresh expiry
    // first token: exp passed but inside 60s grace window
    expect(() => tokens.verify(first.token, EXPECTED, NOW + TOOL_TOKEN_TTL_MS + 30_000)).not.toThrow();
    expect(() => tokens.verify(first.token, EXPECTED, NOW + TOOL_TOKEN_TTL_MS + 90_000)).toThrow(ToolTokenError);
    expect(tokens.verify(second.token, EXPECTED, NOW + TOOL_TOKEN_TTL_MS + 31_000)).toBeTruthy();
  });

  it("enforces scope: taskId/profileId/backendId/tool", () => {
    const tokens = ToolTokenManager.forTest(SECRET);
    const { token } = issue(tokens);
    expect(() => tokens.verify(token, { ...EXPECTED, taskId: "other" }, NOW)).toThrow(/taskId/);
    expect(() => tokens.verify(token, { ...EXPECTED, profileId: "other" }, NOW)).toThrow(/profileId/);
    expect(() => tokens.verify(token, { ...EXPECTED, backendId: "playwright-isolated" }, NOW)).toThrow(/backendId/);
    expect(() => tokens.verify(token, { ...EXPECTED, tool: "browser.page.fill" }, NOW)).toThrow(/not in scope/);
  });
});

function makeServer(over: Partial<ConstructorParameters<typeof BrowserToolServer>[0]> = {}) {
  const tokens = ToolTokenManager.forTest(SECRET);
  const { token } = issue(tokens);
  const outcomes: unknown[] = [];
  const server = new BrowserToolServer({
    tokens,
    resolveHost: () => null,
    onOutcome: (o) => outcomes.push(o),
    now: () => NOW,
    ...over,
  });
  return { server, token, outcomes };
}

const REQ = { toolCallId: "tc-1", taskId: "task-1", profileId: "profile-1", tool: "browser.page.click", args: {}, token: "" };

describe("BrowserToolServer", () => {
  it("fails closed with no_host when no host registered", async () => {
    const { server, token } = makeServer();
    const out = await server.execute({ ...REQ, token });
    expect(out.status).toBe("failed");
    expect(out.error?.code).toBe("browser.no_host");
  });

  it("hard-blocks evaluate/cookies/localStorage/download", async () => {
    // token must scope-allow the tools for the hard block to be reached
    const tokens = ToolTokenManager.forTest(SECRET);
    const { token } = issue(tokens, { allowedTools: [...HARD_BLOCKED_TOOLS] });
    const server = new BrowserToolServer({ tokens, resolveHost: () => null, now: () => NOW });
    for (const tool of HARD_BLOCKED_TOOLS) {
      const out = await server.execute({ ...REQ, toolCallId: `tc-${tool}`, tool: tool as never, token });
      expect(out.error?.code).toBe("browser.tool_blocked");
    }
  });

  it("dedups toolCallId — second execute returns duplicate error", async () => {
    const tokens = ToolTokenManager.forTest(SECRET);
    const { token } = issue(tokens);
    const host: ToolHostChannel = {
      hostInstanceId: "h1",
      send: async () => ({ ok: true }),
      onDisconnect: () => {},
    };
    const s2 = new BrowserToolServer({ tokens, resolveHost: () => host, requestApproval: async () => ({ verdict: "approved" as const }), now: () => NOW });
    const first = await s2.execute({ ...REQ, token });
    expect(first.status).toBe("completed");
    const second = await s2.execute({ ...REQ, token });
    expect(second.error?.code).toBe("browser.duplicate_tool_call");
  });

  it("cancelForTask propagates browser.tool.cancel and resolves unknown (P2-06)", async () => {
    const tokens = ToolTokenManager.forTest(SECRET);
    const { token } = issue(tokens, { allowedTools: ["browser.page.snapshot"] });
    const sent: string[] = [];
    const host: ToolHostChannel = {
      hostInstanceId: "h1",
      send: (method) => {
        sent.push(method);
        return method === "browser.tool.request" ? new Promise(() => {}) : Promise.resolve({ ok: true });
      },
      onDisconnect: () => {},
    };
    const s2 = new BrowserToolServer({ tokens, resolveHost: () => host, now: () => NOW });
    const pending = s2.execute({ ...REQ, toolCallId: "tc-cancel", tool: "browser.page.snapshot", token });
    await new Promise((r) => setTimeout(r, 0)); // let dispatch register
    const outcomes = s2.cancelForTask("task-1");
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]!.status).toBe("unknown"); // stop unconfirmed
    expect(outcomes[0]!.error?.code).toBe("browser.cancel_unconfirmed");
    expect(sent).toContain("browser.tool.cancel");
    const result = await pending;
    expect(result.status).toBe("unknown");
    // other tasks untouched
    expect(s2.cancelForTask("other-task")).toHaveLength(0);
  });

  it("classifies via §4.8 risk engine: reads allow, unresolved mutations approve, hard-blocks deny", () => {
    const req = (tool: string, args: Record<string, unknown> = {}) => ({
      toolCallId: "tc-x",
      taskId: "t",
      tool,
      args,
      token: "",
      profileId: "p",
    });
    const risk = (tool: string, args: Record<string, unknown> = {}) =>
      classifyActionRisk(buildActionContext(req(tool, args) as never));
    expect(risk("browser.page.snapshot").risk).toBe("read");
    // unresolved click context → fail closed approval
    expect(risk("browser.page.click").needsApproval).toBe(true);
    // evaluate is hard-blocked upstream; classifier fails closed too
    expect(risk("browser.page.evaluate").needsApproval).toBe(true);
  });

  it("actionDigest binds tool+args+snapshot+url+origin", () => {
    const req = {
      toolCallId: "tc-d", taskId: "t", tool: "browser.page.click",
      args: { ref: "e1", snapshotId: "snap:1" }, token: "", profileId: "p",
    };
    const actx = buildActionContext(req as never);
    const d1 = browserActionDigest(req as never, actx);
    const d2 = browserActionDigest({ ...(req as object), args: { ref: "e2", snapshotId: "snap:1" } } as never, actx);
    expect(d1).not.toBe(d2);
    expect(d1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("external_mutation approval is allow_once only — no allow_task scope (§4.8)", async () => {
    const tokens = ToolTokenManager.forTest(SECRET);
    const { token } = issue(tokens);
    const host: ToolHostChannel = {
      hostInstanceId: "h1",
      send: async () => ({ ok: true }),
      onDisconnect: () => {},
    };
    const granted = new Set<string>();
    const scopes: Array<string | undefined> = [];
    let approvalCalls = 0;
    const s = new BrowserToolServer({
      tokens,
      resolveHost: () => host,
      requestApproval: async (tctx) => {
        approvalCalls += 1;
        scopes.push(tctx.allowTaskScope);
        // user picks allow_task, but the server must not grant a scope
        // that was never offered (external_mutation → allow_once only)
        return { verdict: "approved" as const, optionId: "allow_task" };
      },
      allowTaskGranted: async (_t, scope) => granted.has(scope),
      grantAllowTask: (_t, scope) => granted.add(scope),
      now: () => NOW,
    });
    const req = { ...REQ, token, args: { ref: "e1", label: "Pay now" } };
    const first = await s.execute({ ...req, toolCallId: "tc-at-1" });
    expect(first.status).toBe("completed");
    expect(approvalCalls).toBe(1);
    expect(scopes[0]).toBeUndefined();
    expect(granted.size).toBe(0);
    // nothing granted → the same action asks again
    const second = await s.execute({ ...req, toolCallId: "tc-at-2" });
    expect(second.status).toBe("completed");
    expect(approvalCalls).toBe(2);
    expect(granted.size).toBe(0);
  });
});

describe("BrowserToolServer tab scope (chromex-9e3)", () => {
  function makeScoped(opts: { result?: unknown; allowedTools?: string[] } = {}) {
    const tokens = ToolTokenManager.forTest(SECRET);
    const { token: token1 } = issue(tokens, {
      allowedTools: opts.allowedTools ?? ["browser.page.snapshot", "browser.page.click", "browser.page.navigate", "browser.tab.close"],
    });
    const { token: token2 } = issue(tokens, {
      taskId: "task-2",
      allowedTools: opts.allowedTools ?? ["browser.page.snapshot", "browser.page.click", "browser.page.navigate", "browser.tab.close"],
    });
    const sent: Array<{ method: string; payload: Record<string, unknown> }> = [];
    const host: ToolHostChannel = {
      hostInstanceId: "h1",
      send: async (method, payload) => {
        sent.push({ method, payload: payload as Record<string, unknown> });
        return opts.result ?? { ok: true, resolvedTabId: 7 };
      },
      onDisconnect: () => {},
    };
    const approvals: string[] = [];
    const server = new BrowserToolServer({
      tokens,
      resolveHost: () => host,
      requestApproval: async (tctx) => {
        approvals.push(tctx.tool);
        return { verdict: "approved" as const };
      },
      now: () => NOW,
    });
    return { server, token1, token2, sent, approvals };
  }

  const call = (
    server: BrowserToolServer,
    token: string,
    over: Partial<Parameters<BrowserToolServer["execute"]>[0]> = {},
  ) =>
    server.execute({
      toolCallId: `tc-${Math.random().toString(36).slice(2)}`,
      taskId: "task-1",
      profileId: "profile-1",
      tool: "browser.page.snapshot",
      args: {},
      token,
      ...over,
    });

  it("first successful call binds the host-resolved tab; scope rides the request payload", async () => {
    const { server, token1, sent } = makeScoped();
    const first = await call(server, token1);
    expect(first.status).toBe("completed");
    expect(sent[0]!.payload.tabScope).toEqual({ boundTabId: null, allowedTabIds: [], foreignTabIds: [] });
    // second call on the bound tab → payload now carries the scope
    const second = await call(server, token1, { args: { tabId: 7 } });
    expect(second.status).toBe("completed");
    expect(sent[1]!.payload.tabScope).toMatchObject({ boundTabId: 7, allowedTabIds: [7] });
  });

  it("cross-task tab access → browser.not_in_scope before dispatch or approval", async () => {
    const { server, token1, token2, sent, approvals } = makeScoped();
    await call(server, token1); // task-1 binds tab 7
    const denied = await call(server, token2, {
      taskId: "task-2",
      token: token2,
      tool: "browser.page.click",
      args: { ref: "e1", tabId: 7 },
    });
    expect(denied.status).toBe("failed");
    expect(denied.error?.code).toBe("browser.not_in_scope");
    expect(sent).toHaveLength(1); // never dispatched
    expect(approvals).toHaveLength(0); // scope denial is terminal, pre-approval
  });

  it("same-task in-scope tab is allowed", async () => {
    const { server, token1 } = makeScoped();
    await call(server, token1);
    const ok = await call(server, token1, { args: { tabId: 7 } });
    expect(ok.status).toBe("completed");
  });

  it("tab outside a bound task's scope → browser.not_in_scope", async () => {
    const { server, token1, sent } = makeScoped();
    await call(server, token1); // binds 7
    const denied = await call(server, token1, { args: { tabId: 42 } });
    expect(denied.error?.code).toBe("browser.not_in_scope");
    expect(sent).toHaveLength(1);
  });

  it("navigate-reported new tab is acquired into the task's scope", async () => {
    const { server, token1, sent } = makeScoped({
      result: { ok: true, resolvedTabId: 7, openedTabId: 9 },
    });
    await call(server, token1, { tool: "browser.page.navigate", args: { url: "https://example.com" } });
    const acquired = await call(server, token1, { args: { tabId: 9 } });
    expect(acquired.status).toBe("completed");
    expect(sent[1]!.payload.tabScope).toMatchObject({ allowedTabIds: expect.arrayContaining([7, 9]) });
  });

  it("acquired tab stays foreign to other tasks", async () => {
    const { server, token1, token2, sent } = makeScoped({
      result: { ok: true, resolvedTabId: 7, openedTabId: 9 },
    });
    await call(server, token1, { tool: "browser.page.navigate", args: { url: "https://example.com" } });
    const denied = await call(server, token2, {
      taskId: "task-2",
      token: token2,
      args: { tabId: 9 },
    });
    expect(denied.error?.code).toBe("browser.not_in_scope");
    expect(sent).toHaveLength(1);
  });

  it("browser.tab.close releases the tab so another task may bind it", async () => {
    const { server, token1, token2 } = makeScoped({
      result: { closed: 7, resolvedTabId: 7 },
    });
    await call(server, token1); // binds 7 — but result is a close shape; still binds via resolvedTabId
    const closed = await call(server, token1, { tool: "browser.tab.close", args: { tabId: 7 } });
    expect(closed.status).toBe("completed");
    const rebound = await call(server, token2, { taskId: "task-2", token: token2, args: { tabId: 7 } });
    expect(rebound.status).toBe("completed");
  });
});
