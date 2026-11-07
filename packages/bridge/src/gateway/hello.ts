/**
 * Hello handshake — plan §4.6.
 *
 * Validates HelloRequest, enforces protocol major version, returns
 * HelloResponse with provider/backend availability, task summaries and
 * feature gates. Runs BEFORE markReady() so clients can sync cursors.
 */

import {
  DEFAULT_BACKEND_CAPABILITIES,
  protocolError,
} from "@codex-sidepanel/shared";
import type {
  HelloRequest,
  HelloResponse,
  HelloTaskSummary,
  BrowserBindingState,
} from "@codex-sidepanel/shared";

import type { GatewayConfig } from "./config.js";
import type { TaskRecord, TurnRecord } from "@codex-sidepanel/shared";

/** Minimal read surface both stores implement. */
export interface StoreRead {
  listTasks(): TaskRecord[];
  listTurns(taskId?: string): TurnRecord[];
  lastTaskSeq(taskId: string): number;
  lastGatewaySeq(): number;
}

export const GATEWAY_PROTOCOL_VERSION = 1;
export const GATEWAY_VERSION = "0.1.0";

export interface HelloDeps {
  store: StoreRead;
  config: GatewayConfig;
  /** provider availability resolved by registry (P1-04 fills real data) */
  providers: HelloResponse["providers"];
  /** extra feature gates beyond config defaults */
  features?: Record<string, boolean>;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function parseHelloRequest(payload: unknown): HelloRequest | { error: string } {
  const raw = asRecord(payload);
  if (!raw) return { error: "hello payload must be an object" };
  if (raw.protocolVersion !== GATEWAY_PROTOCOL_VERSION) {
    return { error: `unsupported protocolVersion ${String(raw.protocolVersion)}` };
  }
  if (typeof raw.clientVersion !== "string" || typeof raw.clientId !== "string") {
    return { error: "clientVersion and clientId are required" };
  }
  if (typeof raw.profileId !== "string" || typeof raw.hostInstanceId !== "string") {
    return { error: "profileId and hostInstanceId are required" };
  }
  const browserInstanceId =
    raw.browserInstanceId === null || raw.browserInstanceId === undefined
      ? null
      : typeof raw.browserInstanceId === "string"
        ? raw.browserInstanceId
        : undefined;
  if (browserInstanceId === undefined) {
    return { error: "browserInstanceId must be string or null" };
  }
  return {
    clientVersion: raw.clientVersion,
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    clientId: raw.clientId,
    profileId: raw.profileId,
    browserInstanceId,
    hostInstanceId: raw.hostInstanceId,
    ...(asRecord(raw.lastSeqByTask)
      ? {
          lastSeqByTask: Object.fromEntries(
            Object.entries(asRecord(raw.lastSeqByTask)!).filter(
              ([, v]) => typeof v === "number",
            ),
          ) as Record<string, number>,
        }
      : {}),
    ...(typeof raw.lastSeqByGateway === "number"
      ? { lastSeqByGateway: raw.lastSeqByGateway }
      : {}),
  };
}

export function buildHelloResponse(
  req: HelloRequest,
  deps: HelloDeps,
): HelloResponse {
  const tasks: HelloTaskSummary[] = deps.store.listTasks().map((t) => ({
    taskId: t.taskId,
    profileId: t.profileId,
    status: t.status,
    lastSeq: deps.store.lastTaskSeq(t.taskId),
    activeTurnId:
      deps.store
        .listTurns(t.taskId)
        .find((turn) => turn.status === "running" || turn.status === "queued")?.turnId ??
      null,
    // identity mismatch → needs_confirmation (§3.2), never auto-stale
    browserBinding: (t.binding.browserInstanceId === req.browserInstanceId
      ? t.binding.state
      : "needs_confirmation") as BrowserBindingState,
    backendId: t.backend.backendId,
  }));

  const allowed = new Set(deps.config.browser.allowedBackends);
  const backends = (
    ["chrome-extension", "playwright-isolated", "playwright-cdp"] as const
  )
    .filter((id) => allowed.has(id))
    .map((id) => ({
      id,
      available:
        id === "chrome-extension" ||
        (id !== "playwright-cdp" && deps.config.browser.playwright.enabledByUser),
      capabilities: DEFAULT_BACKEND_CAPABILITIES[id],
    }));

  return {
    gatewayVersion: GATEWAY_VERSION,
    protocolVersion: GATEWAY_PROTOCOL_VERSION,
    providers: deps.providers,
    backends,
    tasks,
    features: {
      gatewayV2: true,
      browserPolicyV2: false,
      ...(deps.features ?? {}),
    },
    gatewayLastSeq: deps.store.lastGatewaySeq(),
  };
}

export function helloError(err: { error: string }) {
  return protocolError("proto.invalid", err.error);
}
