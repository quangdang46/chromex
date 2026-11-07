import type { BrowserToolName } from "./tool.js";
import type { BrowserBackendId } from "./backend.js";

/**
 * Risk levels — classifier output vocabulary (plan §4.8).
 * "hard_block" and "deny" are terminal: approval can NEVER bypass them.
 */
export type RiskLevel =
  | "read"
  | "low"
  | "data_entry"
  | "data_entry_sensitive"
  | "external_mutation"
  | "financial"
  | "deny"
  | "hard_block";

export type AgentEgressDataClass = "none" | "page-text" | "screenshot" | "attachment";
export type AgentEgressDestination =
  | "local-provider"
  | "cloud-provider"
  | "external-mcp"
  | "logs-telemetry";

export interface ActionContext {
  backendId: BrowserBackendId;
  profileId: string;
  tabId: number | string;
  url: string;
  origin: string;
  action: BrowserToolName;
  target?: {
    ref?: string;
    role?: string;
    tag?: string;
    inputType?: string;
    label?: string;
    name?: string;
    formAction?: string;
    method?: string;
    autosave?: boolean;
    isPassword?: boolean;
    isPayment?: boolean;
    isDestructive?: boolean;
  };
  dataEgress?: "none" | "page-local" | "network-form" | "download";
  /**
   * Data LEAVING the browser. Separate dimension: dataClass × destination
   * (trust boundary). Plan §4.8 P1.7/P1.8.
   */
  agentEgress?: {
    dataClass: AgentEgressDataClass;
    destination: AgentEgressDestination;
    /** page shows signs of sensitive non-password data (PII, email, card, address…) */
    sensitiveContent?: boolean;
  };
  /** public post/send/publish/submit side effect */
  publicSideEffect?: boolean;
  /** file picker, site blocks synthetic events */
  requiresUserGesture?: boolean;
  withinTabScope: boolean;
  /** false when classifier cannot determine target/form/origin semantics → fail closed */
  contextResolved: boolean;
}

// ---------------------------------------------------------------------------
// §4.8 contextual classifier — risk from action + target + page + data,
// never from the action name alone. Fail-closed: unresolved context on a
// mutating action degrades to external_mutation (approval).
// ---------------------------------------------------------------------------

export interface RiskVerdict {
  risk: RiskLevel;
  /** approval required before dispatch */
  needsApproval: boolean;
  /** PermissionRequest.kind when approval is required */
  kind?: "browser_action" | "provider_permission" | "data_entry_sensitive" | "agent_egress";
  /** allow_task may be offered for this verdict (plan §4.8 forbidden combos) */
  allowTaskEligible: boolean;
  reason: string;
}

const READ_TOOLS = new Set([
  "browser.page.snapshot",
  "browser.page.get",
  "browser.tabs.list",
  "browser.page.extract",
  "browser.page.wait",
  "browser.page.console",
]);

const NAVIGATE_RISKY_HOST = /(^|\.)(paypal|stripe|checkout|billing|payments?|auth|login|signin|account|verify|confirm)\./i;

function isFinancialOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname.toLowerCase();
    return NAVIGATE_RISKY_HOST.test(host) || /\b(pay|card|bank)\b/.test(host);
  } catch {
    return false;
  }
}

const PII_PATTERN = /[\w.+-]+@[\w-]+\.[\w.]+|\b\d{3}[- ]?\d{3}[- ]?\d{4}\b|\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/;

export function detectSensitiveContent(text: string | undefined): boolean {
  if (!text) return false;
  return PII_PATTERN.test(text.slice(0, 4000));
}

/**
 * Classify an ActionContext into a risk verdict. Hard blocks and scope
 * denials are terminal — approval can never bypass them.
 */
