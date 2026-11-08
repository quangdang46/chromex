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
    /** optionId the approval hook resolves with (default: plain approve) */
    approvalOptionId?: string;
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
    // allow_egress_task grants are scope-bound only — no digest (chromex-b1h)
    const egressGrantedScopes = new Set<string>();
    const egressGrantCalls: string[] = [];
    const server = new BrowserToolServer({
      tokens,
      resolveHost: () => host,
      requestApproval: async (ctx) => {
        approvals.push(ctx);
        return {
          verdict: "approved" as const,
          ...(deps.approvalOptionId ? { optionId: deps.approvalOptionId } : {}),
        };
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
      egressTaskGranted: async (_t, scope) => egressGrantedScopes.has(scope),
      grantEgressTask: (_t, scope) => {
        egressGrantCalls.push(scope);
        egressGrantedScopes.add(scope);
      },
      ...(deps.sensitiveOrigins ? { sensitiveOrigins: deps.sensitiveOrigins } : {}),
      ...(deps.agentEgressDestination ? { agentEgressDestination: deps.agentEgressDestination } : {}),
      now: () => NOW,
    });
    return { server, token, approvals, granted, grantCalls, grantChecks, egressGrantedScopes, egressGrantCalls };
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

  it("allow_egress_task grant covers later page-text egress for the task — but not sensitive or screenshot", async () => {
    const { server, token, approvals, egressGrantCalls } = makeServer({
      agentEgressDestination: "cloud-provider",
      approvalOptionId: "allow_egress_task",
    });
    // first snapshot asks and carries the egress grant scope
    const first = await server.execute({
      ...req("browser.page.snapshot", { url: "https://a.example.com/1", snapshotId: "snap:1" }),
      token,
      toolCallId: "tc-e1",
    });
    expect(first.status).toBe("completed");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: "agent_egress" });
    expect(approvals[0]!.egressTaskScope).toBe("agent-egress|page-text|cloud-provider");
    expect(approvals[0]!.details.egressTaskScope).toBe("agent-egress|page-text|cloud-provider");
    expect(egressGrantCalls).toEqual(["agent-egress|page-text|cloud-provider"]);

    // a DIFFERENT page/digest is covered by the grant — no re-approval
    const second = await server.execute({
      ...req("browser.page.snapshot", { url: "https://b.example.com/2", snapshotId: "snap:2" }),
      token,
      toolCallId: "tc-e2",
    });
    expect(second.status).toBe("completed");
    expect(approvals).toHaveLength(1);

    // screenshot egress is never covered by the page-text grant
    const shot = await server.execute({
      ...req("browser.page.screenshot", { url: "https://a.example.com/1" }),
      token,
      toolCallId: "tc-e3",
    });
    expect(shot.status).toBe("completed");
    expect(approvals).toHaveLength(2);
    expect(approvals[1]).toMatchObject({ kind: "agent_egress" });
    expect(approvals[1]!.egressTaskScope).toBeUndefined();

    // sensitive-content egress still asks every call
    const sensitive = await server.execute({
      ...req("browser.page.snapshot", { url: "https://bank.example.com/?token=sekrit" }),
      token,
      toolCallId: "tc-e4",
    });
    expect(sensitive.status).toBe("completed");
    expect(approvals).toHaveLength(3);
    expect(approvals[2]!.egressTaskScope).toBeUndefined();
  });

  it("without the grant option, every cloud egress call still asks (allow_once path unchanged)", async () => {
    const { server, token, approvals, egressGrantCalls } = makeServer({
      agentEgressDestination: "cloud-provider",
    });
    for (const [i, url] of ["https://a.example.com/1", "https://b.example.com/2"].entries()) {
      const out = await server.execute({
        ...req("browser.page.snapshot", { url }),
        token,
        toolCallId: `tc-n${i}`,
      });
      expect(out.status).toBe("completed");
    }
    expect(approvals).toHaveLength(2);
    expect(egressGrantCalls).toHaveLength(0);
  });
});

