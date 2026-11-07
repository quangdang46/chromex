import { describe, expect, it } from "vitest";

import { ToolTokenManager } from "../../src/browser/tool-token.js";
import {
  BrowserToolServer,
  buildArgsPreview,
  type ToolApprovalRequest,
  type ToolHostChannel,
} from "../../src/browser/tool-server.js";

const SECRET = "ab".repeat(32);
const NOW = 1_700_000_000_000;

function makeServer(opts: {
  allowedTools: string[];
  onApproval?: (ctx: ToolApprovalRequest) => void;
}) {
  const tokens = ToolTokenManager.forTest(SECRET);
  const { token } = tokens.issue({
    taskId: "task-1",
    profileId: "profile-1",
    backendId: "chrome-extension",
    allowedTools: opts.allowedTools,
    now: NOW,
  });
  const approvals: ToolApprovalRequest[] = [];
  const host: ToolHostChannel = {
    hostInstanceId: "h1",
    send: async () => ({ ok: true }),
    onDisconnect: () => {},
  };
  const server = new BrowserToolServer({
    tokens,
    resolveHost: () => host,
    requestApproval: async (ctx) => {
      approvals.push(ctx);
      opts.onApproval?.(ctx);
      return { verdict: "approved" as const };
    },
    now: () => NOW,
  });
  return { server, token, approvals };
}

describe("buildArgsPreview", () => {
  it("redacts sensitive keys at any depth, keeps normal args", () => {
    const preview = buildArgsPreview({
      ref: "e12",
      password: "hunter2",
      nested: { apiKey: "sk-live", cardPin: "1234", note: "visible" },
      shipping: "not-a-secret",
    }) as Record<string, unknown>;
    expect(preview.ref).toBe("e12");
    expect(preview.password).toBe("•••");
    const nested = preview.nested as Record<string, unknown>;
    expect(nested.apiKey).toBe("•••");
    expect(nested.cardPin).toBe("•••");
    expect(nested.note).toBe("visible");
    expect(preview.shipping).toBe("not-a-secret");
    expect(JSON.stringify(preview)).not.toContain("hunter2");
    expect(JSON.stringify(preview)).not.toContain("sk-live");
  });

  it("redactValues masks fill payload keys only when requested", () => {
    const args = { ref: "e1", text: "typed-secret", value: "v" };
    const plain = buildArgsPreview(args) as Record<string, unknown>;
    expect(plain.text).toBe("typed-secret");
    const redacted = buildArgsPreview(args, { redactValues: true }) as Record<string, unknown>;
    expect(redacted.text).toBe("•••");
    expect(redacted.value).toBe("•••");
    expect(redacted.ref).toBe("e1");
  });

  it("caps size, string length, depth and array length", () => {
    const long = "x".repeat(5000);
    const preview = buildArgsPreview({
      blob: long,
      many: Array.from({ length: 40 }, (_, i) => `item-${i}`),
      deep: { a: { b: { c: { d: { e: { f: "too-deep" } } } } } },
    });
    const json = typeof preview === "string" ? preview : JSON.stringify(preview);
    expect(json.length).toBeLessThanOrEqual(500);
    expect(json).not.toContain(long);
    expect(json).toContain("…");
    const obj = preview as Record<string, unknown>;
    expect((obj.many as unknown[]).length).toBeLessThanOrEqual(16);
    expect(JSON.stringify(obj.deep)).toContain("[truncated]");
  });
});

describe("BrowserToolServer argsPreview", () => {
  it("sensitive fill approval carries no plaintext in argsPreview", async () => {
    // no target ref → contextResolved=false → data_entry_sensitive approval
    const { server, token, approvals } = makeServer({
      allowedTools: ["browser.page.fill"],
    });
    const out = await server.execute({
      toolCallId: "tc-fill",
      taskId: "task-1",
      profileId: "profile-1",
      tool: "browser.page.fill",
      args: {
        url: "https://example.com/login",
        text: "hunter2",
        password: "hunter2",
        ref: undefined,
      },
      token,
    });
    expect(out.status).toBe("completed");
    expect(approvals).toHaveLength(1);
    const preview = approvals[0]!.details.argsPreview;
    const json = JSON.stringify(preview);
    expect(json).not.toContain("hunter2");
    expect(json).toContain("•••");
    expect(json).toContain("https://example.com/login");
  });

  it("non-sensitive approval keeps normal args visible", async () => {
    // navigate with empty url → unresolved → external_mutation approval
    const { server, token, approvals } = makeServer({
      allowedTools: ["browser.page.navigate"],
    });
    const out = await server.execute({
      toolCallId: "tc-nav",
      taskId: "task-1",
      profileId: "profile-1",
      tool: "browser.page.navigate",
      args: { url: "", label: "go", apiKey: "sekrit" },
      token,
    });
    expect(out.status).toBe("completed");
    expect(approvals).toHaveLength(1);
    const preview = approvals[0]!.details.argsPreview as Record<string, unknown>;
    expect(preview.label).toBe("go");
    expect(preview.apiKey).toBe("•••");
    expect(JSON.stringify(preview)).not.toContain("sekrit");
  });

  it("oversize args are truncated in the approval preview", async () => {
    const { server, token, approvals } = makeServer({
      allowedTools: ["browser.page.navigate"],
    });
    const blob = "y".repeat(5000);
    await server.execute({
      toolCallId: "tc-big",
      taskId: "task-1",
      profileId: "profile-1",
      tool: "browser.page.navigate",
      args: { url: "", blob },
      token,
    });
    expect(approvals).toHaveLength(1);
    const preview = approvals[0]!.details.argsPreview;
    const serialized = typeof preview === "string" ? preview : JSON.stringify(preview);
    expect(serialized.length).toBeLessThanOrEqual(500);
    expect(serialized).not.toContain(blob);
  });
});
