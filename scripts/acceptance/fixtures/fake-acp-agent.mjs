// Fake ACP agent for acceptance scenarios — NDJSON JSON-RPC over stdio.
// session/prompt streams agent_message_chunk updates every 500ms and
// holds the response open until session/cancel arrives (→ stopReason
// "cancelled") or FAKE_ACP_TURN_MS elapses (→ "end_turn"). Deterministic
// long-running turns with no real provider cost.
import readline from "node:readline";

if (process.argv.includes("--version")) {
  console.log("fake-acp-agent 0.0.1");
  process.exit(0);
}

const TURN_MS = Number(process.env.FAKE_ACP_TURN_MS ?? 60_000);
const SESSION_ID = "fake-acp-session-1";

let promptCount = 0;
const pendingPrompts = new Map(); // prompt request id → {sessionId, timer, interval}

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function respondError(id, message) {
  send({ jsonrpc: "2.0", id, error: { code: -32603, message } });
}
function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

function sessionUpdate(sessionId, text) {
  notify("session/update", {
    sessionId,
    update: {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text },
    },
  });
}

function settlePrompt(id, stopReason) {
  const p = pendingPrompts.get(id);
  if (!p) return;
  pendingPrompts.delete(id);
  clearInterval(p.interval);
  clearTimeout(p.timer);
  respond(id, { stopReason });
}

const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null && typeof method === "string";
  const isNotification = id === undefined && typeof method === "string";

  if (isNotification && method === "session/cancel") {
    const sessionId = params?.sessionId;
    for (const [pid, p] of pendingPrompts) {
      if (!sessionId || p.sessionId === sessionId) settlePrompt(pid, "cancelled");
    }
    return;
  }
  if (isNotification) return;
  if (!isRequest) return;

  switch (method) {
    case "initialize":
      respond(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: false,
          promptCapabilities: { image: false },
        },
        agentInfo: { name: "fake-acp-agent", version: "0.0.1" },
      });
      return;
    case "session/new":
      respond(id, { sessionId: SESSION_ID });
      return;
    case "session/load":
      respond(id, { sessionId: String(params?.sessionId ?? SESSION_ID) });
      return;
    case "session/prompt": {
      promptCount += 1;
      const sessionId = String(params?.sessionId ?? SESSION_ID);
      const tick = setInterval(() => sessionUpdate(sessionId, "working… "), 500);
      tick.unref?.();
      // first prompt is the interrupt target — hold until cancel or the
      // long timeout; later prompts (queued-turn drain) finish quickly.
      const ms = promptCount === 1 ? TURN_MS : 1_500;
      const timer = setTimeout(() => settlePrompt(id, "end_turn"), ms);
      timer.unref?.();
      pendingPrompts.set(id, { sessionId, interval: tick, timer });
      sessionUpdate(sessionId, "starting");
      return;
    }
    case "session/set_mode":
    case "session/set_config_option":
      respond(id, {});
      return;
    default:
      respondError(id, `fake-acp-agent: unsupported ${method}`);
  }
});
