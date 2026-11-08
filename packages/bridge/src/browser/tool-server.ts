/**
 * Browser tool server + policy skeleton — plan §9.2/§6.7, P1-09.
 *
 * Tool flow: validate token+scope → dedup by toolCallId → hard-block
 * check → build ActionContext → classify (§4.8 skeleton) → approval
 * hook → dispatch browser.tool.request to host → browser.tool.result
 * → verify → tool.completed.
 *
 * This is the MINIMAL host.register path the bead requires: pending-
 * request correlation, per-tool timeout, disconnect → no_host /
 * host_lost_after_dispatch. Full affinity/stranded rules are P2-03.
 */

import { createHash } from "node:crypto";

import {
  agentEgressTaskScope,
  allowTaskScope,
  canonicalJson,
  classifyActionRisk,
  detectSensitiveContent,
  urlOriginPath,
  type ActionContext,
  type AgentEgressDestination,
  type BrowserBackendId,
  type BrowserToolName,
  type RiskLevel,
} from "@codex-sidepanel/shared";

import { TaskTabScope } from "./task-tab-scope.js";
import { ToolTokenError, ToolTokenManager } from "./tool-token.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

/** Per-tool dispatch budgets. Heavy page reads legitimately exceed the
 *  default on real-world DOMs (YouTube/GitHub snapshots observed
 *  timing out at 15s), and page.wait's own timeoutMs clamps up to 30s —
 *  it can never succeed under the default cap. */
const PER_TOOL_TIMEOUT_MS: Record<string, number> = {
  "browser.page.snapshot": 45_000,
  "browser.page.extract": 30_000,
  "browser.page.screenshot": 30_000,
  "browser.page.pdf": 60_000,
  "browser.page.wait": 35_000,
  "browser.page.evaluate": 20_000,
};

/** Tools that are hard-blocked (§9.1/§9.2). browser.page.evaluate was
 *  unblocked after the CDP/scripting tier landed: it runs in the page
 *  MAIN world but every call is approval-gated (risk classifier →
 *  external_mutation, allow_task never offered) with the expression
 *  previewed in argsPreview, and its result is page-text egress class.
 *  Residual caveat: an approved expression can still trigger in-page
 *  side effects (fetch etc.) that no tool-level gate observes. */
export const HARD_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "browser.page.download",
]);

/** §4.8: mutating element actions whose risk verdict depends on WHAT the
 *  target actually is (label, input type, form method, page origin).
 *  Agent args alone cannot see those facts — a ref-targeted click
 *  carries no label — so the extension backend gets a ground-truth
 *  preflight (browser.internal.describeTarget) before classification. */
const TARGET_DESCRIBE_TOOLS: ReadonlySet<string> = new Set([
  "browser.page.click",
  "browser.page.submit",
  "browser.page.hover",
  "browser.page.press",
  "browser.page.drag",
  "browser.page.fill",
  "browser.page.type",
  "browser.page.select",
]);

/** Merge host-resolved element/page facts into the ActionContext.
 *  Ground truth overrides agent-supplied hints: the real label drives
 *  the destructive-word check, the real input type drives the
 *  password/payment check, the real form method drives the
 *  external-mutation check, and the real page origin drives the
 *  financial-origin check (args.url is empty for element actions). */
function applyTargetDescription(actx: ActionContext, desc: Record<string, unknown>): void {
  if (desc.found !== true) return;
  const t = (actx.target ??= {});
  const label = typeof desc.label === "string" ? desc.label : "";
  if (label) t.label = label;
  const inputType = typeof desc.inputType === "string" ? desc.inputType : "";
  if (inputType) {
    t.inputType = inputType;
    if (inputType === "password") t.isPassword = true;
  }
  const formMethod = typeof desc.formMethod === "string" ? desc.formMethod.toUpperCase() : "";
  if (formMethod) t.method = formMethod;
  const formAction = typeof desc.formAction === "string" ? desc.formAction : "";
  if (formAction) t.formAction = formAction;
  const pageOrigin = typeof desc.pageOrigin === "string" ? desc.pageOrigin : "";
  if (pageOrigin) {
    actx.origin = pageOrigin;
    if (!actx.url) actx.url = pageOrigin;
  }
}

/** Facts carried to the host for dispatch-time re-verification —
 *  strings only, bounded by the describe contract (label ≤160 chars,
 *  urls are origin+path). */
const TARGET_FACT_KEYS = [
  "label",
  "tagName",
  "role",
  "inputType",
  "controlType",
  "formMethod",
  "formAction",
  "href",
  "pageOrigin",
  "pageUrl",
] as const;

function pickTargetFacts(desc: Record<string, unknown>): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const key of TARGET_FACT_KEYS) {
    const v = desc[key];
    if (typeof v === "string" && v) out[key] = v.slice(0, 2048);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Approval details.argsPreview bounds — the preview is persisted to the
 *  approvals table and broadcast to every client, so it must stay small
 *  and never carry credential values. */
const ARGS_PREVIEW_MAX_CHARS = 500;
const ARGS_PREVIEW_MAX_DEPTH = 5;
const ARGS_PREVIEW_MAX_STRING = 160;
const ARGS_PREVIEW_MAX_ITEMS = 16;
const ARGS_PREVIEW_REDACTED = "•••";
const ARGS_PREVIEW_TRUNCATED = "[truncated]";

/** camelCase/snake-case normalized key → word-boundary match, so
 *  "cardPin" and "api_key" match but "shipping" does not. */
const SENSITIVE_ARG_KEY =
  /\b(password|passwd|pwd|secret|token|api[-_ ]?key|credit[-_ ]?card|card[-_ ]?number|cvv|cvc|pin|ssn|otp)\b/;

/** Value-bearing fill/type args — redacted when the classifier marks the
 *  action data_entry_sensitive or financial (the value IS the secret). */
const VALUE_ARG_KEYS = new Set(["text", "value", "input"]);

function normalizeArgKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .toLowerCase();
}

