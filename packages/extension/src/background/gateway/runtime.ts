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

import type { Envelope } from "@codex-sidepanel/shared";

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
}

let runtime: GatewayRuntime | null = null;
let initPromise: Promise<GatewayRuntime | null> | null = null;

async function build(): Promise<GatewayRuntime | null> {
  const settings = await getStoredSettings();
  if (!settings.gatewayMode) return null;

  const identity = await loadOrCreateIdentity(chrome.storage.local);
  const listeners = new Set<(env: Envelope) => void>();

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
    onEvent: (env) => {
      if (env.kind === "event" && env.reliability === "durable" && env.stream === "task") {
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
  });

  // §11 reconnect flow: connect → hello seeds tasks → syncAll replays
  // durable events + rebuilds pruned snapshots. Lazy: runs once at
  // startup when the flag is on; failures leave client in
  // starting/unresponsive and the next request() retries.
  void client
    .connect()
    .then((hello) => tasks.onHello(hello))
    .then(() => tasks.syncAll())
    .catch(() => {
      /* connect failure is surfaced via client.state + next request retry */
    });

  return {
    client,
    tasks,
    state: () => client.state,
    request: (method, payload) => client.request(method, payload),
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
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
