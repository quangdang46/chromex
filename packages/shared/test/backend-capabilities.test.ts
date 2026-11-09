import { describe, expect, test } from "vitest";

import {
  DEFAULT_BACKEND_CAPABILITIES,
  effectiveBackendCapabilities,
  minIframeCapability,
} from "../src/browser/backend.js";

describe("backend capabilities", () => {
  test("chrome-extension claims match plan §4.5 (iframe all on http(s); CDP tier verified)", () => {
    const caps = DEFAULT_BACKEND_CAPABILITIES["chrome-extension"];
    expect(caps.iframe).toBe("all");
    // CDP tier (docs/adr/debugger-tier.md, cdp-headless verified):
    // real AX tree + JS dialog handling + trusted paths on every
    // gesture tool. filePicker true — chooser wait+feed via
    // Page.setInterceptFileChooserDialog (cdp-headless verified).
    expect(caps.nativeDialogs).toBe(true);
    expect(caps.accessibility).toBe(true);
    expect(caps.networkBodies).toBe(true);
    // Every gesture-bearing tool has a verified args.trusted CDP path;
    // select/submit/scroll/etc. are programmatic, not gestures.
    expect(caps.trustedGesture).toBe(true);
    expect(caps.filePicker).toBe(true);
    expect(caps.existingUserTabs).toBe(true);
  });

  test("playwright-isolated is isolated, no user session", () => {
    const caps = DEFAULT_BACKEND_CAPABILITIES["playwright-isolated"];
    expect(caps.isolatedProfile).toBe(true);
    expect(caps.existingUserSession).toBe(false);
    expect(caps.existingUserTabs).toBe(false);
    expect(caps.filePicker).toBe(true); // waitForEvent('filechooser') + setFiles
  });

  test("runtime may narrow but never widen capabilities", () => {
    const narrowed = effectiveBackendCapabilities("chrome-extension", {
      screenshot: false,
    });
    expect(narrowed.screenshot).toBe(false);
    // runtime iframe claims are ignored entirely — the advertised level
    // is the verified default, never a runtime assertion.
    const iframeAttempt = effectiveBackendCapabilities("playwright-isolated", {
      iframe: "none", // ignored: cannot narrow either — default is verified "all"
    });
    expect(iframeAttempt.iframe).toBe("all");
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
