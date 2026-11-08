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
  /** browser.page.cookies sub-action — the same tool name spans read
   *  (list metadata), credential egress (list values) and session
   *  mutation (set/delete/clear), so the classifier needs the op. */
  cookieOp?: string;
  /** list was asked to include cookie values — credential-grade egress */
  cookieValues?: boolean;
  /** browser.page.localStorage sub-action — same tool name spans
   *  keys-only read, value egress and storage mutation. */
  storageOp?: string;
  /** storage list/get returns values — page data egress */
  storageValues?: boolean;
  /** browser.bookmarks sub-action — reads are profile-data egress,
   *  create/update/remove mutate the user's bookmark tree. */
  bookmarkOp?: string;
  /** browser.page.caches sub-action — key/metadata lists are reads,
   *  match returns response bodies (egress), put/delete/clear mutate
   *  the Cache API store. */
  cacheOp?: string;
  /** browser.page.serviceWorker sub-action — list is a read,
   *  unregister mutates the origin's worker registrations. */
  swOp?: string;
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
  /** agent_egress verdicts may offer the task-scoped egress grant
   *  ("allow_egress_task"): ONLY non-sensitive page-text egress.
   *  Screenshots, sensitiveContent and other dataClasses stay
   *  allow_once-only — the grant never widens §4.8's forbidden combos. */
  egressTaskEligible?: boolean;
  reason: string;
}

