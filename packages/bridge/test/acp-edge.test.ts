import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AgentEvent, TurnInput } from "@codex-sidepanel/shared";

import { AcpAgentProvider } from "../src/agents/providers/acp/provider.js";
import { AcpAgentSession } from "../src/agents/providers/acp/session.js";
import { AcpEventMapper, type MappedItem } from "../src/agents/providers/acp/mapper.js";

const FAKE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-acp-agent.mjs",
);

/**
 * Inline ACP agent for scenarios fake-acp-agent.mjs does not cover.
 * Driven by FAKE_ACP_SCENARIO:
 *   "modes"     — session/new returns model+mode configOptions; a
 *                 current_mode_update notification follows.
 *   "no-load"   — initialize reports loadSession:false.
 *   prompt text decides the rest: "cancel-stop" → stopReason cancelled,
 *   "perm-empty" → request_permission with options:[], "crash" → exit(1).
 */
const EDGE_AGENT = `
const SCEN = process.env.FAKE_ACP_SCENARIO ?? "ok";
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
let sid = null, pending = null;
const upd = (u) => notify("session/update", { sessionId: sid, update: u });
const finish = (stopReason) => {
  if (pending !== null) { reply(pending, { stopReason: stopReason || "end_turn" }); pending = null; }
};
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const id = msg.id, method = msg.method, params = msg.params;
  if (method === undefined && id !== undefined) { finish(); return; }
  if (!method) return;
  switch (method) {
    case "initialize":
      reply(id, {
        protocolVersion: 1,
        agentCapabilities: {
          loadSession: SCEN !== "no-load",
          promptCapabilities: { image: true },
        },
        authMethods: [],
        agentInfo: { name: "edge-acp", version: "0.0.1" },
      });
      return;
    case "session/new":
    case "session/load": {
      sid = method === "session/load" ? String(params && params.sessionId || "x") : "edge-session-1";
      reply(id, {
        sessionId: sid,
        configOptions: [
          { id: "model", name: "Model", category: "model", type: "select",
            currentValue: "m-a", options: [{ value: "m-a", name: "A" }] },
          { id: "mode", name: "Mode", category: "mode", type: "select",
            currentValue: "plan",
            options: [{ value: "plan", name: "Plan" }, { value: "build", name: "Build" }] },
        ],
      });
      if (SCEN === "modes") {
        notify("session/update", { sessionId: sid,
          update: { sessionUpdate: "current_mode_update", currentModeId: "plan" } });
      }
      return;
    }
    case "session/set_mode": reply(id, {}); return;
    case "session/set_config_option": reply(id, {}); return;
    case "session/prompt": {
      pending = id;
      const parts = (params && params.prompt) || [];
      const text = parts.map((p) => p.text || "").join(" ");
      if (text.indexOf("cancel-stop") >= 0) {
        upd({ sessionUpdate: "agent_message_chunk",
              content: { type: "text", text: "partial" } });
        reply(id, { stopReason: "cancelled" });
        pending = null;
        return;
      }
      if (text.indexOf("perm-empty") >= 0) {
        send({ jsonrpc: "2.0", id: 7001, method: "session/request_permission",
          params: { sessionId: sid,
            toolCall: { toolCallId: "tc-p", title: "Remove", kind: "delete" },
            options: [] } });
        return;
      }
      if (text.indexOf("crash") >= 0) { process.exit(1); }
      upd({ sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "done" } });
      finish();
      return;
    }
    case "session/cancel": finish("cancelled"); return;
    case "session/close": reply(id, {}); return;
    default:
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: "unknown " + method } });
  }
});
`;

function fakeProvider(scenario = "ok"): AcpAgentProvider {
  return new AcpAgentProvider({
    id: "fakeacp",
    displayName: "Fake ACP",
    command: process.execPath,
    args: [FAKE],
    env: { FAKE_ACP_SCENARIO: scenario },
  });
}

function edgeProvider(scenario: string): AcpAgentProvider {
  return new AcpAgentProvider({
    id: "edgeacp",
    displayName: "Edge ACP",
    command: process.execPath,
    args: ["-e", EDGE_AGENT],
    env: { FAKE_ACP_SCENARIO: scenario },
  });
}

function turnInput(text: string, gatewayTurnId = "gt-1"): TurnInput {
  return {
    gatewayTurnId,
    clientMessageId: `cm-${gatewayTurnId}`,
    content: [{ type: "text", text }],
  };
}

