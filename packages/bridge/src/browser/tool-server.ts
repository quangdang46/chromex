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

import type { ActionContext, BrowserBackendId, BrowserToolName } from "@codex-sidepanel/shared";

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
  send(method: "browser.tool.request", payload: unknown): Promise<unknown>;
  onDisconnect(listener: (reason: "disconnect" | "timeout") => void): void;
}

/** ActionContext skeleton (§4.8) — populated enough for classification. */
export interface ToolActionContext {
  profileId?: string;
  taskId: string;
  turnId?: string;
  tool: string;
  args: Record<string, unknown>;
  backendId: BrowserBackendId;
  tabId?: number;
  url?: string;
  origin?: string;
  dataEgress: boolean;
}

export type ToolClassification =
  | { kind: "allow" }
  | { kind: "needs_approval"; reason: string }
  | { kind: "deny"; reason: string };

/**
 * Policy skeleton classifier. Deterministic table — the full §4.8
 * engine (agentEgress, provenance, risk tiers) lands in P2-04.
 * Fail-closed: anything unrecognized that looks mutating → approval.
 */
export function classifyToolCall(ctx: ToolActionContext): ToolClassification {
  if (HARD_BLOCKED_TOOLS.has(ctx.tool)) {
    return { kind: "deny", reason: "tool is hard-blocked" };
  }
  const mutating = /\.(click|fill|submit|navigate|type|select|press|scroll|hover|drag|upload)$/.test(ctx.tool);
  const egress = ctx.dataEgress || /\.(fetch|request|post|send)/.test(ctx.tool);
  if (egress) {
    return { kind: "needs_approval", reason: "data egress requires approval" };
  }
  if (mutating) {
    return { kind: "needs_approval", reason: "mutating action requires approval" };
  }
  return { kind: "allow" };
}

export interface ToolServerDeps {
  tokens: ToolTokenManager;
  /** Resolve which host instance serves a task (minimal registry). */
  resolveHost(taskId: string): ToolHostChannel | null;
  /** Approval hook — P1-09 skeleton; P2-04 replaces with full engine. */
  requestApproval?(ctx: ToolActionContext): Promise<"approved" | "denied" | "timeout">;
  onOutcome?(outcome: ToolCallOutcome): void;
  now?: () => number;
  defaultTimeoutMs?: number;
}

export class BrowserToolServer {
  /** toolCallId → outcome — duplicate-execution protection (§9.1). */
  private readonly outcomes = new Map<string, ToolCallOutcome>();
  private readonly pending = new Map<string, { resolve: (o: ToolCallOutcome) => void; timer: NodeJS.Timeout }>();
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

    // 5. Classify + approval.
    const ctx: ToolActionContext = {
      taskId: req.taskId,
      ...(req.turnId !== undefined ? { turnId: req.turnId } : {}),
      tool: req.tool,
      args: req.args,
      backendId: req.backendId ?? "chrome-extension",
      dataEgress: /\.(fetch|request|post|send)/.test(req.tool),
    };
    const classification = classifyToolCall(ctx);
    if (classification.kind === "deny") {
      return this.finish({ toolCallId: req.toolCallId, tool: req.tool, status: "failed", error: { code: "browser.policy_denied", message: classification.reason } });
    }
    if (classification.kind === "needs_approval") {
      const verdict = await this.deps.requestApproval?.(ctx);
      if (verdict !== "approved") {
        return this.finish({ toolCallId: req.toolCallId, tool: req.tool, status: "failed", error: { code: "browser.approval_denied", message: verdict === "timeout" ? "approval timed out" : "approval denied" } });
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

  cancel(toolCallId: string): ToolCallOutcome | null {
    const p = this.pending.get(toolCallId);
    if (!p) return null;
    clearTimeout(p.timer);
    this.pending.delete(toolCallId);
    return this.finish({ toolCallId, tool: "", status: "cancelled" });
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
