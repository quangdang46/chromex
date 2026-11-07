import { describe, expect, it } from "vitest";

import { classifyActionRisk } from "@codex-sidepanel/shared";

import { ToolTokenManager } from "../../src/browser/tool-token.js";
import {
  BrowserToolServer,
  buildActionContext,
  browserActionDigest,
  type ToolApprovalRequest,
  type ToolCallRequest,
  type ToolHostChannel,
} from "../../src/browser/tool-server.js";

const req = (tool: string, args: Record<string, unknown> = {}): ToolCallRequest => ({
  toolCallId: "tc-ctx",
  taskId: "task-1",
  profileId: "profile-1",
  tool,
  args,
  token: "",
});

describe("buildActionContext — agentEgress wiring (chromex-mcz)", () => {
  it("screenshot → dataClass 'screenshot'; page-content reads → 'page-text'", () => {
    expect(buildActionContext(req("browser.page.screenshot")).agentEgress?.dataClass).toBe("screenshot");
    for (const tool of ["browser.page.snapshot", "browser.page.get", "browser.page.extract"]) {
      expect(buildActionContext(req(tool)).agentEgress?.dataClass).toBe("page-text");
    }
  });

  it("non-egress tools carry no agentEgress", () => {
    for (const tool of ["browser.page.click", "browser.page.navigate", "browser.page.fill", "browser.tabs.list"]) {
      expect(buildActionContext(req(tool, { url: "https://x.test" })).agentEgress).toBeUndefined();
    }
  });

  it("defaults destination to local-provider; caller can override", () => {
    const local = buildActionContext(req("browser.page.snapshot"));
    expect(local.agentEgress?.destination).toBe("local-provider");
    const cloud = buildActionContext(req("browser.page.snapshot"), true, {
      destination: "cloud-provider",
    });
    expect(cloud.agentEgress?.destination).toBe("cloud-provider");
    // non-local egress is an approval dimension even for non-sensitive pages
    const verdict = classifyActionRisk(cloud);
    expect(verdict).toMatchObject({ needsApproval: true, kind: "agent_egress", allowTaskEligible: false });
  });

  it("sensitiveOrigins marks page egress sensitive → agent_egress approval", () => {
    const actx = buildActionContext(req("browser.page.snapshot", { url: "https://mail.example.com/inbox" }), true, {
      sensitiveOrigins: ["https://mail.example.com"],
    });
    expect(actx.agentEgress?.sensitiveContent).toBe(true);
    const verdict = classifyActionRisk(actx);
    expect(verdict).toMatchObject({ needsApproval: true, kind: "agent_egress" });
  });

  it("bare-host sensitiveOrigins entries match by hostname suffix", () => {
    const actx = buildActionContext(req("browser.page.extract", { url: "https://a.b.example.org/x" }), true, {
      sensitiveOrigins: ["example.org"],
    });
    expect(actx.agentEgress?.sensitiveContent).toBe(true);
    const other = buildActionContext(req("browser.page.extract", { url: "https://notexample.org/x" }), true, {
      sensitiveOrigins: ["example.org"],
    });
    expect(other.agentEgress?.sensitiveContent).not.toBe(true);
  });

  it("PII or token-looking URLs mark content sensitive", () => {
    const pii = buildActionContext(req("browser.page.snapshot", { url: "https://x.test/u?a=bob@corp.com" }));
    expect(pii.agentEgress?.sensitiveContent).toBe(true);
    const token = buildActionContext(req("browser.page.snapshot", { url: "https://x.test/cb?access_token=sekrit" }));
    expect(token.agentEgress?.sensitiveContent).toBe(true);
    const clean = buildActionContext(req("browser.page.snapshot", { url: "https://x.test/plain" }));
    expect(clean.agentEgress?.sensitiveContent).not.toBe(true);
  });

  it("fill inputType=password surfaces target.isPassword → data_entry_sensitive", () => {
    const actx = buildActionContext(req("browser.page.fill", { ref: "e9", inputType: "password", text: "x" }));
    expect(actx.target?.isPassword).toBe(true);
    expect(classifyActionRisk(actx)).toMatchObject({ risk: "data_entry_sensitive", needsApproval: true });
  });
});

describe("browserActionDigest — dataEgress binding (chromex-pr8)", () => {
  const base = req("browser.page.fill", { ref: "e1", text: "hi", snapshotId: "snap:1", url: "https://x.test" });

  it("includes dataEgress and agentEgress classification", () => {
    const d1 = browserActionDigest(base, buildActionContext(base));
    const withEgress = buildActionContext(base);
    const d2 = browserActionDigest(base, { ...withEgress, dataEgress: "page-local" });
    expect(d2).not.toBe(d1);
    const d3 = browserActionDigest(base, {
      ...withEgress,
      agentEgress: { dataClass: "page-text", destination: "local-provider" },
    });
    expect(d3).not.toBe(d1);
    const d4 = browserActionDigest(base, {
      ...withEgress,
      agentEgress: { dataClass: "page-text", destination: "cloud-provider" },
    });
    expect(d4).not.toBe(d3);
  });

  it("changed args/snapshotId/url/origin produce a different digest", () => {
    const actx = buildActionContext(base);
    const d1 = browserActionDigest(base, actx);
    for (const mutated of [
      { ...base, args: { ...base.args, ref: "e2" } },
      { ...base, args: { ...base.args, snapshotId: "snap:2" } },
      { ...base, args: { ...base.args, url: "https://other.test" } },
    ]) {
      expect(browserActionDigest(mutated, buildActionContext(mutated))).not.toBe(d1);
    }
    // identical inputs → identical digest
    expect(browserActionDigest(base, buildActionContext(base))).toBe(d1);
  });
});

