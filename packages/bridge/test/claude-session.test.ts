/**
 * ClaudeAgentSession/Mapper tests — fake SDK Query via queryFactory seam.
 * Real-CLI coverage is environment-dependent (claude on PATH + auth);
 * these tests pin the adapter's event mapping, permission plumbing,
 * interrupt and resume-option semantics deterministically.
 */

import { describe, expect, test, vi } from "vitest";

import type { AgentEvent } from "@codex-sidepanel/shared";
import type {
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { ClaudeAgentProvider } from "../src/agents/providers/claude/provider.js";
import { ClaudeAgentSession, CLAUDE_CAPABILITIES } from "../src/agents/providers/claude/session.js";
import { ClaudeEventMapper } from "../src/agents/providers/claude/mapper.js";
import { runAgentSessionConformance } from "./conformance/agent-session.js";

const INPUT = {
  gatewayTurnId: "gt-1",
  clientMessageId: "cm-1",
  content: [{ type: "text" as const, text: "hello" }],
};

/** Scripted SDK message emitter bound to the prompt stream. */
class FakeQuery {
  readonly messages: unknown[] = [];
  interrupted = false;
  closed = false;
  capturedOptions: Options | null = null;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly script: (uuid: string, q: FakeQuery) => void) {}

  async *[Symbol.asyncIterator]() {
    // The real SDK yields messages; the fake yields scripted ones pushed
    // via emit() once the session starts consuming.
    for (;;) {
      while (this.messages.length > 0) yield this.messages.shift();
      if (this.closed) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  emit(msg: unknown): void {
    this.messages.push(msg);
    this.waiters.splice(0).forEach((w) => w());
  }

  interrupt(): Promise<void> {
    this.interrupted = true;
    this.emit({
      type: "result",
      subtype: "success",
      is_error: true,
      session_id: "sess-fake",
      user_message_uuid: this.lastUuid,
      result: "",
    });
    return Promise.resolve();
  }

  lastUuid = "";
  close(): void {
    this.closed = true;
    this.waiters.splice(0).forEach((w) => w());
  }
  supportedCommands(): Promise<never[]> {
    return Promise.resolve([]);
  }
  supportedModels(): Promise<never[]> {
    return Promise.resolve([]);
  }
}

function makeSession(
  script: (uuid: string, q: FakeQuery) => void = () => {},
  config: Record<string, unknown> = { provider: "claude" },
) {
  let queryInstance: FakeQuery | null = null;
  const session = new ClaudeAgentSession(
    config as never,
    { cwd: "/tmp" } as never,
    "sess-test-1",
    {
      queryFactory: ({ prompt, options }) => {
        void prompt;
        const q = new FakeQuery(script);
        q.capturedOptions = options;
        queryInstance = q;
        // consume the prompt stream; script each user message
        void (async () => {
          for await (const m of prompt as AsyncIterable<SDKUserMessage>) {
            q.lastUuid = m.uuid;
            script(m.uuid, q);
          }
        })();
        return q as unknown as Query;
      },
    },
  );
  return {
    session,
    getQuery: () => queryInstance as FakeQuery | null,
  };
}

/** Default happy-path script: assistant text + success result per turn. */
function autoComplete(_uuid: string, q: FakeQuery): void {
  q.emit({
    type: "assistant",
    session_id: "sess-conf",
    user_message_uuid: q.lastUuid,
    parent_tool_use_id: null,
    message: { content: [{ type: "text", text: "ok" }] },
  });
  q.emit({
    type: "result",
    subtype: "success",
    is_error: false,
    session_id: "sess-conf",
    user_message_uuid: q.lastUuid,
    result: "ok",
    usage: { input_tokens: 1, output_tokens: 1 },
  });
}

function collect(session: ClaudeAgentSession) {
  const events: AgentEvent[] = [];
  const deltas: Array<{ event: AgentEvent; deltaOffset?: number }> = [];
  session.subscribe((e) => {
    events.push(e);
    const off = (e as { deltaOffset?: number }).deltaOffset;
    if (off !== undefined) deltas.push({ event: e, deltaOffset: off });
  });
  return { events, deltas };
}

describe("ClaudeEventMapper", () => {
  test("stream_event text_delta → ephemeral assistant.delta with deltaOffset", () => {
    const mapper = new ClaudeEventMapper();
    const items: Array<{ type: string; ephemeral: boolean; deltaOffset?: number }> = [];
    mapper.onEvent((i) => items.push({ type: i.event.type, ephemeral: i.ephemeral, ...(i.deltaOffset !== undefined ? { deltaOffset: i.deltaOffset } : {}) }));
    mapper.bindTurn("gt-1", "uuid-1");
    mapper.mapMessage({
      type: "stream_event",
      session_id: "s1",
      user_message_uuid: "uuid-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hel" } },
    } as never);
    mapper.mapMessage({
      type: "stream_event",
      session_id: "s1",
      user_message_uuid: "uuid-1",
      event: { type: "content_block_delta", delta: { type: "text_delta", text: "lo" } },
    } as never);
    expect(items).toEqual([
      { type: "assistant.delta", ephemeral: true, deltaOffset: 0 },
      { type: "assistant.delta", ephemeral: true, deltaOffset: 3 },
    ]);
  });

  test("result success → assistant.message + usage + turn.completed", () => {
    const mapper = new ClaudeEventMapper();
    const types: string[] = [];
    mapper.onEvent((i) => types.push(i.event.type));
    mapper.bindTurn("gt-1", "uuid-1");
    mapper.mapMessage({
      type: "assistant",
      session_id: "s1",
      user_message_uuid: "uuid-1",
      parent_tool_use_id: null,
      message: { content: [{ type: "text", text: "done" }] },
    } as never);
    mapper.mapMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s1",
      user_message_uuid: "uuid-1",
      result: "done",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2 },
    } as never);
    expect(types).toEqual(["assistant.message", "usage", "turn.completed"]);
    expect(mapper.sessionId).toBe("s1");
  });

  test("interruptRequested → turn.cancelled not completed", () => {
    const mapper = new ClaudeEventMapper();
    const types: string[] = [];
    mapper.onEvent((i) => types.push(i.event.type));
    mapper.bindTurn("gt-1", "uuid-1");
    mapper.markInterruptRequested();
    mapper.mapMessage({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "s1",
      user_message_uuid: "uuid-1",
      result: "",
    } as never);
    expect(types).toEqual(["turn.cancelled"]);
  });
});

