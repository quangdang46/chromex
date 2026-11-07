/**
 * Gateway → legacy bridge.event translation — P1-10 interim path.
 *
 * The sidepanel still consumes the legacy event vocabulary
 * (message.delta/message.completed/turn.*). Until the UI migrates to
 * task.* envelopes natively, durable task events and ephemeral deltas
 * are translated here so existing rendering keeps working in
 * gatewayMode. Unmapped events return null (dropped, never faked).
 *
 * threadId === taskId (compat layer maps session.open→task.create and
 * returns taskId as threadId); turnId === gatewayTurnId.
 */

import type { Envelope } from "@codex-sidepanel/shared";

interface EnvPayload {
  type?: string;
  turnId?: string;
  text?: string;
  deltaOffset?: number;
  stopReason?: string;
  error?: { code?: string; message?: string };
  request?: {
    requestId?: string;
    kind?: string;
    risk?: string;
    summary?: string;
    options?: Array<{ id?: string; label?: string; kind?: string }>;
    details?: {
      tool?: string;
      argsPreview?: unknown;
      origin?: string;
      targetLabel?: string;
      allowTaskScope?: string;
    };
  };
  verified?: boolean | "unknown";
  decision?: { kind?: string };
  [k: string]: unknown;
}

function envOf(env: Envelope): { taskId: string; payload: EnvPayload } | null {
  if (env.kind !== "event") return null;
  const e = env as {
    taskId?: string;
    payload?: EnvPayload;
    type?: string;
    turnId?: string;
    text?: string;
    deltaOffset?: number;
  };
  const taskId = typeof e.taskId === "string" ? e.taskId : "";
  const payload = (e.payload ?? {}) as EnvPayload;
  // durable: type/payload.type mirror; ephemeral: fields are top-level
  if (!payload.type && typeof e.type === "string") payload.type = e.type;
  if (typeof e.turnId === "string" && !payload.turnId) payload.turnId = e.turnId;
  if (typeof e.text === "string" && payload.text === undefined) payload.text = e.text;
  if (typeof e.deltaOffset === "number" && payload.deltaOffset === undefined)
    payload.deltaOffset = e.deltaOffset;
  return taskId ? { taskId, payload } : null;
}

