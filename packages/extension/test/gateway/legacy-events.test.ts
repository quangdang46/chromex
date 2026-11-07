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
  it("tool.completed passes verified through to the trace item", () => {
    const verified = gatewayEventToLegacy(durable("t1", "tool.completed", {
      turnId: "g1", toolCallId: "tc-v", tool: "browser.page.click",
      outcome: "succeeded", verified: true,
    }));
    expect(verified).toMatchObject({ type: "turn.activity", verified: true });
    const unknown = gatewayEventToLegacy(durable("t1", "tool.completed", {
      turnId: "g1", toolCallId: "tc-u", tool: "browser.page.click",
      outcome: "succeeded", verified: "unknown",
    }));
    expect(unknown).toMatchObject({ type: "turn.activity", verified: "unknown" });
    const absent = gatewayEventToLegacy(durable("t1", "tool.completed", {
      turnId: "g1", toolCallId: "tc-n", tool: "Bash", outcome: "succeeded",
    }));
    expect(absent).not.toHaveProperty("verified");
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
  it("turn.diff.updated → legacy turn.diff.updated CodexTurnDiff shape (S8)", () => {
    const diffText = "diff --git a/x.ts b/x.ts\n+hello";
    const out = gatewayEventToLegacy(durable("t1", "turn.diff.updated", {
      turnId: "g1", diff: diffText,
    }));
    expect(out).toMatchObject({
      type: "turn.diff.updated",
      threadId: "t1",
      turnId: "g1",
      diff: { threadId: "t1", turnId: "g1", diff: diffText },
    });
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
  it("gateway-stream account.login.completed → legacy account.login.completed (chromex-fjr)", () => {
    const env = {
      v: 1, kind: "event", reliability: "durable", stream: "gateway",
      seq: 9, ts: 1, type: "account.login.completed",
      payload: {
        type: "account.login.completed", providerId: "codex",
        loginId: "l1", success: true, error: null,
      },
    } as unknown as Envelope;
    expect(gatewayEventToLegacy(env)).toEqual({
      type: "account.login.completed", loginId: "l1", success: true, error: null,
    });
    const failed = {
      ...env,
      payload: { type: "account.login.completed", providerId: "codex", loginId: "l2", success: false, error: "denied" },
    } as unknown as Envelope;
    expect(gatewayEventToLegacy(failed)).toMatchObject({ success: false, error: "denied" });
  });
  it("other gateway-stream events still return null", () => {
    const env = {
      v: 1, kind: "event", reliability: "durable", stream: "gateway",
      seq: 1, ts: 1, type: "gateway.provider.changed",
      payload: { type: "gateway.provider.changed", providerId: "codex", available: true },
    } as unknown as Envelope;
    expect(gatewayEventToLegacy(env)).toBeNull();
  });
  it("unmapped types return null (never faked)", () => {
    expect(gatewayEventToLegacy(durable("t1", "task.paused", { taskId: "t1" }))).toBeNull();
    expect(gatewayEventToLegacy({ v: 1, kind: "response" } as unknown as Envelope)).toBeNull();
  });
  it("permission.requested/resolved carry requestId", () => {
    const req = gatewayEventToLegacy(durable("t1", "permission.requested", {
      turnId: "g1", request: { requestId: "r1", kind: "browser_tool", summary: "click" },
    }));
    expect(req).toMatchObject({ type: "permission.approval.requested", requestId: "r1", threadId: "t1" });
    const res = gatewayEventToLegacy(durable("t1", "permission.resolved", { requestId: "r1", decision: { kind: "allow" } }));
    expect(res).toMatchObject({ type: "permission.resolved", requestId: "r1", threadId: "t1" });
  });
  it("permission.expired → legacy permission.expired so pending cards clear", () => {
    const out = gatewayEventToLegacy(durable("t1", "permission.expired", {
      requestId: "appr-9", reason: "timeout",
    }));
    expect(out).toMatchObject({
      type: "permission.expired", threadId: "t1", requestId: "appr-9", reason: "timeout",
    });
  });
  it("browser_action approval → permission.approval.requested with full context", () => {
    const out = gatewayEventToLegacy(durable("t1", "permission.requested", {
      turnId: "g1",
      request: {
        requestId: "appr-1", kind: "browser_action", risk: "external_mutation",
        summary: "Browser tool browser.page.click requires approval",
        options: [
          { id: "allow_once", label: "Allow once", kind: "allow_once" },
          { id: "allow_task", label: "Allow for this task", kind: "allow_task" },
          { id: "deny", label: "Deny", kind: "deny" },
        ],
        details: {
          tool: "browser.page.click",
          origin: "https://example.com",
          targetLabel: "Submit button",
          argsPreview: { selector: "#submit" },
        },
      },
    }));
    expect(out).toMatchObject({
      type: "permission.approval.requested", requestId: "appr-1", threadId: "t1", turnId: "g1",
      permissionKind: "browser_action", risk: "external_mutation",
      tool: "browser.page.click", origin: "https://example.com", targetLabel: "Submit button",
    });
    const o = out as { options: { id: string; kind: string }[]; argsPreviewText?: string };
    expect(o.options.map((x) => x.id)).toEqual(["allow_once", "allow_task", "deny"]);
    expect(o.argsPreviewText).toContain("#submit");
  });
  it("data_entry_sensitive and agent_egress approvals reach the card, never the void", () => {
    for (const kind of ["data_entry_sensitive", "agent_egress"]) {
      const out = gatewayEventToLegacy(durable("t1", "permission.requested", {
        turnId: "g1",
        request: {
          requestId: `appr-${kind}`, kind, risk: "data_entry_sensitive",
          summary: `${kind} requires approval`,
          options: [{ id: "allow_once", label: "Allow once", kind: "allow_once" }],
          details: { tool: "browser.page.fill", origin: "https://example.com" },
        },
      }));
      expect(out).toMatchObject({
        type: "permission.approval.requested", requestId: `appr-${kind}`, permissionKind: kind,
      });
    }
  });
  it("provider_permission without questions → approval card (not silent hang)", () => {
    const out = gatewayEventToLegacy(durable("t1", "permission.requested", {
      turnId: "g1",
      request: {
        requestId: "appr-pp", kind: "provider_permission", risk: "low",
        summary: "Agent requests permission: Bash",
        options: [{ id: "allow_once", label: "Allow once", kind: "allow_once" }],
        details: { tool: "Bash", argsPreview: { command: "ls" }, origin: "provider" },
      },
    }));
    expect(out).toMatchObject({
      type: "permission.approval.requested", requestId: "appr-pp", permissionKind: "provider_permission",
    });
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
