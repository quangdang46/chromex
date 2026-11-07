import { describe, expect, it } from "vitest";
import { snapshotToMessages } from "../../src/background/gateway/snapshot-messages.js";
import type { InlineTaskSnapshot } from "@codex-sidepanel/shared";

function snap(over: Partial<InlineTaskSnapshot>): InlineTaskSnapshot {
  return {
    storage: { kind: "inline" },
    task: { taskId: "t1" } as InlineTaskSnapshot["task"],
    conversation: { sessionKey: "s", provider: "codex", persistence: null, state: "open" },
    turns: [],
    userMessages: [],
    assistantMessages: [],
    toolCalls: [],
    permissions: [],
    lastSeq: 0,
    rebuiltFrom: "event_log",
    ...over,
  } as InlineTaskSnapshot;
}

describe("snapshotToMessages", () => {
  it("orders user+assistant per turn", () => {
    const out = snapshotToMessages(snap({
      turns: [
        { turnId: "g1", status: "completed", clientMessageId: "c1", createdAt: 1, startedAt: 1 },
        { turnId: "g2", status: "completed", clientMessageId: "c2", createdAt: 2, startedAt: 2 },
      ],
      userMessages: [
        { turnId: "g1", clientMessageId: "c1", createdAt: 1, input: { gatewayTurnId: "g1", clientMessageId: "c1", content: [{ type: "text", text: "hi" }] }, inputCompleteness: "full" },
        { turnId: "g2", clientMessageId: "c2", createdAt: 2, input: { gatewayTurnId: "g2", clientMessageId: "c2", content: [{ type: "text", text: "again" }] }, inputCompleteness: "full" },
      ],
      assistantMessages: [
        { turnId: "g1", createdAt: 1, text: "hello" },
        { turnId: "g2", createdAt: 2, text: "world" },
      ],
    }));
    expect(out.map((m) => `${m.role}:${m.text}`)).toEqual([
      "user:hi", "assistant:hello", "user:again", "assistant:world",
    ]);
  });
  it("missing artifact → explicit placeholder, never empty", () => {
    const out = snapshotToMessages(snap({
      turns: [{ turnId: "g1", status: "completed", clientMessageId: "c1", createdAt: 1, startedAt: 1 }],
      assistantMessages: [{ turnId: "g1", createdAt: 1, text: "", missing: true }],
    }));
    expect(out[0].text).toContain("unavailable");
  });
  it("orphan assistant message (no turn row) still renders", () => {
    const out = snapshotToMessages(snap({
      assistantMessages: [{ turnId: "gx", createdAt: 1, text: "late" }],
    }));
    expect(out).toHaveLength(1);
    expect(out[0].text).toBe("late");
  });
});
