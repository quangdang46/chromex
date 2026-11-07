/**
 * CodexAgentSession tests — fake CodexAppServerClient transport.
 * Contract conformance (GateB-B1) + turn lifecycle + permission flow.
 * Real-app-server coverage lands with the provider.feature RPCs; these
 * tests pin the adapter's mapping/session semantics deterministically.
 */

import { describe, expect, test } from "vitest";

import type { AgentEvent } from "@codex-sidepanel/shared";

import { CodexAgentProvider } from "../src/agents/providers/codex/provider.js";
import { CodexAgentSession } from "../src/agents/providers/codex/session.js";
import { runAgentSessionConformance } from "./conformance/agent-session.js";

type Notification = { method: string; params?: Record<string, unknown> };
type ServerRequest = { id: string | number; method?: string; params?: Record<string, unknown> };

class FakeCodexClient {
  notifications = new Set<(n: Notification) => void>();
  requests = new Set<(r: ServerRequest) => Promise<unknown> | unknown>();
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  turnCount = 0;
  /** when true, turn/start schedules a completed happy-path turn */
  autoComplete = true;

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    switch (method) {
      case "thread/start":
        return { thread: { id: "th-fake-1" } };
      case "thread/resume":
        return { thread: { id: String(params.threadId ?? "th-resumed") } };
      case "turn/start": {
        this.turnCount += 1;
        const id = `pt-${this.turnCount}`;
        queueMicrotask(() => {
          this.emit({ method: "turn/started", params: { turn: { id, status: "inProgress" } } });
          if (this.autoComplete) {
            this.emit({
              method: "item/agentMessage/delta",
              params: { turnId: id, itemId: "m1", delta: "fake reply" },
            });
            this.emit({
              method: "item/completed",
              params: { turnId: id, item: { id: "m1", type: "agentMessage", text: "fake reply" } },
            });
            this.emit({
              method: "turn/completed",
              params: { turn: { id, status: "completed" } },
            });
          }
        });
        return { turn: { id } };
      }
      case "turn/interrupt": {
        const tid = String(params.turnId ?? "");
        queueMicrotask(() => {
          this.emit({
            method: "turn/completed",
            params: { turn: { id: tid, status: "interrupted" } },
          });
        });
        return {};
      }
      case "turn/steer":
        return { turnId: params.expectedTurnId };
      default:
        return {};
    }
  }

  onNotification(h: (n: Notification) => void): () => void {
    this.notifications.add(h);
    return () => this.notifications.delete(h);
  }
  onRequest(h: (r: ServerRequest) => Promise<unknown> | unknown): () => void {
    this.requests.add(h);
    return () => this.requests.delete(h);
  }
  emit(n: Notification): void {
    for (const h of this.notifications) h(n);
  }
  /** simulate a server→client request (e.g. requestUserInput) */
  serverRequest(r: ServerRequest): void {
    for (const h of this.requests) void h(r);
  }
}

function makeSession(
  client = new FakeCodexClient(),
  config: Record<string, unknown> = { provider: "codex" },
) {
  const session = new CodexAgentSession(
    client as never,
    config as never,
    {},
    "sess-test-1",
  );
  return { session, client };
}

const INPUT = {
  gatewayTurnId: "gt-1",
  clientMessageId: "cm-1",
  content: [{ type: "text" as const, text: "hello" }],
};

