import { describe, expect, test } from "vitest";

import { pathPatternMatches, resolveTabBinding, type BindingCandidate } from "../src/gateway/tab-binding.js";
import type { DurableTabDescriptor } from "@codex-sidepanel/shared";

const desc = (over: Partial<DurableTabDescriptor> = {}): DurableTabDescriptor => ({
  profileId: "p1",
  origin: "https://app.example.com",
  pathPattern: "/inbox",
  resolvedAt: 1000,
  originBrowserInstanceId: "bi-1",
  ...over,
});

const tab = (id: number, url: string, over: Partial<BindingCandidate> = {}): BindingCandidate => ({
  tabId: id,
  url,
  title: "Inbox",
  ...over,
});

describe("pathPatternMatches", () => {
  test("exact and wildcard", () => {
    expect(pathPatternMatches("/inbox", "/inbox")).toBe(true);
    expect(pathPatternMatches("/inbox/*", "/inbox/123")).toBe(true);
    expect(pathPatternMatches("/inbox/*", "/other")).toBe(false);
    expect(pathPatternMatches("/inbox", "/inbox/123")).toBe(false);
  });
});

describe("resolveTabBinding — §4.9 restart table", () => {
  test("SW restart (same browserInstanceId): auto rebind on unique match", () => {
    const r = resolveTabBinding(
      { scope: "active_resolved", resolved: desc() },
      [tab(7, "https://app.example.com/inbox")],
      "bi-1",
    );
    expect(r).toMatchObject({ state: "ok", tabId: 7, reason: "bound" });
  });

  test("Chrome restart (new browserInstanceId): stale, never auto-bind", () => {
    const r = resolveTabBinding(
      { scope: "active_resolved", resolved: desc() },
      [tab(7, "https://app.example.com/inbox", { browserInstanceId: "bi-2" })],
      "bi-2",
    );
    expect(r).toMatchObject({ state: "stale", reason: "stale_instance" });
  });

  test("degraded identity (null browserInstanceId): needs_confirmation, never stale", () => {
    const r = resolveTabBinding(
      { scope: "active_resolved", resolved: desc({ originBrowserInstanceId: null }) },
      [tab(7, "https://app.example.com/inbox")],
      null,
    );
    expect(r.state).toBe("needs_confirmation");
    expect(r.reason).toBe("degraded_identity");
  });

  test("tab created in degraded mode, now known instance: needs_confirmation", () => {
    const r = resolveTabBinding(
      { scope: "active_resolved", resolved: desc({ originBrowserInstanceId: null }) },
      [tab(7, "https://app.example.com/inbox")],
      "bi-9",
    );
    expect(r).toMatchObject({ state: "needs_confirmation", reason: "degraded_identity" });
  });

  test("two matching tabs → ambiguous, never auto-pick (even same instance)", () => {
    const r = resolveTabBinding(
      { scope: "active_resolved", resolved: desc({ pathPattern: "/inbox/*" }) },
      [tab(7, "https://app.example.com/inbox/a"), tab(8, "https://app.example.com/inbox/b")],
      "bi-1",
    );
    expect(r).toMatchObject({ state: "needs_confirmation", reason: "ambiguous" });
  });

  test("no matching tab after same-instance restart → stale/tab_closed", () => {
    const r = resolveTabBinding(
      { scope: "active_resolved", resolved: desc() },
      [tab(9, "https://other.example.com/")],
      "bi-1",
    );
    expect(r).toMatchObject({ state: "stale", reason: "tab_closed" });
  });

  test("explicit scope: unique descriptor match binds; zero → stale", () => {
    const intent = { scope: "explicit" as const, refs: [desc()] };
    expect(
      resolveTabBinding(intent, [tab(3, "https://app.example.com/inbox")], "bi-1").state,
    ).toBe("ok");
    expect(resolveTabBinding(intent, [], "bi-1")).toMatchObject({ state: "stale" });
  });

  test("explicit scope with ≥2 matches → ambiguous", () => {
    const intent = { scope: "explicit" as const, refs: [desc({ pathPattern: "/inbox/*" })] };
    const r = resolveTabBinding(
      intent,
      [tab(1, "https://app.example.com/inbox/a"), tab(2, "https://app.example.com/inbox/b")],
      "bi-1",
    );
    expect(r).toMatchObject({ state: "needs_confirmation", reason: "ambiguous" });
  });

  test("untitled → needs_confirmation (user re-picks)", () => {
    expect(resolveTabBinding({ scope: "untitled" }, [], "bi-1")).toMatchObject({
      state: "needs_confirmation",
      reason: "untitled",
    });
  });
});
