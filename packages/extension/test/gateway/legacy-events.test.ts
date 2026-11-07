import { describe, expect, it } from "vitest";
import { gatewayEventToLegacy } from "../../src/background/gateway/legacy-events.js";
import type { Envelope } from "@codex-sidepanel/shared";

function durable(taskId: string, type: string, payload: Record<string, unknown>, seq = 1): Envelope {
  return {
    v: 1, kind: "event", reliability: "durable", stream: "task",
    taskId, seq, ts: 1, type, payload: { type, ...payload },
  } as unknown as Envelope;
}
function eph(taskId: string, turnId: string, type: string, text: string): Envelope {
  return {
    v: 1, kind: "event", reliability: "ephemeral", taskId, turnId,
    type, deltaOffset: 0, text, ts: 1,
  } as unknown as Envelope;
}

describe("gatewayEventToLegacy", () => {
  it("assistant.message → message.completed with threadId=taskId", () => {
    const out = gatewayEventToLegacy(durable("t1", "assistant.message", { turnId: "g1", text: "hi" }));
    expect(out).toMatchObject({ type: "message.completed", threadId: "t1", turnId: "g1", text: "hi" });
  });
  it("turn.completed → legacy turn.completed", () => {
    const out = gatewayEventToLegacy(durable("t1", "turn.completed", { turnId: "g1", stopReason: "end_turn" }));
    expect(out).toMatchObject({ type: "turn.completed", threadId: "t1", turnId: "g1", stopReason: "end_turn" });
  });
  it("ephemeral assistant.delta → message.delta", () => {
    const out = gatewayEventToLegacy(eph("t1", "g1", "assistant.delta", "chunk"));
    expect(out).toMatchObject({ type: "message.delta", threadId: "t1", turnId: "g1", itemId: "gw-g1", delta: "chunk" });
  });
  it("reasoning.delta accumulates into a throttled turn.activity trace item", () => {
    const out = gatewayEventToLegacy(eph("t1", "g1", "reasoning.delta", "think"));
    expect(out).toMatchObject({
      type: "turn.activity",
      threadId: "t1",
      turnId: "g1",
      itemId: "reasoning-g1",
      kind: "reasoning",
      status: "running",
    });
    expect((out as { thinkingText?: string }).thinkingText).toContain("think");
  });
  it("tool.started → turn.activity running with tool detail + inputText", () => {
    const out = gatewayEventToLegacy(durable("t1", "tool.started", {
      turnId: "g1", toolCallId: "tc-1", tool: "commandExecution",
      input: { command: "ls -la" }, source: "provider",
    }));
    expect(out).toMatchObject({
      type: "turn.activity", kind: "command", status: "running",
      itemId: "tc-1", detail: "ls -la", tool: "commandExecution",
    });
    expect((out as { inputText?: string }).inputText).toContain("ls -la");
  });
  it("tool.completed merges onto same itemId with outputText + duration fields", () => {
    const out = gatewayEventToLegacy(durable("t1", "tool.completed", {
      turnId: "g1", toolCallId: "tc-1", tool: "commandExecution",
      outcome: "succeeded", output: { aggregatedOutput: "total 0" },
    }));
    expect(out).toMatchObject({
      type: "turn.activity", kind: "command", status: "completed", itemId: "tc-1",
    });
    expect((out as { outputText?: string }).outputText).toContain("total 0");
  });
  it("failed tool.completed → status failed + errorText", () => {
    const out = gatewayEventToLegacy(durable("t1", "tool.completed", {
      turnId: "g1", toolCallId: "tc-2", tool: "Bash",
      outcome: "failed", output: "exit code 1",
    }));
    expect(out).toMatchObject({ type: "turn.activity", status: "failed", kind: "command" });
    expect((out as { errorText?: string }).errorText).toContain("exit code 1");
  });
  it("claude tool names classify: WebSearch→web, Edit→file, Task→subagent", () => {
    const web = gatewayEventToLegacy(durable("t1", "tool.started", {
      turnId: "g1", toolCallId: "a", tool: "WebSearch", input: { query: "chromex" },
    }));
    expect(web).toMatchObject({ kind: "web", detail: "chromex" });
    const edit = gatewayEventToLegacy(durable("t1", "tool.started", {
      turnId: "g1", toolCallId: "b", tool: "Edit", input: { file_path: "/tmp/x.ts" },
    }));
    expect(edit).toMatchObject({ kind: "file", detail: "/tmp/x.ts" });
    const task = gatewayEventToLegacy(durable("t1", "tool.started", {
      turnId: "g1", toolCallId: "c", tool: "Task", input: { prompt: "research" },
    }));
    expect(task).toMatchObject({ kind: "tool" });
  });
  it("turn.cancelled → turn.completed stopReason=cancelled", () => {
    const out = gatewayEventToLegacy(durable("t1", "turn.cancelled", { turnId: "g1" }));
    expect(out).toMatchObject({ type: "turn.completed", stopReason: "cancelled" });
  });
  it("provider.notice warn → failed turn.activity trace row", () => {
    const out = gatewayEventToLegacy(durable("t1", "provider.notice", {
      level: "warn", message: "turn exceeded budget 5000ms; stop confirmed",
    }, 7));
    expect(out).toMatchObject({
      type: "turn.activity",
      threadId: "t1",
      turnId: "provider-notice",
      itemId: "provider-notice-7",
      kind: "tool",
      title: "Provider warning",
      detail: "turn exceeded budget 5000ms; stop confirmed",
      status: "failed",
    });
  });
  it("provider.notice info → completed trace row; empty message dropped", () => {
    const out = gatewayEventToLegacy(durable("t1", "provider.notice", {
      level: "info", message: "provider reconnected",
    }));
    expect(out).toMatchObject({
      type: "turn.activity", status: "completed", title: "Provider notice",
      detail: "provider reconnected",
    });
    expect(gatewayEventToLegacy(durable("t1", "provider.notice", { level: "info", message: "  " }))).toBeNull();
  });
  it("provider.notice keeps a real turnId when the payload carries one", () => {
    const out = gatewayEventToLegacy(durable("t1", "provider.notice", {
      level: "warn", message: "rate limited", turnId: "g9",
    }));
    expect(out).toMatchObject({ type: "turn.activity", turnId: "g9", status: "failed" });
  });
  it("unmapped types return null (never faked)", () => {
    expect(gatewayEventToLegacy(durable("t1", "task.paused", { taskId: "t1" }))).toBeNull();
    expect(gatewayEventToLegacy({ v: 1, kind: "response" } as unknown as Envelope)).toBeNull();
  });
  it("permission.requested/resolved carry requestId", () => {
    const req = gatewayEventToLegacy(durable("t1", "permission.requested", {
      turnId: "g1", request: { requestId: "r1", kind: "browser_tool", summary: "click" },
    }));
    expect(req).toMatchObject({ type: "permission.requested", requestId: "r1", threadId: "t1" });
    const res = gatewayEventToLegacy(durable("t1", "permission.resolved", { requestId: "r1", decision: { kind: "allow" } }));
    expect(res).toMatchObject({ type: "plan.user_input.resolved", requestId: "r1" });
  });
  it("browser_action approval → approve/deny plan.user_input.requested", () => {
    const out = gatewayEventToLegacy(durable("t1", "permission.requested", {
      turnId: "g1",
      request: {
        requestId: "appr-1", kind: "browser_action", risk: "external_mutation",
        summary: "Browser tool browser.page.click requires approval",
        details: { tool: "browser.page.click" },
      },
    }));
    expect(out).toMatchObject({
      type: "plan.user_input.requested", requestId: "appr-1", threadId: "t1",
    });
    const qs = (out as { questions: { options: { label: string }[] }[] }).questions;
    expect(qs[0]!.options.map((o) => o.label)).toEqual(["allow_once", "deny"]);
  });
  it("browser_action approval passes through allow_task option id", () => {
    const out = gatewayEventToLegacy(durable("t1", "permission.requested", {
      turnId: "g1",
      request: {
        requestId: "appr-2", kind: "browser_action", risk: "external_mutation",
        summary: "s", options: [
          { id: "allow_once", label: "Allow once", kind: "allow_once" },
          { id: "allow_task", label: "Allow for this task", kind: "allow_task" },
          { id: "deny", label: "Deny", kind: "deny" },
        ],
        details: { tool: "browser.page.click" },
      },
    }));
    const qs = (out as { questions: { options: { label: string; id?: string }[] }[] }).questions;
    expect(qs[0]!.options.map((o) => o.id)).toEqual(["allow_once", "allow_task", "deny"]);
  });
  it("provider_permission with questions → plan.user_input.requested", () => {
    const questions = [{ id: "q1", header: "H", question: "Pick one", options: [{ label: "A" }] }];
    const out = gatewayEventToLegacy(durable("t1", "permission.requested", {
      turnId: "g1",
      request: { requestId: "r9", kind: "provider_permission", details: { argsPreview: { questions } } },
    }));
    expect(out).toMatchObject({
      type: "plan.user_input.requested", requestId: "r9", threadId: "t1", turnId: "g1",
    });
    expect((out as { questions?: unknown[] }).questions).toEqual(questions);
  });
});
