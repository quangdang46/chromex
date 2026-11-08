import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mcpScopePath,
  readMcpScopeFile,
  supportedToolsForBackend,
  updateMcpScopeToken,
  writeMcpScopeFile,
} from "../../src/browser/mcp-scope.js";
import { BROWSER_TOOL_NAMES } from "@codex-sidepanel/shared";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "chromex-mcpscope-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = {
  taskId: "t1",
  token: "tok-1",
  tokenExpiresAt: 1000,
  profileId: "p1",
  backendId: "chrome-extension" as const,
  allowedTools: ["browser.page.click"],
  gatewayEndpoint: "/tmp/gw.sock",
  gatewayTokenFile: "/tmp/auth/token",
};

describe("mcp scope files", () => {
  test("write/read roundtrip; file is 0600", async () => {
    const file = await writeMcpScopeFile(dir, base);
    expect(file).toBe(mcpScopePath(dir, "t1"));
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    const read = await readMcpScopeFile(file);
    expect(read?.token).toBe("tok-1");
    expect(read?.taskId).toBe("t1");
  });

  test("updateMcpScopeToken hot-updates token, keeps scope", async () => {
    await writeMcpScopeFile(dir, base);
    expect(await updateMcpScopeToken(dir, "t1", "tok-2", 2000)).toBe(true);
    const read = await readMcpScopeFile(mcpScopePath(dir, "t1"));
    expect(read?.token).toBe("tok-2");
    expect(read?.tokenExpiresAt).toBe(2000);
    expect(read?.allowedTools).toEqual(["browser.page.click"]);
  });

  test("update on missing file returns false; unsafe taskId sanitized", async () => {
    expect(await updateMcpScopeToken(dir, "nope", "x", 1)).toBe(false);
    const file = await writeMcpScopeFile(dir, { ...base, taskId: "a/b:c" });
    expect(path.basename(file)).toBe("a_b_c.json");
    expect((await readMcpScopeFile(file))?.taskId).toBe("a/b:c");
  });

  test("scope file carries the backend's supported tools (chromex-51ua)", async () => {
    const allowedTools = supportedToolsForBackend("playwright-isolated");
    const file = await writeMcpScopeFile(dir, { ...base, backendId: "playwright-isolated", allowedTools });
    const read = await readMcpScopeFile(file);
    expect(read?.allowedTools).toEqual(allowedTools);
  });
});

describe("supportedToolsForBackend (chromex-51ua)", () => {
  test("chrome-extension advertises the full contract", () => {
    expect(supportedToolsForBackend("chrome-extension")).toEqual([...BROWSER_TOOL_NAMES]);
  });

  test("playwright-isolated omits tools it cannot execute", () => {
    const tools = supportedToolsForBackend("playwright-isolated");
    expect(tools).not.toContain("browser.windows.list");
    expect(tools).not.toContain("browser.windows.create");
    expect(tools).not.toContain("browser.windows.update");
    expect(tools).not.toContain("browser.tab.discard");
    expect(tools).not.toContain("browser.tab.highlight"); // no tab strip on isolated
    expect(tools).not.toContain("browser.tabGroups");
    expect(tools).toContain("browser.sessions"); // per-task recently-closed log parity
    expect(tools).not.toContain("browser.proxy");
    expect(tools).not.toContain("browser.privacy");
    expect(tools).not.toContain("browser.management");
    expect(tools).not.toContain("browser.notifications");
    expect(tools).not.toContain("browser.dnr");
    expect(tools).not.toContain("browser.userScripts");
    expect(tools).not.toContain("browser.system");
    expect(tools).not.toContain("browser.processes");
    expect(tools).not.toContain("browser.dns");
    expect(tools).not.toContain("browser.power");
    expect(tools).not.toContain("browser.runtime");
    expect(tools).not.toContain("browser.permissions");
    expect(tools).not.toContain("browser.action");
    expect(tools).not.toContain("browser.downloads.pause");
    expect(tools).not.toContain("browser.downloads.resume");
    expect(tools).not.toContain("browser.downloads.erase");
    expect(tools).not.toContain("browser.windows.remove");
    expect(tools).not.toContain("browser.page.pierce"); // CDP-only — no closed-root pierce on isolated
    expect(tools.length).toBe(BROWSER_TOOL_NAMES.length - 26);
    for (const tool of tools) expect(BROWSER_TOOL_NAMES).toContain(tool);
  });

  test("playwright-cdp has no executor — advertises nothing", () => {
    expect(supportedToolsForBackend("playwright-cdp")).toEqual([]);
  });
});
