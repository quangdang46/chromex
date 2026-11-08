/**
 * S3 (chromex-7k3): two concurrent tasks on different tabs must not
 * cross-contaminate. Live-ish scenario — a real BrowserToolServer with
 * per-task tokens, a fake host that mirrors the extension host's
 * resolveScopedTabId enforcement (tool-host.ts), and the real
 * InMemoryStore for the event/approval surfaces.
 *
 * Proves:
 *  - task A cannot act on task B's tab (browser.not_in_scope, pre-dispatch)
 *  - tabScope payloads carry correct allowed/foreign sets per task
 *  - implicit (no args.tabId) targets resolve each task's OWN bound tab
 *  - tab.activate / tab.close on a foreign tab are rejected
 *  - a concurrent first-bind race cannot record a false success
 *  - durable events and approval rows stay on their own task stream
 */

import { describe, expect, it } from "vitest";

import type { TaskRecord } from "@codex-sidepanel/shared";

import { ToolTokenManager } from "../../src/browser/tool-token.js";
import { BrowserToolServer, type ToolCallRequest, type ToolHostChannel } from "../../src/browser/tool-server.js";
import { InMemoryStore } from "../../src/gateway/store-memory.js";

const SECRET = "ef".repeat(32);
const NOW = 1_700_000_000_000;
const PROFILE = "profile-1";
const INSTANCE = "bi-1";

const ALL_TOOLS = [
  "browser.tabs.list",
  "browser.tab.activate",
  "browser.tab.close",
  "browser.page.snapshot",
  "browser.page.get",
  "browser.page.click",
  "browser.page.navigate",
  "browser.page.fill",
];

function coded(code: string, message: string): Error {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e;
}

interface FakeTab {
  id: number;
  url: string;
}

interface DispatchedCall {
  taskId: string;
  tool: string;
  args: Record<string, unknown>;
  tabScope: { boundTabId: number | null; allowedTabIds: number[]; foreignTabIds: number[] } | null;
}

/** Fake extension host: two tabs (7 = task A's, 9 = task B's), one
 *  active tab, and the SAME scope semantics as tool-host.ts
 *  resolveScopedTabId — explicit tabId → bound tab → active tab, then
 *  allowed-set / foreign-set enforcement. */
function makeFakeHost(tabs: FakeTab[] = [{ id: 7, url: "https://a.example" }, { id: 9, url: "https://b.example" }]) {
  const state = { activeTabId: 7 as number | null };
  const dispatched: DispatchedCall[] = [];
  const activated: number[] = [];
  const closed: number[] = [];

  const resolveScoped = (
    args: Record<string, unknown>,
    scope: DispatchedCall["tabScope"],
  ): number => {
    const explicit = typeof args.tabId === "number" ? args.tabId : null;
    if (scope && explicit === null && scope.boundTabId == null) {
      const inScope = new Set(scope.allowedTabIds);
      if (inScope.size > 1) {
        throw coded("browser.ambiguous_target", "multiple in-scope tabs, no bound default");
      }
    }
    const candidate =
      explicit ?? scope?.boundTabId ?? state.activeTabId;
    if (candidate === null) throw coded("browser.no_tab", "no active tab");
    if (scope) {
      const allowed = new Set(scope.allowedTabIds);
      if (scope.boundTabId != null) allowed.add(scope.boundTabId);
      if (allowed.size > 0) {
        if (!allowed.has(candidate)) {
          throw coded("browser.not_in_scope", `tab ${candidate} outside task scope`);
        }
      } else if (scope.foreignTabIds.includes(candidate)) {
        throw coded("browser.not_in_scope", `tab ${candidate} bound to another task`);
      }
    }
    return candidate;
  };

  const channel: ToolHostChannel = {
    hostInstanceId: "host-1",
    profileId: PROFILE,
    send: (method, payload) => {
      if (method !== "browser.tool.request") return Promise.resolve({ ok: true });
      const p = payload as {
        toolCallId: string;
        taskId: string;
        tool: string;
        args: Record<string, unknown>;
        tabScope?: DispatchedCall["tabScope"];
      };
      dispatched.push({
        taskId: p.taskId,
        tool: p.tool,
        args: p.args,
        tabScope: p.tabScope ?? null,
      });
      const run = (): unknown => {
        const tabId = resolveScoped(p.args, p.tabScope ?? null);
        switch (p.tool) {
          case "browser.tab.activate":
            activated.push(tabId);
            state.activeTabId = tabId;
            return { activated: tabId, resolvedTabId: tabId };
          case "browser.tab.close":
            closed.push(tabId);
            const i = tabs.findIndex((t) => t.id === tabId);
            if (i >= 0) tabs.splice(i, 1);
            if (state.activeTabId === tabId) state.activeTabId = tabs[0]?.id ?? null;
            return { closed: tabId, resolvedTabId: tabId };
          case "browser.page.snapshot":
            return {
              snapshotId: `snap:${p.taskId}:${tabId}`,
              elements: [],
              resolvedTabId: tabId,
            };
          case "browser.page.get": {
            const tab = tabs.find((t) => t.id === tabId);
            if (!tab) throw coded("browser.no_tab", `tab ${tabId} not found`);
            return { id: tab.id, url: tab.url, title: "", active: state.activeTabId === tabId, resolvedTabId: tabId };
          }
          default:
            return { ok: true, resolvedTabId: tabId };
        }
      };
      try {
        return Promise.resolve(run());
      } catch (e) {
        return Promise.reject(e);
      }
    },
    onDisconnect: () => {},
  };
  return {
    channel,
    dispatched,
    activated,
    closed,
    tabs,
    setActive: (id: number | null) => {
      state.activeTabId = id;
    },
  };
}