/** Translate one gateway envelope to a legacy bridge.event, or null. */
export function gatewayEventToLegacy(env: Envelope): Record<string, unknown> | null {
  // Gateway-stream events carry no taskId — envOf() drops them. Account
  // login completion is provider-global (chromex-fjr): pass it through
  // under the legacy event name the sidepanel already handles.
  const gw = env as { stream?: unknown; type?: unknown; payload?: unknown };
  if (gw.stream === "gateway" && gw.type === "account.login.completed") {
    const p = (gw.payload ?? {}) as Record<string, unknown>;
    return {
      type: "account.login.completed",
      loginId: typeof p.loginId === "string" ? p.loginId : "",
      success: p.success === true,
      error: typeof p.error === "string" ? p.error : null,
    };
  }
  const parsed = envOf(env);
  if (!parsed) return null;
  const { taskId, payload } = parsed;
  const turnId = typeof payload.turnId === "string" ? payload.turnId : "";
  const base = { threadId: taskId, ...(turnId ? { turnId } : {}) };

  // ephemeral deltas — reliability:"ephemeral", no seq
  if ((env as { reliability?: string }).reliability === "ephemeral") {
    if (payload.type === "assistant.delta") {
      return {
        type: "message.delta",
        ...base,
        itemId: `gw-${turnId}`,
        delta: typeof payload.text === "string" ? payload.text : "",
      };
    }
    if (payload.type === "reasoning.delta") {
      // accumulate per turn → ONE reasoning trace item, throttled
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text) accumulateReasoning(taskId, turnId, text);
      const throttled = maybeEmitReasoning(taskId, turnId);
      return throttled
        ? {
            type: "turn.activity",
            ...base,
            itemId: `reasoning-${turnId}`,
            kind: "reasoning",
            title: "Thinking",
            detail: "",
            thinkingText: reasoningText(taskId, turnId),
            status: "running",
            timestampMs: Date.now(),
          }
        : null;
    }
    return null;
  }

  switch (payload.type) {
    case "assistant.message":
      return {
        type: "message.completed",
        ...base,
        itemId: `gw-${turnId}`,
        text: typeof payload.text === "string" ? payload.text : "",
      };
    case "turn.started":
      return { type: "turn.started", ...base, activeTurn: { turnId, threadId: taskId } };
    case "reasoning.summary":
      return {
        type: "turn.activity",
        ...base,
        itemId: `reasoning-${turnId}`,
        kind: "reasoning",
        title: "Thinking",
        detail: "",
        thinkingText:
          typeof (payload as { summary?: unknown }).summary === "string"
            ? ((payload as { summary: string }).summary)
            : reasoningText(taskId, turnId),
        status: "completed",
        timestampMs: Date.now(),
      };
    case "turn.completed":
      clearReasoning(taskId, turnId);
      return { type: "turn.completed", ...base, stopReason: payload.stopReason };
    case "turn.failed":
      clearReasoning(taskId, turnId);
      return {
        type: "turn.failed",
        ...base,
        error: payload.error?.message ?? payload.error?.code ?? "turn failed",
      };
    case "turn.cancelled":
      clearReasoning(taskId, turnId);
      return { type: "turn.completed", ...base, stopReason: "cancelled" };
    case "turn.diff.updated":
      // gateway durable turn diff → legacy shape the sidepanel diff UI
      // and deliverable extraction already consume (threadId === taskId).
      return {
        type: "turn.diff.updated",
        ...base,
        diff: {
          threadId: taskId,
          turnId,
          diff: typeof payload.diff === "string" ? payload.diff : "",
        },
      };
    case "turn.unknown":
      clearReasoning(taskId, turnId);
      return { type: "turn.failed", ...base, error: "turn outcome unknown after restart" };
    case "permission.requested": {
      const req = payload.request;
      const argsPreview = req?.details?.argsPreview;
      const questions =
        argsPreview && typeof argsPreview === "object"
          ? (argsPreview as { questions?: unknown }).questions
          : undefined;
      if (
        req?.kind === "provider_permission" &&
        Array.isArray(questions) &&
        questions.length > 0
      ) {
        // ask-user prompts keep the question wizard — every other
        // permission kind (browser_action, data_entry_sensitive,
        // agent_egress, plain provider_permission) renders the
        // dedicated approval card so no request silently hangs.
        return {
          type: "plan.user_input.requested",
          ...base,
          requestId: req.requestId ?? "",
          itemId: `perm-${req.requestId ?? ""}`,
          questions,
        };
      }
      return permissionApprovalLegacyEvent(taskId, turnId, req);
    }
    case "permission.resolved":
      // single legacy event clears BOTH the approval card and the
      // question wizard — either may own this requestId.
      return {
        type: "permission.resolved",
        ...base,
        requestId:
          typeof (payload as { requestId?: unknown }).requestId === "string"
            ? ((payload as { requestId: string }).requestId)
            : "",
      };
    case "permission.expired":
      // approvals time out / tasks go terminal — the panel must drop
      // the pending card instead of leaving it actionable forever.
      return {
        type: "permission.expired",
        ...base,
        requestId:
          typeof (payload as { requestId?: unknown }).requestId === "string"
            ? ((payload as { requestId: string }).requestId)
            : "",
        reason:
          typeof (payload as { reason?: unknown }).reason === "string"
            ? ((payload as { reason: string }).reason)
            : "",
      };
    case "provider.notice": {
      // durable task-level notice (warnings/info from providers or the
      // gateway itself). There is no dedicated legacy event, so surface
      // it as a trace row: warn → failed status, info → completed.
      // Notices usually carry no turnId — group them under a synthetic
      // per-task turn so they render as their own trace message.
      const isWarn = payload.level === "warn";
      const message = typeof payload.message === "string" ? payload.message.trim() : "";
      if (!message) return null;
      const noticeTurnId = turnId || "provider-notice";
      const seq = typeof (env as { seq?: unknown }).seq === "number" ? (env as { seq: number }).seq : 0;
      return {
        type: "turn.activity",
        threadId: taskId,
        turnId: noticeTurnId,
        itemId: `provider-notice-${seq || Date.now()}`,
        kind: "tool",
        title: isWarn ? "Provider warning" : "Provider notice",
        detail: message,
        status: isWarn ? "failed" : "completed",
        timestampMs: Date.now(),
      };
    }
    case "tool.started":
    case "tool.completed": {
      // sidepanel renders agent activity via legacy `turn.activity`
      // trace items — translate provider tool events into that shape so
      // users see what the coding agent is doing, Paseo-style.
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
      const started = payload.type === "tool.started";
      const failed = !started && (payload.outcome === "failed" || payload.outcome === "cancelled");
      const status = started ? "running" : failed ? "failed" : "completed";
      if (started && toolCallId) {
        rememberToolContext(toolCallId, {
          tool: typeof payload.tool === "string" ? payload.tool : "",
          input: payload.input,
        });
      }
      const ctx = (toolCallId && toolContext.get(toolCallId)) || {
        tool: typeof payload.tool === "string" ? payload.tool : "",
        input: payload.input,
      };
      const activity = describeGatewayTool(ctx.tool, ctx.input, status);
      if (toolCallId) toolContext.delete(toolCallId);
      return {
        type: "turn.activity",
        ...base,
        itemId: toolCallId || `tool-${Date.now()}`,
        kind: activity.kind,
        title: activity.title,
        detail: activity.detail,
        status,
        timestampMs: Date.now(),
        tool: ctx.tool || undefined,
        ...(started && ctx.input !== undefined ? { inputText: boundText(ctx.input) } : {}),
        ...(!started && payload.output !== undefined ? { outputText: boundText(payload.output) } : {}),
        ...(failed ? { errorText: boundText(payload.output ?? "tool call failed") } : {}),
        ...(!started && isVerificationResult(payload.verified) ? { verified: payload.verified } : {}),
      };
    }
    default:
      return null;
  }
}

