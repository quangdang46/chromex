/**
 * AcpEventMapper — ACP `session/update` notifications → shared AgentEvent.
 * Mechanism per docs/adr/acp-provider.md.
 *
 * ACP notifications carry no turn id — turns are serialized per session
 * (one session/prompt in flight), so everything attributes to the
 * active gatewayTurnId. Deltas carry deltaOffset = cumulative char count
 * for gap detection (ephemeral, never persisted).
 */

import type {
  AgentEvent,
  SlashCommand,
} from "@codex-sidepanel/shared";

export interface MappedItem {
  event: AgentEvent;
  ephemeral: boolean;
  deltaOffset?: number;
}

interface TurnBuf {
  gatewayTurnId: string;
  text: string;
  reasoning: string;
  textOffset: number;
  reasoningOffset: number;
  sawTerminal: boolean;
}

interface AcpContent {
  type?: string;
  text?: string;
}

interface AcpToolCall {
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  content?: unknown;
}

interface AcpConfigOption {
  id?: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{ value?: string; name?: string }>;
}

export interface AcpSessionInfo {
  sessionId: string | null;
  configOptions: AcpConfigOption[];
  currentModeId: string | null;
  commands: SlashCommand[];
}

export class AcpEventMapper {
  private readonly listeners = new Set<(item: MappedItem) => void>();
  private active: TurnBuf | null = null;
  private sessionIdValue: string | null = null;
  private configOptionsValue: AcpConfigOption[] = [];
  private currentModeIdValue: string | null = null;
  private commandsValue: SlashCommand[] = [];
  private interruptRequested = false;

  onEvent(cb: (item: MappedItem) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get info(): AcpSessionInfo {
    return {
      sessionId: this.sessionIdValue,
      configOptions: this.configOptionsValue,
      currentModeId: this.currentModeIdValue,
      commands: this.commandsValue,
    };
  }

  bindTurn(gatewayTurnId: string): void {
    this.active = {
      gatewayTurnId,
      text: "",
      reasoning: "",
      textOffset: 0,
      reasoningOffset: 0,
      sawTerminal: false,
    };
    this.interruptRequested = false;
  }

  unbindTurn(): void {
    this.active = null;
  }

  markInterruptRequested(): void {
    this.interruptRequested = true;
  }

  #emit(event: AgentEvent, ephemeral = false, deltaOffset?: number): void {
    const item: MappedItem = { event, ephemeral };
    if (deltaOffset !== undefined) item.deltaOffset = deltaOffset;
    for (const l of this.listeners) l(item);
  }

