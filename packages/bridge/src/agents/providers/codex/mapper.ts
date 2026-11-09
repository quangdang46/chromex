/**
 * Codex app-server notification → AgentEvent mapper — P1-05 / GateB-B2.
 *
 * Pure mapping layer replayable against test/fixtures/codex/*.json.
 * Handles the §4.4.1 turnId race: provider notifications may arrive
 * before startTurn() resolves; events are buffered per providerTurnId
 * and flushed once bindTurn(providerTurnId → gatewayTurnId) happens.
 * Events with no turnId assign only when exactly one turn is active.
 *
 * Emits {event, ephemeral} pairs — caller routes durable events to the
 * task stream and ephemeral deltas to the delta channel (never seq).
 */

import type { AgentEvent } from "@codex-sidepanel/shared";

export interface MappedAgentEvent {
  event: AgentEvent;
  /** true for assistant.delta/reasoning.delta — no durable seq */
  ephemeral: boolean;
  /** chars of this turn BEFORE this delta chunk (§4.4 gap detection) */
  deltaOffset?: number;
}

/** Buffered emission — replayed with the resolved gatewayTurnId. */
type DeferredEmit = () => void;

interface PendingBuffer {
  providerTurnId: string;
  deferred: DeferredEmit[];
}

interface DeltaState {
  /** chars emitted so far for deltaOffset continuity */
  offset: number;
}