// ---- permission approval card ---------------------------------------------
//
// Every permission kind that is NOT an ask-user question wizard lands
// here: browser_action, data_entry_sensitive, agent_egress, and plain
// provider_permission tool approvals. The sidepanel renders one
// approval card and answers via permission.respond {requestId, optionId}.

function isVerificationResult(value: unknown): value is boolean | "unknown" {
  return value === true || value === false || value === "unknown";
}

function permissionApprovalLegacyEvent(
  taskId: string,
  turnId: string,
  req: NonNullable<EnvPayload["request"]> | undefined,
): Record<string, unknown> {
  const requestId = typeof req?.requestId === "string" ? req.requestId : "";
  const options = (req?.options ?? [])
    .filter((o) => typeof o?.id === "string" && o.id && typeof o?.label === "string" && o.label)
    .map((o) => ({
      id: o.id as string,
      label: o.label as string,
      kind: typeof o.kind === "string" ? o.kind : "allow_once",
    }));
  const details = req?.details;
  const argsPreviewText =
    details?.argsPreview !== undefined ? boundText(details.argsPreview, 1500) : "";
  return {
    type: "permission.approval.requested",
    threadId: taskId,
    ...(turnId ? { turnId } : {}),
    requestId,
    itemId: `appr-${requestId}`,
    permissionKind: typeof req?.kind === "string" ? req.kind : "",
    risk: typeof req?.risk === "string" ? req.risk : "",
    summary: typeof req?.summary === "string" ? req.summary : "",
    tool: typeof details?.tool === "string" ? details.tool : "",
    origin: typeof details?.origin === "string" ? details.origin : "",
    ...(typeof details?.targetLabel === "string" && details.targetLabel
      ? { targetLabel: details.targetLabel }
      : {}),
    ...(argsPreviewText ? { argsPreviewText } : {}),
    options,
  };
}

// ---- reasoning accumulation (one trace item per turn, throttled) ----

const REASONING_THROTTLE_MS = 200;
const REASONING_MAX_CHARS = 8000;
const reasoningBuf = new Map<string, { text: string; lastEmit: number }>();

function reasoningKey(taskId: string, turnId: string): string {
  return `${taskId}${turnId}`;
}

function accumulateReasoning(taskId: string, turnId: string, delta: string): void {
  const key = reasoningKey(taskId, turnId);
  const buf = reasoningBuf.get(key) ?? { text: "", lastEmit: 0 };
  buf.text = (buf.text + delta).slice(-REASONING_MAX_CHARS);
  reasoningBuf.set(key, buf);
}

function reasoningText(taskId: string, turnId: string): string {
  return reasoningBuf.get(reasoningKey(taskId, turnId))?.text ?? "";
}

function maybeEmitReasoning(taskId: string, turnId: string): boolean {
  const key = reasoningKey(taskId, turnId);
  const buf = reasoningBuf.get(key);
  if (!buf) return false;
  const now = Date.now();
  if (now - buf.lastEmit < REASONING_THROTTLE_MS) return false;
  buf.lastEmit = now;
  return true;
}

function clearReasoning(taskId: string, turnId: string): void {
  reasoningBuf.delete(reasoningKey(taskId, turnId));
}

// tool.completed arrives without tool/input on some providers (claude
// mapper emits tool:"" ) — remember the started payload per call id.
const toolContext = new Map<string, { tool: string; input?: unknown }>();
const MAX_TOOL_CONTEXT = 500;

