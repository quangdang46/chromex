import { describe, expect, test } from "vitest";

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
