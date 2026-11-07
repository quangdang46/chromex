/**
 * Shared AgentSession invariants — parametric over provider adapters.
 *
 * Complements two existing layers:
 *  - test/conformance/agent-session.ts — member-surface checklist
 *    (already run per-provider from codex-session.test.ts /
 *    claude-session.test.ts).
 *  - test/codex-session.test.ts / test/claude-session.test.ts —
 *    provider-specific mapping semantics.
 *
 * THIS file asserts the turn-lifecycle contract BOTH adapters must
 * satisfy, driven through each adapter's real session class over a fake
 * transport (FakeCodexClient / FakeQuery — same seams the per-provider
 * suites use; they are not exported, so minimal copies live here):
 *
 *   1. turn lifecycle ordering: turn start → assistant deltas →
 *      assistant.message → exactly one terminal event, per turn.
 *   2. deltaOffset monotonic (strictly increasing, first = 0) within
 *      each turn's ephemeral deltas.
 *   3. permission.requested carries requestId + options; the pending
 *      mirror resolves via respondToPermission and emits
 *      permission.resolved; the provider-side request actually answers.
 *   4. A second startTurn after the terminal event binds a NEW
 *      providerTurnId cleanly and emits a fresh ordered lifecycle.
 *   5. Post-terminal provider frames are never re-emitted under a
 *      different turnId. NOTE: the gateway owns dropping post-terminal
 *      traffic; at session level the observable contract is attribution
 *      — codex still forwards trailing deltas under the OLD gateway
 *      turnId (documented in CodexAgentSession), claude's mapper drops
 *      them via sawTerminal. Both are asserted per-adapter.
 */

import { describe, expect, test, vi } from "vitest";