function previewArgValue(value: unknown, depth: number, redactValues: boolean): unknown {
  if (typeof value === "string") {
    return value.length > ARGS_PREVIEW_MAX_STRING
      ? `${value.slice(0, ARGS_PREVIEW_MAX_STRING)}…`
      : value;
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (depth >= ARGS_PREVIEW_MAX_DEPTH) {
    return ARGS_PREVIEW_TRUNCATED;
  }
  if (Array.isArray(value)) {
    return value
      .slice(0, ARGS_PREVIEW_MAX_ITEMS)
      .map((item) => previewArgValue(item, depth + 1, redactValues));
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
      key,
      SENSITIVE_ARG_KEY.test(normalizeArgKey(key)) ||
      (redactValues && VALUE_ARG_KEYS.has(normalizeArgKey(key)))
        ? ARGS_PREVIEW_REDACTED
        : previewArgValue(nested, depth + 1, redactValues),
    ]),
  );
}

/** Build the bounded, redacted args preview for approval details. Sensitive
 *  keys are always masked; `redactValues` additionally masks fill/type
 *  payload keys when the classifier flagged the action as sensitive or
 *  financial. Oversized previews collapse to a truncated JSON string. */
export function buildArgsPreview(
  args: Record<string, unknown>,
  opts: { redactValues?: boolean } = {},
): unknown {
  const preview = previewArgValue(args, 0, opts.redactValues === true);
  const json = JSON.stringify(preview) ?? "null";
  if (json.length <= ARGS_PREVIEW_MAX_CHARS) {
    return preview;
  }
  return `${json.slice(0, ARGS_PREVIEW_MAX_CHARS - 1)}…`;
}

export interface ToolCallRequest {
  toolCallId: string;
  taskId: string;
  turnId?: string;
  tool: string;
  args: Record<string, unknown>;
  token: string;
  /** Task-bound profile — token profileId must match (plan §9.1). */
  profileId: string;
  backendId?: BrowserBackendId;
  /** Chrome run the task's tabs live in — namespaces runtime tabIds
   *  (chromex-jtl, §3.2). Absent ⇒ degraded; scope still works per
   *  profileId+backendId but cannot distinguish Chrome restarts. */
  browserInstanceId?: string | null;
}

export interface ToolCallOutcome {
  toolCallId: string;
  tool: string;
  status: "completed" | "failed" | "cancelled" | "unknown";
  result?: unknown;
  error?: { code: string; message: string };
  /** semantic verdict from the host/backend — absent means unverified
   *  (recorded "unknown" downstream), never optimistically true
   *  (chromex-0fza). */
  verified?: boolean | "unknown";
}

/** Minimal host channel: send a tool request to a registered host and
 *  await its result (or timeout / disconnect). `profileId`, when the
 *  resolver knows it, lets the tool server reject cross-profile dispatch
 *  with browser.wrong_profile instead of silently adopting foreign tabs
 *  (chromex-jtl, plan §3.2/§7.3#5). */
export interface ToolHostChannel {
  readonly hostInstanceId: string;
  /** profile this host serves — checked against req.profileId */
  readonly profileId?: string;
  send(method: "browser.tool.request" | "browser.tool.cancel", payload: unknown): Promise<unknown>;
  onDisconnect(listener: (reason: "disconnect" | "timeout") => void): void;
}

/** A resolver may refuse routing with a typed error instead of a host —
 *  e.g. BrowserHostRegistry's wrong_profile/not_in_scope/stranded kinds
 *  surface to the tool caller unchanged (chromex-jtl). */
export interface ToolHostRejection {
  error: { code: string; message: string };
}

/** Approval request handed to the host-side approval hook (§4.8). */
export interface ToolApprovalRequest {
  taskId: string;
  turnId?: string;
  tool: string;
  args: Record<string, unknown>;
  backendId: BrowserBackendId;
  risk: RiskLevel;
  kind: "browser_action" | "provider_permission" | "data_entry_sensitive" | "agent_egress";
  reason: string;
  /** canonical allow_task scope — present only when allowTaskEligible */
  allowTaskScope?: string;
  /** canonical allow_egress_task scope — present only when the verdict
   *  offers the per-task page-content egress grant (non-sensitive
   *  page-text only; see RiskVerdict.egressTaskEligible) */
  egressTaskScope?: string;
  /** hash(tool,args,targetRef,snapshotId,url,origin) — approval binds to this */
  actionDigest: string;
  details: {
    tool: string;
    argsPreview: unknown;
    origin: string;
    targetLabel?: string;
    allowTaskScope?: string;
    egressTaskScope?: string;
  };
}

export type ToolApprovalVerdict =
  | { verdict: "approved"; optionId?: string }
  | { verdict: "denied" | "timeout"; optionId?: string };

/** §4.8 agentEgress inputs the caller can supply per deployment.
 *  `destination` is where tool results leave the browser for this
 *  task's provider; `sensitiveOrigins` marks origins whose page content
 *  is treated as sensitive regardless of detected PII. */
export interface ActionContextEgress {
  destination?: AgentEgressDestination;
  sensitiveOrigins?: readonly string[];
}

/** Tools whose results carry page content out of the browser (§4.8
 *  agentEgress dataClass). Mutating tools are covered by dataEgress /
 *  target semantics instead. */
