/**
 * TaskSnapshot → sidepanel ConversationMessage[] — P1-10 rebuild path.
 *
 * Produces the minimal honest view: user prompts and assistant finals in
 * turn order. Tool calls/permissions are NOT synthesized into fake
 * messages — the durable event stream already carries them live, and
 * snapshot rebuilds happen when the panel re-syncs after pruning.
 * Artifact-missing assistant text becomes an explicit placeholder,
 * never silently empty.
 */

import type { InlineTaskSnapshot } from "@codex-sidepanel/shared";
import type { ConversationMessage } from "../../types.js";

function userText(input: { content?: { type: string; text?: string }[] }): string {
  return (input.content ?? [])
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("\n")
    .trim();
}

export function snapshotToMessages(snapshot: InlineTaskSnapshot): ConversationMessage[] {
  const messages: ConversationMessage[] = [];
  const assistantsByTurn = new Map(snapshot.assistantMessages.map((m) => [m.turnId, m]));

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
  return messages;
}
