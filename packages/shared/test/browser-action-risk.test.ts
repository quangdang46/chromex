import { describe, expect, test } from "vitest";

import {
  assessBrowserDomActionPlan,
  browserActionNeedsConfirmation,
  type BrowserActionRiskAssessment,
} from "../src/index.js";
import type { BrowserDomActionPlan, BrowserDomSnapshot } from "../src/index.js";

function element(overrides: Partial<BrowserDomSnapshot["elements"][number]> = {}) {
  return {
    ref: "dom-1",
    role: "button",
    tagName: "button",
    label: "",
    text: "",
    selector: "#target",
    disabled: false,
    viewportRect: { left: 0, top: 0, width: 10, height: 10 },
    ...overrides,
  };
}

function snapshot(elements: BrowserDomSnapshot["elements"]): BrowserDomSnapshot {
  return {
    metadata: { title: "Test", url: "https://example.com" } as BrowserDomSnapshot["metadata"],
    elements,
  };
}

function plan(steps: BrowserDomActionPlan["steps"]): BrowserDomActionPlan {
  return { shouldAct: true, summary: "", steps, requiresConfirmation: true, confidence: 1 };
}

describe("assessBrowserDomActionPlan", () => {
  test("routine scroll and focus steps are not sensitive", () => {
    const result = assessBrowserDomActionPlan(
      plan([
        { action: "scroll", direction: "down", amountPx: 400, reason: "Scroll down." },
        { action: "focus", targetRef: "dom-1", reason: "Focus the search box." },
      ]),
      snapshot([element({ ref: "dom-1", role: "searchbox", label: "Search" })]),
    );

    expect(result.level).toBe("routine");
    expect(result.reasons).toEqual([]);
  });

  test("submit action is always sensitive", () => {
    const result = assessBrowserDomActionPlan(
      plan([{ action: "submit", targetRef: "dom-1", reason: "Submit the form." }]),
      snapshot([element({ ref: "dom-1", role: "button", text: "Go" })]),
    );

    expect(result.level).toBe("sensitive");
    expect(result.reasons).toContain("form-submit");
  });

  test("click on a post/publish/delete target is sensitive", () => {
    for (const label of ["Post", "Publish", "Send message", "Delete account", "Xóa bài", "Đăng bình luận"]) {
      const result = assessBrowserDomActionPlan(
        plan([{ action: "click", targetRef: "dom-1", reason: "Click the button." }]),
        snapshot([element({ ref: "dom-1", text: label })]),
      );

      expect(result.level, label).toBe("sensitive");
      expect(result.reasons).toContain("public-or-destructive-target");
    }
  });

  test("click on a benign target is routine", () => {
    const result = assessBrowserDomActionPlan(
      plan([{ action: "click", targetRef: "dom-1", reason: "Open the menu." }]),
      snapshot([element({ ref: "dom-1", text: "Menu", label: "Open navigation" })]),
    );

    expect(result.level).toBe("routine");
  });

  test("fill into a password field is sensitive", () => {
    const result = assessBrowserDomActionPlan(
      plan([{ action: "fill", targetRef: "dom-1", value: "hunter2", reason: "Enter password." }]),
      snapshot([element({ ref: "dom-1", role: "textbox", inputType: "password", label: "Password" })]),
    );

    expect(result.level).toBe("sensitive");
    expect(result.reasons).toContain("credential-entry");
  });

  test("fill into a normal text field is routine", () => {
    const result = assessBrowserDomActionPlan(
      plan([{ action: "fill", targetRef: "dom-1", value: "hello", reason: "Type a note." }]),
      snapshot([element({ ref: "dom-1", role: "textbox", inputType: "text", label: "Note" })]),
    );

    expect(result.level).toBe("routine");
  });

  test("sensitive match also works through selector resolution and step label", () => {
    const result = assessBrowserDomActionPlan(
      plan([{ action: "click", selector: "#buy", label: "Buy now", reason: "Purchase item." }]),
      snapshot([element({ selector: "#buy", text: "Add to cart" })]),
    );

    expect(result.level).toBe("sensitive");
  });

  test("unrelated words containing sensitive substrings do not match", () => {
    const result = assessBrowserDomActionPlan(
      plan([{ action: "click", targetRef: "dom-1", reason: "Open payloads viewer." }]),
      snapshot([element({ ref: "dom-1", text: "Payloads", label: "View payloads" })]),
    );

    expect(result.level).toBe("routine");
  });
});

describe("browserActionNeedsConfirmation", () => {
  const sensitive: BrowserActionRiskAssessment = { level: "sensitive", reasons: ["form-submit"] };
  const routine: BrowserActionRiskAssessment = { level: "routine", reasons: [] };

  test("sensitive plans need confirmation in ask and auto-review modes", () => {
    for (const permissionMode of ["ask", "auto-review"]) {
      expect(
        browserActionNeedsConfirmation(sensitive, { operationConfirmed: false, permissionMode }),
      ).toBe(true);
    }
  });

  test("sensitive plans do not need confirmation in full mode", () => {
    expect(
      browserActionNeedsConfirmation(sensitive, { operationConfirmed: false, permissionMode: "full" }),
    ).toBe(false);
  });

  test("an already-confirmed operation never needs confirmation again", () => {
    expect(
      browserActionNeedsConfirmation(sensitive, { operationConfirmed: true, permissionMode: "auto-review" }),
    ).toBe(false);
  });

  test("routine plans never need confirmation in any mode", () => {
    for (const permissionMode of ["ask", "auto-review", "full"]) {
      expect(
        browserActionNeedsConfirmation(routine, { operationConfirmed: false, permissionMode }),
      ).toBe(false);
    }
  });
});
