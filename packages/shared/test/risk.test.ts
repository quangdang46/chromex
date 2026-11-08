import { describe, expect, test } from "vitest";

import {
  agentEgressTaskScope,
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

  test("agentEgress egressTaskEligible: clean page-text only — screenshot/sensitive stay per-call", () => {
    // non-sensitive page-text to a non-local destination → task grant offered
    const clean = classifyActionRisk(ctx({
      action: "browser.page.snapshot",
      agentEgress: { dataClass: "page-text", destination: "cloud-provider" },
    }));
    expect(clean).toMatchObject({
      needsApproval: true,
      kind: "agent_egress",
      allowTaskEligible: false,
      egressTaskEligible: true,
    });
    // sensitive content → never grantable
    const sensitive = classifyActionRisk(ctx({
      action: "browser.page.snapshot",
      agentEgress: { dataClass: "page-text", destination: "cloud-provider", sensitiveContent: true },
    }));
    expect(sensitive.egressTaskEligible).toBe(false);
    // screenshots → never grantable (spec: screenshot egress is allow_once only)
    const shot = classifyActionRisk(ctx({
      action: "browser.page.screenshot",
      agentEgress: { dataClass: "screenshot", destination: "cloud-provider" },
    }));
    expect(shot).toMatchObject({ needsApproval: true, kind: "agent_egress" });
    expect(shot.egressTaskEligible).toBe(false);
    // local non-sensitive → no approval at all
    const local = classifyActionRisk(ctx({
      action: "browser.page.snapshot",
      agentEgress: { dataClass: "page-text", destination: "local-provider" },
    }));
    expect(local.needsApproval).toBe(false);
    expect(local.egressTaskEligible).toBeFalsy();
  });

  test("browser.page.console is read; tab.create/hover/press classified (chromex-he2/nr8/cly)", () => {
    expect(classifyActionRisk(ctx({ action: "browser.page.console" })).risk).toBe("read");

    // tab.create: blank or resolved http(s) → low; anything else approval
    expect(classifyActionRisk(ctx({ action: "browser.tab.create", url: "" })).risk).toBe("low");
    expect(
      classifyActionRisk(
        ctx({ action: "browser.tab.create", url: "https://x.test/p", origin: "https://x.test" }),
      ).risk,
    ).toBe("low");
    const bad = classifyActionRisk(
      ctx({ action: "browser.tab.create", url: "javascript:alert(1)", origin: "" }),
    );
    expect(bad).toMatchObject({ risk: "external_mutation", needsApproval: true, allowTaskEligible: false });

    // hover/press share the click/submit contextual rules
    expect(
      classifyActionRisk(ctx({ action: "browser.page.hover", target: { ref: "e1", label: "Menu" } })).risk,
    ).toBe("low");
    expect(classifyActionRisk(ctx({ action: "browser.page.hover", contextResolved: false })).needsApproval).toBe(true);
    expect(classifyActionRisk(ctx({ action: "browser.page.press", contextResolved: true })).risk).toBe("low");
    expect(
      classifyActionRisk(ctx({ action: "browser.page.press", target: { ref: "e1", label: "Delete account" } }))
        .needsApproval,
    ).toBe(true);
  });

  test("page.find/downloads.list are read; history is low mutation; upload is sensitive approval", () => {
    expect(classifyActionRisk(ctx({ action: "browser.page.find" })).risk).toBe("read");
    expect(classifyActionRisk(ctx({ action: "browser.downloads.list" })).risk).toBe("read");
    expect(classifyActionRisk(ctx({ action: "browser.page.history" })).risk).toBe("low");

    const up = classifyActionRisk(
      ctx({ action: "browser.page.upload", target: { ref: "e1", tag: "input", inputType: "file" } }),
    );
    expect(up).toMatchObject({
      risk: "data_entry_sensitive",
      needsApproval: true,
      kind: "data_entry_sensitive",
      allowTaskEligible: false,
    });
    // financial origin still wins over the upload case.
    const fin = classifyActionRisk(
      ctx({
        action: "browser.page.upload",
        origin: "https://paypal.com",
        url: "https://paypal.com/x",
        target: { ref: "e1" },
      }),
    );
    expect(fin.risk).toBe("financial");
  });

  test("browser.page.cookies: metadata read; values/mutations always approval", () => {
    // list without values → read (values withheld by the backend)
    const meta = classifyActionRisk(ctx({ action: "browser.page.cookies", cookieOp: "list" }));
    expect(meta.risk).toBe("read");
    expect(meta.needsApproval).toBe(false);
    // includeValues → credential-grade egress, per-call approval
    const vals = classifyActionRisk(
      ctx({ action: "browser.page.cookies", cookieOp: "list", cookieValues: true }),
    );
    expect(vals).toMatchObject({
      risk: "external_mutation",
      needsApproval: true,
      kind: "agent_egress",
      allowTaskEligible: false,
    });
    // set/delete/clear → session mutation, never task-eligible
    for (const op of ["set", "delete", "clear"]) {
      const v = classifyActionRisk(ctx({ action: "browser.page.cookies", cookieOp: op }));
      expect(v).toMatchObject({
        risk: "external_mutation",
        needsApproval: true,
        kind: "browser_action",
        allowTaskEligible: false,
      });
    }
  });

  test("browser.page.localStorage: keys read; values/mutations always approval", () => {
    const keys = classifyActionRisk(ctx({ action: "browser.page.localStorage", storageOp: "list" }));
    expect(keys.risk).toBe("read");
    expect(keys.needsApproval).toBe(false);
    for (const [op, vals] of [["get", true], ["list", true], ["set", false], ["remove", false], ["clear", false]] as const) {
      const v = classifyActionRisk(
        ctx({ action: "browser.page.localStorage", storageOp: op, storageValues: vals }),
      );
      expect(v.needsApproval).toBe(true);
      expect(v.allowTaskEligible).toBe(false);
    }
    // mutations are browser_action; value reads are agent_egress
    expect(
      classifyActionRisk(ctx({ action: "browser.page.localStorage", storageOp: "set" })).kind,
    ).toBe("browser_action");
    expect(
      classifyActionRisk(ctx({ action: "browser.page.localStorage", storageOp: "get", storageValues: true })).kind,
    ).toBe("agent_egress");
  });

  test("browser.page.indexedDB: metadata/keys read; get/mutations always approval", () => {
    for (const op of ["listDbs", "listStores", "keys"]) {
      const v = classifyActionRisk(ctx({ action: "browser.page.indexedDB", storageOp: op }));
      expect(v.risk).toBe("read");
      expect(v.needsApproval).toBe(false);
    }
    for (const op of ["get", "put", "delete", "clear", "createStore"]) {
      const v = classifyActionRisk(ctx({ action: "browser.page.indexedDB", storageOp: op }));
      expect(v.needsApproval).toBe(true);
      expect(v.allowTaskEligible).toBe(false);
    }
    expect(
      classifyActionRisk(ctx({ action: "browser.page.indexedDB", storageOp: "put" })).kind,
    ).toBe("browser_action");
    expect(
      classifyActionRisk(ctx({ action: "browser.page.indexedDB", storageOp: "get", storageValues: true })).kind,
    ).toBe("agent_egress");
  });

  test("browser.bookmarks: reads are egress-gated; mutations always approval", () => {
    for (const op of ["list", "search", "get"]) {
      const v = classifyActionRisk(ctx({ action: "browser.bookmarks", bookmarkOp: op }));
      expect(v.risk).toBe("read");
      expect(v.needsApproval).toBe(false);
    }
    for (const op of ["create", "update", "remove"]) {
      const v = classifyActionRisk(ctx({ action: "browser.bookmarks", bookmarkOp: op }));
      expect(v.needsApproval).toBe(true);
      expect(v.allowTaskEligible).toBe(false);
      expect(v.kind).toBe("browser_action");
    }
    // default op is list → read
    expect(classifyActionRisk(ctx({ action: "browser.bookmarks" })).risk).toBe("read");
  });

  test("browser.page.caches: metadata reads; match egress; mutations approval", () => {
    for (const op of ["listCaches", "listKeys"]) {
      const v = classifyActionRisk(ctx({ action: "browser.page.caches", cacheOp: op }));
      expect(v.risk).toBe("read");
      expect(v.needsApproval).toBe(false);
    }
    const match = classifyActionRisk(ctx({ action: "browser.page.caches", cacheOp: "match" }));
    expect(match.needsApproval).toBe(true);
    expect(match.kind).toBe("agent_egress");
    expect(match.allowTaskEligible).toBe(false);
    for (const op of ["put", "delete", "clear"]) {
      const v = classifyActionRisk(ctx({ action: "browser.page.caches", cacheOp: op }));
      expect(v.needsApproval).toBe(true);
      expect(v.allowTaskEligible).toBe(false);
      expect(v.kind).toBe("browser_action");
    }
    expect(classifyActionRisk(ctx({ action: "browser.page.caches" })).risk).toBe("read");
  });

  test("browser.page.serviceWorker: list read; unregister approval", () => {
    const list = classifyActionRisk(ctx({ action: "browser.page.serviceWorker", swOp: "list" }));
    expect(list.risk).toBe("read");
    expect(list.needsApproval).toBe(false);
    for (const op of ["unregister", "update"] as const) {
      const v = classifyActionRisk(ctx({ action: "browser.page.serviceWorker", swOp: op }));
      expect(v.needsApproval).toBe(true);
      expect(v.allowTaskEligible).toBe(false);
      expect(v.kind).toBe("browser_action");
    }
    expect(classifyActionRisk(ctx({ action: "browser.page.serviceWorker" })).risk).toBe("read");
  });

  test("browser.history.delete: always approval, never task-eligible", () => {
    const v = classifyActionRisk(ctx({ action: "browser.history.delete" }));
    expect(v.risk).toBe("external_mutation");
    expect(v.needsApproval).toBe(true);
    expect(v.allowTaskEligible).toBe(false);
    expect(v.kind).toBe("browser_action");
  });

  test("browser.page.cdp: always approval, never task-eligible", () => {
    for (const action of ["browser.page.cdp"] as const) {
      const v = classifyActionRisk(ctx({ action }));
      expect(v.risk).toBe("external_mutation");
      expect(v.needsApproval).toBe(true);
      expect(v.allowTaskEligible).toBe(false);
      expect(v.kind).toBe("browser_action");
    }
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
  test("agentEgressTaskScope binds the egress class, not the action", () => {
    const s = agentEgressTaskScope({ dataClass: "page-text", destination: "cloud-provider" });
    expect(s).toBe("agent-egress|page-text|cloud-provider");
    expect(agentEgressTaskScope({ dataClass: "screenshot", destination: "cloud-provider" })).not.toBe(s);
  });

  test("PII detection", () => {
    expect(detectSensitiveContent("contact me at a@b.com")).toBe(true);
    expect(detectSensitiveContent("hello world")).toBe(false);
    expect(detectSensitiveContent(undefined)).toBe(false);
  });
});