import type {
  AgentEvent,
  AgentSession,
  PermissionRequest,
  TurnInput,
} from "@codex-sidepanel/shared";
import type {
  Options,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { CodexAgentSession } from "../src/agents/providers/codex/session.js";
import { ClaudeAgentSession } from "../src/agents/providers/claude/session.js";

// ---------------------------------------------------------------------------
// Shared assertion helpers
// ---------------------------------------------------------------------------

const TERMINAL_TYPES = new Set(["turn.completed", "turn.failed", "turn.cancelled"]);
const LIFECYCLE_TYPES = new Set([
  "turn.started",
  "assistant.message",
  "reasoning.summary",
  "tool.started",
  "tool.completed",
  ...TERMINAL_TYPES,
]);

function turnIdOf(e: AgentEvent): string | undefined {
  return (e as { turnId?: string }).turnId;
}

interface LifecycleSnapshot {
  startedIdx: number;
  firstDeltaIdx: number;
  lastDeltaIdx: number;
  terminalIdx: number;
  terminalCount: number;
  terminalType: string | null;
  /** deltaOffset values of assistant.delta/reasoning.delta in order */
  deltaOffsets: number[];
}

function snapshotTurn(events: AgentEvent[], turnId: string): LifecycleSnapshot {
  const snap: LifecycleSnapshot = {
    startedIdx: -1,
    firstDeltaIdx: -1,
    lastDeltaIdx: -1,
    terminalIdx: -1,
    terminalCount: 0,
    terminalType: null,
    deltaOffsets: [],
  };
  events.forEach((e, i) => {
    if (turnIdOf(e) !== turnId) return;
    if (e.type === "turn.started" && snap.startedIdx === -1) snap.startedIdx = i;
    if (e.type === "assistant.delta" || e.type === "reasoning.delta") {
      if (snap.firstDeltaIdx === -1) snap.firstDeltaIdx = i;
      snap.lastDeltaIdx = i;
      const off = (e as { deltaOffset?: number }).deltaOffset;
      if (typeof off === "number") snap.deltaOffsets.push(off);
    }
    if (TERMINAL_TYPES.has(e.type)) {
      snap.terminalCount += 1;
      snap.terminalIdx = i;
      snap.terminalType = e.type;
    }
  });
  return snap;
}

/**
 * Assert the shared ordering + offset invariants for one completed turn.
 * `expectsTurnStarted`: codex's mapper emits turn.started on bindTurn;
 * claude's mapper does not (the gateway owns the user-facing start
 * signal there) — presence is asserted only where the adapter claims it.
 */
function assertTurnLifecycle(
  events: AgentEvent[],
  turnId: string,
  expectsTurnStarted: boolean,
): void {
  const snap = snapshotTurn(events, turnId);
  expect(snap.terminalCount, `expected exactly one terminal for ${turnId}`).toBe(1);
  expect(snap.terminalType).toBe("turn.completed");
  expect(snap.firstDeltaIdx, `deltas before terminal for ${turnId}`).toBeGreaterThan(-1);
  expect(snap.lastDeltaIdx).toBeLessThan(snap.terminalIdx);
  if (expectsTurnStarted) {
    expect(snap.startedIdx, `turn.started emitted for ${turnId}`).toBeGreaterThan(-1);
    expect(snap.startedIdx).toBeLessThan(snap.firstDeltaIdx);
  }
  // durable lifecycle events must not appear after the terminal
  const lateDurable = events
    .slice(snap.terminalIdx + 1)
    .filter((e) => turnIdOf(e) === turnId && LIFECYCLE_TYPES.has(e.type));
  expect(lateDurable, `no durable lifecycle events after terminal for ${turnId}`).toEqual([]);
  // deltaOffset: strictly increasing within the turn, starting at 0
  expect(snap.deltaOffsets.length).toBeGreaterThanOrEqual(2);
  expect(snap.deltaOffsets[0]).toBe(0);
  for (let i = 1; i < snap.deltaOffsets.length; i += 1) {
    expect(snap.deltaOffsets[i]!).toBeGreaterThan(snap.deltaOffsets[i - 1]!);
  }
}

function inputFor(gatewayTurnId: string): TurnInput {
  return {
    gatewayTurnId,
    clientMessageId: `cm-${gatewayTurnId}`,
    content: [{ type: "text", text: "conformance probe" }],
  };
}

async function flush(times = 3): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

// ---------------------------------------------------------------------------
// Probe contract — one per adapter, same observable surface
// ---------------------------------------------------------------------------

interface TurnHandle {
  gatewayTurnId: string;
  providerTurnId?: string;
}

interface PermissionAck {
  request: PermissionRequest;
  /** resolves when the provider transport accepted the response */
  providerAck: Promise<unknown>;
}

interface SessionProbe {
  readonly name: string;
  readonly session: AgentSession;
  readonly events: AgentEvent[];
  /** codex emits turn.started on bind; claude does not */
  readonly expectsTurnStarted: boolean;
  /** what a post-terminal provider delta looks like at session level */
  readonly postTerminalDelta: "dropped" | "old-turn-id";
  openTurn(gatewayTurnId: string): Promise<TurnHandle>;
  /** stream two text deltas + final assistant message (no terminal yet) */
  streamTurnContent(handle: TurnHandle): Promise<void>;
  /** emit the terminal frame; resolves once the terminal event is observed */
  finishTurn(handle: TurnHandle): Promise<void>;
  /** emit one more delta for the handle's provider turn, post-terminal */
  trailingDelta(handle: TurnHandle): Promise<void>;
  /** raise a provider permission request mid-turn */
  requestPermission(handle: TurnHandle): Promise<PermissionAck>;
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Codex adapter probe — CodexAgentSession over FakeCodexClient transport
// ---------------------------------------------------------------------------

type CodexNotification = { method: string; params?: Record<string, unknown> };
type CodexServerRequest = {
  id: string | number;
  method?: string;
  params?: Record<string, unknown>;
};

class FakeCodexClient {
  readonly notifications = new Set<(n: CodexNotification) => void>();
  readonly requests = new Set<(r: CodexServerRequest) => Promise<unknown> | unknown>();
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  turnCount = 0;

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    switch (method) {
      case "thread/start":
        return { thread: { id: "th-conf-1" } };
      case "thread/resume":
        return { thread: { id: String(params.threadId ?? "th-resumed") } };
      case "turn/start": {
        this.turnCount += 1;
        return { turn: { id: `pt-${this.turnCount}` } };
      }
      case "turn/interrupt":
        return {};
      case "turn/steer":
        return { turnId: params.expectedTurnId };
      default:
        return {};
    }
  }

  onNotification(h: (n: CodexNotification) => void): () => void {
    this.notifications.add(h);
    return () => this.notifications.delete(h);
  }

  onRequest(h: (r: CodexServerRequest) => Promise<unknown> | unknown): () => void {
    this.requests.add(h);
    return () => this.requests.delete(h);
  }

  emit(n: CodexNotification): void {
    for (const h of this.notifications) h(n);
  }

  /** simulate a server→client request; resolves with handler results */
  serverRequest(r: CodexServerRequest): Promise<unknown[]> {
    return Promise.all([...this.requests].map((h) => Promise.resolve(h(r))));
  }
}

function codexDelta(client: FakeCodexClient, turnId: string, itemId: string, delta: string): void {
  client.emit({
    method: "item/agentMessage/delta",
    params: { turnId, itemId, delta },
  });
}

function makeCodexProbe(): SessionProbe {
  const client = new FakeCodexClient();
  const events: AgentEvent[] = [];
  const session = new CodexAgentSession(
    client as never,
    { provider: "codex" } as never,
    {},
    "sess-conf-codex",
  );
  session.subscribe((e) => events.push(e));
  let permSeq = 0;

  return {
    name: "codex",
    session,
    events,
    expectsTurnStarted: true,
    // CodexAgentSession forwards trailing item events under the still-bound
    // (old) gatewayTurnId; the gateway drops post-terminal traffic.
    postTerminalDelta: "old-turn-id",

    async openTurn(gatewayTurnId) {
      // bindTurn emits turn.started synchronously during startTurn.
      const res = await session.startTurn(inputFor(gatewayTurnId));
      return { gatewayTurnId, providerTurnId: res.providerTurnId };
    },

    async streamTurnContent(handle) {
      const pt = handle.providerTurnId!;
      client.emit({
        method: "turn/started",
        params: { turn: { id: pt, status: "inProgress" } },
      });
      codexDelta(client, pt, `m-${handle.gatewayTurnId}`, "Hel");
      codexDelta(client, pt, `m-${handle.gatewayTurnId}`, "lo");
      client.emit({
        method: "item/completed",
        params: {
          turnId: pt,
          item: { id: `m-${handle.gatewayTurnId}`, type: "agentMessage", text: "Hello" },
        },
      });
      await flush();
    },

    async finishTurn(handle) {
      client.emit({
        method: "turn/completed",
        params: { turn: { id: handle.providerTurnId, status: "completed" } },
      });
      await vi.waitFor(() => {
        expect(
          events.some(
            (e) => e.type === "turn.completed" && turnIdOf(e) === handle.gatewayTurnId,
          ),
        ).toBe(true);
      });
    },

    async trailingDelta(handle) {
      codexDelta(client, handle.providerTurnId!, `m-${handle.gatewayTurnId}`, "!");
      await flush();
    },

    async requestPermission(handle) {
      permSeq += 1;
      const requestId = `rpc-conf-${permSeq}`;
      const providerAck = client.serverRequest({
        id: requestId,
        method: "item/tool/requestUserInput",
        params: {
          turnId: handle.providerTurnId,
          itemId: `req-${permSeq}`,
          questions: [
            {
              id: "q1",
              question: "Allow this action?",
              options: [
                { id: "allow", label: "Allow" },
                { id: "deny", label: "Deny" },
              ],
            },
          ],
        },
      });
      await vi.waitFor(() => {
        expect(
          session.getPendingPermissions().some((p) => p.requestId === requestId),
        ).toBe(true);
      });
      const request = session
        .getPendingPermissions()
        .find((p) => p.requestId === requestId)!;
      return { request, providerAck };
    },

    async close() {
      await session.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Claude adapter probe — ClaudeAgentSession over FakeQuery (SDK seam)
// ---------------------------------------------------------------------------

class FakeQuery {
  readonly messages: unknown[] = [];
  interrupted = false;
  closed = false;
  capturedOptions: Options | null = null;
  lastUuid = "";
  private readonly waiters: Array<() => void> = [];

  async *[Symbol.asyncIterator]() {
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
      session_id: "sess-conf",
      user_message_uuid: this.lastUuid,
      result: "",
    });
    return Promise.resolve();
  }

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

function makeClaudeProbe(): SessionProbe {
  const events: AgentEvent[] = [];
  let queryInstance: FakeQuery | null = null;
  const session = new ClaudeAgentSession(
    { provider: "claude" } as never,
    { cwd: "/tmp" } as never,
    "sess-conf-claude",
    {
      queryFactory: ({ prompt, options }) => {
        const q = new FakeQuery();
        q.capturedOptions = options;
        queryInstance = q;
        // consume the prompt stream; stamp each user message's uuid so
        // externally emitted SDK frames correlate to the bound turn.
        void (async () => {
          for await (const m of prompt as AsyncIterable<SDKUserMessage>) {
            q.lastUuid = m.uuid;
          }
        })();
        return q as unknown as Query;
      },
    },
  );
  session.subscribe((e) => events.push(e));
  let permSeq = 0;

  function query(): FakeQuery {
    if (!queryInstance) throw new Error("claude query not started");
    return queryInstance;
  }

  function sdkFrame(msg: Record<string, unknown>): void {
    query().emit({ session_id: "sess-conf", ...msg });
  }

  return {
    name: "claude",
    session,
    events,
    expectsTurnStarted: false,
    // ClaudeEventMapper drops frames for a turn after sawTerminal.
    postTerminalDelta: "dropped",

    async openTurn(gatewayTurnId) {
      const res = await session.startTurn(inputFor(gatewayTurnId));
      // wait until the prompt consumer stamped the turn uuid
      await vi.waitFor(() => {
        expect(queryInstance).not.toBeNull();
        expect(queryInstance!.lastUuid).toBe(res.providerTurnId);
      });
      return { gatewayTurnId, providerTurnId: res.providerTurnId };
    },

    async streamTurnContent(handle) {
      const uuid = handle.providerTurnId!;
      for (const text of ["Hel", "lo"]) {
        sdkFrame({
          type: "stream_event",
          user_message_uuid: uuid,
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text },
          },
        });
      }
      sdkFrame({
        type: "assistant",
        user_message_uuid: uuid,
        parent_tool_use_id: null,
        message: { content: [{ type: "text", text: "Hello" }] },
      });
      // claude emits assistant.message only at result time; the durable
      // signal that streamed content landed is the second delta.
      await vi.waitFor(() => {
        const deltas = events.filter(
          (e) =>
            (e.type === "assistant.delta" || e.type === "reasoning.delta") &&
            turnIdOf(e) === handle.gatewayTurnId,
        );
        expect(deltas.length).toBeGreaterThanOrEqual(2);
      });
    },

    async finishTurn(handle) {
      sdkFrame({
        type: "result",
        subtype: "success",
        is_error: false,
        user_message_uuid: handle.providerTurnId,
        result: "Hello",
        usage: { input_tokens: 3, output_tokens: 2 },
      });
      await vi.waitFor(() => {
        expect(
          events.some(
            (e) => e.type === "turn.completed" && turnIdOf(e) === handle.gatewayTurnId,
          ),
        ).toBe(true);
      });
    },

    async trailingDelta(handle) {
      sdkFrame({
        type: "stream_event",
        user_message_uuid: handle.providerTurnId,
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "!" },
        },
      });
      await flush(5);
    },

    async requestPermission(handle) {
      permSeq += 1;
      const q = query();
      const canUseTool = (
        q.capturedOptions as {
          canUseTool?: (
            name: string,
            input: Record<string, unknown>,
            opts: { toolUseID: string },
          ) => Promise<unknown>;
        }
      ).canUseTool;
      expect(canUseTool).toBeTypeOf("function");
      const providerAck = canUseTool!(
        "Bash",
        { command: "ls" },
        { toolUseID: `tu-conf-${permSeq}` },
      );
      await vi.waitFor(() => {
        expect(session.getPendingPermissions().length).toBe(1);
      });
      const request = session.getPendingPermissions()[0]!;
      // permission.requested should carry the bound gateway turnId
      const ev = events.find(
        (e) => e.type === "permission.requested" && e.request.requestId === request.requestId,
      );
      expect(ev).toBeDefined();
      void handle;
      return { request, providerAck };
    },

    async close() {
      await session.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Shared conformance suite
// ---------------------------------------------------------------------------

const ADAPTERS: Array<{ label: string; make: () => SessionProbe }> = [
  { label: "codex", make: makeCodexProbe },
  { label: "claude", make: makeClaudeProbe },
];

for (const adapter of ADAPTERS) {
  describe(`AgentSession shared invariants: ${adapter.label}`, () => {
    test("turn lifecycle ordering + monotonic deltaOffset", async () => {
      const probe = adapter.make();
      const h1 = await probe.openTurn("gt-1");
      await probe.streamTurnContent(h1);
      await probe.finishTurn(h1);

      assertTurnLifecycle(probe.events, "gt-1", probe.expectsTurnStarted);

      // every turn-scoped event belongs to the gateway turnId, never the
      // provider turnId (§4.4.1 identity separation)
      for (const e of probe.events) {
        const tid = turnIdOf(e);
        if (tid !== undefined) expect(tid).toBe("gt-1");
      }
      await probe.close();
    });

    test("permission.requested carries requestId+options; respond resolves pending", async () => {
      const probe = adapter.make();
      const h = await probe.openTurn("gt-p");
      await probe.streamTurnContent(h);

      const { request, providerAck } = await probe.requestPermission(h);
      expect(typeof request.requestId).toBe("string");
      expect(request.requestId.length).toBeGreaterThan(0);
      expect(request.kind).toBe("provider_permission");
      expect(Array.isArray(request.options)).toBe(true);
      expect(request.options.length).toBeGreaterThan(0);
      expect(
        probe.events.some(
          (e) =>
            e.type === "permission.requested" &&
            e.request.requestId === request.requestId,
        ),
      ).toBe(true);
      expect(
        probe.session.getPendingPermissions().map((p) => p.requestId),
      ).toContain(request.requestId);

      const allow = request.options.find((o) => o.kind !== "deny") ?? request.options[0]!;
      const res = await probe.session.respondToPermission(request.requestId, {
        requestId: request.requestId,
        optionId: allow.id,
      });
      expect(res).toBeDefined();
      expect(probe.session.getPendingPermissions()).toHaveLength(0);
      expect(
        probe.events.some(
          (e) => e.type === "permission.resolved" && e.requestId === request.requestId,
        ),
      ).toBe(true);
      // the provider-side request must actually resolve (no hung RPC/SDK call)
      await expect(providerAck).resolves.toBeDefined();

      await probe.finishTurn(h);
      await probe.close();
    });

    test("second startTurn after terminal binds a new turnId cleanly", async () => {
      const probe = adapter.make();
      const h1 = await probe.openTurn("gt-a");
      await probe.streamTurnContent(h1);
      await probe.finishTurn(h1);

      const h2 = await probe.openTurn("gt-b");
      expect(h2.providerTurnId).toBeTruthy();
      expect(h2.providerTurnId).not.toBe(h1.providerTurnId);
      await probe.streamTurnContent(h2);
      await probe.finishTurn(h2);

      assertTurnLifecycle(probe.events, "gt-a", probe.expectsTurnStarted);
      assertTurnLifecycle(probe.events, "gt-b", probe.expectsTurnStarted);

      // no gt-a events may appear after gt-b's lifecycle begins — the old
      // turn is fully sealed, never re-emitted under the new binding.
      const firstB = probe.events.findIndex((e) => turnIdOf(e) === "gt-b");
      expect(firstB).toBeGreaterThan(-1);
      const leaked = probe.events
        .slice(firstB)
        .filter((e) => turnIdOf(e) === "gt-a");
      expect(leaked).toEqual([]);
      // exactly one terminal per turn across the whole session
      expect(snapshotTurn(probe.events, "gt-a").terminalCount).toBe(1);
      expect(snapshotTurn(probe.events, "gt-b").terminalCount).toBe(1);
      await probe.close();
    });

    test("post-terminal provider frames are not re-emitted under another turnId", async () => {
      const probe = adapter.make();
      const h1 = await probe.openTurn("gt-t1");
      await probe.streamTurnContent(h1);
      await probe.finishTurn(h1);
      const before = probe.events.length;

      await probe.trailingDelta(h1);

      if (probe.postTerminalDelta === "dropped") {
        // claude: sawTerminal gate — nothing may be emitted at all
        expect(probe.events.length).toBe(before);
      } else {
        // codex: trailing deltas still surface but ONLY under the old
        // gatewayTurnId (gateway owns the post-terminal drop); nothing may
        // be attributed to a turn that does not exist yet.
        const late = probe.events.slice(before);
        for (const e of late) {
          const tid = turnIdOf(e);
          if (tid !== undefined) expect(tid).toBe("gt-t1");
        }
        // and no durable lifecycle event may be resurrected
        expect(late.filter((e) => LIFECYCLE_TYPES.has(e.type))).toEqual([]);
      }
      await probe.close();
    });
  });
}
