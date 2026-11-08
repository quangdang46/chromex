/**
 * Gateway runtime — plan §11 / P1-08 wiring.
 *
 * Lazily owns the GatewayClient + TaskController for the background
 * service worker. Enabled by `settings.gatewayMode` (default OFF —
 * rollback = flag off, legacy path untouched).
 *
 * The runtime only ADDS capability: agent-domain RPCs can go through
 * `request()`; legacy UI flows keep using `bridge` until P1-10 migrates
 * call sites. Durable gateway events are forwarded to subscribers.
 */

import type { Envelope, InlineTaskSnapshot } from "@codex-sidepanel/shared";

import { getStoredSettings } from "../storage.js";
import { GatewayClient, type GatewayConnectionState } from "./gateway-client.js";
import { loadOrCreateIdentity } from "./identity.js";
import { TaskController } from "./task-controller.js";

export interface GatewayRuntime {
  client: GatewayClient;
  tasks: TaskController;
  state(): GatewayConnectionState;
  request(method: string, payload?: unknown): Promise<unknown>;
  /** subscribe to gateway envelopes (events incl. task stream) */
  onEvent(listener: (env: Envelope) => void): () => void;
  /** subscribe to snapshot rebuilds (P1-10 UI resync) */
  onSnapshotRebuilt(listener: (taskId: string, snapshot: InlineTaskSnapshot) => void): () => void;
  /** resolves once hello + syncAll have seeded task views — await before
   *  reading tasks.* state on a cold SW (activeTurnId, statuses) */
  ready(): Promise<void>;
}

let runtime: GatewayRuntime | null = null;
let initPromise: Promise<GatewayRuntime | null> | null = null;

/** Server→client request handler (browser.tool.*). Registered by
 *  background/index.ts once it can execute tools; default rejects
 *  proto.unsupported — honest, never fakes a result. */
let serverRequestHandler: ((method: string, payload: unknown) => Promise<unknown>) | null = null;

export function setGatewayServerRequestHandler(
  fn: ((method: string, payload: unknown) => Promise<unknown>) | null,
): void {
  serverRequestHandler = fn;
}

/** Agent status badge (browser.action) — merged UNDER the attention
 *  count so a pending approval can never be hidden by agent text.
 *  ownerTaskId ties the badge to the task that set it: when that task
 *  reaches a terminal status (or disappears) the badge auto-clears —
 *  a stale "working" badge is the agent lying to the user. */
let agentBadge: { text: string; color?: string; title?: string; ownerTaskId?: string } | null = null;
let attentionCount = 0;

function renderBadge(): void {
  const pending = attentionCount;
  const text = pending > 0 ? String(pending) : agentBadge?.text ?? "";
  void chrome.action.setBadgeText({ text });
  if (pending > 0) {
    void chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
    void chrome.action.setTitle({ title: "Chromex tasks need attention" }).catch(() => undefined);
  } else if (agentBadge) {
    void chrome.action.setBadgeBackgroundColor({ color: agentBadge.color ?? "#5f6368" });
    void chrome.action
      .setTitle({ title: agentBadge.title ?? defaultActionTitle() })
      .catch(() => undefined);
  } else {
    // Nothing to show — badge text is already "" above, but a stale title
    // would survive an agentBadge clear or a service-worker restart.
    void chrome.action.setTitle({ title: defaultActionTitle() }).catch(() => undefined);
  }
}

function defaultActionTitle(): string {
  try {
    return chrome.runtime.getManifest?.().name ?? "Chromex";
  } catch {
    return "Chromex";
  }
}

const TERMINAL_TASK_STATUSES = new Set(["completed", "failed", "cancelled"]);

/** browser.action set/clear — writes the agent badge. Attention count
 *  takes precedence over agent text; clearing only removes agent text.
 *  ownerTaskId (the calling task) auto-clears the badge when that task
 *  finishes — pass undefined for a standing status that must be
 *  cleared explicitly. */
export function setAgentBadge(
  state: { text: string; color?: string; title?: string } | null,
  ownerTaskId?: string,
): void {
  agentBadge = state ? { ...state, ...(ownerTaskId ? { ownerTaskId } : {}) } : null;
  renderBadge();
}