function makeWorld(over: { store?: InMemoryStore } = {}) {
  const tokens = ToolTokenManager.forTest(SECRET);
  const { token: tokenA } = tokens.issue({
    taskId: "task-a",
    profileId: PROFILE,
    backendId: "chrome-extension",
    allowedTools: ALL_TOOLS,
    now: NOW,
  });
  const { token: tokenB } = tokens.issue({
    taskId: "task-b",
    profileId: PROFILE,
    backendId: "chrome-extension",
    allowedTools: ALL_TOOLS,
    now: NOW,
  });

  const host = makeFakeHost();
  const store = over.store ?? new InMemoryStore();
  // onClassified/requestApproval append durable events — tasks must exist
  putTask(store, "task-a");
  putTask(store, "task-b");
  const approvals: Array<{ taskId: string; tool: string; approvalId?: string }> = [];
  const resolveHostCalls: string[] = [];

  const server = new BrowserToolServer({
    tokens,
    resolveHost: (taskId) => {
      resolveHostCalls.push(taskId);
      return host.channel;
    },
    now: () => NOW,
    requestApproval: async (tctx) => {
      approvals.push({ taskId: tctx.taskId, tool: tctx.tool });
      // mirror gateway/main.ts: durable row on the OWNING task
      const approvalId = `appr-${tctx.taskId}-${approvals.length}`;
      (store as unknown as { insertApproval?: (r: Record<string, unknown>) => void }).insertApproval?.({
        approvalId,
        taskId: tctx.taskId,
        request: { requestId: approvalId, taskId: tctx.taskId, tool: tctx.tool },
        actionDigest: tctx.actionDigest,
        status: "pending",
        createdAt: NOW,
      });
      (store as unknown as { appendTaskEvent?: (id: string, e: unknown) => unknown }).appendTaskEvent?.(
        tctx.taskId,
        {
          type: "permission.requested",
          request: {
            requestId: approvalId,
            taskId: tctx.taskId,
            kind: tctx.kind,
            risk: tctx.risk,
            summary: `${tctx.tool} requires approval`,
            actionDigest: tctx.actionDigest,
            details: { tool: tctx.tool, argsPreview: {}, origin: "" },
            options: [{ id: "allow_once", label: "Allow once", kind: "allow_once" }],
          },
        },
      );
      // leave the row PENDING — the test asserts per-task pending lists
      return { verdict: "approved" as const, optionId: "allow_once" };
    },
    onClassified: (taskId, actx, v) => {
      (store as unknown as { appendTaskEvent?: (id: string, e: unknown) => unknown }).appendTaskEvent?.(taskId, {
        type: "browser.tool.classified",
        action: actx.action,
        risk: v.risk,
        needsApproval: v.needsApproval,
        reason: v.reason,
      });
    },
    onOutcome: () => {},
  });

  let seq = 0;
  const call = (taskId: "task-a" | "task-b", token: string, over: Partial<ToolCallRequest> = {}) =>
    server.execute({
      toolCallId: `tc-${taskId}-${++seq}`,
      taskId,
      profileId: PROFILE,
      backendId: "chrome-extension",
      browserInstanceId: INSTANCE,
      tool: "browser.page.snapshot",
      args: {},
      token,
      ...over,
    });

  return { server, tokenA, tokenB, host, store, approvals, resolveHostCalls, call };
}