function collect(session: AcpAgentSession) {
  const events: AgentEvent[] = [];
  session.subscribe((e) => events.push(e));
  return { events };
}

async function waitFor(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function edgeSession(scenario: string): Promise<AcpAgentSession> {
  return (await edgeProvider(scenario).createSession(
    { provider: "edgeacp" },
    { cwd: "/tmp" },
  )) as AcpAgentSession;
}

// ---------------------------------------------------------------------------
// AcpEventMapper — pure unit coverage, no subprocess.
// ---------------------------------------------------------------------------

describe("AcpEventMapper", () => {
  function makeMapper() {
    const mapper = new AcpEventMapper();
    const items: MappedItem[] = [];
    mapper.onEvent((i) => items.push(i));
    return { mapper, items };
  }

  it("drops session/update traffic while no turn is bound", () => {
    const { mapper, items } = makeMapper();
    mapper.mapUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } });
    mapper.mapUpdate({ sessionUpdate: "tool_call", toolCallId: "tc-x", title: "T", kind: "read" });
    mapper.mapUpdate({ sessionUpdate: "usage_update", used: 1, size: 2 });
    expect(items).toEqual([]);
  });

  it("deltaOffset is cumulative per stream and marks deltas ephemeral", () => {
    const { mapper, items } = makeMapper();
    mapper.bindTurn("gt-1");
    mapper.mapUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ab" } });
    mapper.mapUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "cd" } });
    mapper.mapUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "zz" } });
    const deltas = items.filter((i) => i.event.type === "assistant.delta");
    const thoughts = items.filter((i) => i.event.type === "reasoning.delta");
    expect(deltas.map((d) => d.deltaOffset)).toEqual([0, 2]);
    expect(thoughts.map((d) => d.deltaOffset)).toEqual([0]);
    expect(deltas.every((d) => d.ephemeral)).toBe(true);
    expect(thoughts.every((d) => d.ephemeral)).toBe(true);
    mapper.unbindTurn();
  });

  it("string content is accepted for chunks; non-text content is ignored", () => {
    const { mapper, items } = makeMapper();
    mapper.bindTurn("gt-1");
    mapper.mapUpdate({ sessionUpdate: "agent_message_chunk", content: "plain" });
    mapper.mapUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "image" } });
    mapper.mapUpdate({ sessionUpdate: "agent_message_chunk" });
    expect(items).toHaveLength(1);
    expect((items[0].event as { text: string }).text).toBe("plain");
    mapper.unbindTurn();
  });

  it("tool_call emits tool.started; pending/in_progress updates emit nothing", () => {
    const { mapper, items } = makeMapper();
    mapper.bindTurn("gt-1");
    mapper.mapUpdate({
      sessionUpdate: "tool_call",
      toolCallId: "tc-1", title: "Read", kind: "read", status: "in_progress",
      rawInput: { path: "/x" },
    });
    mapper.mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "pending" });
    mapper.mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "in_progress" });
    const types = items.map((i) => i.event.type);
    expect(types).toEqual(["tool.started"]);
    const started = items[0].event as { toolCallId: string; tool: string; input: unknown; source: string };
    expect(started.toolCallId).toBe("tc-1");
    expect(started.tool).toBe("read");
    expect(started.input).toEqual({ path: "/x" });
    expect(started.source).toBe("provider");
    mapper.unbindTurn();
  });

  it("tool_call_update completed/failed → tool.completed with outcome and output", () => {
    const { mapper, items } = makeMapper();
    mapper.bindTurn("gt-1");
    mapper.mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc-1", status: "completed", rawOutput: { ok: 1 } });
    mapper.mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "tc-2", status: "failed", content: [{ type: "text", text: "boom" }] });
    mapper.mapUpdate({ sessionUpdate: "tool_call_update", toolCallId: "", status: "completed" });
    const done = items.filter((i) => i.event.type === "tool.completed");
    expect(done).toHaveLength(2);
    expect((done[0].event as { outcome: string }).outcome).toBe("succeeded");
    expect((done[0].event as { output: unknown }).output).toEqual({ ok: 1 });
    expect((done[1].event as { outcome: string }).outcome).toBe("failed");
    expect((done[1].event as { output: unknown }).output).toEqual([{ type: "text", text: "boom" }]);
    mapper.unbindTurn();
  });

  it("unknown sessionUpdate kinds and malformed params are ignored", () => {
    const { mapper, items } = makeMapper();
    mapper.bindTurn("gt-1");
    mapper.mapUpdate(null);
    mapper.mapUpdate({});
    mapper.mapUpdate({ sessionUpdate: "future_kind", data: 1 });
    mapper.mapUpdate({ sessionUpdate: "session_info_update", title: "x" });
    expect(items).toEqual([]);
    mapper.unbindTurn();
  });

  it("usage_update maps used→inputTokens and size→contextWindow extra", () => {
    const { mapper, items } = makeMapper();
    mapper.bindTurn("gt-1");
    mapper.mapUpdate({ sessionUpdate: "usage_update", used: 42, size: 1000 });
    const usage = items[0].event as { type: string; usage: { inputTokens?: number; extra?: Record<string, unknown> } };
    expect(usage.type).toBe("usage");
    expect(usage.usage.inputTokens).toBe(42);
    expect(usage.usage.extra).toEqual({ contextWindowUsed: 42, contextWindowSize: 1000 });
    mapper.unbindTurn();
  });

  it("available_commands_update filters empty names and maps argumentHint", () => {
    const { mapper } = makeMapper();
    mapper.mapUpdate({
      sessionUpdate: "available_commands_update",
      availableCommands: [
        { name: "review", description: "Review", argumentHint: "<file>" },
        { name: "", description: "dropped" },
        { description: "no name" },
        "junk",
      ],
    });
    expect(mapper.info.commands).toEqual([
      { name: "review", description: "Review", argumentHint: "<file>" },
    ]);
  });

  it("config_option_update and current_mode_update feed runtime info", () => {
    const { mapper } = makeMapper();
    mapper.seedSession("s-1", [{ id: "model", currentValue: "m-1" }]);
    mapper.mapUpdate({ sessionUpdate: "config_option_update", configOptions: [{ id: "model", currentValue: "m-2" }] });
    mapper.mapUpdate({ sessionUpdate: "current_mode_update", currentModeId: "plan" });
    expect(mapper.info.sessionId).toBe("s-1");
    expect(mapper.info.configOptions).toEqual([{ id: "model", currentValue: "m-2" }]);
    expect(mapper.info.currentModeId).toBe("plan");
  });

  it("finishTurn emits message, reasoning summary, then turn.completed with stopReason", () => {
    const { mapper, items } = makeMapper();
    mapper.bindTurn("gt-1");
    mapper.mapUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hello world" } });
    mapper.mapUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
    mapper.finishTurn("end_turn");
    const types = items.map((i) => i.event.type);
    // deltas first, then terminal trio
    expect(types.slice(-3)).toEqual(["assistant.message", "reasoning.summary", "turn.completed"]);
    const msg = items.find((i) => i.event.type === "assistant.message")!.event as { text: string };
    expect(msg.text).toBe("Hello world");
    const completed = items.find((i) => i.event.type === "turn.completed")!.event as { stopReason?: string };
    expect(completed.stopReason).toBe("end_turn");
    // unbound after finish
    mapper.mapUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "late" } });
    expect(items.filter((i) => i.event.type === "assistant.delta")).toHaveLength(1);
  });

  it("finishTurn is idempotent — a second call emits nothing", () => {
    const { mapper, items } = makeMapper();
    mapper.bindTurn("gt-1");
    mapper.finishTurn("end_turn");
    mapper.finishTurn("end_turn");
    mapper.finishTurn(undefined, true, "late error");
    expect(items.filter((i) => ["turn.completed", "turn.failed", "turn.cancelled"].includes(i.event.type))).toHaveLength(1);
  });

  it("finishTurn with no active turn is a no-op", () => {
    const { mapper, items } = makeMapper();
    mapper.finishTurn("end_turn");
    mapper.finishTurn(undefined, true, "boom");
    expect(items).toEqual([]);
  });

  it("failure maps to typed ProtocolError shape on turn.failed", () => {
    const { mapper, items } = makeMapper();
    mapper.bindTurn("gt-9");
    mapper.finishTurn(undefined, true, "ACP -32603: upstream exploded");
    const failed = items[0].event as {
      type: string; turnId: string;
      error: { code: string; message: string; retryable: boolean; requiresUserAction: boolean; sideEffectState: string };
    };
    expect(failed.type).toBe("turn.failed");
    expect(failed.turnId).toBe("gt-9");
    expect(failed.error.code).toBe("provider.turn_failed");
    expect(failed.error.message).toContain("upstream exploded");
    expect(failed.error.retryable).toBe(true);
    expect(failed.error.requiresUserAction).toBe(false);
    expect(failed.error.sideEffectState).toBe("unknown");
  });

  it("interruptRequested or stopReason cancelled → turn.cancelled, not completed", () => {
    const { mapper, items } = makeMapper();
    mapper.bindTurn("gt-1");
    mapper.mapUpdate({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "partial" } });
    mapper.markInterruptRequested();
    mapper.finishTurn("end_turn");
    const terminal = items.find((i) => i.event.type === "turn.cancelled")!.event as { reason?: string };
    expect(terminal.reason).toBe("interrupted");
    expect(items.some((i) => i.event.type === "turn.completed")).toBe(false);
    // assistant.message is suppressed on cancel — only the delta streamed
    expect(items.some((i) => i.event.type === "assistant.message")).toBe(false);
  });

  it("stopReason 'cancelled' alone (no interrupt()) also yields turn.cancelled", () => {
    const { mapper, items } = makeMapper();
    mapper.bindTurn("gt-1");
    mapper.finishTurn("cancelled");
    expect(items[0].event.type).toBe("turn.cancelled");
  });

  it("reasoning.summary truncates at 4000 chars", () => {
    const { mapper, items } = makeMapper();
    mapper.bindTurn("gt-1");
    mapper.mapUpdate({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "r".repeat(5000) } });
    mapper.finishTurn("end_turn");
    const summary = items.find((i) => i.event.type === "reasoning.summary")!.event as { summary: string };
    expect(summary.summary).toHaveLength(4000);
  });
});

