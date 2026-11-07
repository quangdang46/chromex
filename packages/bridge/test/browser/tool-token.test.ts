import { describe, expect, it } from "vitest";

import { canonicalJson, ToolTokenError, ToolTokenManager, TOOL_TOKEN_TTL_MS } from "../../src/browser/tool-token.js";
import { BrowserToolServer, classifyToolCall, HARD_BLOCKED_TOOLS } from "../../src/browser/tool-server.js";
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
    const s2 = new BrowserToolServer({ tokens, resolveHost: () => host, requestApproval: async () => "approved", now: () => NOW });
    const first = await s2.execute({ ...REQ, token });
    expect(first.status).toBe("completed");
    const second = await s2.execute({ ...REQ, token });
    expect(second.error?.code).toBe("browser.duplicate_tool_call");
  });

  it("classifies mutating tools as needs_approval, reads as allow", () => {
    const base = { taskId: "t", tool: "x", args: {}, backendId: "chrome-extension" as const, dataEgress: false };
    expect(classifyToolCall({ ...base, tool: "browser.page.snapshot" }).kind).toBe("allow");
    expect(classifyToolCall({ ...base, tool: "browser.page.click" }).kind).toBe("needs_approval");
    expect(classifyToolCall({ ...base, tool: "browser.page.evaluate" }).kind).toBe("deny");
  });
});