function putTask(store: InMemoryStore, taskId: string): void {
  const now = Date.now();
  store.putTask({
    taskId,
    createdAt: now,
    updatedAt: now,
    status: "active",
    profileId: PROFILE,
    providerId: "codex",
    conversationKey: `conv-${taskId}`,
    cwd: "/tmp",
    backend: { backendId: "chrome-extension", pinnedBy: "default" },
    tabIntent: { scope: "untitled" },
    binding: { browserInstanceId: INSTANCE, state: "ok" },
    lastSeq: 0,
    lastReadSeq: 0,
  } as TaskRecord);
}

describe("S3: two concurrent tasks on different tabs (chromex-7k3)", () => {
  it("each task binds its own tab; scope payloads list the other task's tab as foreign", async () => {
    const w = makeWorld();
    const a1 = await w.call("task-a", w.tokenA, { args: { tabId: 7 } });
    const b1 = await w.call("task-b", w.tokenB, { args: { tabId: 9 } });
    expect(a1.status).toBe("completed");
    expect(b1.status).toBe("completed");

    // interleave subsequent calls — payloads must reflect BOTH binds
    await w.call("task-a", w.tokenA, { args: { tabId: 7 }, tool: "browser.page.get" });
    await w.call("task-b", w.tokenB, { args: { tabId: 9 }, tool: "browser.page.get" });

    const scopeA = w.host.dispatched.find((d) => d.taskId === "task-a" && d.tool === "browser.page.get")!
      .tabScope!;
    const scopeB = w.host.dispatched.find((d) => d.taskId === "task-b" && d.tool === "browser.page.get")!
      .tabScope!;
    expect(scopeA).toMatchObject({ boundTabId: 7, allowedTabIds: [7], foreignTabIds: [9] });
    expect(scopeB).toMatchObject({ boundTabId: 9, allowedTabIds: [9], foreignTabIds: [7] });
    // host affinity: every dispatch for a task resolved to the same host
    expect(w.resolveHostCalls).toContain("task-a");
    expect(w.resolveHostCalls).toContain("task-b");
  });

  it("task A cannot act on task B's tab — explicit tabId denied pre-dispatch, incl. activate/close", async () => {
    const w = makeWorld();
    await w.call("task-a", w.tokenA, { args: { tabId: 7 } });
    await w.call("task-b", w.tokenB, { args: { tabId: 9 } });
    const before = w.host.dispatched.length;
    const approvalsBefore = w.approvals.length;

    for (const [tool, args] of [
      ["browser.page.click", { tabId: 9, ref: "e1", label: "Go" }],
      ["browser.tab.activate", { tabId: 9 }],
      ["browser.tab.close", { tabId: 9 }],
      ["browser.page.snapshot", { tabId: 9 }],
    ] as const) {
      const out = await w.call("task-a", w.tokenA, { tool, args });
      expect(out.status).toBe("failed");
      expect(out.error?.code).toBe("browser.not_in_scope");
    }
    // nothing reached the host; no approval was requested for denied scope
    expect(w.host.dispatched.length).toBe(before);
    expect(w.host.activated).toEqual([]);
    expect(w.host.closed).toEqual([]);
    expect(w.approvals.length).toBe(approvalsBefore);
    // and B's tab is untouched
    expect(w.host.tabs.map((t) => t.id).sort()).toEqual([7, 9]);
  });

  it("implicit targets resolve each task's own bound tab — never the shared active tab", async () => {
    const w = makeWorld();
    await w.call("task-a", w.tokenA, { args: { tabId: 7 } });
    await w.call("task-b", w.tokenB, { args: { tabId: 9 } });
    // make B's tab the ACTIVE tab — A's implicit call must still hit 7
    w.host.setActive(9);
    const aSnap = await w.call("task-a", w.tokenA);
    const bSnap = await w.call("task-b", w.tokenB);
    expect(aSnap.status).toBe("completed");
    expect(bSnap.status).toBe("completed");
    const aCall = w.host.dispatched.at(-2)!;
    const bCall = w.host.dispatched.at(-1)!;
    expect(aCall.taskId).toBe("task-a");
    expect(aCall.tabScope?.boundTabId).toBe(7);
    expect(bCall.tabScope?.boundTabId).toBe(9);
    // snapshot results report the resolved (own) tab
    expect((aSnap.result as { resolvedTabId: number }).resolvedTabId).toBe(7);
    expect((bSnap.result as { resolvedTabId: number }).resolvedTabId).toBe(9);
  });

  it("once task A owns the active tab, task B's implicit call cannot adopt it", async () => {
    const w = makeWorld();
    await w.call("task-a", w.tokenA); // unbound → active tab 7 → A binds it
    // B still unbound; active tab is now A's. B's implicit call ships an
    // empty-scope payload listing 7 as foreign → host refuses.
    const bImplicit = await w.call("task-b", w.tokenB);
    expect(bImplicit.status).toBe("failed");
    expect(bImplicit.error?.code).toBe("browser.not_in_scope");
    // B can still bind a DIFFERENT free tab explicitly
    const bBind = await w.call("task-b", w.tokenB, { args: { tabId: 9 } });
    expect(bBind.status).toBe("completed");
  });

  it("concurrent first-bind race: the loser gets browser.not_in_scope, never a false success", async () => {
    const w = makeWorld();
    // park host sends so both tasks dispatch BEFORE either result lands —
    // both scope payloads are computed while tab 7 is still unowned.
    const gate: Array<{ taskId: string; resolve: () => void }> = [];
    const origSend = w.host.channel.send;
    w.host.channel.send = (method, payload) => {
      if (method !== "browser.tool.request") return origSend(method, payload);
      const p = payload as { taskId: string };
      return new Promise((resolve, reject) => {
        gate.push({
          taskId: p.taskId,
          // emulate the host having acted on the (then-current) active tab
          resolve: () => origSend(method, payload).then(resolve, reject),
        });
      });
    };
    const pA = w.call("task-a", w.tokenA); // implicit → active tab 7
    const pB = w.call("task-b", w.tokenB); // implicit → active tab 7
    await new Promise((r) => setTimeout(r, 0));
    expect(gate).toHaveLength(2);
    const gateFor = (taskId: string) => gate.find((g) => g.taskId === taskId)!;
    // A's result lands first → A binds tab 7
    gateFor("task-a").resolve();
    const outA = await pA;
    expect(outA.status).toBe("completed");
    // B's result lands second → host resolved tab 7, but A owns it now
    gateFor("task-b").resolve();
    const outB = await pB;
    expect(outB.status).toBe("failed");
    expect(outB.error?.code).toBe("browser.not_in_scope");
    // B did NOT gain tab 7 — a later explicit attempt is denied pre-dispatch
    const dispatchedBefore = w.host.dispatched.length;
    const retry = await w.call("task-b", w.tokenB, { args: { tabId: 7 } });
    expect(retry.error?.code).toBe("browser.not_in_scope");
    expect(w.host.dispatched.length).toBe(dispatchedBefore);
  });

  it("durable events and approval rows stay on their own task", async () => {
    const store = new InMemoryStore();
    putTask(store, "task-a");
    putTask(store, "task-b");
    const w = makeWorld({ store });

    // mutating tools that require approval: click with a pay-ish label
    // (external_mutation) and tab.close (unclassified → fail-closed)
    const aClick = await w.call("task-a", w.tokenA, {
      tool: "browser.page.click",
      args: { tabId: 7, ref: "e1", label: "Pay now" },
    });
    const bClose = await w.call("task-b", w.tokenB, {
      tool: "browser.tab.close",
      args: { tabId: 9 },
    });
    expect(aClick.status).toBe("completed");
    expect(bClose.status).toBe("completed");
    expect(w.approvals.map((a) => a.taskId).sort()).toEqual(["task-a", "task-b"]);

    // approval rows are keyed by task_id — each task sees only its own
    const approvalsA = (store as unknown as { listApprovals: (id: string) => Array<{ request: { taskId?: string } }> }).listApprovals("task-a");
    const approvalsB = (store as unknown as { listApprovals: (id: string) => Array<{ request: { taskId?: string } }> }).listApprovals("task-b");
    expect(approvalsA).toHaveLength(1);
    expect(approvalsB).toHaveLength(1);
    expect(approvalsA[0]!.request.taskId).toBe("task-a");
    expect(approvalsB[0]!.request.taskId).toBe("task-b");
    expect(
      (store as unknown as { listPendingApprovals: (id: string) => unknown[] }).listPendingApprovals("task-a"),
    ).toHaveLength(1);
    expect(
      (store as unknown as { listPendingApprovals: (id: string) => unknown[] }).listPendingApprovals("task-b"),
    ).toHaveLength(1);
    expect(
      (store as unknown as { listPendingApprovals: (id: string) => unknown[] }).listPendingApprovals("task-c"),
    ).toHaveLength(0);

    // durable task streams: classified + permission.requested events for
    // each call landed on the OWNING task's stream only, seq from 1
    const eventsA = store.allTaskEvents("task-a");
    const eventsB = store.allTaskEvents("task-b");
    expect(eventsA.length).toBeGreaterThan(0);
    expect(eventsB.length).toBeGreaterThan(0);
    expect(eventsA.every((e) => e.taskId === "task-a" && e.stream === "task")).toBe(true);
    expect(eventsB.every((e) => e.taskId === "task-b" && e.stream === "task")).toBe(true);
    expect(eventsA[0]!.seq).toBe(1);
    expect(eventsB[0]!.seq).toBe(1);
    // task.sync replay window for A contains no B events
    const replayA = store.taskEventsAfter("task-a", 0);
    expect(replayA.events.every((e) => e.taskId === "task-a")).toBe(true);
    expect(replayA.events.some((e) => e.type === "permission.requested")).toBe(true);
  });
});

describe("TaskTabScope.bind on an already-scoped task", () => {
  it("acquires a second tab (tab.create) instead of reporting not_in_scope", async () => {
    const { TaskTabScope } = await import("../../src/browser/task-tab-scope.js");
    const scope = new TaskTabScope();
    const ns = "p chrome-ext bi-1";
    // task already bound tab 7, then creates tab 11
    expect(scope.bind("task-a", 7, ns)).toBe(true);
    expect(scope.bind("task-a", 11, ns)).toBe(true);
    expect(scope.payloadFor("task-a", ns).allowedTabIds.sort((a,b)=>a-b)).toEqual([7, 11]);
    // bound default stays the first tab
    expect(scope.payloadFor("task-a", ns).boundTabId).toBe(7);
    // a tab owned by another task still rejects
    expect(scope.bind("task-b", 9, ns)).toBe(true);
    expect(scope.bind("task-a", 9, ns)).toBe(false);
    // and pre-dispatch targeting stays strict: scoped task cannot aim
    // args.tabId at an unowned tab
    expect(scope.permits("task-a", 42, ns)).toBe(false);
  });
});