const EGRESS_DATA_CLASS: Partial<Record<BrowserToolName, "page-text" | "screenshot">> = {
  "browser.page.snapshot": "page-text",
  "browser.page.get": "page-text",
  "browser.page.extract": "page-text",
  "browser.page.screenshot": "screenshot",
  "browser.page.pdf": "screenshot",
  // console entries are page-generated content — same egress class as
  // extracted text (may carry tokens/PII the page logged).
  "browser.page.console": "page-text",
  // evaluate returns arbitrary page-derived values — same egress class.
  "browser.page.evaluate": "page-text",
  // find returns page text + element selectors — same egress class.
  "browser.page.find": "page-text",
  // CDP response bodies are page content (docs/adr/debugger-tier.md).
  "browser.page.responseBody": "page-text",
  "browser.page.webSocket": "page-text",
  // history entries are personal browsing data — same egress gate.
  "browser.history.search": "page-text",
  // bookmark titles/URLs are personal profile data — same egress gate.
  "browser.bookmarks": "page-text",
};

/** Tools that never target a tab — the implicit-target ambiguity check
 *  (chromex-ykj) does not apply: there is no tab to disambiguate. */
const TAB_LESS_TOOLS: ReadonlySet<string> = new Set([
  "browser.tabs.list",
  "browser.tab.create",
  "browser.downloads.list",
  "browser.downloads.save",
  "browser.downloads.cancel",
  "browser.windows.list",
  "browser.windows.create",
  "browser.windows.update",
  "browser.history.search",
  "browser.bookmarks",
]);

/** Credential-looking query params — plan §4.8 marks "URL chứa token"
 *  pages sensitive for egress purposes. */
const TOKEN_URL_PATTERN =
  /[?&](?:access[_-]?token|auth|code|key|secret|sig|signature|session|jwt|token)=[^&\s]/i;

/** sensitiveOrigins entries may be full origins ("https://a.com") or
 *  bare hosts ("a.com", matches subdomains). */
function originIsSensitive(origin: string, sensitiveOrigins: readonly string[] | undefined): boolean {
  if (!origin || !sensitiveOrigins?.length) return false;
  let host = "";
  try {
    host = new URL(origin).hostname.toLowerCase();
  } catch {
    return false;
  }
  return sensitiveOrigins.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    if (e.includes("://")) {
      try {
        return new URL(e).origin === origin;
      } catch {
        return false;
      }
    }
    return host === e || host.endsWith(`.${e}`);
  });
}

/** §4.8 rule 2: page content leaving the browser is sensitive when the
 *  origin is configured sensitive, the URL carries a token, or the
 *  visible args/page metadata match PII patterns. */
function pageContentSensitive(
  url: string,
  label: string | undefined,
  origin: string,
  egress: ActionContextEgress,
): boolean {
  if (originIsSensitive(origin, egress.sensitiveOrigins)) return true;
  if (TOKEN_URL_PATTERN.test(url)) return true;
  return detectSensitiveContent([url, label ?? ""].join(" "));
}

/** Build the §4.8 ActionContext for a tool call. `contextResolved`
 *  is honest: mutating tools need an explicit target/url arg —
 *  anything less fails closed inside the classifier. `withinTabScope`
 *  is the real TaskTabScope check result for an explicit args.tabId;
 *  implicit (active/bound-tab) resolution is enforced host-side.
 *  `egress` supplies the agentEgress destination + sensitiveOrigins
 *  the classifier cannot derive from the request alone. */
export function buildActionContext(
  req: ToolCallRequest,
  withinTabScope = true,
  egress: ActionContextEgress = {},
): ActionContext {
  const args = req.args ?? {};
  const url = typeof args.url === "string" ? args.url : "";
  let origin = "";
  try {
    origin = url ? new URL(url).origin : "";
  } catch {
    origin = "";
  }
  const hasTarget =
    typeof args.ref === "string" || typeof args.selector === "string" || typeof args.label === "string";
  const mutating = /\.(click|fill|submit|navigate|type|select|press|scroll|hover|drag|upload|setInputFiles|dialog)$/.test(req.tool);
  const targetLabel = typeof args.label === "string" ? args.label : undefined;
  const inputType = typeof args.inputType === "string" ? args.inputType : undefined;
  const egressDataClass = EGRESS_DATA_CLASS[req.tool as BrowserToolName];
  const agentEgress = egressDataClass
    ? {
        dataClass: egressDataClass,
        destination: egress.destination ?? ("local-provider" as const),
        sensitiveContent: pageContentSensitive(url, targetLabel, origin, egress),
      }
    : undefined;
  return {
    backendId: req.backendId ?? "chrome-extension",
    profileId: req.profileId,
    tabId: typeof args.tabId === "number" ? args.tabId : "unknown",
    url,
    origin,
    action: req.tool as BrowserToolName,
    ...(hasTarget || targetLabel || inputType !== undefined
      ? {
          target: {
            ...(typeof args.ref === "string" ? { ref: args.ref } : {}),
            ...(targetLabel ? { label: targetLabel } : {}),
            ...(inputType !== undefined ? { inputType } : {}),
            ...(inputType === "password" || args.isPassword === true ? { isPassword: true } : {}),
          },
        }
      : {}),
    ...(typeof args.text === "string" || typeof args.value === "string"
      ? { dataEgress: "network-form" as const }
      : {}),
    ...(agentEgress ? { agentEgress } : {}),
    ...(req.tool === "browser.page.cookies"
      ? {
          cookieOp: typeof args.action === "string" ? args.action : "list",
          cookieValues: args.includeValues === true,
        }
      : {}),
    ...(req.tool === "browser.page.localStorage" || req.tool === "browser.page.indexedDB"
      ? {
          storageOp: typeof args.action === "string" ? args.action : (req.tool === "browser.page.indexedDB" ? "listDbs" : "list"),
          storageValues: args.action === "get" || args.includeValues === true,
        }
      : {}),
    ...(req.tool === "browser.bookmarks"
      ? { bookmarkOp: typeof args.action === "string" ? args.action : "list" }
      : {}),
    ...(req.tool === "browser.page.caches"
      ? { cacheOp: typeof args.action === "string" ? args.action : "listCaches" }
      : {}),
    ...(req.tool === "browser.page.serviceWorker"
      ? { swOp: typeof args.action === "string" ? args.action : "list" }
      : {}),
    withinTabScope,
    // press may legitimately target the focused element with no explicit
    // target — the key itself is the resolved input. hover still needs a
    // target or it fails closed to approval.
    contextResolved:
      !mutating ||
      hasTarget ||
      (req.tool.endsWith("navigate") && url !== "") ||
      req.tool.endsWith("scroll") ||
      req.tool.endsWith("wait") ||
      (req.tool === "browser.page.press" && typeof args.key === "string" && args.key.length > 0),
  };
}