describe("ClaudeAgentSession", () => {
  test("capabilities are honest (no steer, no free-form persistence claim)", () => {
    expect(CLAUDE_CAPABILITIES.streaming).toBe(true);
    expect(CLAUDE_CAPABILITIES.interrupt).toBe(true);
    expect(CLAUDE_CAPABILITIES.resume).toBe(true);
    expect(CLAUDE_CAPABILITIES.steer).toBeFalsy();
  });

  test("startTurn streams deltas and completes on result success", async () => {
    const { session, getQuery } = makeSession((_uuid, q) => {
      q.emit({
        type: "stream_event",
        session_id: "sess-fake",
        user_message_uuid: q.lastUuid,
        event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } },
      });
      q.emit({
        type: "assistant",
        session_id: "sess-fake",
        user_message_uuid: q.lastUuid,
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "Hi there" }] },
      });
      q.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-fake",
        user_message_uuid: q.lastUuid,
        result: "Hi there",
        usage: { input_tokens: 3, output_tokens: 2 },
      });
    });
    const { events, deltas } = collect(session);
    const res = await session.startTurn(INPUT as never);
    expect(res.accepted).toBe(true);
    expect(res.providerTurnId).toBeTruthy();
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn.completed")).toBe(true);
    });
    expect(events.some((e) => e.type === "assistant.delta")).toBe(true);
    expect(events.some((e) => e.type === "assistant.message")).toBe(true);
    expect(events.some((e) => e.type === "usage")).toBe(true);
    expect(deltas[0]?.deltaOffset).toBe(0);
    expect(getQuery()?.capturedOptions?.includePartialMessages).toBe(true);
    expect(getQuery()?.capturedOptions?.permissionMode).toBe("default");
    await session.close();
  });

  test("steer reports unavailable (ADR: interrupt→new turn instead)", async () => {
    const { session } = makeSession();
    expect((await session.steer(INPUT as never)).status).toBe("unavailable");
    await session.close();
  });

  test("interrupt emits turn.cancelled and clears active turn", async () => {
    const { session, getQuery } = makeSession((_uuid, q) => {
      // hang: no terminal until interrupt() emits the error result
      void q;
    });
    const { events } = collect(session);
    await session.startTurn(INPUT as never);
    await new Promise((r) => setTimeout(r, 10)); // let prompt consumer stamp uuid
    await session.interrupt();
    expect(events.some((e) => e.type === "turn.cancelled")).toBe(true);
    expect(getQuery()?.interrupted).toBe(true);
    await session.close();
  });

  test("resume handle maps to SDK resume option; fresh session has none", async () => {
    const { session, getQuery } = makeSession();
    await session.startTurn(INPUT as never);
    await vi.waitFor(() => expect(getQuery()).not.toBeNull());
    expect(getQuery()?.capturedOptions?.resume).toBeUndefined();
    await session.close();

    let captured: Options | null = null;
    const resumed = new ClaudeAgentSession(
      {
        provider: "claude",
        resume: { persistence: { provider: "claude", ref: "sess-abc", kind: "session" } },
      } as never,
      { cwd: "/tmp" } as never,
      "sess-resume",
      {
        queryFactory: ({ options }) => {
          captured = options;
          return new FakeQuery(() => {}) as unknown as Query;
        },
      },
    );
    await resumed.startTurn(INPUT as never);
    await vi.waitFor(() => expect(captured).not.toBeNull());
    expect(captured?.resume).toBe("sess-abc");
    await resumed.close();
  });

  test("describePersistence only after session_id observed", async () => {
    const { session } = makeSession((_uuid, q) => {
      q.emit({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: "sess-real-1",
        user_message_uuid: q.lastUuid,
        result: "ok",
        usage: {},
      });
    });
    expect(session.describePersistence()).toBeNull();
    await session.startTurn(INPUT as never);
    await vi.waitFor(() => expect(session.describePersistence()?.ref).toBe("sess-real-1"));
    await session.close();
  });

  test("canUseTool → permission.requested; respondToPermission resolves allow", async () => {
    const { session } = makeSession((_uuid, q) => {
      const opts = (q.capturedOptions as { canUseTool?: (n: string, i: Record<string, unknown>, o: object) => Promise<unknown> }).canUseTool;
      void opts?.("Bash", { command: "ls" }, { toolUseID: "tu-1" });
    });
    const { events } = collect(session);
    await session.startTurn(INPUT as never);
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "permission.requested")).toBe(true);
    });
    const req = session.getPendingPermissions()[0]!;
    expect(req.kind).toBe("provider_permission");
    const res = await session.respondToPermission(req.requestId, {
      optionId: "allow",
      decidedAt: Date.now(),
    } as never);
    expect(res).toEqual({});
    expect(events.some((e) => e.type === "permission.resolved")).toBe(true);
    expect(session.getPendingPermissions()).toHaveLength(0);
    await session.close();
  });

  test("deny response resolves canUseTool with deny behavior", async () => {
    let resolved: unknown = null;
    const { session } = makeSession((_uuid, q) => {
      const opts = q.capturedOptions as { canUseTool?: (n: string, i: Record<string, unknown>, o: object) => Promise<unknown> };
      void opts?.canUseTool?.("Bash", {}, { toolUseID: "tu-2" }).then((r) => {
        resolved = r;
      });
    });
    collect(session);
    await session.startTurn(INPUT as never);
    await vi.waitFor(() => expect(session.getPendingPermissions()).toHaveLength(1));
    const req = session.getPendingPermissions()[0]!;
    await session.respondToPermission(req.requestId, {
      optionId: "deny",
      decidedAt: Date.now(),
    } as never);
    await vi.waitFor(() => expect(resolved).not.toBeNull());
    expect(resolved).toMatchObject({ behavior: "deny" });
    await session.close();
  });
});