// ---------------------------------------------------------------------------
// Session-level edges — ownership, cancellation, error mapping, persistence.
// ---------------------------------------------------------------------------

describe("AcpAgentSession edges", () => {
  it("interrupt() with no active turn is a no-op; canStopRuntime is true", async () => {
    const p = fakeProvider();
    const session = (await p.createSession({ provider: "fakeacp" }, {})) as AcpAgentSession;
    const { events } = collect(session);
    await session.interrupt(); // must resolve, not hang or throw
    expect(session.canStopRuntime()).toBe(true);
    expect(events).toEqual([]);
    await session.close();
  }, 20_000);

  it("canStopRuntime is false while a prompt is in flight, true after", async () => {
    const p = fakeProvider("slow");
    const session = (await p.createSession({ provider: "fakeacp" }, {})) as AcpAgentSession;
    const { events } = collect(session);
    await session.startTurn(turnInput("slow"));
    await waitFor(() => events.some((e) => e.type === "assistant.delta"));
    expect(session.canStopRuntime()).toBe(false);
    await waitFor(() => events.some((e) => e.type === "turn.completed" || e.type === "turn.cancelled" || e.type === "turn.failed"));
    expect(session.canStopRuntime()).toBe(true);
    await session.close();
  }, 20_000);

  it("steer is honestly unavailable for ACP", async () => {
    const p = fakeProvider();
    const session = (await p.createSession({ provider: "fakeacp" }, {})) as AcpAgentSession;
    const res = await session.steer(turnInput("mid-turn"));
    expect(res).toEqual({ status: "unavailable" });
    await session.close();
  }, 20_000);

  it("respondToPermission on an unknown requestId is a no-op", async () => {
    const p = fakeProvider("permission");
    const session = (await p.createSession({ provider: "fakeacp" }, {})) as AcpAgentSession;
    const { events } = collect(session);
    const res = await session.respondToPermission("no-such-id", {
      requestId: "no-such-id",
      optionId: "allow_once",
    });
    expect(res).toEqual({});
    expect(session.getPendingPermissions()).toEqual([]);
    expect(events.filter((e) => e.type === "permission.resolved")).toEqual([]);
    await session.close();
  }, 20_000);

  it("permission.requested carries the active turnId; resolved removes the pending entry", async () => {
    const p = fakeProvider("permission");
    const session = (await p.createSession({ provider: "fakeacp" }, {})) as AcpAgentSession;
    const { events } = collect(session);
    await session.startTurn(turnInput("do it", "gt-perm"));
    await waitFor(() => events.some((e) => e.type === "permission.requested"));

    const req = events.find((e) => e.type === "permission.requested") as {
      turnId?: string;
      request: { requestId: string };
    };
    expect(req.turnId).toBe("gt-perm");
    expect(session.getPendingPermissions().map((r) => r.requestId)).toContain(req.request.requestId);

    await session.respondToPermission(req.request.requestId, {
      requestId: req.request.requestId,
      optionId: "allow_once",
    });
    await waitFor(() => events.some((e) => e.type === "turn.completed"));
    expect(session.getPendingPermissions()).toEqual([]);
    await session.close();
  }, 20_000);

  it("close() emits conversation.closed and is idempotent", async () => {
    const p = fakeProvider();
    const session = (await p.createSession({ provider: "fakeacp" }, {})) as AcpAgentSession;
    const { events } = collect(session);
    await session.close();
    await session.close();
    const closed = events.filter((e) => e.type === "conversation.closed");
    expect(closed).toHaveLength(1);
    expect((closed[0] as { reason?: string }).reason).toBe("closed");
  }, 20_000);

  it("stopReason 'cancelled' without interrupt() still yields turn.cancelled", async () => {
    const session = await edgeSession("ok");
    const { events } = collect(session);
    await session.startTurn(turnInput("cancel-stop please"));
    await waitFor(() => events.some((e) => e.type === "turn.cancelled" || e.type === "turn.completed"));
    expect(events.some((e) => e.type === "turn.cancelled")).toBe(true);
    expect(events.some((e) => e.type === "turn.completed")).toBe(false);
    expect(session.canStopRuntime()).toBe(true);
    await session.close();
  }, 20_000);

  it("permission request with empty options gets allow_once/deny defaults", async () => {
    const session = await edgeSession("ok");
    const { events } = collect(session);
    await session.startTurn(turnInput("perm-empty go"));
    await waitFor(() => events.some((e) => e.type === "permission.requested"));

    const req = events.find((e) => e.type === "permission.requested") as {
      request: { requestId: string; options: Array<{ id: string; kind: string }> };
    };
    expect(req.request.options.map((o) => o.id).sort()).toEqual(["allow_once", "deny"]);

    await session.respondToPermission(req.request.requestId, {
      requestId: req.request.requestId,
      optionId: "allow_once",
    });
    await waitFor(() => events.some((e) => e.type === "turn.completed"));
    const resolved = events.find((e) => e.type === "permission.resolved") as {
      decision: { optionId: string; kind: string };
    };
    expect(resolved.decision.optionId).toBe("allow_once");
    expect(resolved.decision.kind).toBe("allow_once");
    await session.close();
  }, 20_000);

  it("agent process exit mid-turn → turn.failed with typed ProtocolError", async () => {
    const session = await edgeSession("ok");
    const { events } = collect(session);
    await session.startTurn(turnInput("crash now"));
    await waitFor(() => events.some((e) => e.type === "turn.failed"));
    const failed = events.find((e) => e.type === "turn.failed") as {
      error: { code: string; message: string; retryable: boolean };
    };
    expect(failed.error.code).toBe("provider.turn_failed");
    expect(failed.error.message).toContain("ACP process exited");
    expect(failed.error.retryable).toBe(true);
    await session.close();
  }, 20_000);

  it("mode configOptions surface via getAvailableModes/getCurrentMode/setMode", async () => {
    const session = await edgeSession("modes");
    await session.startTurn(turnInput("hi"));
    // poll until the mode surfaces (session/new + notification may race the turn)
    const deadline = Date.now() + 5_000;
    let modes: Awaited<ReturnType<AcpAgentSession["getAvailableModes"]>> = [];
    let current: string | null = null;
    while (Date.now() < deadline) {
      modes = await session.getAvailableModes();
      current = await session.getCurrentMode();
      if (modes.length === 2 && current === "plan") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(modes).toEqual([
      { id: "plan", label: "Plan" },
      { id: "build", label: "Build" },
    ]);
    expect(current).toBe("plan");
    await session.setMode("build"); // must not throw
    await session.close();
  }, 20_000);

  it("loadSession:false downgrades resume capability and ignores the persisted ref", async () => {
    const p = edgeProvider("no-load");
    const session = (await p.resumeSession(
      { provider: "edgeacp", ref: "old-session-9", kind: "session" },
      { provider: "edgeacp" },
      {},
    )) as AcpAgentSession;
    const { events } = collect(session);
    await session.startTurn(turnInput("hi"));
    await waitFor(() => events.some((e) => e.type === "turn.completed"));
    expect(session.capabilities.resume).toBe(false);
    // session/new was used — ref is the fresh id, not "old-session-9"
    const pers = session.describePersistence();
    expect(pers?.ref).toBe("edge-session-1");
    await session.close();
  }, 20_000);
});