/** Result keys that may reference a tab the call opened/acquired
 *  (chromex-9e3). `resolvedTabId` is handled separately — it is the
 *  acted-on tab, not an acquisition. */
const TAB_REF_KEYS = new Set(["tabId", "openedTabId", "newTabId", "targetTabId"]);
const TAB_REF_MAX_DEPTH = 3;

/** Collect integer tabIds referenced inside a tool result so the task
 *  scope can record legitimately acquired tabs (e.g. navigate opened a
 *  new tab). Depth-bounded; non-tab objects are ignored. */
function harvestTabRefs(value: unknown, depth = 0, out = new Set<number>()): Set<number> {
  if (depth > TAB_REF_MAX_DEPTH || value === null || typeof value !== "object") return out;
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 32)) harvestTabRefs(item, depth + 1, out);
    return out;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (TAB_REF_KEYS.has(key) && typeof nested === "number" && Number.isInteger(nested)) {
      out.add(nested);
    } else {
      harvestTabRefs(nested, depth + 1, out);
    }
  }
  return out;
}

/** §4.8 actionDigest: hash(canonical(tool,args,target ref,snapshotId,url,
 *  origin,dataEgress,agentEgress)). Any change to those inputs —
 *  including the egress classification — invalidates a prior approval. */
export function browserActionDigest(req: ToolCallRequest, actx: ActionContext): string {
  return createHash("sha256")
    .update(
      canonicalJson({
        tool: req.tool,
        args: req.args ?? {},
        targetRef: actx.target?.ref ?? null,
        snapshotId: typeof req.args?.snapshotId === "string" ? req.args.snapshotId : null,
        url: actx.url || null,
        origin: actx.origin || null,
        dataEgress: actx.dataEgress ?? "none",
        agentEgress: actx.agentEgress
          ? {
              dataClass: actx.agentEgress.dataClass,
              destination: actx.agentEgress.destination,
              sensitiveContent: actx.agentEgress.sensitiveContent === true,
            }
          : null,
      }),
    )
    .digest("hex");
}

export interface ToolServerDeps {
  tokens: ToolTokenManager;
  /** Resolve which host instance serves a task (minimal registry).
   *  May return a ToolHostRejection to surface a typed routing error
   *  (browser.wrong_profile etc.) or null for browser.no_host. */
  resolveHost(taskId: string): ToolHostChannel | ToolHostRejection | null;
  /** §6.6 gate: returns a failure outcome error when the task's pinned
   *  backend cannot serve this call (mismatch/unavailable). Checked
   *  after token+dedup+hard-block, before host resolution. */
  backendGate?(req: ToolCallRequest): { code: string; message: string } | null;
  /** Approval hook — full §4.8 engine (P2-04). */
  requestApproval?(ctx: ToolApprovalRequest): Promise<ToolApprovalVerdict>;
  /** allow_task scope check — granted scopes persist for task lifetime.
   *  `actionDigest` is the digest of the CURRENT action: the grant only
   *  covers the exact action it was approved for, so the implementation
   *  must compare it against the digest stored on the granting approval
   *  (changed args/snapshot/url/egress → not granted → re-approval). */
  allowTaskGranted?(taskId: string, scope: string, actionDigest: string): Promise<boolean>;
  /** Record an allow_task grant after user approval. `actionDigest`
   *  binds the grant to the approved action (see allowTaskGranted). */
  grantAllowTask?(taskId: string, scope: string, actionDigest: string): void;
  /** allow_egress_task scope check — the user granted "page content may
   *  egress to this destination for the rest of the task" once. Unlike
   *  allow_task this is NOT digest-bound: the grant covers the egress
   *  class (agentEgressTaskScope), and the classifier only marks
   *  non-sensitive page-text egress eligible, so screenshots and
   *  sensitiveContent still require allow_once per call. */
  egressTaskGranted?(taskId: string, scope: string): Promise<boolean>;
  /** Record an allow_egress_task grant after user approval (audit
   *  symmetry with grantAllowTask — the durable record is the
   *  approval row's decision.scope). */
  grantEgressTask?(taskId: string, scope: string): void;
  /** §4.8 agentEgress: where page data leaves for this task's provider.
   *  Default "local-provider" keeps non-sensitive reads as `read`;
   *  "cloud-provider"/"external-mcp" makes every page-data egress an
   *  agent_egress approval. */
  agentEgressDestination?: AgentEgressDestination;
  /** Origins whose page content is treated as sensitive for egress —
   *  full origins or bare hosts (subdomains match). */
  sensitiveOrigins?: readonly string[];
  /** Redacted ActionContext audit hook (§4.8: logged for audit). */
  onClassified?(taskId: string, ctx: ActionContext, verdict: { risk: RiskLevel; needsApproval: boolean; reason: string }): void;
  onOutcome?(outcome: ToolCallOutcome): void;
  now?: () => number;
  defaultTimeoutMs?: number;
}

