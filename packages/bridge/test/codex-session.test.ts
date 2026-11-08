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

  test("planMode ctx sends collaborationMode on turn/start", async () => {
    const { session, client } = makeSession();
    await session.startTurn({
      ...INPUT,
      ctx: { metadata: { planMode: true } },
    });
    const start = client.calls.find((c) => c.method === "turn/start");
    const cm = start?.params.collaborationMode as
      | { mode?: string; settings?: { model?: string } }
      | undefined;
    expect(cm?.mode).toBe("plan");
    await session.close();
  });

  test("no planMode ctx → no collaborationMode", async () => {
    const { session, client } = makeSession();
    await session.startTurn(INPUT);
    const start = client.calls.find((c) => c.method === "turn/start");
    expect(start?.params).not.toHaveProperty("collaborationMode");
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

  test("requestUserInput → respondToPermission honors per-question answers", async () => {
    const { session, client } = makeSession();
    client.autoComplete = false;
    await session.startTurn(INPUT);
    await new Promise((r) => setTimeout(r, 5));

    let serverResponse: Promise<unknown> | null = null;
    for (const h of client.requests) {
      serverResponse = Promise.resolve(
        h({
          id: "rpc-2",
          method: "item/tool/requestUserInput",
          params: {
            questions: [
              { id: "q1", question: "First?", options: [{ id: "a1", label: "A1" }, { id: "a2", label: "A2" }] },
              { id: "q2", question: "Second?", options: [{ id: "b1", label: "B1" }] },
            ],
          },
        }),
      );
    }
    await new Promise((r) => setTimeout(r, 5));
    expect(session.getPendingPermissions().map((p) => p.requestId)).toContain("rpc-2");

    await session.respondToPermission("rpc-2", {
      requestId: "rpc-2",
      answers: { q1: ["a2"], q2: ["free text"] },
    });
    expect(await serverResponse).toEqual({
      answers: {
        q1: { answers: ["a2"] },
        q2: { answers: ["free text"] },
      },
    });
    await session.interrupt();
    await session.close();
  });

  test("interrupt sends turn/interrupt and resolves", async () => {
    const { session, client } = makeSession();
    client.autoComplete = false;
    await session.startTurn(INPUT);
    await session.interrupt();
    expect(client.calls.some((c) => c.method === "turn/interrupt")).toBe(true);
    await session.close();
  });

  test("interrupt keeps turn bound until a delayed terminal notification", async () => {
    const { session, client } = makeSession();
    client.autoComplete = false;
    await session.startTurn(INPUT);
    const events: AgentEvent[] = [];
    session.subscribe((e) => events.push(e));

    // The real app-server answers turn/interrupt immediately and emits
    // turn/completed{interrupted} only after the abort finishes — simulate
    // that gap by suppressing the fake's auto-emit and sending it late.
    const origRequest = client.request.bind(client);
    client.request = (method: string, params: Record<string, unknown> = {}) => {
      if (method === "turn/interrupt") {
        client.calls.push({ method, params });
        return Promise.resolve({});
      }
      return origRequest(method, params);
    };

    const interruptPromise = session.interrupt();
    await new Promise((r) => setTimeout(r, 20));
    client.emit({
      method: "turn/completed",
      params: { turn: { id: "pt-1", status: "interrupted" } },
    });
    await interruptPromise;

    expect(events.some((e) => e.type === "turn.cancelled" && e.turnId === "gt-1")).toBe(true);
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

describe("CodexAgentProvider.callFeature — account carve-outs (chromex-pnk)", () => {
  function makeSecrets() {
    const store = new Map<string, string>();
    return {
      store,
      setOpenAiApiKey: (k: string) => void store.set("openAiApiKey", k),
      clearOpenAiApiKey: () => void store.delete("openAiApiKey"),
      hasOpenAiApiKey: () => store.has("openAiApiKey"),
    };
  }

  test("apiKey login stores the secret without touching the app-server", async () => {
    const client = new FakeCodexClient();
    const secrets = makeSecrets();
    const provider = new CodexAgentProvider({ client: client as never, secrets });

    const res = await provider.callFeature("provider.feature.codex.account.login.start", {
      type: "apiKey",
      apiKey: "sk-test",
    });

    expect(res).toEqual({ stored: true });
    expect(secrets.hasOpenAiApiKey()).toBe(true);
    expect(client.calls).toHaveLength(0);
    await provider.shutdown();
  });

  test("apiKey login without a key rejects before any app-server call", async () => {
    const client = new FakeCodexClient();
    const provider = new CodexAgentProvider({ client: client as never, secrets: makeSecrets() });

    await expect(
      provider.callFeature("provider.feature.codex.account.login.start", { type: "apiKey" }),
    ).rejects.toThrow(/requires params\.apiKey/u);
    expect(client.calls).toHaveLength(0);
    await provider.shutdown();
  });

  test("chatgpt login forwards to account/login/start", async () => {
    const client = new FakeCodexClient();
    const provider = new CodexAgentProvider({ client: client as never });

    await provider.callFeature("provider.feature.codex.account.login.start", { type: "chatgpt" });

    expect(client.calls[0]).toEqual({
      method: "account/login/start",
      params: { type: "chatgpt" },
    });
    await provider.shutdown();
  });

  test("logout calls account/logout and clears the stored api key", async () => {
    const client = new FakeCodexClient();
    const secrets = makeSecrets();
    secrets.setOpenAiApiKey("sk-test");
    const provider = new CodexAgentProvider({ client: client as never, secrets });

    await provider.callFeature("provider.feature.codex.account.logout", {});

    expect(client.calls[0]).toEqual({ method: "account/logout", params: {} });
    expect(secrets.hasOpenAiApiKey()).toBe(false);
    await provider.shutdown();
  });

  test("account/login/completed notification → onAccountLoginCompleted (chromex-fjr)", async () => {
    const client = new FakeCodexClient();
    const seen: Array<{ loginId: string; success: boolean; error: string | null }> = [];
    const provider = new CodexAgentProvider({
      client: client as never,
      onAccountLoginCompleted: (e) => seen.push(e),
    });

    client.emit({
      method: "account/login/completed",
      params: { loginId: "login-1", success: true },
    });
    client.emit({ method: "turn/started", params: {} }); // unrelated — ignored
    client.emit({
      method: "account/login/completed",
      params: { loginId: "login-2", success: false, error: "denied" },
    });

    expect(seen).toEqual([
      { loginId: "login-1", success: true, error: null },
      { loginId: "login-2", success: false, error: "denied" },
    ]);
    await provider.shutdown();
    // shutdown unsubscribes — no further callbacks
    client.emit({ method: "account/login/completed", params: { loginId: "login-3", success: true } });
    expect(seen).toHaveLength(2);
  });

  test("account.status is enriched with openAiApiKeyConfigured", async () => {
    const client = new FakeCodexClient();
    const secrets = makeSecrets();
    secrets.setOpenAiApiKey("sk-test");
    const provider = new CodexAgentProvider({ client: client as never, secrets });

    const res = (await provider.callFeature("provider.feature.codex.account.status", {})) as Record<
      string,
      unknown
    >;

    expect(res.openAiApiKeyConfigured).toBe(true);
    expect(client.calls[0]).toEqual({ method: "account/read", params: { refreshToken: false } });
    await provider.shutdown();
  });
});
