import { describe, expect, test } from "vitest";

import { BROWSER_TOOL_NAMES } from "@codex-sidepanel/shared";

import { PlaywrightIsolatedBackend } from "../../src/browser/backends/playwright/isolated.js";

describe("PlaywrightIsolatedBackend", () => {
  test("absent playwright-core → browser.backend_unavailable (lazy, honest)", async () => {
    const backend = new PlaywrightIsolatedBackend({
      loadPlaywright: async () => {
        throw new Error("Cannot find module 'playwright-core'");
      },
    });
    await expect(
      backend.execute("t1", "browser.page.snapshot", {}),
    ).rejects.toMatchObject({ code: "browser.backend_unavailable" });
    // cached failure — second call same code, no re-import attempt crash
    await expect(
      backend.execute("t1", "browser.page.navigate", { url: "https://example.com" }),
    ).rejects.toMatchObject({ code: "browser.backend_unavailable" });
  });

  test("unsupported tool → proto.unsupported even with playwright present", async () => {
    const backend = new PlaywrightIsolatedBackend({
      loadPlaywright: async () => ({ chromium: { launch: async () => { throw new Error("no launch in test"); } } }) as never,
    });
    await expect(
      backend.execute("t1", "browser.page.evaluate" as never, {}),
    ).rejects.toMatchObject({ code: "proto.unsupported" });
  });

  test("capabilities match ADR-B4: isolated, no user session/tabs", () => {
    const backend = new PlaywrightIsolatedBackend();
    expect(backend.id).toBe("playwright-isolated");
    expect(backend.capabilities.isolatedProfile).toBe(true);
    expect(backend.capabilities.existingUserSession).toBe(false);
    expect(backend.capabilities.existingUserTabs).toBe(false);
    expect(backend.capabilities.filePicker).toBe(false); // setInputFiles ≠ native picker
    expect(backend.capabilities.nativeDialogs).toBe(false);
    expect(backend.capabilities.browserChrome).toBe(false);
  });

  test("execute after close → backend_unavailable", async () => {
    const backend = new PlaywrightIsolatedBackend({
      loadPlaywright: async () => ({ chromium: {} }) as never,
    });
    await backend.close();
    await expect(
      backend.execute("t1", "browser.tabs.list", {}),
    ).rejects.toMatchObject({ code: "browser.backend_unavailable" });
  });
});

describe("PlaywrightIsolatedBackend capability honesty", () => {
  test("supportedTools is a subset of the shared contract", () => {
    const backend = new PlaywrightIsolatedBackend();
    for (const tool of backend.supportedTools) {
      expect(BROWSER_TOOL_NAMES).toContain(tool);
    }
  });

  test("every contract tool the backend does not claim → proto.unsupported, playwright never loaded", async () => {
    let loads = 0;
    const backend = new PlaywrightIsolatedBackend({
      loadPlaywright: async () => {
        loads += 1;
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
    // a tool that lands in the contract later (e.g. browser.tab.create,
    // browser.page.hover) is equally honest — checked before any launch
    await expect(
      backend.execute("t1", "browser.tab.create" as never, {}),
    ).rejects.toMatchObject({ code: "proto.unsupported" });
    await expect(
      backend.execute("t1", "browser.page.hover" as never, {}),
    ).rejects.toMatchObject({ code: "proto.unsupported" });
    expect(loads).toBe(0);
  });

  test("tabs.list reports real page titles, not placeholders", async () => {
    const pages = [
      { url: () => "https://a.example/", title: async () => "Alpha" },
      { url: () => "https://b.example/", title: async () => "Beta" },
    ];
    const backend = new PlaywrightIsolatedBackend({
      loadPlaywright: async () => stubPlaywright(pages) as never,
    });
    const result = (await backend.execute("t1", "browser.tabs.list", {})) as {
      tabs: Array<{ tabId: number; url: string; title: string; active: boolean }>;
    };
    expect(result.tabs).toHaveLength(2);
    expect(result.tabs[0]).toMatchObject({
      tabId: 0,
      url: "https://a.example/",
      title: "Alpha",
      active: false,
    });
    expect(result.tabs[1]).toMatchObject({ tabId: 1, title: "Beta", active: true });
  });

  test("missing isolated tab → browser.tab_not_found (not a fake success)", async () => {
    const backend = new PlaywrightIsolatedBackend({
      loadPlaywright: async () => stubPlaywright([]) as never,
    });
    await expect(
      backend.execute("t1", "browser.tab.activate", { tabId: 3 }),
    ).rejects.toMatchObject({ code: "browser.tab_not_found" });
  });

  test("wait timeout → browser.timeout, never a satisfied result", async () => {
    const page = {
      url: () => "https://x.example/",
      title: async () => "X",
      locator: () => ({ count: async () => 0 }),
      waitForTimeout: async () => {},
    };
    const backend = new PlaywrightIsolatedBackend({
      loadPlaywright: async () => stubPlaywright([page]) as never,
    });
    await expect(
      backend.execute("t1", "browser.page.wait", { selector: ".never", timeoutMs: 30 }),
    ).rejects.toMatchObject({ code: "browser.timeout" });
  });
});

/** Minimal playwright-core stub — only what the isolated backend touches. */
function stubPlaywright(pages: unknown[]) {
  const pwPages = pages as Array<Record<string, unknown>>;
  const context = {
    pages: () => pwPages,
    newPage: async () => {
      throw new Error("unexpected newPage in test");
    },
    close: async () => {},
  };
  const browser = {
    isConnected: () => true,
    newContext: async () => context,
    close: async () => {},
  };
  return { chromium: { launch: async () => browser } };
}