const TOOL_ITEM_TYPES = new Set([
  "commandExecution",
  "fileChange",
  "mcpToolCall",
  "webSearch",
  "imageGeneration",
]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

export class CodexEventMapper {
  private gatewayTurnId: string | null = null;
  private providerTurnId: string | null = null;
  private readonly pending: PendingBuffer[] = [];
  private readonly deltas = new Map<string, DeltaState>();
  private readonly listeners = new Set<(e: MappedAgentEvent) => void>();
  private droppedNoTurnId = 0;

  constructor(private readonly sessionKey: string) {}

  onEvent(listener: (e: MappedAgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get droppedEventCount(): number {
    return this.droppedNoTurnId;
  }

  /**
   * Bind provider turn ↔ gateway turn. Flushes buffered events for that
   * providerTurnId. Call when startTurn resolves. The Gateway owns
   * user.message.created (it created the task) — the adapter only emits
   * provider-derived events.
   */
  bindTurn(providerTurnId: string, gatewayTurnId: string): void {
    this.providerTurnId = providerTurnId;
    this.gatewayTurnId = gatewayTurnId;
    this.emitDurable({ type: "turn.started", turnId: gatewayTurnId });
    // flush ALL buffers for this provider turn (events + deferred fns)
    for (let i = this.pending.length - 1; i >= 0; i -= 1) {
      const buf = this.pending[i]!;
      if (buf.providerTurnId === providerTurnId) {
        this.pending.splice(i, 1);
        for (const fn of buf.deferred) fn();
      }
    }
  }

  /** Mark the bound turn finished — subsequent no-turnId events drop. */
  unbindTurn(): void {
    this.gatewayTurnId = null;
    this.providerTurnId = null;
  }

  /**
   * Map one app-server notification. Returns mapped events via listeners.
   */
  mapNotification(method: string, params: unknown): void {
    const p = asRecord(params);
    if (!p) return;

    switch (method) {
      case "turn/started": {
        const turn = asRecord(p.turn);
        const providerTurnId = str(turn?.id) ?? str(p.turnId);
        if (providerTurnId && !this.gatewayTurnId) {
          // ensure a buffer exists so early events have somewhere to go
          if (!this.pending.some((b) => b.providerTurnId === providerTurnId)) {
            this.pending.push({ providerTurnId, deferred: [] });
          }
        }
        return;
      }
      case "item/agentMessage/delta": {
        const text = str(p.delta) ?? "";
        if (!text) return;
        const itemId = str(p.itemId) ?? "agent-message";
        const state = this.deltas.get(itemId) ?? { offset: 0 };
        const deltaOffset = state.offset;
        state.offset += text.length;
        this.deltas.set(itemId, state);
        this.withTurn(str(p.turnId), (turnId) =>
          this.emitEphemeral({ type: "assistant.delta", turnId, text }, deltaOffset),
        );
        return;
      }
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const text = str(p.delta) ?? "";
        if (!text) return;
        this.withTurn(str(p.turnId), (turnId) =>
          this.emitEphemeral({ type: "reasoning.delta", turnId, text }),
        );
        return;
      }
      case "item/started": {
        const item = asRecord(p.item);
        if (!item) return;
        const itemType = str(item.type);
        if (!itemType || !TOOL_ITEM_TYPES.has(itemType)) return;
        const toolCallId = str(item.id) ?? str(item.callId) ?? "unknown";
        this.withTurn(str(p.turnId) ?? str(item.turnId), (turnId) =>
          this.emitDurable({
            type: "tool.started",
            turnId,
            toolCallId,
            tool: itemType,
            source: "provider",
            input: boundInput(item),
          }),
        );
        return;
      }
      case "item/completed": {
        const item = asRecord(p.item);
        if (!item) return;
        const itemType = str(item.type);
        if (itemType === "agentMessage") {
          const text = extractAgentMessageText(item);
          if (!text) return; // diagnostic: empty completion skipped
          this.withTurn(str(p.turnId) ?? str(item.turnId), (turnId) =>
            this.emitDurable({ type: "assistant.message", turnId, text }),
          );
          return;
        }
        if (itemType && TOOL_ITEM_TYPES.has(itemType)) {
          const toolCallId = str(item.id) ?? str(item.callId) ?? "unknown";
          const output = boundOutput(item);
          this.withTurn(str(p.turnId) ?? str(item.turnId), (turnId) =>
            this.emitDurable({
              type: "tool.completed",
              turnId,
              toolCallId,
              tool: itemType,
              outcome: toolOutcome(item),
              ...(output !== undefined ? { output } : {}),
            }),
          );
        }
        return;
      }
      case "turn/diff/updated": {
        // durable deliverable evidence — was dropped in gateway mode while
        // the legacy codex-plane emitted turn.diff.updated (S8).
        const diff = str(p.diff);
        if (diff === null) return;
        this.withTurn(str(p.turnId), (turnId) =>
          this.emitDurable({ type: "turn.diff.updated", turnId, diff }),
        );
        return;
      }
      case "item/tool/requestUserInput": {
        const requestId = str(p.itemId) ?? str(p.requestId) ?? `perm-${Date.now()}`;
        this.withTurn(str(p.turnId), (turnId) =>
          this.emitDurable({
            type: "permission.requested",
            turnId,
            request: {
              requestId,
              // Gateway (P1-06) stamps taskId/actionDigest at persist time —
              // provider-level requests carry empty placeholders here.
              taskId: "",
              turnId,
              kind: "provider_permission",
              risk: "low",
              summary: summarizeUserInputRequest(p),
              actionDigest: "",
              details: {
                tool: "requestUserInput",
                argsPreview: boundInput(p) ?? null,
                origin: "provider",
              },
              options: permissionOptions(p),
            },
          }),
        );
        return;
      }
      case "turn/completed": {
        const turn = asRecord(p.turn);
        const status = str(turn?.status) ?? str(p.status);
        const error = asRecord(turn?.error);
        // route through withTurn so a completion arriving before
        // bindTurn() buffers like every other turn-scoped event (§4.4.1)
        this.withTurn(str(turn?.id) ?? str(p.turnId), (turnId) => {
          if (status === "interrupted" || status === "cancelled") {
            this.emitDurable({ type: "turn.cancelled", turnId, reason: status });
          } else if (error || status === "failed" || status === "error") {
            this.emitDurable({
              type: "turn.failed",
              turnId,
              error: {
                code: "provider.turn_failed",
                message: str(error?.message) ?? "turn failed",
                retryable: true,
                requiresUserAction: false,
                sideEffectState: "unknown",
              },
            });
          } else {
            this.emitDurable({ type: "turn.completed", turnId });
          }
        });
        // Turn is terminal — delta offsets only matter intra-turn.
        // (pending buffers must NOT be dropped here: bindTurn may still
        // arrive after the completion notification and needs them.)
        this.deltas.clear();
        return;
      }
      default:
        return;
    }
  }

  /** Resolve provider turnId → gateway turnId, buffering when unbound. */
  private withTurn(providerTurnId: string | null, fn: (gatewayTurnId: string) => void): void {
    if (this.gatewayTurnId) {
      fn(this.gatewayTurnId);
      return;
    }
    if (providerTurnId) {
      // buffer the EMISSION (not the event) so it flushes with the
      // resolved gatewayTurnId — events must never carry a wrong turnId.
      const captured = fn;
      let buf = this.pending.find((b) => b.providerTurnId === providerTurnId);
      if (!buf) {
        buf = { providerTurnId, deferred: [] };
        this.pending.push(buf);
      }
      buf.deferred.push(() => {
        if (this.gatewayTurnId) captured(this.gatewayTurnId);
      });
      return;
    }
    // no turnId: assign only when exactly one bound/active turn
    if (this.gatewayTurnId) {
      fn(this.gatewayTurnId);
      return;
    }
    this.droppedNoTurnId += 1;
  }

  private emit(e: MappedAgentEvent): void {
    for (const l of this.listeners) l(e);
  }

  private emitDurable(event: AgentEvent): void {
    this.emit({ event, ephemeral: false });
  }

  private emitEphemeral(
    event: Extract<AgentEvent, { type: "assistant.delta" | "reasoning.delta" }>,
    deltaOffset?: number,
  ): void {
    this.emit({ event, ephemeral: true, ...(deltaOffset !== undefined ? { deltaOffset } : {}) });
  }
}

function boundInput(item: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const key of [
    "command",
    "commandLine",
    "cmd",
    "argv",
    "query",
    "url",
    "path",
    "file_path",
    "notebook_path",
    "changes",
    "arguments",
  ]) {
    if (item[key] !== undefined) out[key] = item[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function boundOutput(item: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const key of [
    "aggregatedOutput",
    "aggregated_output",
    "output",
    "outputText",
    "output_text",
    "result",
    "exitCode",
    "changes",
  ]) {
    if (item[key] !== undefined) out[key] = item[key];
  }
  return Object.keys(out).length ? out : undefined;
}

function extractAgentMessageText(item: Record<string, unknown>): string | null {
  const text = str(item.text);
  if (text) return text;
  const content = item.content;
  if (Array.isArray(content)) {
    const joined = content
      .map((c) => {
        const r = asRecord(c);
        return r && r.type === "text" ? str(r.text) : null;
      })
      .filter((x): x is string => !!x)
      .join("");
    return joined || null;
  }
  return null;
}

function toolOutcome(item: Record<string, unknown>): "succeeded" | "failed" | "cancelled" | "unknown" {
  const status = str(item.status);
  if (status === "completed" || status === "succeeded") {
    const exitCode = item.exitCode;
    if (typeof exitCode === "number" && exitCode !== 0) return "failed";
    return "succeeded";
  }
  if (status === "failed" || status === "error") return "failed";
  if (status === "cancelled" || status === "interrupted") return "cancelled";
  if (status === "inProgress" || status === "in_progress") return "unknown";
  return "unknown";
}

function summarizeUserInputRequest(p: Record<string, unknown>): string {
  const questions = Array.isArray(p.questions) ? p.questions : [];
  const first = asRecord(questions[0]);
  return str(first?.question) ?? "Codex requests user input";
}

function permissionOptions(p: Record<string, unknown>): Array<{
  id: string;
  label: string;
  kind: "allow_once" | "allow_task" | "deny";
}> {
  const questions = Array.isArray(p.questions) ? p.questions : [];
  const first = asRecord(questions[0]);
  const opts = Array.isArray(first?.options) ? first.options : [];
  return opts
    .map((o) => {
      const r = asRecord(o);
      const id = str(r?.id) ?? "";
      const label = str(r?.label) ?? id;
      const kind =
        /deny|reject|no/i.test(id + label)
          ? ("deny" as const)
          : /always|task|session/i.test(id + label)
            ? ("allow_task" as const)
            : ("allow_once" as const);
      return id ? { id, label, kind } : null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}
