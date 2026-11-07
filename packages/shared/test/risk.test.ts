import { describe, expect, test } from "vitest";

import {
  allowTaskScope,
  classifyActionRisk,
  detectSensitiveContent,
  type ActionContext,
} from "../src/browser/risk.js";

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  backendId: "chrome-extension",
  profileId: "p1",
  tabId: 1,
  url: "",
  origin: "https://app.example.com",
  action: "browser.page.click",
  withinTabScope: true,
  contextResolved: true,
  ...over,
});

describe("classifyActionRisk — §4.8 matrix", () => {
  test("read tools → read, no approval", () => {
    for (const a of ["browser.page.snapshot", "browser.page.get", "browser.tabs.list", "browser.page.wait"] as const) {
      const v = classifyActionRisk(ctx({ action: a }));
      expect(v.risk).toBe("read");
      expect(v.needsApproval).toBe(false);
    }
  });

  test("scroll/activate → low", () => {
    expect(classifyActionRisk(ctx({ action: "browser.page.scroll" })).risk).toBe("low");
    expect(classifyActionRisk(ctx({ action: "browser.tab.activate" })).risk).toBe("low");
  });

  test("navigate http(s) resolved → low; unresolved → external_mutation approval", () => {
    expect(
      classifyActionRisk(ctx({ action: "browser.page.navigate", url: "https://x.test/", origin: "https://x.test", contextResolved: true })).risk,
    ).toBe("low");
    const v = classifyActionRisk(ctx({ action: "browser.page.navigate", url: "", contextResolved: false }));
    expect(v).toMatchObject({ risk: "external_mutation", needsApproval: true, kind: "browser_action" });
  });

  test("fill plain field → data_entry allow; password → data_entry_sensitive approval, no allow_task", () => {
    expect(classifyActionRisk(ctx({ action: "browser.page.fill", target: { ref: "e1", label: "Name" } })).risk).toBe("data_entry");
    const v = classifyActionRisk(ctx({ action: "browser.page.fill", target: { ref: "e2", isPassword: true } }));
    expect(v).toMatchObject({ risk: "data_entry_sensitive", needsApproval: true, allowTaskEligible: false });
  });

  test("fill autosave or unresolved → approval", () => {
    expect(classifyActionRisk(ctx({ action: "browser.page.fill", target: { ref: "e1", autosave: true } })).needsApproval).toBe(true);
    expect(classifyActionRisk(ctx({ action: "browser.page.fill", contextResolved: false })).needsApproval).toBe(true);
  });

  test("click benign resolved → low; submit-label/form POST/unresolved → external_mutation", () => {
    expect(classifyActionRisk(ctx({ action: "browser.page.click", target: { ref: "e1", label: "OK" } })).risk).toBe("low");
    expect(classifyActionRisk(ctx({ action: "browser.page.click", target: { ref: "e1", label: "Submit" } })).needsApproval).toBe(true);
    expect(classifyActionRisk(ctx({ action: "browser.page.click", target: { ref: "e1", method: "POST" } })).needsApproval).toBe(true);
    expect(classifyActionRisk(ctx({ action: "browser.page.click", contextResolved: false })).needsApproval).toBe(true);
  });

  test("payment origin or isPayment → financial, approval, never allow_task", () => {
    const v1 = classifyActionRisk(ctx({ action: "browser.page.click", origin: "https://paypal.com", url: "https://paypal.com/x" }));
    expect(v1).toMatchObject({ risk: "financial", needsApproval: true, allowTaskEligible: false });
    const v2 = classifyActionRisk(ctx({ action: "browser.page.fill", target: { ref: "e1", isPayment: true } }));
    expect(v2.risk).toBe("financial");
  });

  test("outside tab scope → deny (terminal)", () => {
    expect(classifyActionRisk(ctx({ withinTabScope: false })).risk).toBe("deny");
  });

  test("agentEgress sensitive or non-local → agent_egress approval, allow_once only", () => {
    const v = classifyActionRisk(ctx({
      action: "browser.page.screenshot",
      agentEgress: { dataClass: "screenshot", destination: "cloud-provider", sensitiveContent: true },
    }));
    expect(v).toMatchObject({ needsApproval: true, kind: "agent_egress", allowTaskEligible: false });
    const local = classifyActionRisk(ctx({
      action: "browser.page.extract",
      agentEgress: { dataClass: "page-text", destination: "local-provider" },
    }));
    expect(local.needsApproval).toBe(false);
  });

  test("unknown tool → fail closed external_mutation", () => {
    const v = classifyActionRisk(ctx({ action: "browser.page.evaluate" as never }));
    expect(v.needsApproval).toBe(true);
  });

  test("external_mutation never offers allow_task (§4.8 forbidden combo)", () => {
    const verdicts = [
      classifyActionRisk(ctx({ action: "browser.page.navigate", url: "", contextResolved: false })),
      classifyActionRisk(ctx({ action: "browser.page.navigate", url: "notaurl", contextResolved: true })),
      classifyActionRisk(ctx({ action: "browser.page.click", target: { ref: "e1", label: "Pay now" } })),
      classifyActionRisk(ctx({ action: "browser.page.click", contextResolved: false })),
      classifyActionRisk(ctx({ action: "browser.page.submit", target: { ref: "e1", method: "POST" } })),
      classifyActionRisk(ctx({ action: "browser.page.evaluate" as never })),
    ];
    for (const v of verdicts) {
      expect(v.risk).toBe("external_mutation");
      expect(v.needsApproval).toBe(true);
      expect(v.allowTaskEligible).toBe(false);
    }
  });
});

describe("allowTaskScope + detectSensitiveContent", () => {
  test("scope is tool+origin+targetFormIntent+dataClass+destination", () => {
    const s = allowTaskScope(
      ctx({
        action: "browser.page.fill",
        target: { ref: "e1", label: "Name" },
        agentEgress: { dataClass: "none", destination: "local-provider" },
      }),
    );
    expect(s.split("|")).toEqual([
      "browser.page.fill",
      "https://app.example.com",
      "generic",
      "none",
      "local-provider",
    ]);
  });

  test("targetFormIntent distinguishes payment/password/form-method/label intents", () => {
    const scope = (target: ActionContext["target"]) =>
      allowTaskScope(ctx({ action: "browser.page.click", target })).split("|")[2];
    expect(scope({ ref: "e1", isPayment: true })).toBe("payment");
    expect(scope({ ref: "e1", isPassword: true })).toBe("password");
    expect(scope({ ref: "e1", method: "POST" })).toBe("form-post");
    expect(scope({ ref: "e1", autosave: true })).toBe("autosave");
    expect(scope({ ref: "e1", isDestructive: true })).toBe("destructive");
    expect(scope({ ref: "e1", label: "Search" })).toBe("search");
    expect(scope({ ref: "e1", label: "Pay now" })).toBe("purchase");
    expect(scope(undefined)).toBe("none");
  });
  test("PII detection", () => {
    expect(detectSensitiveContent("contact me at a@b.com")).toBe(true);
    expect(detectSensitiveContent("hello world")).toBe(false);
    expect(detectSensitiveContent(undefined)).toBe(false);
  });
});
