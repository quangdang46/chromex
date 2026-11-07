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
  allowTaskScope,
  canonicalJson,
  classifyActionRisk,
  urlOriginPath,
  type ActionContext,
  type BrowserBackendId,
  type BrowserToolName,
  type RiskLevel,
} from "@codex-sidepanel/shared";

import { TaskTabScope } from "./task-tab-scope.js";
import { ToolTokenError, ToolTokenManager } from "./tool-token.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

/** Tools that are hard-blocked from day one (§9.1/§9.2). */
export const HARD_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "browser.page.evaluate",
  "browser.page.cookies",
  "browser.page.localStorage",
  "browser.page.download",
]);

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
}

export interface ToolCallOutcome {
  toolCallId: string;
  tool: string;
  status: "completed" | "failed" | "cancelled" | "unknown";
  result?: unknown;
  error?: { code: string; message: string };
  verified?: boolean;
}

/** Minimal host channel: send a tool request to a registered host and
 *  await its result (or timeout / disconnect). */
export interface ToolHostChannel {
  readonly hostInstanceId: string;
  send(method: "browser.tool.request" | "browser.tool.cancel", payload: unknown): Promise<unknown>;
  onDisconnect(listener: (reason: "disconnect" | "timeout") => void): void;
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
  /** hash(tool,args,targetRef,snapshotId,url,origin) — approval binds to this */
  actionDigest: string;
  details: {
    tool: string;
    argsPreview: unknown;
    origin: string;
    targetLabel?: string;
    allowTaskScope?: string;
  };
}

export type ToolApprovalVerdict =
  | { verdict: "approved"; optionId?: string }
  | { verdict: "denied" | "timeout"; optionId?: string };

/** Build the §4.8 ActionContext for a tool call. `contextResolved`
 *  is honest: mutating tools need an explicit target/url arg —
 *  anything less fails closed inside the classifier. `withinTabScope`
 *  is the real TaskTabScope check result for an explicit args.tabId;
 *  implicit (active/bound-tab) resolution is enforced host-side. */
export function buildActionContext(req: ToolCallRequest, withinTabScope = true): ActionContext {
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
  const mutating = /\.(click|fill|submit|navigate|type|select|press|scroll|hover|drag|upload)$/.test(req.tool);
  const targetLabel = typeof args.label === "string" ? args.label : undefined;
  return {
    backendId: req.backendId ?? "chrome-extension",
    profileId: req.profileId,
    tabId: typeof args.tabId === "number" ? args.tabId : "unknown",
    url,
    origin,
    action: req.tool as BrowserToolName,
    ...(hasTarget || targetLabel
      ? {
          target: {
            ...(typeof args.ref === "string" ? { ref: args.ref } : {}),
            ...(targetLabel ? { label: targetLabel } : {}),
          },
        }
      : {}),
    ...(typeof args.text === "string" || typeof args.value === "string"
      ? { dataEgress: "network-form" as const }
      : {}),
    withinTabScope,
    contextResolved: !mutating || hasTarget || (req.tool.endsWith("navigate") && url !== "") || req.tool.endsWith("scroll") || req.tool.endsWith("wait"),
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

/** §4.8 actionDigest: hash(canonical(tool,args,target ref,snapshotId,url,origin)). */
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
      }),
    )
    .digest("hex");
}

export interface ToolServerDeps {
  tokens: ToolTokenManager;
  /** Resolve which host instance serves a task (minimal registry). */
  resolveHost(taskId: string): ToolHostChannel | null;
  /** §6.6 gate: returns a failure outcome error when the task's pinned
   *  backend cannot serve this call (mismatch/unavailable). Checked
   *  after token+dedup+hard-block, before host resolution. */
  backendGate?(req: ToolCallRequest): { code: string; message: string } | null;
  /** Approval hook — full §4.8 engine (P2-04). */
  requestApproval?(ctx: ToolApprovalRequest): Promise<ToolApprovalVerdict>;
  /** allow_task scope check — granted scopes persist for task lifetime. */
  allowTaskGranted?(taskId: string, scope: string): Promise<boolean>;
  /** Record an allow_task grant after user approval. */
  grantAllowTask?(taskId: string, scope: string): void;
  /** Redacted ActionContext audit hook (§4.8: logged for audit). */
  onClassified?(taskId: string, ctx: ActionContext, verdict: { risk: RiskLevel; needsApproval: boolean; reason: string }): void;
  onOutcome?(outcome: ToolCallOutcome): void;
  now?: () => number;
  defaultTimeoutMs?: number;
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

