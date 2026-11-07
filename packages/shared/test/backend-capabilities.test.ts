import { describe, expect, test } from "vitest";

import {
  DEFAULT_BACKEND_CAPABILITIES,
  effectiveBackendCapabilities,
  minIframeCapability,
} from "../src/browser/backend.js";

describe("backend capabilities", () => {
  test("chrome-extension claims match plan §4.5 (iframe all on http(s), no dialogs)", () => {
    const caps = DEFAULT_BACKEND_CAPABILITIES["chrome-extension"];
    expect(caps.iframe).toBe("all");
    expect(caps.nativeDialogs).toBe(false);
    expect(caps.accessibility).toBe(false);
    expect(caps.existingUserTabs).toBe(true);
  });

  test("playwright-isolated is isolated, no user session", () => {
    const caps = DEFAULT_BACKEND_CAPABILITIES["playwright-isolated"];
    expect(caps.isolatedProfile).toBe(true);
    expect(caps.existingUserSession).toBe(false);
    expect(caps.existingUserTabs).toBe(false);
    expect(caps.filePicker).toBe(false); // setInputFiles ≠ native picker
  });

  test("runtime may narrow but never widen capabilities", () => {
    const narrowed = effectiveBackendCapabilities("chrome-extension", {
      screenshot: false,
    });
    expect(narrowed.screenshot).toBe(false);
    // runtime iframe claims are ignored entirely — the advertised level
    // is the verified default, never a runtime assertion.
    const iframeAttempt = effectiveBackendCapabilities("playwright-isolated", {
      iframe: "all", // ignored: cannot widen
    });
    expect(iframeAttempt.iframe).toBe("none");
    const widened = effectiveBackendCapabilities("playwright-isolated", {
      accessibility: false,
    });
    expect(widened.accessibility).toBe(false);
    expect(widened.upload).toBe(true); // untouched stays
  });

  test("minIframeCapability picks the lower level", () => {
    expect(minIframeCapability("all", "none")).toBe("none");
    expect(minIframeCapability("same-origin", "all")).toBe("same-origin");
  });
});
