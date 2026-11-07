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
  request?: { requestId?: string; kind?: string; summary?: string; risk?: string };
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
      return {
        type: "reasoning.delta",
        ...base,
        delta: typeof payload.text === "string" ? payload.text : "",
      };
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
    case "turn.completed":
      return { type: "turn.completed", ...base, stopReason: payload.stopReason };
    case "turn.failed":
      return {
        type: "turn.failed",
        ...base,
        error: payload.error?.message ?? payload.error?.code ?? "turn failed",
      };
    case "turn.cancelled":
      return { type: "turn.completed", ...base, stopReason: "cancelled" };
    case "turn.unknown":
      return { type: "turn.failed", ...base, error: "turn outcome unknown after restart" };
    case "permission.requested": {
      const req = payload.request as
        | {
            requestId?: string;
            kind?: string;
            summary?: string;
            options?: Array<{ id?: string; label?: string; kind?: string }>;
            details?: { argsPreview?: { questions?: unknown[] } };
          }
        | undefined;
      const questions = req?.details?.argsPreview?.questions;
      if (req?.kind === "browser_action") {
        // gateway browser-tool approval — render as a single
        // approve/deny question through the existing input card;
        // permission.respond resolves the approvals row.
        const summary =
          typeof (req as { summary?: unknown }).summary === "string"
            ? (req as { summary: string }).summary
            : "Browser action requires approval";
        return {
          type: "plan.user_input.requested",
          ...base,
          requestId: req.requestId ?? "",
          itemId: `appr-${req.requestId ?? ""}`,
          questions: [
            {
              id: "decision",
              header: "Approval",
              question: summary,
              options:
                (req.options ?? []).filter((o) => typeof o?.label === "string").length > 0
                  ? (req.options ?? [])
                      .filter((o) => typeof o?.label === "string")
                      .map((o) => ({
                        label: o.label as string,
                        description:
                          o.kind === "allow_task"
                            ? "Allow this action scope for the rest of the task"
                            : o.kind === "deny"
                              ? "Reject this browser action"
                              : "Allow this browser action once",
                        ...(typeof o.id === "string" ? { id: o.id } : {}),
                      }))
                  : [
                      { label: "allow_once", description: "Allow this browser action once" },
                      { label: "deny", description: "Reject this browser action" },
                    ],
            },
          ],
        };
      }
      if (req?.kind === "provider_permission" && Array.isArray(questions) && questions.length > 0) {
        // legacy UI renders provider questions via plan.user_input.*
        return {
          type: "plan.user_input.requested",
          ...base,
          requestId: req.requestId ?? "",
          itemId: `perm-${req.requestId ?? ""}`,
          questions,
        };
      }
      return {
        type: "permission.requested",
        ...base,
        requestId: req?.requestId ?? "",
        request: req,
      };
    }
    case "permission.resolved":
      return {
        type: "plan.user_input.resolved",
        requestId: (payload as { requestId?: string }).requestId ?? "",
      };
    case "tool.started":
    case "tool.completed": {
      // sidepanel renders agent activity via legacy `turn.activity`
      // trace items — translate provider tool events into that shape so
      // users see what the coding agent is doing, Paseo-style.
      const toolCallId = typeof payload.toolCallId === "string" ? payload.toolCallId : "";
      const started = payload.type === "tool.started";
      const status = started ? "running" : "completed";
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
      const failed = !started && payload.outcome === "failed";
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
      };
    }
    default:
      return null;
  }
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
  status: "running" | "completed",
): { kind: TraceKind; title: string; detail: string } {
  const name = tool.toLowerCase();
  const rec = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const detail =
    str(rec.command) ||
    str(rec.query) ||
    str(rec.url) ||
    str(rec.path) ||
    str(rec.file_path) ||
    str(rec.filePath) ||
    str(rec.pattern) ||
    summarizeInput(input);
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