describe("CodexAgentSession", () => {
  test("startTurn binds provider turn and streams mapped events", async () => {
    const { session, client } = makeSession();
    const events: AgentEvent[] = [];
    session.subscribe((e) => events.push(e));

    const res = await session.startTurn(INPUT);
    expect(res.accepted).toBe(true);
    expect(res.providerTurnId).toBe("pt-1");

    // let queued notifications flush
    await new Promise((r) => setTimeout(r, 10));
    const types = events.map((e) => e.type);
    expect(types).toContain("turn.started");
    expect(types).toContain("assistant.delta");
    expect(types).toContain("assistant.message");
    expect(types).toContain("turn.completed");
    // all turn-scoped events carry the GATEWAY turn id, never pt-1
    for (const e of events) {
      if ("turnId" in e) expect((e as { turnId?: string }).turnId).toBe("gt-1");
    }
    await session.close();
  });

  test("second startTurn allowed after terminal event", async () => {
    const { session } = makeSession();
    await session.startTurn(INPUT);
    await new Promise((r) => setTimeout(r, 10));
    const res2 = await session.startTurn({ ...INPUT, gatewayTurnId: "gt-2" });
    expect(res2.accepted).toBe(true);
    await session.close();
  });

  test("describePersistence returns codex thread handle after startTurn", async () => {
    const { session } = makeSession();
    expect(session.describePersistence()).toBeNull();
    await session.startTurn(INPUT);
    const h = session.describePersistence();
    expect(h).toMatchObject({ provider: "codex", ref: "th-fake-1", kind: "thread" });
    await session.close();
  });

  test("requestUserInput server request → permission.requested → respond resolves", async () => {
    const { session, client } = makeSession();
    client.autoComplete = false; // keep turn open
    const events: AgentEvent[] = [];
    session.subscribe((e) => events.push(e));
    await session.startTurn(INPUT);
    await new Promise((r) => setTimeout(r, 5));

    let serverResolved: unknown = null;
    // intercept: our fake stores handlers; wrap resolve capture via request promise
    client.serverRequest({
      id: "rpc-1",
      method: "item/tool/requestUserInput",
      params: {
        turnId: "pt-1",
        itemId: "req-1",
        questions: [
          { id: "q1", question: "Allow?", options: [{ id: "allow", label: "Allow" }, { id: "deny", label: "Deny" }] },
        ],
      },
    });
    await new Promise((r) => setTimeout(r, 5));

    const permEvent = events.find((e) => e.type === "permission.requested");
    expect(permEvent).toBeDefined();
    const pending = session.getPendingPermissions();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe("provider_permission");

    const res = await session.respondToPermission("rpc-1", {
      requestId: "rpc-1",
      optionId: "allow",
    });
    expect(res.followUpPrompt).toBeUndefined();
    expect(session.getPendingPermissions()).toHaveLength(0);
    expect(events.some((e) => e.type === "permission.resolved")).toBe(true);
    await session.interrupt();
    await session.close();
    void serverResolved;
  });

  test("interrupt sends turn/interrupt and resolves", async () => {
    const { session, client } = makeSession();
    client.autoComplete = false;
    await session.startTurn(INPUT);
    await session.interrupt();
    expect(client.calls.some((c) => c.method === "turn/interrupt")).toBe(true);
    await session.close();
  });

  test("resumeSession uses thread/resume with persistence ref", async () => {
    const provider = new CodexAgentProvider({ client: new FakeCodexClient() as never });
    const session = await provider.resumeSession(
      { provider: "codex", ref: "th-old", kind: "thread" },
      { provider: "codex" },
      {},
    );
    await session.startTurn(INPUT);
    const client = (provider as unknown as { client: FakeCodexClient }).client;
    expect(client.calls.some((c) => c.method === "thread/resume" && c.params.threadId === "th-old")).toBe(true);
    expect(session.describePersistence()?.ref).toBe("th-old");
    await session.close();
    await provider.shutdown();
  });
});

// GateB-B1 conformance suite against the real adapter + fake transport.
runAgentSessionConformance("codex", async () => {
  const { session } = makeSession();
  return { session, turnInput: INPUT };
});

describe("CodexAgentSession — MCP config override (§9.3)", () => {
  test("options.mcpServers → thread/start config.mcp_servers", async () => {
    const { session, client } = makeSession(new FakeCodexClient(), {
      provider: "codex",
      options: {
        mcpServers: {
          chromex_browser: {
            command: "/usr/bin/node",
            args: ["/x/mcp-stdio.js"],
            env: { CHROMEX_MCP_SCOPE_FILE: "/data/mcp/t1.json" },
          },
        },
      },
    });
    await session.startTurn({
      gatewayTurnId: "gt-mcp",
      clientMessageId: "cm-mcp",
      content: [{ type: "text", text: "hi" }],
    });
    const start = client.calls.find((c) => c.method === "thread/start");
    expect(start).toBeDefined();
    const cfg = (start!.params as { config?: { mcp_servers?: Record<string, unknown> } }).config;
    expect(cfg?.mcp_servers?.chromex_browser).toEqual({
      command: "/usr/bin/node",
      args: ["/x/mcp-stdio.js"],
      env: { CHROMEX_MCP_SCOPE_FILE: "/data/mcp/t1.json" },
    });
  });

  test("no mcpServers → no config override sent", async () => {
    const { session, client } = makeSession();
    await session.startTurn({
      gatewayTurnId: "gt-plain",
      clientMessageId: "cm-plain",
      content: [{ type: "text", text: "hi" }],
    });
    const start = client.calls.find((c) => c.method === "thread/start");
    expect((start!.params as { config?: unknown }).config).toBeUndefined();
  });
});