describe("ClaudeAgentProvider lifecycle (P3-02)", () => {
  test("isAvailable false for missing binary, true for resolvable one", async () => {
    const missing = new ClaudeAgentProvider({ command: "/nonexistent/claude-bin" });
    expect((await missing.isAvailable()).available).toBe(false);
    const ok = new ClaudeAgentProvider({ command: "/usr/bin/true" });
    // /usr/bin/true ignores args and exits 0 → available (version empty)
    expect((await ok.isAvailable()).available).toBe(true);
  });

  test("resumeSession produces a claude session wired to the handle", async () => {
    const provider = new ClaudeAgentProvider({ command: "/usr/bin/true" });
    const session = await provider.resumeSession(
      { provider: "claude", ref: "sess-old", kind: "session" },
      { provider: "claude" },
      { cwd: "/tmp" },
    );
    expect(session.provider).toBe("claude");
    // query is lazy — no SDK process spawned until startTurn
    await session.close();
  });

  test("stale resume / provider error → turn.failed (not hung)", async () => {
    const { session } = makeSession((_uuid, q) => {
      q.emit({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        session_id: "sess-fake",
        user_message_uuid: q.lastUuid,
        errors: ["No conversation found with session ID"],
      });
    });
    const { events } = collect(session);
    await session.startTurn(INPUT as never);
    await vi.waitFor(() => {
      expect(events.some((e) => e.type === "turn.failed")).toBe(true);
    });
    const failed = events.find((e) => e.type === "turn.failed") as {
      error?: { message?: string };
    };
    expect(String(failed.error?.message)).toContain("No conversation found");
    await session.close();
  });
});

describe("ClaudeAgentSession conformance (GateB-B1)", () => {
  runAgentSessionConformance("claude", async () => {
    const { session } = makeSession(autoComplete);
    return { session, turnInput: INPUT as never };
  });
});