/** chromex-0fza: the host/backend result may carry an honest semantic
 *  verdict (`verified: true|false|"unknown"` — see BrowserActionResult /
 *  content/verify.ts). Anything else means no verification ran; the
 *  outcome stays undefined so tool.completed records "unknown" rather
 *  than a blanket true. */
function hostResultVerified(result: unknown): boolean | "unknown" | undefined {
  if (!result || typeof result !== "object") return undefined;
  const v = (result as { verified?: unknown }).verified;
  return v === true || v === false || v === "unknown" ? v : undefined;
}

export class BrowserToolServer {
  /** toolCallId → outcome — duplicate-execution protection (§9.1). */
  private readonly outcomes = new Map<string, ToolCallOutcome>();
  private readonly pending = new Map<string, { resolve: (o: ToolCallOutcome) => void; timer: NodeJS.Timeout; taskId: string; host: ToolHostChannel; req: ToolCallRequest }>();
  /** SEC chromex-9e3: runtime taskId→tabIds scope (chrome-extension
   *  backend only — playwright backends isolate tabs per task already). */
  private readonly tabScope = new TaskTabScope();
  private readonly deps: ToolServerDeps;

  constructor(deps: ToolServerDeps) {
    this.deps = deps;
  }

  /** Seed a durable outcome at startup (S5/§9.1): the dedup map is
   *  empty after a gateway restart, so durable tool.started/completed
   *  events are the only memory of calls that already ran. Seeding every
   *  recorded toolCallId makes retry behavior identical to a live
   *  session — any repeat hits duplicate_tool_call instead of
   *  re-dispatching a possibly-executed action. Calls interrupted
   *  mid-flight ("started"/"unknown") additionally record an honest
   *  interrupted error. */
  seedDurableOutcome(
    toolCallId: string,
    tool: string,
    last: "started" | "completed" | "failed" | "cancelled" | "unknown",
  ): void {
    if (this.outcomes.has(toolCallId)) return;
    const interrupted = last === "started" || last === "unknown";
    this.outcomes.set(toolCallId, {
      toolCallId,
      tool,
      status: interrupted ? "failed" : last,
      ...(interrupted
        ? {
            error: {
              code: "browser.interrupted",
              message: "previous attempt outcome unknown — gateway restarted mid-call; use a new toolCallId to retry",
            },
          }
        : {}),
      verified: "unknown",
    });
  }

