#!/usr/bin/env node
/**
 * Fake ACP agent for kill -9 gateway recovery tests — ndjson JSON-RPC
 * over stdio. Companion to fake-acp-agent.mjs with crash-test semantics:
 *
 * FAKE_ACP_MODE:
 *   "hang-match"   — prompts whose text contains FAKE_ACP_HANG_MATCH
 *                    (default "hang") never get a session/prompt reply;
 *                    all other prompts complete normally with end_turn.
 *   "permission"   — every prompt emits session/request_permission and
 *                    pends until the client responds (then completes).
 *
 * FAKE_ACP_LOG: when set, every session/prompt appends one JSON line
 *   {"type":"session/prompt","text":"..."} — the test uses it to prove
 *   no prompt was replayed after a gateway restart.
 *
 * Exits when stdin closes so orphaned agents don't linger after the
 * gateway is SIGKILLed.
 */
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const mode = process.env.FAKE_ACP_MODE ?? "hang-match";
const hangMatch = process.env.FAKE_ACP_HANG_MATCH ?? "hang";
const logFile = process.env.FAKE_ACP_LOG ?? null;
const rl = createInterface({ input: process.stdin });
rl.on("close", () => process.exit(0));

let sessionId = null;
let pendingPromptId = null;
let pendingPermId = null;

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const update = (u) => notify("session/update", { sessionId, update: u });
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, message, code = -32603) =>
  send({ jsonrpc: "2.0", id, error: { code, message } });

function promptText(params) {
  const blocks = Array.isArray(params?.prompt) ? params.prompt : [];
  return blocks
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function streamChunks() {
  update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello" } });
  update({
    sessionUpdate: "tool_call",
    toolCallId: "tc-1", title: "Read file", kind: "read", status: "in_progress",
    rawInput: { path: "/tmp/x" },
  });
}

function finishPrompt(stopReason = "end_turn") {
  if (pendingPromptId !== null) {
    reply(pendingPromptId, { stopReason });
    pendingPromptId = null;
  }
}

function requestPermission() {
  pendingPermId = 9000 + Math.floor(Math.random() * 1000);
  send({
    jsonrpc: "2.0", id: pendingPermId, method: "session/request_permission",
    params: {
      sessionId,
      toolCall: { toolCallId: "tc-2", title: "Delete file", kind: "delete", rawInput: { path: "/tmp/y" } },
      options: [
        { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
        { optionId: "reject_once", name: "Reject", kind: "reject_once" },
      ],
    },
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
        agentInfo: { name: "fake-acp-crash", version: "0.0.1" },
      });
      return;
    case "session/new":
    case "session/load": {
      sessionId = method === "session/load"
        ? String(params?.sessionId ?? "resumed")
        : "fake-crash-session-1";
      reply(id, {
        sessionId,
        configOptions: [],
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
      const text = promptText(params);
      if (logFile) {
        try { appendFileSync(logFile, JSON.stringify({ type: "session/prompt", text }) + "\n"); } catch { /* best-effort */ }
      }
      streamChunks();
      if (mode === "permission") {
        requestPermission();
        return; // finishes when the permission response arrives
      }
      if (mode === "hang-match" && text.includes(hangMatch)) {
        return; // never reply — the turn stays running until the gateway dies
      }
      finishPrompt();
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