async function build(): Promise<GatewayRuntime | null> {
  const settings = await getStoredSettings();
  if (!settings.gatewayMode) return null;

  const identity = await loadOrCreateIdentity(chrome.storage.local);
  const listeners = new Set<(env: Envelope) => void>();
  const snapshotListeners = new Set<(taskId: string, snapshot: InlineTaskSnapshot) => void>();

  // tasks is assigned before any hello can fire (connect is lazy —
  // first request triggers it, by which time `tasks` exists).
  let tasks!: TaskController;
  const client = new GatewayClient({
    hello: async () => ({
      protocolVersion: 1 as const,
      clientId: identity.clientId,
      profileId: identity.profileId,
      browserInstanceId: null, // host injects the B6-derived id
      hostInstanceId: "",
      ...tasks.helloCursors(),
    }),
    onRequest: async (method, payload) => {
      if (!serverRequestHandler) {
        const e = new Error(`no handler for ${method}`) as Error & { code?: string };
        e.code = "proto.unsupported";
        throw e;
      }
      return serverRequestHandler(method, payload);
    },
    onStateChange: (state) => {
      // Push backend health to the sidepanel (gateway-state badge).
      // sendMessage may be absent (tests) or have no receiver — never
      // let a notification failure kill the connect path.
      try {
        void chrome.runtime
          .sendMessage({ type: "gateway.state.changed", state })
          .catch(() => undefined);
      } catch {
        /* no sidepanel / stubbed runtime */
      }
    },
    onEvent: (env) => {
      // durable task + gateway streams both feed TaskController — the
      // gateway branch only advances lastSeqByGateway so live events are
      // not replayed by the next gateway.sync (chromex-fjr).
      if (
        env.kind === "event" &&
        env.reliability === "durable" &&
        (env.stream === "task" || env.stream === "gateway")
      ) {
        tasks.handleEvent(env as Parameters<TaskController["handleEvent"]>[0]);
      }
      for (const l of listeners) l(env);
    },
  });

  tasks = new TaskController({
    client,
    storage: chrome.storage.local,
    onTaskEvent: (_taskId, env) => {
      for (const l of listeners) l(env);
    },
    onGatewayEvent: (env) => {
      for (const l of listeners) l(env as Envelope);
    },
    onSnapshotRebuilt: (taskId, snapshot) => {
      for (const l of snapshotListeners) l(taskId, snapshot);
    },
    onTasksChanged: () => {
      // Attention badge: the whole point of gateway attention states is
      // telling a user who walked away that a task needs them (approval,
      // finished, error, browser offline). The sidepanel may be closed —
      // the action badge is the only always-visible surface. Count of
      // attention-bearing tasks; clears itself when attention resolves.
      try {
        attentionCount = tasks.listTasks().filter((t) => t.attention !== null).length;
        // Stale-badge guard: an owner-tasked badge dies with its task —
        // terminal status or the task vanishing entirely.
        if (agentBadge?.ownerTaskId) {
          const owner = tasks.listTasks().find((t) => t.taskId === agentBadge!.ownerTaskId);
          if (!owner || TERMINAL_TASK_STATUSES.has(owner.status)) {
            agentBadge = null;
          }
        }
        renderBadge();
      } catch {
        /* chrome.action unavailable (tests/stubbed runtime) */
      }
      try {
        void chrome.runtime
          .sendMessage({ type: "gateway.tasks.changed" })
          .catch(() => undefined);
      } catch {
        /* no sidepanel / stubbed runtime */
      }
    },
  });

  // §11 reconnect flow: connect → hello seeds tasks → syncAll replays
  // durable events + rebuilds pruned snapshots. Lazy: runs once at
  // startup when the flag is on; failures leave client in
  // starting/unresponsive and the next request() retries.
  const readyPromise = client
    .connect()
    .then((hello) => tasks.onHello(hello))
    .then(() => tasks.syncAll())
    .then(() => undefined)
    .catch(() => {
      /* connect failure is surfaced via client.state + next request retry */
    });
  void readyPromise;

  return {
    client,
    tasks,
    state: () => client.state,
    request: (method, payload) => client.request(method, payload),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onSnapshotRebuilt: (listener) => {
      snapshotListeners.add(listener);
      return () => snapshotListeners.delete(listener);
    },
    ready: () => readyPromise,
  };
}

/** Returns the gateway runtime when gatewayMode is on, else null. */
export async function getGatewayRuntime(): Promise<GatewayRuntime | null> {
  if (runtime) return runtime;
  if (!initPromise) {
    initPromise = build()
      .then((rt) => {
        runtime = rt;
        return rt;
      })
      .catch(() => null);
  }
  return initPromise;
}

/** Force re-read of the flag (settings changed). */
export function resetGatewayRuntime(): void {
  runtime?.client.close();
  runtime = null;
  initPromise = null;
}
