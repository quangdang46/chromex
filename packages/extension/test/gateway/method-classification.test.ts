import { describe, expect, test } from "vitest";

import {
  GATEWAY_SERVED_METHODS,
  SIDECAR_METHODS,
  isGatewayServed,
  isSidecarMethod,
} from "../../src/background/gateway/compat/legacy-methods.js";

/**
 * chromex-jmk: GATEWAY_SERVED_METHODS / isGatewayServed looked dead —
 * routing keys off SIDECAR_METHODS alone. These tests make the pair
 * load-bearing: the two transports must never claim the same method,
 * and every explicitly gateway-served method must classify as such.
 */
describe("gateway/sidecar method classification", () => {
  test("gateway-served and sidecar sets are disjoint", () => {
    for (const method of GATEWAY_SERVED_METHODS) {
      expect(SIDECAR_METHODS.has(method), `${method} claimed by both`).toBe(false);
    }
  });

  test("every GATEWAY_SERVED_METHODS entry classifies as gateway-served", () => {
    for (const method of GATEWAY_SERVED_METHODS) {
      expect(isGatewayServed(method), method).toBe(true);
    }
  });

  test("provider.feature.* wildcard is gateway-served but never sidecar", () => {
    expect(isGatewayServed("provider.feature.codex.anything.new")).toBe(true);
    for (const method of SIDECAR_METHODS) {
      expect(method.startsWith("provider.feature."), method).toBe(false);
    }
  });

  test("planning RPCs are gateway-native, not sidecar (chromex-pwu)", () => {
    expect(isGatewayServed("route.plan")).toBe(true);
    expect(isGatewayServed("browser.action.plan")).toBe(true);
    expect(isSidecarMethod("route.plan")).toBe(false);
    expect(isSidecarMethod("browser.action.plan")).toBe(false);
  });

  test("known sidecar domains classify as sidecar, not gateway", () => {
    for (const method of [
      "image.generate.start",
      "voice.session.start",
      "dictation.transcription.start",
      "translation.api_key.save",
      "diagnostics.log.write",
      "runtime.config.read",
      "local.file.reveal",
      "workspace.harness.read",
      "apps.list",
      "profile.select",
    ]) {
      expect(isSidecarMethod(method), method).toBe(true);
      expect(isGatewayServed(method), method).toBe(false);
    }
  });
});
