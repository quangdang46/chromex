import { describe, expect, test } from "vitest";

import { BROWSER_TOOL_NAMES } from "@codex-sidepanel/shared";

import {
  PLAYWRIGHT_CDP_CAPABILITIES,
  PlaywrightCdpBackend,
} from "../../src/browser/backends/playwright/cdp.js";
import { PLAYWRIGHT_ISOLATED_SUPPORTED_TOOLS } from "../../src/browser/backends/playwright/isolated.js";

describe("PlaywrightCdpBackend", () => {
  test("identity + capabilities: cdp-attached, isolated per-task contexts", () => {
    const backend = new PlaywrightCdpBackend({ endpoint: async () => null });
    expect(backend.id).toBe("playwright-cdp");
    expect(backend.capabilities.attachToRunningChrome).toBe(true);
    // tasks run in fresh newContext() partitions — the attached
    // browser's own tabs/session are never surfaced to tools
    expect(backend.capabilities.isolatedProfile).toBe(true);
    expect(backend.capabilities.existingUserTabs).toBe(false);
    expect(backend.capabilities.existingUserSession).toBe(false);
    expect(backend.capabilities.trustedGesture).toBe(true);
    expect(backend.capabilities.nativeDialogs).toBe(true);
    expect(backend.capabilities.filePicker).toBe(true);
    expect(backend.capabilities.browserChrome).toBe(false);
    expect(PLAYWRIGHT_CDP_CAPABILITIES).toBe(backend.capabilities);
  });

  test("no endpoint → browser.backend_unavailable, never a silent launch", async () => {
    const backend = new PlaywrightCdpBackend({ endpoint: async () => null });
    await expect(
      backend.execute("t1", "browser.page.snapshot", {}),
    ).rejects.toMatchObject({ code: "browser.backend_unavailable" });
  });

  test("endpoint() throwing → same honest unavailable", async () => {
    const backend = new PlaywrightCdpBackend({
      endpoint: async () => {
        throw new Error("resolver exploded");
      },
    });
    await expect(
      backend.execute("t1", "browser.tabs.list", {}),
    ).rejects.toMatchObject({ code: "browser.backend_unavailable" });
  });

  test("unsupported tool → proto.unsupported before any endpoint/connect attempt", async () => {
    let endpointCalls = 0;
    const backend = new PlaywrightCdpBackend({
      endpoint: async () => {
        endpointCalls += 1;
        return "http://127.0.0.1:1";
      },
      loadPlaywright: async () => {
        throw new Error("must not load for unsupported tools");
      },
    });
    const claimed = new Set<string>(backend.supportedTools);
    for (const tool of BROWSER_TOOL_NAMES) {
      if (claimed.has(tool)) continue;
      await expect(backend.execute("t1", tool, {})).rejects.toMatchObject({
        code: "proto.unsupported",
      });
    }
    expect(endpointCalls).toBe(0);
  });

  test("supportedTools matches the isolated executor surface", () => {
    const backend = new PlaywrightCdpBackend({ endpoint: async () => null });
    expect([...backend.supportedTools].sort()).toEqual(
      [...PLAYWRIGHT_ISOLATED_SUPPORTED_TOOLS].sort(),
    );
    for (const tool of backend.supportedTools) {
      expect(BROWSER_TOOL_NAMES).toContain(tool);
    }
  });

  test("error messages name playwright-cdp, not playwright-isolated", async () => {
    const backend = new PlaywrightCdpBackend({ endpoint: async () => null });
    await expect(
      backend.execute("t1", "browser.page.snapshot", { mode: "dom" }),
    ).rejects.toThrow(/playwright-cdp/);
    await expect(
      backend.execute("t1", "browser.windows.list" as never, {}),
    ).rejects.toThrow(/playwright-cdp does not support/);
  });
});