  async execute(req: ToolCallRequest): Promise<ToolCallOutcome> {
    const now = this.deps.now?.() ?? Date.now();

    // 1. Token verify (signature, exp, skew, scope).
    try {
      this.deps.tokens.verify(
        req.token,
        {
          taskId: req.taskId,
          profileId: req.profileId,
          backendId: req.backendId ?? "chrome-extension",
          tool: req.tool,
        },
        now,
      );
    } catch (err) {
      if (err instanceof ToolTokenError) {
        return this.finish({ toolCallId: req.toolCallId, tool: req.tool, status: "failed", error: { code: err.code, message: err.message } });
      }
      throw err;
    }

    // 2. Duplicate-execution protection.
    const prior = this.outcomes.get(req.toolCallId);
    if (prior) {
      return { ...prior, error: { code: "browser.duplicate_tool_call", message: `toolCallId ${req.toolCallId} already has outcome ${prior.status}` } };
    }

    // 3. Hard block.
    if (HARD_BLOCKED_TOOLS.has(req.tool)) {
      return this.finish({ toolCallId: req.toolCallId, tool: req.tool, status: "failed", error: { code: "browser.tool_blocked", message: "tool is hard-blocked" } });
    }

    // 3b. §6.6 backend gate — pinned backend vs tool requirements.
    const gate = this.deps.backendGate?.(req);
    if (gate) {
      return this.finish({ toolCallId: req.toolCallId, tool: req.tool, status: "failed", error: gate });
    }

    // 4. Host resolution — a resolver may return a typed rejection
    // (chromex-jtl: wrong_profile reaches the caller, never a silent
    // cross-profile adopt).
    const resolved = this.deps.resolveHost(req.taskId);
    if (resolved && "error" in resolved) {
      return this.finish({ toolCallId: req.toolCallId, tool: req.tool, status: "failed", error: resolved.error });
    }
    const host = resolved;
    if (!host) {
      return this.finish({ toolCallId: req.toolCallId, tool: req.tool, status: "failed", error: { code: "browser.no_host", message: "no host registered for task" } });
    }
    // chromex-jtl: a host that declares a different profile than the
    // task/token must never receive the call — its tabIds belong to
    // another profile's namespace (§3.2).
    if (host.profileId !== undefined && host.profileId !== req.profileId) {
      return this.finish({
        toolCallId: req.toolCallId,
        tool: req.tool,
        status: "failed",
        error: {
          code: "browser.wrong_profile",
          message: `host serves profile ${host.profileId}; task is bound to ${req.profileId}`,
        },
      });
    }

    // 5. §4.8 classify + approval. withinTabScope is the real scope
    // check for an explicit args.tabId; implicit tab resolution is
    // enforced by the host against the tabScope payload (step 6).
    const backendId = req.backendId ?? "chrome-extension";
    // A present-but-non-numeric tabId must not silently degrade to the
    // implicit own-tab path — that would skip the §4.8 scope check
    // entirely (acceptance s3 caught a string tabId doing exactly this).
    if (req.args?.tabId !== undefined && req.args?.tabId !== null && typeof req.args.tabId !== "number") {
      return this.finish({
        toolCallId: req.toolCallId,
        tool: req.tool,
        status: "failed",
        error: {
          code: "browser.invalid_args",
          message: "args.tabId must be a number",
        },
      });
    }
    // Same contract for args.frameId — a malformed frame selector must
    // not silently fall back to the top frame.
    if (
      req.args?.frameId !== undefined &&
      req.args?.frameId !== null &&
      (typeof req.args.frameId !== "number" || !Number.isInteger(req.args.frameId) || req.args.frameId < 0)
    ) {
      return this.finish({
        toolCallId: req.toolCallId,
        tool: req.tool,
        status: "failed",
        error: {
          code: "browser.invalid_args",
          message: "args.frameId must be a non-negative integer",
        },
      });
    }
    const explicitTabId = typeof req.args?.tabId === "number" ? req.args.tabId : null;
    // chromex-jtl: tabIds are namespaced by (profileId, backendId,
    // browserInstanceId) — the same numeric id under another profile or
    // Chrome run is a different tab (§3.2).
    const scopeNs =
      backendId === "chrome-extension"
        ? `${req.profileId} ${backendId} ${req.browserInstanceId ?? ""}`
        : "";
    const withinTabScope =
      backendId !== "chrome-extension" || explicitTabId === null
        ? true
        : this.tabScope.permits(req.taskId, explicitTabId, scopeNs);
    const actx = buildActionContext(req, withinTabScope, {
      ...(this.deps.agentEgressDestination ? { destination: this.deps.agentEgressDestination } : {}),
      ...(this.deps.sensitiveOrigins ? { sensitiveOrigins: this.deps.sensitiveOrigins } : {}),
    });
    // tabScope payload for the host — computed once here so the §4.8
    // preflight below resolves the same scoped tab set the dispatch
    // will enforce (chromex-9e3).
    const riskTabScope =
      backendId === "chrome-extension"
        ? this.tabScope.payloadFor(req.taskId, scopeNs)
        : undefined;
    // §4.8 ground truth: args-only context is blind for element
    // actions — enrich with the facts the host resolves inside the
    // page (real label/input type/form method/page origin) BEFORE
    // classifying. Both real-tab backends implement the internal
    // describeTarget pseudo-tool. Fail-open on preflight errors: the
    // dispatch itself surfaces stale-ref/not-found honestly; blocking
    // here would only mask the real error behind an approval prompt.
    // Skipped entirely when the call is already terminal (out of
    // scope) or ambiguous — no point spending a host round-trip.
    const preflightBackend =
      backendId === "chrome-extension" || backendId === "playwright-isolated";
    const preflightRelevant =
      preflightBackend &&
      withinTabScope &&
      TARGET_DESCRIBE_TOOLS.has(req.tool) &&
      !(
        backendId === "chrome-extension" &&
        explicitTabId === null &&
        this.tabScope.implicitTargetAmbiguous(req.taskId, scopeNs)
      );
    let desc: Record<string, unknown> | null = null;
    if (preflightRelevant) {
      desc = await this.describeActionTarget(host, req, riskTabScope).catch(() => null);
      if (desc) applyTargetDescription(actx, desc);
    }
    // §4.8 dispatch binding: carry the described facts to the host so
    // the content script can re-verify them against the resolved
    // element synchronously before acting. Without this the page can
    // mutate the target (relabel, retarget form/href, swap origin)
    // during the approval round-trip and the action fires on semantics
    // the classifier never saw. Attached for EVERY preflight-covered
    // call — a "low" verdict is equally stale after mutation.
    const expectedTarget =
      preflightRelevant && desc?.found === true ? pickTargetFacts(desc) : undefined;
    const verdict = classifyActionRisk(actx);
    this.deps.onClassified?.(req.taskId, actx, verdict);
    // scope denials are terminal — never approval-bypassable (§4.8).
    if (!actx.withinTabScope) {
      return this.finish({
        toolCallId: req.toolCallId,
        tool: req.tool,
        status: "failed",
        error: { code: "browser.not_in_scope", message: `tab ${explicitTabId} is outside this task's tab scope` },
      });
    }
    // chromex-ykj: an implicit target is ambiguous when the task holds
    // multiple in-scope tabs but no bound default — surface the coded
    // error instead of letting the host silently pick one.
    if (
      backendId === "chrome-extension" &&
      explicitTabId === null &&
      !TAB_LESS_TOOLS.has(req.tool) &&
      this.tabScope.implicitTargetAmbiguous(req.taskId, scopeNs)
    ) {
      return this.finish({
        toolCallId: req.toolCallId,
        tool: req.tool,
        status: "failed",
        error: {
          code: "browser.ambiguous_target",
          message: "task scope contains multiple tabs and no bound default; pass args.tabId to disambiguate",
        },
      });
    }
    if (verdict.risk === "deny" || verdict.risk === "hard_block") {
      return this.finish({ toolCallId: req.toolCallId, tool: req.tool, status: "failed", error: { code: "browser.policy_denied", message: verdict.reason } });
    }
    if (verdict.needsApproval) {
      const scope = verdict.allowTaskEligible ? allowTaskScope(actx) : undefined;
      const egressScope =
        verdict.egressTaskEligible && actx.agentEgress
          ? agentEgressTaskScope(actx.agentEgress)
          : undefined;
      // §4.8: the digest binds approval (and any allow_task reuse) to
      // this exact action — args/snapshot/url/egress changes invalidate.
      const actionDigest = browserActionDigest(req, actx);
      const alreadyGranted =
        (scope !== undefined &&
          (await this.deps.allowTaskGranted?.(req.taskId, scope, actionDigest)) === true) ||
        (egressScope !== undefined &&
          (await this.deps.egressTaskGranted?.(req.taskId, egressScope)) === true);
      if (!alreadyGranted) {
        const approval = await this.deps.requestApproval?.({
          taskId: req.taskId,
          ...(req.turnId !== undefined ? { turnId: req.turnId } : {}),
          tool: req.tool,
          args: req.args,
          backendId: req.backendId ?? "chrome-extension",
          risk: verdict.risk,
          kind: verdict.kind ?? "browser_action",
          reason: verdict.reason,
          ...(scope !== undefined ? { allowTaskScope: scope } : {}),
          ...(egressScope !== undefined ? { egressTaskScope: egressScope } : {}),
          actionDigest,
          details: {
            tool: req.tool,
            // redacted + bounded: this preview is persisted to the
            // approvals table and broadcast to every connected client
            argsPreview: buildArgsPreview(req.args, {
              redactValues: verdict.kind === "data_entry_sensitive" || verdict.risk === "financial",
            }),
            origin: actx.origin,
            ...(actx.target?.label ? { targetLabel: actx.target.label } : {}),
            ...(scope !== undefined ? { allowTaskScope: scope } : {}),
            ...(egressScope !== undefined ? { egressTaskScope: egressScope } : {}),
          },
        });
        const approved = approval?.verdict === "approved";
        if (!approved) {
          return this.finish({
            toolCallId: req.toolCallId,
            tool: req.tool,
            status: "failed",
            error: {
              code: "browser.approval_denied",
              message: approval?.verdict === "timeout" ? "approval timed out" : "approval denied",
            },
          });
        }
        if (scope !== undefined && approval?.optionId === "allow_task") {
          this.deps.grantAllowTask?.(req.taskId, scope, actionDigest);
        }
        if (egressScope !== undefined && approval?.optionId === "allow_egress_task") {
          this.deps.grantEgressTask?.(req.taskId, egressScope);
        }
      }
    }

    // 6. Dispatch with per-tool timeout.
    return this.dispatch(host, req, expectedTarget);
  }