describe("BrowserToolServer — §4.8 ground-truth target preflight", () => {
  const SECRET = "cd".repeat(32);
  const NOW = 1_700_000_000_000;

  function makePreflightServer(describeResult: Record<string, unknown>) {
    const tokens = ToolTokenManager.forTest(SECRET);
    const { token } = tokens.issue({
      taskId: "task-1",
      profileId: "profile-1",
      backendId: "chrome-extension",
      allowedTools: ["browser.page.click", "browser.page.fill"],
      now: NOW,
    });
    const sent: Array<{ tool?: string; args?: Record<string, unknown> }> = [];
    const host: ToolHostChannel = {
      hostInstanceId: "h1",
      send: async (_method, payload) => {
        const p = payload as { tool?: string; args?: Record<string, unknown> };
        sent.push(p);
        if (p.tool === "browser.internal.describeTarget") return describeResult;
        return { ok: true, resolvedTabId: 3 };
      },
      onDisconnect: () => {},
    };
    const approvals: ToolApprovalRequest[] = [];
    const server = new BrowserToolServer({
      tokens,
      resolveHost: () => host,
      requestApproval: async (ctx) => {
        approvals.push(ctx);
        return { verdict: "approved" as const };
      },
      now: () => NOW,
    });
    return { server, token, approvals, sent };
  }

  it("ref-targeted click on a destructive-labeled element requires approval — args carried no label", async () => {
    const { server, token, approvals, sent } = makePreflightServer({
      found: true,
      label: "Delete account permanently",
      tagName: "button",
      pageOrigin: "https://app.example.com",
      pageUrl: "https://app.example.com/settings",
    });
    const out = await server.execute({
      ...req("browser.page.click", { ref: "e7", snapshotId: "snap:1" }),
      token,
    });
    expect(out.status).toBe("completed");
    // preflight went to the host BEFORE dispatch
    expect(sent.map((s) => s.tool)).toEqual(["browser.internal.describeTarget", "browser.page.click"]);
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: "browser_action", risk: "external_mutation" });
    // the approval preview shows the REAL label, not agent args
    expect(approvals[0]!.details.targetLabel).toBe("Delete account permanently");
  });

  it("click on a financial origin requires approval even with a benign label", async () => {
    const { server, token, approvals } = makePreflightServer({
      found: true,
      label: "Continue",
      tagName: "button",
      pageOrigin: "https://www.paypal.com",
      pageUrl: "https://www.paypal.com/checkout",
    });
    const out = await server.execute({
      ...req("browser.page.click", { ref: "e2" }),
      token,
      toolCallId: "tc-pay",
    });
    expect(out.status).toBe("completed");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ risk: "financial" });
  });

  it("fill into a real password input is data_entry_sensitive — agent never said so", async () => {
    const { server, token, approvals } = makePreflightServer({
      found: true,
      label: "Password",
      tagName: "input",
      inputType: "password",
      pageOrigin: "https://app.example.com",
      pageUrl: "https://app.example.com/login",
    });
    const out = await server.execute({
      ...req("browser.page.fill", { ref: "e3", text: "hunter2" }),
      token,
      toolCallId: "tc-pw",
    });
    expect(out.status).toBe("completed");
    expect(approvals).toHaveLength(1);
    expect(approvals[0]).toMatchObject({ kind: "data_entry_sensitive", risk: "data_entry_sensitive" });
  });

  it("benign click on a resolved element stays approval-free", async () => {
    const { server, token, approvals } = makePreflightServer({
      found: true,
      label: "Search",
      tagName: "button",
      pageOrigin: "https://shop.example.com",
      pageUrl: "https://shop.example.com/",
    });
    const out = await server.execute({
      ...req("browser.page.click", { ref: "e4" }),
      token,
      toolCallId: "tc-ok",
    });
    expect(out.status).toBe("completed");
    expect(approvals).toHaveLength(0);
  });

  it("preflight failure fails open — dispatch surfaces the real error", async () => {
    const tokens = ToolTokenManager.forTest(SECRET);
    const { token } = tokens.issue({
      taskId: "task-1",
      profileId: "profile-1",
      backendId: "chrome-extension",
      allowedTools: ["browser.page.click"],
      now: NOW,
    });
    const host: ToolHostChannel = {
      hostInstanceId: "h1",
      send: async (_m, payload) => {
        const p = payload as { tool?: string };
        if (p.tool === "browser.internal.describeTarget") throw new Error("tab gone");
        return { ok: false, error: "browser.element_not_found" };
      },
      onDisconnect: () => {},
    };
    const server = new BrowserToolServer({
      tokens,
      resolveHost: () => host,
      now: () => NOW,
    });
    const out = await server.execute({
      ...req("browser.page.click", { ref: "e9" }),
      token,
      toolCallId: "tc-failopen",
    });
    // no approval was demanded; the dispatch result flows through
    expect(out.status).toBe("completed");
  });
});