const READ_TOOLS = new Set([
  "browser.page.snapshot",
  "browser.page.get",
  "browser.tabs.list",
  "browser.page.extract",
  "browser.page.wait",
  "browser.page.console",
  "browser.page.find",
  "browser.downloads.list",
  "browser.page.network",
  // CDP tier (docs/adr/debugger-tier.md): response bodies are page
  // content — same read+egress class as extract/find.
  "browser.page.responseBody",
  // WS frames are page-originated payload content — same read+egress
  // class as responseBody (page-text, bounded, approval-gated).
  "browser.page.webSocket",
  "browser.windows.list",
  // browsing history is personal data leaving the browser — same
  // egress gate as page text (approval for non-local destinations)
  "browser.history.search",
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
        // per-task egress grant covers clean page-text reads only —
        // screenshots and sensitive content keep per-call approval.
        egressTaskEligible: !sensitive && egress.dataClass === "page-text",
        reason: sensitive
          ? "sensitive page content egress requires approval"
          : "data egress to non-local destination requires approval",
      });
    }
  }

  if (READ_TOOLS.has(ctx.action)) {
    return verdict("read", { reason: "read-only tool" });
  }

  if (ctx.action === "browser.page.pdf") {
    return verdict("read", {
      reason: "pdf capture is read + agentEgress (handled above)",
    });
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
    case "browser.page.history":
    case "browser.page.emulate":
      // Emulation overrides are local, reversible (reset:true) and have
      // no external side effect — same class as scroll/activate.
      return verdict("low", { reason: "low-risk navigation/UI action" });

    case "browser.page.unroute": {
      // Removes agent-installed interception — restores real network
      // traffic; cannot create new capability. Low like scroll.
      return verdict("low", { reason: "removes agent-installed route interception" });
    }

    case "browser.page.route": {
      // Fulfilled responses inject arbitrary content into the page and
      // mask real server replies — the classifier cannot inspect the
      // body, so approval is always required, never allow_task.
      return verdict("external_mutation", {
        needsApproval: true,
        kind: "browser_action",
        allowTaskEligible: false,
        reason: "route fulfillment injects response content into the page",
      });
    }

    case "browser.page.setInputFiles": {
      // Local paths enter the page like upload bytes — sensitive entry,
      // approval always required (allow_task never offered).
      return verdict("data_entry_sensitive", {
        needsApproval: true,
        kind: "data_entry_sensitive",
        allowTaskEligible: false,
        reason: "file paths enter user data into the page",
      });
    }

    case "browser.page.dialog": {
      // Accepting a JS dialog can confirm a side effect (confirm/alert
      // flows); dismissing is safer but the classifier cannot see args —
      // approval always required.
      return verdict("external_mutation", {
        needsApproval: true,
        kind: "browser_action",
        allowTaskEligible: false,
        reason: "dialog accept/dismiss may resolve a page side effect",
      });
    }

    case "browser.page.upload": {
      // File bytes enter the page like typed data — sensitive entry.
      // The classifier cannot see file contents, so approval is always
      // required (allow_task is never offered for sensitive entry).
      return verdict("data_entry_sensitive", {
        needsApproval: true,
        kind: "data_entry_sensitive",
        allowTaskEligible: false,
        reason: "file upload enters user data into the page",
      });
    }

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
    case "browser.page.press":
    case "browser.page.drag": {
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

    case "browser.page.evaluate": {
      // Arbitrary JS in the page's main world can read page state,
      // mutate the DOM, and trigger network egress — the classifier
      // cannot inspect the expression, so approval is always required
      // and allow_task is never offered (§4.8).
      return verdict("external_mutation", {
        needsApproval: true,
        kind: "browser_action",
        allowTaskEligible: false,
        reason: "arbitrary page script execution requires approval",
      });
    }

    case "browser.tab.duplicate": {
      // Cloning a tab reloads its URL — same exposure as tab.create to
      // the resolved target. Unresolved contexts fail closed.
      const dest = ctx.url || "";
      let ok = false;
      try {
        const u = new URL(dest);
        ok = (u.protocol === "http:" || u.protocol === "https:") && ctx.contextResolved;
      } catch {
        ok = false;
      }
      if (ok) {
        return verdict("low", { reason: "duplicate resolved http(s) tab" });
      }
      return verdict("external_mutation", {
        needsApproval: true,
        kind: "browser_action",
        allowTaskEligible: false,
        reason: "tab.duplicate target unresolved",
      });
    }

    case "browser.windows.create": {
      // Same exposure model as tab.create: a new window loading a URL
      // is a mutation; resolved http(s)/blank stays low, anything else
      // fails closed to approval.
      const dest = ctx.url || "";
      if (dest === "") {
        return verdict("low", { reason: "new blank window" });
      }
      let ok = false;
      try {
        const u = new URL(dest);
        ok = (u.protocol === "http:" || u.protocol === "https:") && ctx.contextResolved;
      } catch {
        ok = false;
      }
      if (ok) {
        return verdict("low", { reason: "new window to resolved http(s) url" });
      }
      return verdict("external_mutation", {
        needsApproval: true,
        kind: "browser_action",
        allowTaskEligible: false,
        reason: "windows.create target unresolved",
      });
    }

    case "browser.tab.update":
    case "browser.tab.discard":
      // Scoped tab chrome ops — pin/mute are trivially reversible;
      // discard unloads the page (state loss possible) but only on
      // task-owned tabs, same blast radius as tab.close/reload.
      return verdict("low", { reason: "scoped tab lifecycle op" });

    case "browser.page.cookies": {
      const op = ctx.cookieOp ?? "list";
      if (op === "set" || op === "delete" || op === "clear") {
        // Session-state mutation: injecting or removing cookies can
        // hijack or destroy the user's login — never task-eligible.
        return verdict("external_mutation", {
          needsApproval: true,
          kind: "browser_action",
          allowTaskEligible: false,
          reason: "cookie mutation changes session state",
        });
      }
      if (ctx.cookieValues === true) {
        // Values are session tokens / credentials leaving the browser —
        // per-call approval regardless of destination.
        return verdict("external_mutation", {
          needsApproval: true,
          kind: "agent_egress",
          allowTaskEligible: false,
          reason: "cookie values are credential-grade — per-call approval",
        });
      }
      return verdict("read", { reason: "cookie metadata list (values withheld)" });
    }

    case "browser.page.localStorage": {
      const op = ctx.storageOp ?? "list";
      if (op === "set" || op === "remove" || op === "clear") {
        // Web-storage mutation can corrupt app state / session tokens —
        // never task-eligible.
        return verdict("external_mutation", {
          needsApproval: true,
          kind: "browser_action",
          allowTaskEligible: false,
          reason: "web storage mutation changes page state",
        });
      }
      if (op === "get" || ctx.storageValues === true) {
        // Stored values are page data — often tokens/session state —
        // per-call approval regardless of destination.
        return verdict("external_mutation", {
          needsApproval: true,
          kind: "agent_egress",
          allowTaskEligible: false,
          reason: "web storage values are page data — per-call approval",
        });
      }
      return verdict("read", { reason: "storage key list (values withheld)" });
    }

    case "browser.page.indexedDB": {
      const op = ctx.storageOp ?? "listDbs";
      if (op === "put" || op === "delete" || op === "clear" || op === "createStore") {
        // IDB mutation corrupts app state — never task-eligible.
        return verdict("external_mutation", {
          needsApproval: true,
          kind: "browser_action",
          allowTaskEligible: false,
          reason: "indexedDB mutation changes page state",
        });
      }
      if (op === "get" || ctx.storageValues === true) {
        return verdict("external_mutation", {
          needsApproval: true,
          kind: "agent_egress",
          allowTaskEligible: false,
          reason: "indexedDB values are page data — per-call approval",
        });
      }
      return verdict("read", { reason: "indexedDB metadata/key list" });
    }

    case "browser.browsingData.clear": {
      // Wipes browsing data across the whole profile — the per-origin
      // storage tools are scoped, this is not. Irreversible, never
      // task-eligible.
      return verdict("external_mutation", {
        needsApproval: true,
        kind: "browser_action",
        allowTaskEligible: false,
        reason: "browsing data clear destroys profile state",
      });
    }

    case "browser.history.delete": {
      // Deletes the user's browsing history — irreversible profile-data
      // destruction, never task-eligible.
      return verdict("external_mutation", {
        needsApproval: true,
        kind: "browser_action",
        allowTaskEligible: false,
        reason: "history deletion destroys profile data",
      });
    }

    case "browser.bookmarks": {
      const op = ctx.bookmarkOp ?? "list";
      if (op === "create" || op === "update" || op === "remove") {
        // Bookmark tree mutation alters the user's profile permanently —
        // never task-eligible.
        return verdict("external_mutation", {
          needsApproval: true,
          kind: "browser_action",
          allowTaskEligible: false,
          reason: "bookmark mutation changes profile data",
        });
      }
      // Reads fall through to the agentEgress dimension above —
      // bookmark titles/URLs are personal data (page-text class).
      return verdict("read", { reason: "bookmark read" });
    }

    case "browser.page.caches": {
      const op = ctx.cacheOp ?? "listCaches";
      if (op === "put" || op === "delete" || op === "clear") {
        // Cache mutation can poison what the page/service worker serves —
        // never task-eligible.
        return verdict("external_mutation", {
          needsApproval: true,
          kind: "browser_action",
          allowTaskEligible: false,
          reason: "cache mutation changes served content",
        });
      }
      if (op === "match") {
        // Cached response bodies are page data — per-call approval.
        return verdict("external_mutation", {
          needsApproval: true,
          kind: "agent_egress",
          allowTaskEligible: false,
          reason: "cached response body is page data — per-call approval",
        });
      }
      return verdict("read", { reason: "cache metadata/key list" });
    }

    case "browser.page.cdp": {
      // Raw DevTools protocol — the classifier cannot inspect the
      // method, and even read-sounding domains can mutate page or
      // browser state (Runtime.evaluate runs arbitrary JS). Always
      // approval, never task-eligible.
      return verdict("external_mutation", {
        needsApproval: true,
        kind: "browser_action",
        allowTaskEligible: false,
        reason: "raw CDP command requires approval",
      });
    }

    case "browser.page.serviceWorker": {
      const op = ctx.swOp ?? "list";
      if (op === "unregister" || op === "update") {
        // unregister kills the worker; update can swap the controlling
        // worker for a new script — both change origin behavior.
        return verdict("external_mutation", {
          needsApproval: true,
          kind: "browser_action",
          allowTaskEligible: false,
          reason: "service worker lifecycle change alters origin behavior",
        });
      }
      return verdict("read", { reason: "service worker registration list" });
    }

    case "browser.windows.update":
      // Focus/state changes are reversible window chrome ops — no page
      // mutation, no egress.
      return verdict("low", { reason: "window focus/state update" });

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

/** Canonical allow_egress_task scope: the egress CLASS, not one action.
 *  Unlike allowTaskScope this is deliberately not digest-bound — the
 *  grant means "page content may leave for this destination for the
 *  rest of the task" and is only ever issued for non-sensitive
 *  page-text egress (see RiskVerdict.egressTaskEligible). */
export function agentEgressTaskScope(egress: {
  dataClass: AgentEgressDataClass;
  destination: AgentEgressDestination;
}): string {
  return ["agent-egress", egress.dataClass, egress.destination].join("|");
}