    // 4. Host resolution.
    const host = this.deps.resolveHost(req.taskId);
    if (!host) {
      return this.finish({ toolCallId: req.toolCallId, tool: req.tool, status: "failed", error: { code: "browser.no_host", message: "no host registered for task" } });
    }

    // 5. §4.8 classify + approval. withinTabScope is the real scope
    // check for an explicit args.tabId; implicit tab resolution is
    // enforced by the host against the tabScope payload (step 6).
    const backendId = req.backendId ?? "chrome-extension";
    const explicitTabId = typeof req.args?.tabId === "number" ? req.args.tabId : null;
    const withinTabScope =
      backendId !== "chrome-extension" || explicitTabId === null
        ? true
        : this.tabScope.permits(req.taskId, explicitTabId);
    const actx = buildActionContext(req, withinTabScope);
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
    if (verdict.risk === "deny" || verdict.risk === "hard_block") {
      return this.finish({ toolCallId: req.toolCallId, tool: req.tool, status: "failed", error: { code: "browser.policy_denied", message: verdict.reason } });
    }
    if (verdict.needsApproval) {
      const scope = verdict.allowTaskEligible ? allowTaskScope(actx) : undefined;
      const alreadyGranted =
        scope !== undefined && (await this.deps.allowTaskGranted?.(req.taskId, scope)) === true;
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
          actionDigest: browserActionDigest(req, actx),
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
          this.deps.grantAllowTask?.(req.taskId, scope);
        }
      }
    }

    // 6. Dispatch with per-tool timeout.
    return this.dispatch(host, req);
  }

  private dispatch(host: ToolHostChannel, req: ToolCallRequest): Promise<ToolCallOutcome> {
    const timeoutMs = this.deps.defaultTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS;
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
          ? this.tabScope.payloadFor(req.taskId)
          : undefined;
      host.send("browser.tool.request", {
        toolCallId: req.toolCallId,
        taskId: req.taskId,
        turnId: req.turnId,
        tool: req.tool,
        args: req.args,
        ...(tabScope ? { tabScope } : {}),
      })
        .then((result) => {
          this.#noteTabScope(req, result);
          // host.send resolves when browser.tool.result arrives (channel impl)
          this.pending.get(req.toolCallId)?.resolve({
            toolCallId: req.toolCallId,
            tool: req.tool,
            status: "completed",
            result,
            verified: true,
          });
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
   *  success so a failed first call leaves the task unbound. */
  #noteTabScope(req: ToolCallRequest, result: unknown): void {
    if ((req.backendId ?? "chrome-extension") !== "chrome-extension") return;
    if (!result || typeof result !== "object") return;
    const r = result as Record<string, unknown>;
    const resolved =
      typeof r.resolvedTabId === "number"
        ? r.resolvedTabId
        : typeof req.args?.tabId === "number"
          ? req.args.tabId
          : null;
    if (resolved === null) return;
    this.tabScope.bind(req.taskId, resolved);
    this.tabScope.acquire(req.taskId, harvestTabRefs(r));
    if (req.tool === "browser.tab.close" && (r.closed === resolved || r.closed === true)) {
      this.tabScope.release(req.taskId, resolved);
    }
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
    this.#noteTabScope(p.req, result);
    p.resolve({ toolCallId, tool: "", status: "completed", result, verified: true });
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