describe("BrowserToolServer — agentEgress approval + allow_task digest (chromex-mcz/pr8)", () => {
  const SECRET = "ab".repeat(32);
  const NOW = 1_700_000_000_000;

  function makeServer(deps: {
    allowedTools?: string[];
    sensitiveOrigins?: string[];
    agentEgressDestination?: "local-provider" | "cloud-provider" | "external-mcp" | "logs-telemetry";
  } = {}) {
    const tokens = ToolTokenManager.forTest(SECRET);
    const { token } = tokens.issue({
      taskId: "task-1",
      profileId: "profile-1",
      backendId: "chrome-extension",
      allowedTools: deps.allowedTools ?? ["browser.page.snapshot", "browser.page.screenshot"],
      now: NOW,
    });
    const host: ToolHostChannel = {
      hostInstanceId: "h1",
      send: async () => ({ ok: true, resolvedTabId: 3 }),
      onDisconnect: () => {},
    };
    const approvals: ToolApprovalRequest[] = [];
    const granted = new Map<string, string>();
    const grantCalls: Array<{ scope: string; digest: string }> = [];
    const grantChecks: Array<{ scope: string; digest: string }> = [];
    const server = new BrowserToolServer({
      tokens,
      resolveHost: () => host,
      requestApproval: async (ctx) => {
        approvals.push(ctx);
        return { verdict: "approved" as const };
      },
      // mirrors the intended store contract: a scope grant only covers
      // the exact actionDigest it was approved for (chromex-pr8)
      allowTaskGranted: async (_t, scope, digest) => {
        grantChecks.push({ scope, digest });
        return granted.get(scope) === digest;
      },
      grantAllowTask: (_t, scope, digest) => {
        grantCalls.push({ scope, digest });
        granted.set(scope, digest);
      },
      ...(deps.sensitiveOrigins ? { sensitiveOrigins: deps.sensitiveOrigins } : {}),
      ...(deps.agentEgressDestination ? { agentEgressDestination: deps.agentEgressDestination } : {}),
      now: () => NOW,
    });
    return { server, token, approvals, granted, grantCalls, grantChecks };
  }

  it("snapshot on a sensitive origin asks agent_egress approval; clean origin does not", async () => {
    const { server, token, approvals } = makeServer({ sensitiveOrigins: ["https://bank.example.com"] });
    const clean = await server.execute({
      ...req("browser.page.snapshot", { url: "https://shop.example.com" }),
      token,
    });
    expect(clean.status).toBe("completed");
    expect(approvals).toHaveLength(0);
    const sensitive = await server.execute({
      ...req("browser.page.snapshot", { url: "https://bank.example.com/accounts" }),
      token,
      toolCallId: "tc-sens",
    });
    expect(sensitive.status).toBe("completed");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: "agent_egress", risk: "external_mutation" });
    expect(approvals[0]!.actionDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("cloud-provider destination turns every page-data read into an approval", async () => {
    const { server, token, approvals } = makeServer({ agentEgressDestination: "cloud-provider" });
    const out = await server.execute({
      ...req("browser.page.snapshot", { url: "https://plain.example.com" }),
      token,
    });
    expect(out.status).toBe("completed");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.kind).toBe("agent_egress");
  });

  it("approval actionDigest binds the exact action inputs (chromex-pr8)", async () => {
    const { server, token, approvals } = makeServer({ agentEgressDestination: "cloud-provider" });
    const callReq = req("browser.page.snapshot", { url: "https://plain.example.com", snapshotId: "snap:9" });
    const out = await server.execute({ ...callReq, token });
    expect(out.status).toBe("completed");
    expect(approvals).toHaveLength(1);
    const actx = buildActionContext(callReq, true, { destination: "cloud-provider" });
    expect(approvals[0]!.actionDigest).toBe(browserActionDigest(callReq, actx));
    // a mutated action (different args/snapshot) yields a different digest —
    // the value allowTaskGranted must compare against the stored grant
    const mutated = { ...callReq, args: { ...callReq.args, snapshotId: "snap:10" } };
    expect(browserActionDigest(mutated, buildActionContext(mutated, true, { destination: "cloud-provider" }))).not.toBe(
      approvals[0]!.actionDigest,
    );
  });
});
