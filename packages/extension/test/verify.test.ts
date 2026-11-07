import { describe, expect, test } from "vitest";

import { verifyDomAction, type PageObservation, type TargetObservation } from "../src/content/verify.js";
import type { BrowserDomActionStep } from "@codex-sidepanel/shared";

const page = (over: Partial<PageObservation> = {}): PageObservation => ({
  url: "https://app.example.com/inbox",
  scrollX: 0,
  scrollY: 0,
  ...over,
});

const target = (over: Partial<TargetObservation> = {}): TargetObservation => ({
  connected: true,
  value: "",
  checked: null,
  ariaExpanded: null,
  focused: false,
  ...over,
});

const step = (action: BrowserDomActionStep["action"], over: Partial<BrowserDomActionStep> = {}): BrowserDomActionStep => ({
  action,
  reason: "test",
  ...over,
});

describe("verifyDomAction — §6.3 semantic layer", () => {
  test("click + targeted evidence (aria-expanded flip) → true", () => {
    const before = { page: page(), target: target({ ariaExpanded: "false" }) };
    const after = { page: page(), target: target({ ariaExpanded: "true" }) };
    expect(verifyDomAction(step("click"), before, after)).toBe(true);
  });

  test("click + element gone → true", () => {
    const before = { page: page(), target: target() };
    const after = { page: page(), target: target({ connected: false }) };
    expect(verifyDomAction(step("click"), before, after)).toBe(true);
  });

  test("click + url change → true", () => {
    const before = { page: page(), target: target() };
    const after = { page: page({ url: "https://app.example.com/done" }), target: target() };
    expect(verifyDomAction(step("click"), before, after)).toBe(true);
  });

  test("click + no evidence → unknown (never false, never retried)", () => {
    const before = { page: page(), target: target() };
    const after = { page: page(), target: target() };
    expect(verifyDomAction(step("click"), before, after)).toBe("unknown");
  });

  test("click + only scroll change (generic) → still unknown", () => {
    const before = { page: page(), target: target() };
    const after = { page: page({ scrollY: 400 }), target: target() };
    expect(verifyDomAction(step("click"), before, after)).toBe("unknown");
  });

  test("fill + value reflected → true", () => {
    const before = { page: page(), target: target({ value: "" }) };
    const after = { page: page(), target: target({ value: "hello" }) };
    expect(verifyDomAction(step("fill", { value: "hello" }), before, after)).toBe(true);
  });

  test("fill + different value landed → false (contradicting evidence)", () => {
    const before = { page: page(), target: target({ value: "" }) };
    const after = { page: page(), target: target({ value: "partial" }) };
    expect(verifyDomAction(step("fill", { value: "hello" }), before, after)).toBe(false);
  });

  test("fill + value unchanged → unknown", () => {
    const before = { page: page(), target: target({ value: "keep" }) };
    const after = { page: page(), target: target({ value: "keep" }) };
    expect(verifyDomAction(step("fill", { value: "hello" }), before, after)).toBe("unknown");
  });

  test("fill + target vanished → unknown, not false", () => {
    const before = { page: page(), target: target({ value: "" }) };
    const after = { page: page(), target: target({ connected: false, value: "" }) };
    expect(verifyDomAction(step("fill", { value: "x" }), before, after)).toBe("unknown");
  });

  test("select + value match → true; mismatch → false", () => {
    const b = { page: page(), target: target({ value: "a" }) };
    expect(verifyDomAction(step("select", { value: "b" }), b, { page: page(), target: target({ value: "b" }) })).toBe(true);
    expect(verifyDomAction(step("select", { value: "b" }), b, { page: page(), target: target({ value: "c" }) })).toBe(false);
  });

  test("submit + url change → true; no evidence → unknown", () => {
    const before = { page: page(), target: target() };
    expect(
      verifyDomAction(step("submit"), before, { page: page({ url: "https://app.example.com/next" }), target: target() }),
    ).toBe(true);
    expect(verifyDomAction(step("submit"), before, { page: page(), target: target() })).toBe("unknown");
  });

  test("scroll + scroll delta → true; no delta → unknown", () => {
    const before = { page: page(), target: null };
    expect(verifyDomAction(step("scroll"), before, { page: page({ scrollY: 300 }), target: null })).toBe(true);
    expect(verifyDomAction(step("scroll"), before, { page: page(), target: null })).toBe("unknown");
  });

  test("focus + activeElement → true; else unknown", () => {
    const before = { page: page(), target: target({ focused: false }) };
    expect(verifyDomAction(step("focus"), before, { page: page(), target: target({ focused: true }) })).toBe(true);
    expect(verifyDomAction(step("focus"), before, { page: page(), target: target({ focused: false }) })).toBe("unknown");
  });

  test("navigate + url change → true; unchanged → unknown", () => {
    const before = { page: page(), target: null };
    expect(
      verifyDomAction(step("navigate", { url: "https://x.test/" }), before, { page: page({ url: "https://x.test/" }), target: null }),
    ).toBe(true);
    expect(verifyDomAction(step("navigate", { url: "https://x.test/" }), before, { page: page(), target: null })).toBe("unknown");
  });
});
