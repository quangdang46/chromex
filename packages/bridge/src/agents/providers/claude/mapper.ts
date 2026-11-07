/**
 * ClaudeEventMapper — Claude Agent SDK messages → shared AgentEvent.
 *
 * Turn correlation: the session mints a UUID per startTurn and stamps
 * it on the SDKUserMessage; SDK frames echo it back as
 * `user_message_uuid`. We bind uuid → gatewayTurnId and prefer that
 * binding, falling back to the sequentially-active turn (turns are
 * serialized per session by SessionManager).
 *
 * Deltas: `includePartialMessages` stream_events carry
 * content_block_delta{text_delta|thinking_delta}; deltaOffset is a
 * per-turn running char count so clients can detect gaps (ephemeral,
 * never persisted).
 */

import type {
  AgentEvent,
  PermissionRequest,
} from "@codex-sidepanel/shared";
import type {
  SDKMessage,
  SDKPartialAssistantMessage,
  SDKAssistantMessage,
  SDKUserMessage,
  SDKResultMessage,
  SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";

export interface MappedItem {
  event: AgentEvent;
  /** true for assistant.delta / reasoning.delta — RAM-only */
  ephemeral: boolean;
  deltaOffset?: number;
}

interface TurnBuf {
  gatewayTurnId: string;
  uuid: string;
  text: string;
  reasoning: string;
  textOffset: number;
  reasoningOffset: number;
  sawTerminal: boolean;
  /** tool_use_id → tool name, so tool_result completions keep identity */
  toolNames: Map<string, string>;
}

type RawDelta =
  | { type: "text_delta"; text: string }
  | { type: "thinking_delta"; thinking: string }
  | { type: string };

export class ClaudeEventMapper {
  private readonly listeners = new Set<(item: MappedItem) => void>();
  private readonly turns = new Map<string, TurnBuf>(); // by uuid AND gatewayTurnId alias
  private activeGatewayTurnId: string | null = null;
  private sessionIdValue: string | null = null;
  private interruptRequested = false;

  onEvent(cb: (item: MappedItem) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  get sessionId(): string | null {
    return this.sessionIdValue;
  }

  /** Register a turn before its user message is enqueued. */
  bindTurn(gatewayTurnId: string, uuid: string): void {
    const buf: TurnBuf = {
      gatewayTurnId,
      uuid,
      text: "",
      reasoning: "",
      textOffset: 0,
      reasoningOffset: 0,
      sawTerminal: false,
      toolNames: new Map(),
    };
    this.turns.set(uuid, buf);
    this.turns.set(gatewayTurnId, buf);
    this.activeGatewayTurnId = gatewayTurnId;
    this.interruptRequested = false;
  }

  unbindTurn(): void {
    this.activeGatewayTurnId = null;
  }

  markInterruptRequested(): void {
    this.interruptRequested = true;
  }

  #emit(event: AgentEvent, ephemeral = false, deltaOffset?: number): void {
    const item: MappedItem = { event, ephemeral };
    if (deltaOffset !== undefined) item.deltaOffset = deltaOffset;
    for (const l of this.listeners) l(item);
  }

  #turnFor(msg: object): TurnBuf | null {
    const uuid = (msg as { user_message_uuid?: string }).user_message_uuid;
    if (uuid) {
      const byUuid = this.turns.get(uuid);
      if (byUuid) return byUuid;
    }
    return this.activeGatewayTurnId ? (this.turns.get(this.activeGatewayTurnId) ?? null) : null;
  }

  mapMessage(msg: SDKMessage): void {
    if (typeof (msg as { session_id?: unknown }).session_id === "string") {
      this.sessionIdValue = (msg as { session_id: string }).session_id;
    }
    switch (msg.type) {
      case "stream_event":
        this.#mapStreamEvent(msg as SDKPartialAssistantMessage);
        return;
      case "assistant":
        this.#mapAssistant(msg as SDKAssistantMessage);
        return;
      case "user":
        this.#mapUser(msg as SDKUserMessage);
        return;
      case "result":
        this.#mapResult(msg as SDKResultMessage);
        return;
      case "system":
        // init/status/compact etc. — nothing durable to emit; session_id
        // already captured above.
        void (msg as SDKSystemMessage);
        return;
      default:
        // task_*, hook_*, permission_denied advisories, mirror errors —
        // non-blocking chatter; provider.notice reserved for real issues.
        return;
    }
  }

  #mapStreamEvent(msg: SDKPartialAssistantMessage): void {
    const turn = this.#turnFor(msg);
    if (!turn || turn.sawTerminal) return;
    const ev = msg.event as { type?: string; delta?: RawDelta };
    if (ev.type !== "content_block_delta" || !ev.delta) return;
    const d = ev.delta;
    if (d.type === "text_delta" && "text" in d) {
      const text = d.text;
      this.#emit(
        { type: "assistant.delta", turnId: turn.gatewayTurnId, text },
        true,
        turn.textOffset,
      );
      turn.textOffset += text.length;
      turn.text += text;
    } else if (d.type === "thinking_delta" && "thinking" in d) {
      const text = d.thinking;
      this.#emit(
        { type: "reasoning.delta", turnId: turn.gatewayTurnId, text },
        true,
        turn.reasoningOffset,
      );
      turn.reasoningOffset += text.length;
      turn.reasoning += text;
    }
  }

  #mapAssistant(msg: SDKAssistantMessage): void {
    const turn = this.#turnFor(msg);
    if (!turn || turn.sawTerminal || msg.parent_tool_use_id) {
      // subagent frames still produce tool.started below only when they
      // carry tool_use; text from subagents is not main-turn output.
      if (msg.parent_tool_use_id) this.#mapToolUseBlocks(msg, turn);
      return;
    }
    for (const block of msg.message.content ?? []) {
      const b = block as { type?: string; text?: string; thinking?: string; id?: string; name?: string; input?: unknown };
      if (b.type === "text" && typeof b.text === "string") {
        turn.text += b.text;
      } else if (b.type === "thinking" && typeof b.thinking === "string") {
        turn.reasoning += b.thinking;
      } else if (b.type === "tool_use") {
        const id = String(b.id ?? "");
        const name = String(b.name ?? "unknown");
        turn.toolNames.set(id, name);
        this.#emit({
          type: "tool.started",
          turnId: turn.gatewayTurnId,
          toolCallId: id,
          tool: name,
          ...(b.input !== undefined ? { input: b.input } : {}),
          source: "provider",
        });
      }
    }
  }

  #mapToolUseBlocks(msg: SDKAssistantMessage, turn: TurnBuf | null): void {
    if (!turn) return;
    for (const block of msg.message.content ?? []) {
      const b = block as { type?: string; id?: string; name?: string; input?: unknown };
      if (b.type === "tool_use") {
        const id = String(b.id ?? "");
        const name = `subagent:${String(b.name ?? "unknown")}`;
        turn.toolNames.set(id, name);
        this.#emit({
          type: "tool.started",
          turnId: turn.gatewayTurnId,
          toolCallId: id,
          tool: name,
          ...(b.input !== undefined ? { input: b.input } : {}),
          source: "provider",
        });
      }
    }
  }

  #mapUser(msg: SDKUserMessage): void {
    // tool_result blocks inside user messages → tool.completed.
    // Our own submitted prompts also echo here — ignore plain text.
    const content = (msg.message as { content?: unknown }).content;
    if (!Array.isArray(content)) return;
    const turn = this.#turnFor(msg);
    for (const block of content) {
      const b = block as {
        type?: string;
        tool_use_id?: string;
        is_error?: boolean;
        content?: unknown;
      };
      if (b.type !== "tool_result" || !turn) continue;
      const failed = b.is_error === true;
      this.#emit({
        type: "tool.completed",
        turnId: turn.gatewayTurnId,
        toolCallId: String(b.tool_use_id ?? ""),
        tool: turn.toolNames.get(String(b.tool_use_id ?? "")) ?? "",
        outcome: failed ? "failed" : "succeeded",
        ...(b.content !== undefined ? { output: b.content } : {}),
      });
    }
  }

  #mapResult(msg: SDKResultMessage): void {
    const turn = this.#turnFor(msg);
    if (!turn || turn.sawTerminal) return;
    turn.sawTerminal = true;

    const subtype = (msg as { subtype?: string }).subtype;
    const isError = (msg as { is_error?: boolean }).is_error === true;
    const interrupted = this.interruptRequested;

    if (subtype === "success" && !isError && !interrupted) {
      const text = turn.text || String((msg as { result?: string }).result ?? "");
      if (text) {
        this.#emit({ type: "assistant.message", turnId: turn.gatewayTurnId, text });
      }
      if (turn.reasoning) {
        this.#emit({
          type: "reasoning.summary",
          turnId: turn.gatewayTurnId,
          summary: turn.reasoning.slice(0, 4000),
        });
      }
      const usage = (msg as { usage?: Record<string, unknown> }).usage as
        | { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number }
        | undefined;
      if (usage) {
        this.#emit({
          type: "usage",
          turnId: turn.gatewayTurnId,
          usage: {
            inputTokens: usage.input_tokens ?? 0,
            outputTokens: usage.output_tokens ?? 0,
            ...(usage.cache_read_input_tokens !== undefined
              ? { cachedInputTokens: usage.cache_read_input_tokens }
              : {}),
          },
        });
      }
      this.#emit({ type: "turn.completed", turnId: turn.gatewayTurnId });
    } else if (interrupted || subtype === "error_during_execution" || isError) {
      if (interrupted) {
        this.#emit({ type: "turn.cancelled", turnId: turn.gatewayTurnId, reason: "interrupted" });
      } else {
        this.#emit({
          type: "turn.failed",
          turnId: turn.gatewayTurnId,
          error: {
            code: "provider.turn_failed",
            message: String(
              (msg as { errors?: unknown }).errors ??
                (msg as { subtype?: string }).subtype ??
                "claude turn failed",
            ),
            retryable: true,
            requiresUserAction: false,
            sideEffectState: "unknown",
          },
        });
      }
    } else {
      // success-but-empty edge → still terminal
      this.#emit({ type: "turn.completed", turnId: turn.gatewayTurnId });
    }
    if (this.activeGatewayTurnId === turn.gatewayTurnId) {
      this.activeGatewayTurnId = null;
    }
  }
}

/** Build the shared PermissionRequest for a canUseTool invocation. */
export function permissionRequestForToolCall(opts: {
  requestId: string;
  turnId?: string;
  toolName: string;
  input: Record<string, unknown>;
  prompt?: string;
  description?: string;
}): PermissionRequest {
  const summary =
    opts.prompt ??
    opts.description ??
    `Claude requests permission to use ${opts.toolName}`;
  return {
    requestId: opts.requestId,
    taskId: "", // Gateway stamps at persist time
    ...(opts.turnId ? { turnId: opts.turnId } : {}),
    kind: "provider_permission",
    risk: "low",
    summary,
    actionDigest: "",
    details: {
      tool: opts.toolName,
      argsPreview: opts.input,
      origin: "provider",
    },
    options: [
      { id: "allow", label: "Allow once", kind: "allow_once" },
      { id: "deny", label: "Deny", kind: "deny" },
    ],
  };
}
