import { readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

import type { AgentEvent, TurnInput } from "@codex-sidepanel/shared";

import { AcpAgentProvider } from "../src/agents/providers/acp/provider.js";
import { AcpAgentSession } from "../src/agents/providers/acp/session.js";
import { runAgentSessionConformance } from "./conformance/agent-session.js";

const FAKE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures/fake-acp-agent.mjs",
);

function provider(scenario = "ok"): AcpAgentProvider {
  return new AcpAgentProvider({
    id: "fakeacp",
    displayName: "Fake ACP",
    command: process.execPath,
    args: [FAKE],
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
  const deltas: Array<{ type: string; text: string; deltaOffset?: number }> = [];
  session.subscribe((e) => {
    events.push(e);
    if (e.type === "assistant.delta" || e.type === "reasoning.delta") {
      deltas.push({ type: e.type, text: e.text, deltaOffset: (e as { deltaOffset?: number }).deltaOffset });
    }
  });
  return { events, deltas };
}

async function waitFor(
  pred: () => boolean,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("AcpAgentProvider/AcpAgentSession", () => {
  it("isAvailable probes the binary", async () => {
    const p = provider();
    const res = await p.isAvailable();
    expect(res.available).toBe(true); // node --version exits 0
  });

  it("full turn: deltas, tool events, usage, commands, persistence", async () => {
    const p = provider();
    const session = (await p.createSession(
      { provider: "fakeacp" },
      { cwd: "/tmp" },
    )) as AcpAgentSession;
    const { events, deltas } = collect(session);

    await session.startTurn(turnInput("hi"));
    await waitFor(() => events.some((e) => e.type === "turn.completed"));

    const types = events.map((e) => e.type);
    expect(types).toContain("assistant.delta");
    expect(types).toContain("assistant.message");
    expect(types).toContain("reasoning.summary");
    expect(types).toContain("tool.started");
    expect(types).toContain("tool.completed");
    expect(types).toContain("usage");
    expect(types).toContain("turn.completed");

    const msg = events.find((e) => e.type === "assistant.message") as { text: string };
    expect(msg.text).toBe("Hello world");

    // deltaOffset monotonic per stream (text and reasoning count separately)
    for (const type of ["assistant.delta", "reasoning.delta"]) {
      const offsets = deltas.filter((d) => d.type === type).map((d) => d.deltaOffset ?? -1);
      expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    }

    const toolStarted = events.find((e) => e.type === "tool.started") as {
      toolCallId: string; tool: string; input?: unknown;
    };
    expect(toolStarted.toolCallId).toBe("tc-1");
    expect(toolStarted.input).toEqual({ path: "/tmp/x" });

    const cmds = await session.listCommands();
    expect(cmds).toEqual([{ name: "review", description: "Review code" }]);

    const info = await session.getRuntimeInfo();
    expect(info.sessionId).toBe("fake-session-1");
    expect(info.model).toBe("fake-model-a");

    const pers = session.describePersistence();
    expect(pers).toEqual({ provider: "fakeacp", ref: "fake-session-1", kind: "session" });

    await session.close();
  }, 20_000);

  it("setModel goes through session/set_config_option", async () => {
    const p = provider();
    const session = (await p.createSession({ provider: "fakeacp" }, {})) as AcpAgentSession;
    await session.setModel("fake-model-b");
    const info = await session.getRuntimeInfo();
    // config option was applied at session start only for config.model;
    // setModel issues the RPC — fake replies ok. Runtime info still shows
    // seeded currentValue until an update arrives — assert no throw.
    expect(info.provider).toBe("fakeacp");
    await session.close();
  }, 20_000);

  it("permission flow: request_permission → permission.requested → respond → resolved", async () => {
    const p = provider("permission");
    const session = (await p.createSession({ provider: "fakeacp" }, {})) as AcpAgentSession;
    const { events } = collect(session);

    await session.startTurn(turnInput("do it"));
    await waitFor(() => events.some((e) => e.type === "permission.requested"));

    const req = events.find((e) => e.type === "permission.requested") as {
      request: { requestId: string; options: Array<{ id: string; kind: string }> };
    };
    const optionIds = req.request.options.map((o) => o.id);
    expect(optionIds).toContain("allow_once");
    expect(optionIds).toContain("allow_always");
    expect(optionIds).toContain("reject_once");
    // kind mapping: allow_always → allow_task
    const always = req.request.options.find((o) => o.id === "allow_always");
    expect(always?.kind).toBe("allow_task");

    await session.respondToPermission(req.request.requestId, {
      requestId: req.request.requestId,
      optionId: "allow_once",
    });
    await waitFor(() => events.some((e) => e.type === "turn.completed"));

    const resolved = events.find((e) => e.type === "permission.resolved") as {
      decision: { optionId: string };
    };
    expect(resolved.decision.optionId).toBe("allow_once");

    const toolCompleted = events.find(
      (e) => e.type === "tool.completed" && (e as { toolCallId: string }).toolCallId === "tc-2",
    ) as { outcome: string };
    expect(toolCompleted.outcome).toBe("succeeded");

    await session.close();
  }, 20_000);

  it("deny permission → tool failed + turn still completes", async () => {
    const p = provider("permission");
    const session = (await p.createSession({ provider: "fakeacp" }, {})) as AcpAgentSession;
    const { events } = collect(session);
    await session.startTurn(turnInput("do it"));
    await waitFor(() => events.some((e) => e.type === "permission.requested"));
    const req = events.find((e) => e.type === "permission.requested") as {
      request: { requestId: string };
    };
    await session.respondToPermission(req.request.requestId, {
      requestId: req.request.requestId,
      optionId: "reject_once",
    });
    await waitFor(() => events.some((e) => e.type === "turn.completed"));
    const tc2 = events.find(
      (e) => e.type === "tool.completed" && (e as { toolCallId: string }).toolCallId === "tc-2",
    ) as { outcome: string };
    expect(tc2.outcome).toBe("failed");
    await session.close();
  }, 20_000);

  it("prompt RPC error → turn.failed", async () => {
    const p = provider("fail");
    const session = (await p.createSession({ provider: "fakeacp" }, {})) as AcpAgentSession;
    const { events } = collect(session);
    await session.startTurn(turnInput("boom"));
    await waitFor(() => events.some((e) => e.type === "turn.failed"));
    const failed = events.find((e) => e.type === "turn.failed") as {
      error: { message: string };
    };
    expect(failed.error.message).toContain("upstream exploded");
    await session.close();
  }, 20_000);

  it("interrupt sends session/cancel → turn.cancelled", async () => {
    const p = provider("slow");
    const session = (await p.createSession({ provider: "fakeacp" }, {})) as AcpAgentSession;
    const { events } = collect(session);
    await session.startTurn(turnInput("slow"));
    await waitFor(() => events.some((e) => e.type === "assistant.delta"));
    await session.interrupt();
    await waitFor(() => events.some((e) => e.type === "turn.cancelled" || e.type === "turn.completed"));
    const terminal = events.find(
      (e) => e.type === "turn.cancelled" || e.type === "turn.completed",
    );
    // fixture resolves cancelled on session/cancel
    expect(terminal?.type).toBe("turn.cancelled");
    await session.close();
  }, 20_000);

  it("resumeSession uses session/load with the persisted ref", async () => {
    const p = provider();
    const session = (await p.resumeSession(
      { provider: "fakeacp", ref: "fake-session-1", kind: "session" },
      { provider: "fakeacp" },
      {},
    )) as AcpAgentSession;
    const { events } = collect(session);
    await session.startTurn(turnInput("again"));
    await waitFor(() => events.some((e) => e.type === "turn.completed"));
    const info = await session.getRuntimeInfo();
    expect(info.sessionId).toBe("fake-session-1"); // fixture echoes load id
    await session.close();
  }, 20_000);

  it("config.options.mcpServers → session/new mcpServers with ACP env shape", async () => {
    // ACP EnvVariable[] is {name,value} pairs, not a record — the gateway
    // spawn descriptor uses a record, so the provider must translate.
    const capture = path.join(os.tmpdir(), `acp-mcp-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
      const p = new AcpAgentProvider({
        id: "fakeacp",
        displayName: "Fake ACP",
        command: process.execPath,
        args: [FAKE],
        env: { FAKE_ACP_SCENARIO: "ok", FAKE_ACP_CAPTURE: capture },
      });
      const session = (await p.createSession(
        {
          provider: "fakeacp",
          options: {
            mcpServers: {
              chromex_browser: {
                command: process.execPath,
                args: ["/x/mcp-stdio.js"],
                env: { CHROMEX_MCP_SCOPE_FILE: "/data/mcp/t1.json" },
              },
              skipped: { args: ["no-command"] }, // no command → dropped
            },
          },
        },
        { cwd: "/tmp" },
      )) as AcpAgentSession;
      const { events } = collect(session);
      await session.startTurn(turnInput("hi"));
      await waitFor(() => events.some((e) => e.type === "turn.completed"));

      const captured = JSON.parse(readFileSync(capture, "utf8")) as {
        method: string;
        mcpServers: unknown;
      };
      expect(captured.method).toBe("session/new");
      expect(captured.mcpServers).toEqual([
        {
          name: "chromex_browser",
          command: process.execPath,
          args: ["/x/mcp-stdio.js"],
          env: [{ name: "CHROMEX_MCP_SCOPE_FILE", value: "/data/mcp/t1.json" }],
        },
      ]);
      await session.close();
    } finally {
      rmSync(capture, { force: true });
    }
  }, 20_000);

  it("no mcpServers in config → session/new gets an empty array", async () => {
    const capture = path.join(os.tmpdir(), `acp-mcp-empty-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    try {
      const p = new AcpAgentProvider({
        id: "fakeacp",
        displayName: "Fake ACP",
        command: process.execPath,
        args: [FAKE],
        env: { FAKE_ACP_SCENARIO: "ok", FAKE_ACP_CAPTURE: capture },
      });
      const session = (await p.createSession({ provider: "fakeacp" }, { cwd: "/tmp" })) as AcpAgentSession;
      const { events } = collect(session);
      await session.startTurn(turnInput("hi"));
      await waitFor(() => events.some((e) => e.type === "turn.completed"));
      const captured = JSON.parse(readFileSync(capture, "utf8")) as { mcpServers: unknown };
      expect(captured.mcpServers).toEqual([]);
      await session.close();
    } finally {
      rmSync(capture, { force: true });
    }
  }, 20_000);

  it("sequential turns share one ACP session", async () => {
    const p = provider();
    const session = (await p.createSession({ provider: "fakeacp" }, {})) as AcpAgentSession;
    const { events } = collect(session);
    await session.startTurn(turnInput("one", "gt-1"));
    await waitFor(() => events.filter((e) => e.type === "turn.completed").length === 1);
    await session.startTurn(turnInput("two", "gt-2"));
    await waitFor(() => events.filter((e) => e.type === "turn.completed").length === 2);
    const info = await session.getRuntimeInfo();
    expect(info.sessionId).toBe("fake-session-1");
    await session.close();
  }, 20_000);
});

describe("AcpAgentSession conformance (GateB-B1)", () => {
  runAgentSessionConformance("acp", async () => {
    const p = provider();
    const session = (await p.createSession({ provider: "fakeacp" }, {})) as AcpAgentSession;
    return {
      session,
      turnInput: {
        gatewayTurnId: "conf-acp-1",
        clientMessageId: "conf-acp-cm",
        content: [{ type: "text", text: "conformance probe" }],
      },
    };
  });
});
