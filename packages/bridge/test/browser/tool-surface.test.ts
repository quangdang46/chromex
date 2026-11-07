import { describe, expect, it } from "vitest";

import { BROWSER_TOOL_NAMES } from "@codex-sidepanel/shared";

import { internalToolName, mcpToolName } from "../../src/browser/mcp-server.js";
import { buildActionContext, type ToolCallRequest } from "../../src/browser/tool-server.js";

const req = (tool: string, args: Record<string, unknown> = {}): ToolCallRequest => ({
  toolCallId: "tc-new",
  taskId: "task-1",
  profileId: "profile-1",
  tool,
  args,
  token: "",
});

describe("browser tool surface expansion (chromex-he2/nr8/cly)", () => {
  it("new tools are in the canonical contract and MCP name map round-trips", () => {
    for (const tool of [
      "browser.tab.create",
      "browser.page.console",
      "browser.page.hover",
      "browser.page.press",
      "browser.page.find",
      "browser.page.history",
      "browser.downloads.list",
    ] as const) {
      expect(BROWSER_TOOL_NAMES).toContain(tool);
      expect(internalToolName(mcpToolName(tool))).toBe(tool);
    }
  });

  it("tab.create resolves context without a target tab; url feeds classification", () => {
    const blank = buildActionContext(req("browser.tab.create", {}));
    expect(blank.contextResolved).toBe(true);
    expect(blank.agentEgress).toBeUndefined();
    const withUrl = buildActionContext(req("browser.tab.create", { url: "https://x.test" }));
    expect(withUrl.url).toBe("https://x.test");
    expect(withUrl.origin).toBe("https://x.test");
  });

  it("page.console carries page-text egress like other content reads", () => {
    const actx = buildActionContext(req("browser.page.console", { url: "https://x.test" }));
    expect(actx.agentEgress?.dataClass).toBe("page-text");
    expect(actx.contextResolved).toBe(true); // read tool
  });

  it("press with a key resolves context without an explicit target; without key it fails closed", () => {
    const keyed = buildActionContext(req("browser.page.press", { key: "Enter" }));
    expect(keyed.contextResolved).toBe(true);
    const keyless = buildActionContext(req("browser.page.press", {}));
    expect(keyless.contextResolved).toBe(false);
    const hoverNoTarget = buildActionContext(req("browser.page.hover", {}));
    expect(hoverNoTarget.contextResolved).toBe(false);
  });

  it("find carries page-text egress; history needs no target; upload needs one", () => {
    const find = buildActionContext(req("browser.page.find", { text: "hello", url: "https://x.test" }));
    expect(find.agentEgress?.dataClass).toBe("page-text");
    expect(find.contextResolved).toBe(true); // read tool

    const history = buildActionContext(req("browser.page.history", { action: "back" }));
    expect(history.contextResolved).toBe(true); // not in the mutating regex — tab-level nav

    const uploadTargeted = buildActionContext(
      req("browser.page.upload", { selector: "input[type=file]", files: [{ name: "a", base64: "eA==" }] }),
    );
    expect(uploadTargeted.contextResolved).toBe(true);
    const uploadBare = buildActionContext(req("browser.page.upload", { files: [{ name: "a", base64: "eA==" }] }));
    expect(uploadBare.contextResolved).toBe(false); // mutating without target → fail closed
  });
});
