import { describe, expect, test } from "vitest";

import { resolveBackendSelection, backendMismatchFor } from "../../src/browser/backend-selection.js";

const base = {
  defaultBackend: "auto" as const,
  allowedBackends: ["chrome-extension", "playwright-isolated"] as const,
  playwrightEnabledByUser: false,
  playwrightRuntimeAvailable: false,
};

describe("resolveBackendSelection (§6.6)", () => {
  test("auto → chrome-extension when allowed", () => {
    const r = resolveBackendSelection({ ...base });
    expect(r.backend).toEqual({ backendId: "chrome-extension", pinnedBy: "default" });
  });

  test("explicit user pin wins over config default", () => {
    const r = resolveBackendSelection({
      ...base,
      requested: { backendId: "playwright-isolated", pinnedBy: "user" },
      defaultBackend: "chrome-extension",
      playwrightEnabledByUser: true,
      playwrightRuntimeAvailable: true,
    });
    expect(r.backend.backendId).toBe("playwright-isolated");
    expect(r.backend.pinnedBy).toBe("user");
  });

  test("explicit pin to unavailable backend → browser.backend_unavailable, no fallback", () => {
    expect(() =>
      resolveBackendSelection({
        ...base,
        requested: { backendId: "playwright-isolated", pinnedBy: "user" },
      }),
    ).toThrowError(expect.objectContaining({ code: "browser.backend_unavailable" }));
  });

  test("playwright-isolated gated by enabledByUser even when runtime present", () => {
    expect(() =>
      resolveBackendSelection({
        ...base,
        requested: { backendId: "playwright-isolated", pinnedBy: "user" },
        playwrightRuntimeAvailable: true,
        // enabledByUser stays false
      }),
    ).toThrowError(expect.objectContaining({ code: "browser.backend_unavailable" }));
  });

  test("auto skips playwright-isolated when disabled → extension", () => {
    const r = resolveBackendSelection({
      ...base,
      playwrightRuntimeAvailable: true,
      // enabledByUser false → isolated not available
    });
    expect(r.backend.backendId).toBe("chrome-extension");
  });

  test("auto picks playwright-isolated only when enabled + runtime + extension disallowed", () => {
    const r = resolveBackendSelection({
      ...base,
      allowedBackends: ["playwright-isolated"],
      playwrightEnabledByUser: true,
      playwrightRuntimeAvailable: true,
    });
    expect(r.backend.backendId).toBe("playwright-isolated");
  });

  test("backend not in allowedBackends → unavailable", () => {
    expect(() =>
      resolveBackendSelection({
        ...base,
        requested: { backendId: "chrome-extension", pinnedBy: "user" },
        allowedBackends: ["playwright-isolated"],
      }),
    ).toThrowError(expect.objectContaining({ code: "browser.backend_unavailable" }));
  });

  test("playwright-cdp never selectable in MVP", () => {
    expect(() =>
      resolveBackendSelection({
        ...base,
        requested: { backendId: "playwright-cdp", pinnedBy: "user" },
        playwrightEnabledByUser: true,
        playwrightRuntimeAvailable: true,
      }),
    ).toThrowError(expect.objectContaining({ code: "browser.backend_unavailable" }));
  });
});

describe("backendMismatchFor (§6.6)", () => {
  test("tab-bound work + isolated pin → backend_mismatch", () => {
    expect(backendMismatchFor("playwright-isolated", true)).toBe("browser.backend_mismatch");
  });
  test("untitled + isolated → ok", () => {
    expect(backendMismatchFor("playwright-isolated", false)).toBeNull();
  });
  test("tab-bound + extension → ok", () => {
    expect(backendMismatchFor("chrome-extension", true)).toBeNull();
  });
});
