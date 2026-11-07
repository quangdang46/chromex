#!/usr/bin/env node
/**
 * Fake ACP agent for tests — ndjson JSON-RPC over stdio.
 * FAKE_ACP_SCENARIO: "ok" (default) | "permission" | "fail" | "slow"
 */
import { createInterface } from "node:readline";

const scenario = process.env.FAKE_ACP_SCENARIO ?? "ok";
const rl = createInterface({ input: process.stdin });

let sessionId = null;
let pendingPromptId = null;
let pendingPermId = null;
let permCounter = 0;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const update = (u) => notify("session/update", { sessionId, update: u });
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message, code = -32603) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

function finishPrompt(stopReason = "end_turn") {
  if (pendingPromptId !== null) {
    reply(pendingPromptId, { stopReason });
    pendingPromptId = null;
  }
}

function streamChunks() {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } });
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: " world" } });
  update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking…" } });
  update({
    sessionUpdate: "tool_call",
    toolCallId: "tc-1", title: "Read file", kind: "read", status: "in_progress",
    rawInput: { path: "/tmp/x" },
  });
}

function streamTail() {
  update({
    sessionUpdate: "tool_call_update",
    toolCallId: "tc-1", status: "completed", rawOutput: { ok: true },
  });
  update({ sessionUpdate: "usage_update", used: 123, size: 200000 });
  update({
    sessionUpdate: "available_commands_update",
    availableCommands: [{ name: "review", description: "Review code" }],
  });
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;

  // response to an agent→client request (has id, no method)
  if (method === undefined && id !== undefined) {
    if (pendingPermId !== null && id === pendingPermId) {
      const selected = msg.result?.outcome?.optionId;
      const allowed = typeof selected === "string" && !selected.startsWith("reject") && selected !== "deny";
      update({
        sessionUpdate: "tool_call_update",
        toolCallId: "tc-2",
        status: allowed ? "completed" : "failed",
        rawOutput: { decision: selected ?? null },
      });
      streamTail();
      finishPrompt();
      pendingPermId = null;
    }
    return;
  }
  if (method === undefined) return;

  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: true,
          promptCapabilities: { image: false },
          sessionCapabilities: { close: {}, resume: {} },
        },
        authMethods: [],
        agentInfo: { name: "fake-acp", version: "0.0.1" },
      });
      return;
    case "session/new":
    case "session/load": {
      sessionId = method === "session/load"
        ? String(params?.sessionId ?? "resumed")
        : "fake-session-1";
      reply(id, {
        sessionId,
        configOptions: [
          {
            id: "model", name: "Model", category: "model", type: "select",
            currentValue: "fake-model-a",
            options: [
              { value: "fake-model-a", name: "Model A" },
              { value: "fake-model-b", name: "Model B" },
            ],
          },
        ],
        modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }] },
      });
      return;
    }
    case "session/set_config_option":
      reply(id, { configOptions: [{ id: params?.configId, currentValue: params?.value }] });
      return;
    case "session/set_mode":
      reply(id, {});
      return;
    case "session/prompt": {
      pendingPromptId = id;
      if (scenario === "fail") { fail(id, "upstream exploded"); pendingPromptId = null; return; }
      streamChunks();
      if (scenario === "permission") {
        pendingPermId = 9000 + ++permCounter;
        send({
          jsonrpc: "2.0", id: pendingPermId, method: "session/request_permission",
          params: {
            sessionId,
            toolCall: { toolCallId: "tc-2", title: "Delete file", kind: "delete", rawInput: { path: "/tmp/y" } },
            options: [
              { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
              { optionId: "allow_always", name: "Always allow", kind: "allow_always" },
              { optionId: "reject_once", name: "Reject", kind: "reject_once" },
            ],
          },
        });
        return; // finishes when the permission response arrives
      }
      streamTail();
      if (scenario === "slow") {
        setTimeout(() => finishPrompt(), 400);
      } else {
        finishPrompt();
      }
      return;
    }
    case "session/cancel":
      finishPrompt("cancelled");
      return;
    case "session/close":
      reply(id, {});
      return;
    default:
      fail(id, `unknown method ${method}`, -32601);
  }
});
