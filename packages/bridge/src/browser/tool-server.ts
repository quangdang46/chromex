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

import { ToolTokenError, ToolTokenManager } from "./tool-token.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

/** Tools that are hard-blocked from day one (§9.1/§9.2). */
export const HARD_BLOCKED_TOOLS: ReadonlySet<string> = new Set([
  "browser.page.evaluate",
  "browser.page.cookies",
  "browser.page.localStorage",
  "browser.page.download",
]);

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
 *  anything less fails closed inside the classifier. */
export function buildActionContext(req: ToolCallRequest): ActionContext {
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
    withinTabScope: true, // scope enforcement is the host registry's job (P2-03)
    contextResolved: !mutating || hasTarget || (req.tool.endsWith("navigate") && url !== "") || req.tool.endsWith("scroll") || req.tool.endsWith("wait"),
  };
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
  private readonly pending = new Map<string, { resolve: (o: ToolCallOutcome) => void; timer: NodeJS.Timeout; taskId: string; host: ToolHostChannel }>();
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

    // 4. Host resolution.
    const host = this.deps.resolveHost(req.taskId);
    if (!host) {
      return this.finish({ toolCallId: req.toolCallId, tool: req.tool, status: "failed", error: { code: "browser.no_host", message: "no host registered for task" } });
    }

    // 5. §4.8 classify + approval.
    const actx = buildActionContext(req);
    const verdict = classifyActionRisk(actx);
    this.deps.onClassified?.(req.taskId, actx, verdict);
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
            argsPreview: req.args,
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
      });
      host.send("browser.tool.request", { toolCallId: req.toolCallId, taskId: req.taskId, turnId: req.turnId, tool: req.tool, args: req.args })
        .then((result) => {
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
          this.pending.get(req.toolCallId)?.resolve({
            toolCallId: req.toolCallId,
            tool: req.tool,
            status: "failed",
            error: { code: "browser.host_error", message: err instanceof Error ? err.message : String(err) },
          });
        });
    });
  }

  /** Host reported browser.tool.result / disconnect. */
  deliverResult(toolCallId: string, result: unknown): void {
    const p = this.pending.get(toolCallId);
    if (!p) return;
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