export function classifyActionRisk(ctx: ActionContext): RiskVerdict {
  const verdict = (risk: RiskLevel, opts: Partial<RiskVerdict> = {}): RiskVerdict => ({
    risk,
    needsApproval: false,
    allowTaskEligible: false,
    reason: "",
    ...opts,
  });

  // scope/profile denials — terminal
  if (!ctx.withinTabScope) {
    return verdict("deny", { reason: "target outside tab scope" });
  }

  // agentEgress is a separate risk dimension (§4.8 rule 2): page data
  // leaving the browser needs approval when sensitive or non-local.
  const egress = ctx.agentEgress;
  if (egress && egress.dataClass !== "none") {
    const sensitive = egress.sensitiveContent === true;
    const nonLocal = egress.destination !== "local-provider";
    if (sensitive || nonLocal) {
      // forbidden combos → allow_once only (screenshot egress, sensitive,
      // or any non-local destination)
      return verdict("external_mutation", {
        needsApproval: true,
        kind: "agent_egress",
        allowTaskEligible: false,
        reason: sensitive
          ? "sensitive page content egress requires approval"
          : "data egress to non-local destination requires approval",
      });
    }
  }

  if (READ_TOOLS.has(ctx.action)) {
    return verdict("read", { reason: "read-only tool" });
  }

  if (ctx.action === "browser.page.screenshot") {
    return verdict("read", {
      reason: "screenshot is read + agentEgress (handled above)",
    });
  }

  const t = ctx.target;
  const financial = isFinancialOrigin(ctx.origin) || t?.isPayment === true;

  if (financial) {
    // financial → approval, NEVER allow_task (§4.8)
    return verdict("financial", {
      needsApproval: true,
      kind: "browser_action",
      allowTaskEligible: false,
      reason: "payment/auth context requires approval",
    });
  }

  switch (ctx.action) {
    case "browser.page.scroll":
    case "browser.tab.activate":
      return verdict("low", { reason: "low-risk navigation/UI action" });

    case "browser.page.navigate": {
      const dest = ctx.url || "";
      let ok = false;
      try {
        const u = new URL(dest);
        ok = (u.protocol === "http:" || u.protocol === "https:") && ctx.contextResolved;
      } catch {
        ok = false;
      }
      if (ok && !isFinancialOrigin(dest)) {
        return verdict("low", { reason: "http(s) navigation with resolved context" });
      }
      // external_mutation → approval, NEVER allow_task (§4.8 forbidden combo)
      return verdict("external_mutation", {
        needsApproval: true,
        kind: "browser_action",
        allowTaskEligible: false,
        reason: "navigation target or side effect unresolved",
      });
    }

    case "browser.page.fill":
    case "browser.page.type":
    case "browser.page.select": {
      if (t?.isPassword || t?.isPayment) {
        return verdict("data_entry_sensitive", {
          needsApproval: true,
          kind: "data_entry_sensitive",
          allowTaskEligible: false,
          reason: "password/payment field entry requires approval",
        });
      }
      if (t?.autosave || !ctx.contextResolved) {
        return verdict("data_entry_sensitive", {
          needsApproval: true,
          kind: "data_entry_sensitive",
          allowTaskEligible: false,
          reason: "autosave or unresolved form context requires approval",
        });
      }
      return verdict("data_entry", { reason: "plain field entry" });
    }

    case "browser.page.click":
    case "browser.page.submit":
    case "browser.page.hover":
    case "browser.page.press": {
      const destructiveLabel = /submit|send|post|publish|delete|confirm|pay|purchase|order|transfer/i;
      const formMutating = t?.method ? t.method.toUpperCase() !== "GET" : false;
      if (t?.isDestructive || destructiveLabel.test(t?.label ?? "") || formMutating || !ctx.contextResolved) {
        // external_mutation → approval, NEVER allow_task (§4.8 forbidden combo)
        return verdict("external_mutation", {
          needsApproval: true,
          kind: "browser_action",
          allowTaskEligible: false,
          reason: "click may trigger a public/external side effect",
        });
      }
      return verdict("low", { reason: "click with resolved benign context" });
    }

    case "browser.page.focus":
      return verdict("low", { reason: "focus is low-risk" });

    case "browser.tab.create": {
      // Opening a tab is a mutation (new page load, possible egress), so
      // it is never `read`. Blank or resolved http(s) targets are low;
      // anything else fails closed to approval like navigate.
      const dest = ctx.url || "";
      if (dest === "") {
        return verdict("low", { reason: "new blank tab" });
      }
      let ok = false;
      try {
        const u = new URL(dest);
        ok = (u.protocol === "http:" || u.protocol === "https:") && ctx.contextResolved;
      } catch {
        ok = false;
      }
      if (ok) {
        return verdict("low", { reason: "new tab to resolved http(s) url" });
      }
      return verdict("external_mutation", {
        needsApproval: true,
        kind: "browser_action",
        allowTaskEligible: false,
        reason: "tab.create target unresolved",
      });
    }

    default:
      // unknown tool → fail closed for anything that isn't provably read
      return verdict("external_mutation", {
        needsApproval: true,
        kind: "browser_action",
        allowTaskEligible: false,
        reason: "unclassified tool — fail closed",
      });
  }
}

/**
 * Deterministic targetFormIntent for the allow_task scope (§4.8): what the
 * target DOES, so a grant on one intent (search box) can't leak to another
 * (pay button) on the same origin. Derived from ActionContext.target only.
 */
function targetFormIntent(ctx: ActionContext): string {
  const t = ctx.target;
  if (!t) return "none";
  if (t.isPayment) return "payment";
  if (t.isPassword) return "password";
  const method = t.method?.toUpperCase();
  if (method && method !== "GET") return `form-${method.toLowerCase()}`;
  if (t.autosave) return "autosave";
  if (t.isDestructive) return "destructive";
  const label = `${t.label ?? ""} ${t.name ?? ""}`.toLowerCase();
  if (/pay|purchase|checkout|order|buy|transfer/.test(label)) return "purchase";
  if (/search/.test(label)) return "search";
  if (/submit|send|post|publish|delete|confirm/.test(label)) return "submit";
  return "generic";
}

/** Canonical allow_task scope (§4.8): tool + origin + targetFormIntent + dataClass + destination. */
export function allowTaskScope(ctx: ActionContext): string {
  return [
    ctx.action,
    ctx.origin,
    targetFormIntent(ctx),
    ctx.agentEgress?.dataClass ?? "none",
    ctx.agentEgress?.destination ?? "none",
  ].join("|");
}