  #contentText(content: unknown): string {
    if (typeof content === "string") return content;
    const c = content as AcpContent | undefined;
    return c?.type === "text" && typeof c.text === "string" ? c.text : "";
  }

  /** Dispatch one `session/update` params object ({sessionUpdate, ...}). */
  mapUpdate(params: unknown): void {
    const p = params as Record<string, unknown> | null;
    const kind = p?.sessionUpdate;
    if (!p || typeof kind !== "string") return;
    switch (kind) {
      case "agent_message_chunk": {
        const text = this.#contentText(p.content);
        const t = this.active;
        if (!t || !text) return;
        this.#emit(
          { type: "assistant.delta", turnId: t.gatewayTurnId, text },
          true,
          t.textOffset,
        );
        t.textOffset += text.length;
        t.text += text;
        return;
      }
      case "agent_thought_chunk": {
        const text = this.#contentText(p.content);
        const t = this.active;
        if (!t || !text) return;
        this.#emit(
          { type: "reasoning.delta", turnId: t.gatewayTurnId, text },
          true,
          t.reasoningOffset,
        );
        t.reasoningOffset += text.length;
        t.reasoning += text;
        return;
      }
      case "tool_call":
        this.#mapToolCall(p as unknown as AcpToolCall, "started");
        return;
      case "tool_call_update":
        this.#mapToolCall(p as unknown as AcpToolCall, "update");
        return;
      case "usage_update":
        this.#mapUsage(p);
        return;
      case "available_commands_update":
        this.#mapCommands(p);
        return;
      case "config_option_update":
        this.#mapConfigOptions(p);
        return;
      case "current_mode_update":
        if (typeof p.currentModeId === "string") {
          this.currentModeIdValue = p.currentModeId;
        }
        return;
      case "session_info_update":
        return;
      default:
        return;
    }
  }

  #mapToolCall(tc: AcpToolCall, phase: "started" | "update"): void {
    const t = this.active;
    if (!t) return;
    const toolCallId = String(tc.toolCallId ?? "");
    if (!toolCallId) return;
    if (phase === "started" || tc.status === "pending" || tc.status === "in_progress") {
      if (phase === "started") {
        this.#emit({
          type: "tool.started",
          turnId: t.gatewayTurnId,
          toolCallId,
          tool: tc.kind ?? tc.title ?? "tool",
          ...(tc.rawInput !== undefined ? { input: tc.rawInput } : {}),
          source: "provider",
        });
      }
      return;
    }
    if (tc.status === "completed" || tc.status === "failed") {
      this.#emit({
        type: "tool.completed",
        turnId: t.gatewayTurnId,
        toolCallId,
        tool: tc.kind ?? tc.title ?? "tool",
        outcome: tc.status === "completed" ? "succeeded" : "failed",
        ...(tc.rawOutput !== undefined ? { output: tc.rawOutput } : tc.content !== undefined ? { output: tc.content } : {}),
      });
    }
  }

  #mapUsage(p: Record<string, unknown>): void {
    const t = this.active;
    if (!t) return;
    const used = typeof p.used === "number" ? p.used : undefined;
    const size = typeof p.size === "number" ? p.size : undefined;
    this.#emit({
      type: "usage",
      turnId: t.gatewayTurnId,
      usage: {
        ...(used !== undefined ? { inputTokens: used } : {}),
        ...(size !== undefined ? { extra: { contextWindowUsed: used ?? null, contextWindowSize: size } } : {}),
      },
    });
  }

  #mapCommands(p: Record<string, unknown>): void {
    const list = p.availableCommands;
    if (!Array.isArray(list)) return;
    this.commandsValue = list
      .filter((c): c is Record<string, unknown> => !!c && typeof c === "object")
      .map((c) => ({
        name: String(c.name ?? ""),
        ...(typeof c.description === "string" ? { description: c.description } : {}),
        ...(typeof c.argumentHint === "string" ? { argumentHint: c.argumentHint } : {}),
      }))
      .filter((c) => c.name.length > 0);
  }

  #mapConfigOptions(p: Record<string, unknown>): void {
    const opts = p.configOptions;
    if (Array.isArray(opts)) this.configOptionsValue = opts as AcpConfigOption[];
  }

  /** Called when session/new|load returns — seeds configOptions + sessionId. */
  seedSession(sessionId: string, configOptions?: unknown): void {
    this.sessionIdValue = sessionId;
    if (Array.isArray(configOptions)) {
      this.configOptionsValue = configOptions as AcpConfigOption[];
    }
  }

  /** Terminal emission when the session/prompt RPC resolves. */
  finishTurn(stopReason: string | undefined, turnFailed = false, errorMessage?: string): void {
    const t = this.active;
    if (!t || t.sawTerminal) return;
    t.sawTerminal = true;
    if (turnFailed && this.interruptRequested) {
      // The prompt RPC rejected because we cancelled — the truthful
      // terminal is cancelled, not failed (a failure flush would wrongly
      // auto-send queued composer messages).
      this.#emit({ type: "turn.cancelled", turnId: t.gatewayTurnId, reason: "interrupted" });
    } else if (turnFailed) {
      this.#emit({
        type: "turn.failed",
        turnId: t.gatewayTurnId,
        error: {
          code: "provider.turn_failed",
          message: errorMessage ?? "ACP turn failed",
          retryable: true,
          requiresUserAction: false,
          sideEffectState: "unknown",
        },
      });
    } else if (this.interruptRequested || stopReason === "cancelled") {
      this.#emit({ type: "turn.cancelled", turnId: t.gatewayTurnId, reason: "interrupted" });
    } else {
      if (t.text) {
        this.#emit({ type: "assistant.message", turnId: t.gatewayTurnId, text: t.text });
      }
      if (t.reasoning) {
        this.#emit({
          type: "reasoning.summary",
          turnId: t.gatewayTurnId,
          summary: t.reasoning.slice(0, 4000),
        });
      }
      this.#emit({
        type: "turn.completed",
        turnId: t.gatewayTurnId,
        ...(stopReason ? { stopReason } : {}),
      });
    }
    if (this.active?.gatewayTurnId === t.gatewayTurnId) this.active = null;
  }
}
