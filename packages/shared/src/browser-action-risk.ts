import type { BrowserDomActionPlan, BrowserDomSnapshot } from "./types.js";

/**
 * Deterministic risk classification for planned DOM actions.
 *
 * The planner model's `requiresConfirmation` flag is advisory only — it
 * defaults to true during normalization, so it cannot drive enforcement. This
 * classifier is the policy: it inspects the resolved step targets and flags
 * plans that can send, post, delete, purchase, or enter credentials. The
 * extension background uses it to require explicit user confirmation even in
 * `auto-review` mode.
 */

export type BrowserActionRiskLevel = "routine" | "sensitive";

export interface BrowserActionRiskAssessment {
  level: BrowserActionRiskLevel;
  reasons: string[];
}

// Public or destructive verbs. Matched against the target element's human
// label/text, the step label, and the step reason. Unicode-aware boundaries so
// Vietnamese terms work; `\b` is ASCII-only and would miss them.
const SENSITIVE_TARGET_PATTERN =
  /(?<![\p{L}\p{N}])(?:post|publish|send|submit|delete|remove|purchase|buy|pay|checkout|order|comment|reply|sign(?:ing)?\s*up|register|đăng|gửi|xóa|xoá|mua|thanh\s*toán|đặt\s*hàng|bình\s*luận|trả\s*lời|đăng\s*ký)(?![\p{L}\p{N}])/iu;

const SENSITIVE_STEP_ACTIONS = new Set(["submit"]);
const CREDENTIAL_INPUT_TYPES = new Set(["password"]);

export function assessBrowserDomActionPlan(
  plan: BrowserDomActionPlan,
  snapshot: BrowserDomSnapshot,
): BrowserActionRiskAssessment {
  const reasons = new Set<string>();

  for (const step of plan.steps) {
    if (SENSITIVE_STEP_ACTIONS.has(step.action)) {
      reasons.add("form-submit");
    }

    const element = resolveStepElement(step, snapshot);
    const haystacks = [element?.label, element?.text, element?.placeholder, step.label, step.reason]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0);

    if (haystacks.some((value) => SENSITIVE_TARGET_PATTERN.test(value))) {
      reasons.add("public-or-destructive-target");
    }

    const inputType = element?.inputType?.trim().toLowerCase();
    if (
      (step.action === "fill" || step.action === "select") &&
      inputType &&
      CREDENTIAL_INPUT_TYPES.has(inputType)
    ) {
      reasons.add("credential-entry");
    }
  }

  return {
    level: reasons.size > 0 ? "sensitive" : "routine",
    reasons: Array.from(reasons).sort(),
  };
}

export interface BrowserActionConfirmationDecision {
  /** User already confirmed `page.dom.perform` for this request. */
  operationConfirmed: boolean;
  /** Side-panel `browserActionPermissionMode`; "full" pre-authorizes everything. */
  permissionMode: string;
}

/**
 * Whether a sensitive plan must stop for explicit user confirmation.
 * Routine plans never need it; a confirmed operation or "full" mode do not
 * either — both are explicit user choices.
 */
export function browserActionNeedsConfirmation(
  assessment: BrowserActionRiskAssessment,
  decision: BrowserActionConfirmationDecision,
): boolean {
  if (assessment.level !== "sensitive") {
    return false;
  }
  if (decision.operationConfirmed || decision.permissionMode === "full") {
    return false;
  }
  return true;
}

function resolveStepElement(
  step: BrowserDomActionPlan["steps"][number],
  snapshot: BrowserDomSnapshot,
) {
  return snapshot.elements.find(
    (element) =>
      (step.targetRef && element.ref === step.targetRef) ||
      (step.selector && element.selector === step.selector),
  );
}
