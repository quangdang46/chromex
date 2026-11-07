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
  it("orders user+assistant per turn behind a restore notice", () => {
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
    expect(out[0]).toMatchObject({ id: "snap-restore-notice", role: "assistant" });
    expect(out[0].text).toContain("history restored");
    expect(out.slice(1).map((m) => `${m.role}:${m.text}`)).toEqual([
      "user:hi", "assistant:hello", "user:again", "assistant:world",
    ]);
  });
  it("missing artifact → explicit placeholder, never empty", () => {
    const out = snapshotToMessages(snap({
      turns: [{ turnId: "g1", status: "completed", clientMessageId: "c1", createdAt: 1, startedAt: 1 }],
      assistantMessages: [{ turnId: "g1", createdAt: 1, text: "", missing: true }],
    }));
    expect(out[1].text).toContain("unavailable");
  });
  it("orphan assistant message (no turn row) still renders", () => {
    const out = snapshotToMessages(snap({
      assistantMessages: [{ turnId: "gx", createdAt: 1, text: "late" }],
    }));
    expect(out).toHaveLength(2);
    expect(out[1].text).toBe("late");
  });
  it("empty snapshot → no phantom notice", () => {
    expect(snapshotToMessages(snap({}))).toEqual([]);
  });
  it("toolCalls become bounded synthetic trace items on the turn's assistant message", () => {
    const out = snapshotToMessages(snap({
      turns: [{ turnId: "g1", status: "completed", clientMessageId: "c1", createdAt: 5, startedAt: 5 }],
      assistantMessages: [{ turnId: "g1", createdAt: 9, text: "done" }],
      toolCalls: [
        {
          turnId: "g1", toolCallId: "tc-1", tool: "Bash", source: "provider",
          outcome: "succeeded", summary: "ls -la", verified: true,
        },
        {
          turnId: "g1", toolCallId: "tc-2", tool: "browser.page.click", source: "browser",
          outcome: "failed", inputSummary: { selector: "#pay" },
        },
      ],
    }));
    const assistant = out.find((m) => m.id === "snap-a-g1");
    expect(assistant?.trace).toHaveLength(2);
    expect(assistant?.trace?.[0]).toMatchObject({
      id: "snap-tool-tc-1", kind: "tool", title: "Bash", detail: "ls -la",
      status: "completed", verified: true, timestampMs: 5,
    });
    expect(assistant?.trace?.[1]).toMatchObject({
      id: "snap-tool-tc-2", status: "failed", detail: '{"selector":"#pay"}',
    });
    expect(assistant?.trace?.[1]?.verified).toBeUndefined();
  });
  it("toolCalls for a turn with no assistant message get a trace-only message", () => {
    const out = snapshotToMessages(snap({
      turns: [{ turnId: "g2", status: "completed", clientMessageId: "c2", createdAt: 3, startedAt: 3 }],
      toolCalls: [
        { turnId: "g2", toolCallId: "tc-9", tool: "WebSearch", source: "provider", outcome: "succeeded" },
      ],
    }));
    const traceOnly = out.find((m) => m.id === "snap-a-g2");
    expect(traceOnly?.text).toBe("");
    expect(traceOnly?.trace?.[0]).toMatchObject({ title: "Web Search", status: "completed" });
  });
});
