/**
 * TaskSnapshot → sidepanel ConversationMessage[] — P1-10 rebuild path.
 *
 * Produces the minimal honest view: user prompts and assistant finals in
 * turn order. Tool calls/permissions are NOT synthesized into fake
 * messages — the durable event stream already carries them live, and
 * snapshot rebuilds happen when the panel re-syncs after pruning.
 * Artifact-missing assistant text becomes an explicit placeholder,
 * never silently empty.
 *
 * Rebuild honesty: snapshotToMessages only runs after event-log pruning,
 * so the live trace (tool calls, plans, permission prompts) is gone.
 * The result leads with a visible "history restored" notice and, when
 * the snapshot carries toolCalls, attaches bounded synthetic trace
 * summary items so the turn still shows WHAT ran — never fabricated
 * detail beyond what the snapshot recorded.
 */

import type { InlineTaskSnapshot, TaskSnapshotToolCall } from "@codex-sidepanel/shared";
import type { ConversationMessage, ConversationMessageTraceItem } from "../../types.js";

const SNAPSHOT_TRACE_ITEM_LIMIT = 12;
const SNAPSHOT_DETAIL_MAX_CHARS = 300;

function userText(input: { content?: { type: string; text?: string }[] }): string {
  return (input.content ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

function boundDetail(value: unknown, max = SNAPSHOT_DETAIL_MAX_CHARS): string {
  if (value === undefined || value === null) return "";
  let s: string;
  if (typeof value === "string") {
    s = value;
  } else {
    try {
      s = JSON.stringify(value);
    } catch {
      s = String(value);
    }
  }
  s = s.trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function humanizeSnapshotTool(tool: string): string {
  const cleaned = tool.replace(/^subagent:/, "").replace(/[_-]+/g, " ").trim();
  if (!cleaned) return "Tool";
  return cleaned.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (c) => c.toUpperCase());
}

function snapshotToolStatus(outcome: TaskSnapshotToolCall["outcome"]): ConversationMessageTraceItem["status"] {
  // mirrors legacy-events.ts tool.completed mapping: failed/cancelled
  // are terminal failures; "unknown" (crash recovery) stays completed —
  // the outcome text rides in the detail instead of a fake status.
  return outcome === "failed" || outcome === "cancelled" ? "failed" : "completed";
}

function snapshotToolTraceItem(
  call: TaskSnapshotToolCall,
  timestampMs: number,
): ConversationMessageTraceItem {
  const summary = typeof call.summary === "string" ? call.summary.trim() : "";
  const detail =
    summary ||
    boundDetail(call.inputSummary) ||
    (call.outcome !== "succeeded" ? `outcome: ${call.outcome}` : "");
  return {
    id: `snap-tool-${call.toolCallId || call.tool}`,
    kind: "tool",
    title: humanizeSnapshotTool(call.tool || "tool"),
    detail,
    status: snapshotToolStatus(call.outcome),
    timestampMs,
    ...(call.tool ? { tool: call.tool } : {}),
    ...(call.verified !== undefined ? { verified: call.verified } : {}),
  };
}

export function snapshotToMessages(snapshot: InlineTaskSnapshot): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const assistantsByTurn = new Map(snapshot.assistantMessages.map((m) => [m.turnId, m]));
  const turnsById = new Map(snapshot.turns.map((t) => [t.turnId, t]));

  for (const turn of snapshot.turns) {
    const user = snapshot.userMessages.find((m) => m.turnId === turn.turnId);
    if (user) {
      const text = userText(user.input);
      messages.push({
        id: `snap-u-${turn.turnId}`,
        role: "user",
        text: text || "(attachment-only message)",
      });
    }
    const assistant = assistantsByTurn.get(turn.turnId);
    if (assistant) {
      messages.push({
        id: `snap-a-${turn.turnId}`,
        role: "assistant",
        text: assistant.missing
          ? "_(original response unavailable — artifact expired)_"
          : assistant.text || "_(empty response)_",
      });
    }
  }
  // assistant finals whose turn row is gone (edge) still render
  const seen = new Set(messages.map((m) => m.id.replace(/^snap-[ua]-/, "")));
  for (const m of snapshot.assistantMessages) {
    if (!seen.has(m.turnId)) {
      messages.push({
        id: `snap-a-${m.turnId}`,
        role: "assistant",
        text: m.missing ? "_(original response unavailable — artifact expired)_" : m.text || "_(empty response)_",
      });
    }
  }

  // synthetic trace summaries from snapshot.toolCalls — attached to the
  // turn's assistant message, or a trace-only assistant message when the
  // turn produced no final text.
  const toolCallsByTurn = new Map<string, TaskSnapshotToolCall[]>();
  for (const call of snapshot.toolCalls ?? []) {
    if (!call?.turnId) continue;
    const list = toolCallsByTurn.get(call.turnId) ?? [];
    list.push(call);
    toolCallsByTurn.set(call.turnId, list);
  }
  for (const [turnId, calls] of toolCallsByTurn) {
    if (!calls.length) continue;
    const turn = turnsById.get(turnId);
    const timestampMs = turn?.startedAt ?? turn?.createdAt ?? 0;
    const items = calls
      .slice(-SNAPSHOT_TRACE_ITEM_LIMIT)
      .map((call) => snapshotToolTraceItem(call, timestampMs));
    const messageId = `snap-a-${turnId}`;
    let message = messages.find((m) => m.id === messageId);
    if (!message) {
      message = { id: messageId, role: "assistant", text: "", trace: [] };
      messages.push(message);
    }
    message.trace = [...(message.trace ?? []), ...items];
  }

  if (!messages.length) {
    return messages;
  }
  // honest rebuild marker — live tool/plan/permission detail was pruned
  // with the event log; only what the snapshot carried is shown above.
  return [
    {
      id: "snap-restore-notice",
      role: "assistant",
      text: "_(history restored — earlier tool details unavailable)_",
    },
    ...messages,
  ];
}