function rememberToolContext(id: string, ctx: { tool: string; input?: unknown }): void {
  if (toolContext.size >= MAX_TOOL_CONTEXT) {
    const oldest = toolContext.keys().next().value;
    if (oldest !== undefined) toolContext.delete(oldest);
  }
  toolContext.set(id, ctx);
}

type TraceKind = "command" | "file" | "web" | "image" | "browser" | "tool";

function describeGatewayTool(
  tool: string,
  input: unknown,
  status: "running" | "completed" | "failed",
): { kind: TraceKind; title: string; detail: string } {
  const name = tool.toLowerCase();
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const detail = extractToolDetail(rec) || summarizeInput(input);
  const running = status === "running";
  const pick = (run: string, done: string) => (running ? run : done);

  if (name.includes("commandexecution") || name.includes("bash") || name.includes("shell") || name.includes("exec")) {
    return { kind: "command", title: pick("Running command", "Command complete"), detail };
  }
  if (name.includes("websearch") || name.includes("web_search") || name.includes("webfetch") || name.includes("web_fetch")) {
    return { kind: "web", title: pick("Searching the web", "Web search complete"), detail };
  }
  if (name.includes("imagegeneration") || name.includes("image_generation") || name === "image") {
    return { kind: "image", title: pick("Generating image", "Image generated"), detail };
  }
  if (
    name.includes("filechange") ||
    name.includes("edit") ||
    name.includes("write") ||
    name.includes("patch") ||
    name.includes("multiedit") ||
    name.includes("notebook")
  ) {
    return { kind: "file", title: pick("Editing files", "File changes complete"), detail };
  }
  if (
    name.includes("read") ||
    name.includes("grep") ||
    name.includes("glob") ||
    name.includes("list") ||
    name.includes("file") ||
    name.includes("ls")
  ) {
    return { kind: "file", title: pick("Exploring files", "File exploration complete"), detail };
  }
  if (name.includes("mcp") || name.startsWith("mcp__")) {
    const server = str(rec.server) || name.split("__")[1] || "";
    const toolName = str(rec.tool) || name.split("__").slice(2).join("__");
    return {
      kind: "tool",
      title: pick("Using MCP tool", "MCP tool complete"),
      detail: [server, toolName].filter(Boolean).join(" · ") || detail,
    };
  }
  if (name.includes("browser") || name.startsWith("browser.")) {
    return { kind: "browser", title: pick("Browser action", "Browser action complete"), detail };
  }
  if (name.includes("task") || name.includes("subagent") || name.includes("agent")) {
    return { kind: "tool", title: pick("Subagent working", "Subagent finished"), detail };
  }
  return {
    kind: "tool",
    title: pick(`${humanizeToolName(tool)} running`, `${humanizeToolName(tool)} complete`),
    detail,
  };
}

function humanizeToolName(tool: string): string {
  const cleaned = tool.replace(/^subagent:/, "").replace(/[_-]+/g, " ").trim();
  if (!cleaned) return "Tool";
  return cleaned.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractToolDetail(rec: Record<string, unknown>): string {
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  for (const key of [
    "command",
    "commandLine",
    "cmd",
    "query",
    "url",
    "path",
    "file_path",
    "filePath",
    "notebook_path",
    "pattern",
    "prompt",
  ]) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim().slice(0, 300);
    if (Array.isArray(v)) {
      const joined = v
        .map((x) => (typeof x === "string" ? x : JSON.stringify(x)))
        .join(" ")
        .trim();
      if (joined) return joined.slice(0, 300);
    }
  }
  const changes = rec.changes;
  if (Array.isArray(changes) && changes.length) {
    const parts = changes
      .map((c) => {
        const r = c && typeof c === "object" ? (c as Record<string, unknown>) : {};
        return str(r.path) || str(r.file_path) || str(r.filePath) || "";
      })
      .filter(Boolean);
    if (parts.length) {
      return parts.slice(0, 6).join(", ") + (parts.length > 6 ? ` +${parts.length - 6} more` : "");
    }
  }
  return "";
}

function boundText(value: unknown, max = 1200): string {
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else {
    try {
      s = JSON.stringify(value, null, 2);
    } catch {
      s = String(value);
    }
  }
  s = s.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function summarizeInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  try {
    const s = JSON.stringify(input);
    return s.length > 160 ? `${s.slice(0, 157)}…` : s;
  } catch {
    return "";
  }
}
