import type { DurableAgentEvent } from "../agent/events.js";
import type { ProviderId } from "../agent/provider-id.js";
import type { PauseReason, TaskAttention, TaskStatus } from "./record.js";
import type { BackendBinding } from "./record.js";
import type { BrowserBindingState } from "../browser/identity.js";
import type { BrowserToolName } from "../browser/tool.js";
import type { RiskLevel } from "../browser/risk.js";
import type { ProtocolError } from "../protocol/errors.js";

/**
 * Task/Gateway event unions — plan §4.4.
 * `task.snapshot` is a RESPONSE, not an event.
 * `task.purged` is NOT a task-stream event (it would delete itself);
 * purge emits `gateway.task_purged` tombstone on the gateway stream.
 */

export type TaskEvent =
  | { type: "task.created"; taskId: string; profileId: string; providerId: ProviderId; backend: BackendBinding }
  | { type: "task.status_changed"; from: TaskStatus; to: TaskStatus; pauseReason?: PauseReason }
  | { type: "task.backend_changed"; from: BackendBinding; to: BackendBinding; by: "user" }
  | { type: "task.attention_changed"; attention: TaskAttention | null }
  | { type: "task.tab_binding"; state: BrowserBindingState; profileId: string; browserInstanceId: string | null }
  | { type: "task.completed" }
  | { type: "task.failed"; error: ProtocolError }
  | { type: "task.cancelled"; reason: string }
  // §4.8 audit: redacted ActionContext classification — args VALUES are
  // never logged, only classification + target metadata. Durable so the
  // approval/risk trail survives restart and event-log pruning.
  | {
      type: "browser.tool.classified";
      action: BrowserToolName | string;
      risk: RiskLevel;
      needsApproval: boolean;
      reason: string;
      origin: string | null;
      targetLabel: string | null;
      contextResolved: boolean;
      turnId?: string;
    };

export type TaskEventType = TaskEvent["type"];

/**
 * The SINGLE union for the task stream — used by envelope, task.sync,
 * event log, and snapshot alike. Never pick AgentEvent or TaskEvent alone.
 */
export type DurableTaskEvent = DurableAgentEvent | TaskEvent;
export type DurableTaskEventType = DurableTaskEvent["type"];

export type GatewayEvent =
  | { type: "gateway.started"; version: string; recoveredTurns: number; recoveredTasks: number }
  | { type: "gateway.restarted"; reason: "crash" | "user" | "update"; previousUptimeMs?: number }
  // EPHEMERAL: no seq, no persist, no replay. If audit needed → separate table.
  | { type: "gateway.notice"; level: "info" | "warn"; message: string; backpressure?: "deltas_dropped" }
  | { type: "gateway.provider.changed"; providerId: ProviderId; available: boolean; version?: string }
  | { type: "gateway.catalog.updated"; providerId: ProviderId; contentHash: string }
  // provider-global account lifecycle (chromex-fjr) — NOT task-scoped, so
  // it lives on the gateway stream. Name mirrors the legacy bridge event
  // (`account.login.completed`) so the extension translation is identity.
  | {
      type: "account.login.completed";
      providerId: ProviderId;
      loginId: string;
      success: boolean;
      error: string | null;
    }
  // replayable tombstone — the ONLY purge signal clients can rely on
  | { type: "gateway.task_purged"; taskId: string; purgedAt: number; reason: "user" | "retention" };

export type GatewayEventType = GatewayEvent["type"];

/** The ephemeral subset of GatewayEvent — sent via reliability:"ephemeral" envelope. */
export type GatewayNotice = Extract<GatewayEvent, { type: "gateway.notice" }>;

/** Durable gateway events — everything except the ephemeral notice. */
export type DurableGatewayEvent = Exclude<GatewayEvent, GatewayNotice>;
export type DurableGatewayEventType = DurableGatewayEvent["type"];

/** Which gateway events may be replayed from the durable stream. */
export const GATEWAY_EVENT_REPLAYABLE: ReadonlySet<GatewayEventType> = new Set([
  "gateway.started",
  "gateway.restarted",
  "gateway.provider.changed",
  "gateway.catalog.updated",
  "account.login.completed",
  "gateway.task_purged",
]);