  private dispatch(
    host: ToolHostChannel,
    req: ToolCallRequest,
    expectedTarget?: Record<string, string>,
  ): Promise<ToolCallOutcome> {
    const timeoutMs =
      PER_TOOL_TIMEOUT_MS[req.tool] ?? this.deps.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
    return new Promise<ToolCallOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.toolCallId);
        resolve(this.finish({
          toolCallId: req.toolCallId,
          tool: req.tool,
          status: "unknown",
          error: { code: "browser.tool_timeout", message: `tool ${req.tool} timed out after ${timeoutMs}ms` },
        }));
      }, timeoutMs);
      this.pending.set(req.toolCallId, {
        resolve: (outcome) => {
          clearTimeout(timer);
          this.pending.delete(req.toolCallId);
          resolve(this.finish(outcome));
        },
        timer,
        taskId: req.taskId,
        host,
        req,
      });
      // tabScope lets the host re-check the RESOLVED tabId (incl. the
      // active-tab default and bound-tab fallback the gateway cannot
      // see) against this task's permitted set — chromex-9e3.
      const tabScope =
        (req.backendId ?? "chrome-extension") === "chrome-extension"
          ? this.tabScope.payloadFor(
              req.taskId,
              `${req.profileId} ${req.backendId ?? "chrome-extension"} ${req.browserInstanceId ?? ""}`,
            )
          : undefined;
      host.send("browser.tool.request", {
        toolCallId: req.toolCallId,
        taskId: req.taskId,
        turnId: req.turnId,
        tool: req.tool,
        args: req.args,
        ...(expectedTarget ? { expectedTarget } : {}),
        ...(tabScope ? { tabScope } : {}),
      })
        .then((result) => {
          // chromex-7k3: the host may have resolved a tab that lost a
          // concurrent first-bind race (scope payload was computed before
          // the other task bound it). The action already ran host-side —
          // it cannot be undone — but the outcome must not record a
          // success for a tab this task does not own.
          const inScope = this.#noteTabScope(req, result);
          const verified = hostResultVerified(result);
          // host.send resolves when browser.tool.result arrives (channel impl)
          this.pending.get(req.toolCallId)?.resolve(
            inScope
              ? {
                  toolCallId: req.toolCallId,
                  tool: req.tool,
                  status: "completed",
                  result,
                  ...(verified !== undefined ? { verified } : {}),
                }
              : {
                  toolCallId: req.toolCallId,
                  tool: req.tool,
                  status: "failed",
                  result,
                  error: {
                    code: "browser.not_in_scope",
                    message: "host resolved a tab outside this task's scope (concurrent bind conflict)",
                  },
                },
          );
        })
        .catch((err: unknown) => {
          // backend channels (e.g. playwright-isolated) throw coded
          // ProtocolErrors — preserve the code so callers see
          // browser.backend_unavailable / backend_mismatch, not a
          // generic host_error.
          const coded =
            err && typeof err === "object" && typeof (err as { code?: unknown }).code === "string"
              ? (err as { code: string }).code
              : "browser.host_error";
          this.pending.get(req.toolCallId)?.resolve({
            toolCallId: req.toolCallId,
            tool: req.tool,
            status: "failed",
            error: { code: coded, message: err instanceof Error ? err.message : String(err) },
          });
        });
    });
  }

  /** Learn binds/acquisitions from a successful host result. Only
   *  chrome-extension results carry `resolvedTabId`; binds record on
   *  success so a failed first call leaves the task unbound.
   *  Returns false when the host-resolved tab could not be bound —
   *  i.e. it belongs to another task in this namespace (chromex-7k3). */
  #noteTabScope(req: ToolCallRequest, result: unknown): boolean {
    if ((req.backendId ?? "chrome-extension") !== "chrome-extension") return true;
    if (!result || typeof result !== "object") return true;
    const ns = `${req.profileId} ${req.backendId ?? "chrome-extension"} ${req.browserInstanceId ?? ""}`;
    const r = result as Record<string, unknown>;
    const resolved =
      typeof r.resolvedTabId === "number"
        ? r.resolvedTabId
        : typeof req.args?.tabId === "number"
          ? req.args.tabId
          : null;
    if (resolved === null) return true;
    const bound = this.tabScope.bind(req.taskId, resolved, ns);
    this.tabScope.acquire(req.taskId, harvestTabRefs(r), ns);
    if (req.tool === "browser.tab.close" && (r.closed === resolved || r.closed === true)) {
      this.tabScope.release(req.taskId, resolved);
    }
    return bound;
  }

  /** Task purge/end — drop its tab scope and ownership claims so the
   *  tabs can bind to a future task. */
  releaseTask(taskId: string): void {
    this.tabScope.releaseTask(taskId);
  }

  /** Host reported browser.tool.result / disconnect. */
  deliverResult(toolCallId: string, result: unknown): void {
    const p = this.pending.get(toolCallId);
    if (!p) return;
    const inScope = this.#noteTabScope(p.req, result);
    const verified = hostResultVerified(result);
    p.resolve(
      inScope
        ? {
            toolCallId,
            tool: "",
            status: "completed",
            result,
            ...(verified !== undefined ? { verified } : {}),
          }
        : {
            toolCallId,
            tool: "",
            status: "failed",
            result,
            error: {
              code: "browser.not_in_scope",
              message: "host resolved a tab outside this task's scope (concurrent bind conflict)",
            },
          },
    );
  }

  hostDisconnected(hostInstanceId: string): void {
    for (const [id, p] of this.pending) {
      // pending entries don't track host; mark all as unknown on disconnect
      // of the serving host — minimal registry keeps it simple
      p.resolve({ toolCallId: id, tool: "", status: "unknown", error: { code: "browser.host_lost_after_dispatch", message: `host ${hostInstanceId} disconnected` } });
    }
  }

  /** Explicit per-call cancel (browser.tool.cancel RPC): the caller
   *  targeted this call, so `cancelled` records the accepted cancel;
   *  task-level propagation uses `unknown` instead — see cancelForTask. */
  cancel(toolCallId: string): ToolCallOutcome | null {
    const p = this.pending.get(toolCallId);
    if (!p) return null;
    void p.host.send("browser.tool.cancel", { toolCallId, taskId: p.taskId }).catch(() => {});
    clearTimeout(p.timer);
    this.pending.delete(toolCallId);
    return this.finish({ toolCallId, tool: "", status: "cancelled" });
  }

  /** P2-06: task interrupt/cancel propagates browser.tool.cancel to
   *  every in-flight call of that task. Stop confirmation is not
   *  guaranteed (host may not implement cancel) — unconfirmed stops
   *  resolve `unknown`, never a guessed `cancelled`. */
  cancelForTask(taskId: string): ToolCallOutcome[] {
    const outcomes: ToolCallOutcome[] = [];
    for (const [toolCallId, p] of [...this.pending]) {
      if (p.taskId !== taskId) continue;
      // best-effort notify; outcome stays unknown until the host
      // confirms via a late tool.result (which is dropped — pending
      // entry is gone) — conservative per §9.2.
      void p.host.send("browser.tool.cancel", { toolCallId, taskId }).catch(() => {});
      p.resolve({
        toolCallId,
        tool: "",
        status: "unknown",
        error: { code: "browser.cancel_unconfirmed", message: "task cancelled; tool stop unconfirmed" },
      });
      const recorded = this.outcomes.get(toolCallId);
      if (recorded) outcomes.push(recorded);
    }
    return outcomes;
  }

  /** §4.8 preflight: ask the extension host to describe the pending
   *  action's resolved target (real label/input type/form method) plus
   *  the page origin. Internal pseudo-tool — never agent-visible. */
  private async describeActionTarget(
    host: ToolHostChannel,
    req: ToolCallRequest,
    tabScope: unknown,
  ): Promise<Record<string, unknown> | null> {
    const res = await host.send("browser.tool.request", {
      toolCallId: `${req.toolCallId}:describe`,
      taskId: req.taskId,
      tool: "browser.internal.describeTarget",
      args: req.args ?? {},
      ...(tabScope ? { tabScope } : {}),
    });
    return res !== null && typeof res === "object" ? (res as Record<string, unknown>) : null;
  }

  private finish(outcome: ToolCallOutcome): ToolCallOutcome {
    this.outcomes.set(outcome.toolCallId, outcome);
    this.deps.onOutcome?.(outcome);
    return outcome;
  }

  /** Build the §4.8 ActionContext for an upcoming tool call. Fail-closed:
   *  contextResolved=false when target semantics are unknown (P2-04 fills). */
  buildActionContext(req: ToolCallRequest): ActionContext {
    return {
      backendId: req.backendId ?? "chrome-extension",
      profileId: "",
      tabId: "",
      url: "",
      origin: "",
      action: req.tool as BrowserToolName,
      dataEgress: /\.(fetch|request|post|send)/.test(req.tool) ? "network-form" : "none",
      withinTabScope: true,
      contextResolved: false,
    };
  }
}
