import type { ProviderId } from "../agent/provider-id.js";
import type { AgentCapabilityFlags } from "../agent/capabilities.js";
import type { BrowserBackendId, BrowserBackendCapabilities } from "../browser/backend.js";
import type { BrowserBindingState } from "../browser/identity.js";
import type { TaskSnapshot } from "../tasks/snapshot.js";
import type { TaskStatus } from "../tasks/record.js";
import type { DurableTaskEventEnvelope, DurableGatewayEventEnvelope } from "./envelope.js";

/**
 * Handshake / sync contracts — plan §4.6.
 * These are RPC payloads, not events.
 */

export interface HelloRequest {
  clientVersion: string;
  protocolVersion: 1;
  clientId: string;
  /** stable for installation lifetime — may be lost on reinstall/reset */
  profileId: string;
  /** null ⇒ degraded identity mode (§3.2) */
  browserInstanceId: string | null;
  hostInstanceId: string;
  /** per-task durable cursors */
  lastSeqByTask?: Record<string, number>;
  /** gateway-stream cursor; absent ⇒ 0 */
  lastSeqByGateway?: number;
}

export interface HelloTaskSummary {
  taskId: string;
  profileId: string;
  status: TaskStatus;
  lastSeq: number;
  activeTurnId?: string | null;
  /** whether the browser binding is still valid for the browserInstanceId just sent */
  browserBinding: BrowserBindingState;
}

export interface HelloResponse {
  gatewayVersion: string;
  protocolVersion: 1;
  providers: Array<{ id: ProviderId; available: boolean; capabilities: AgentCapabilityFlags }>;
  backends: Array<{ id: BrowserBackendId; available: boolean; capabilities: BrowserBackendCapabilities }>;
  tasks: HelloTaskSummary[];
  /** one-time feature gating */
  features: Record<string, boolean>;
  tokenRotated?: boolean;
  /** newest seq on the gateway stream — client decides replay from it */
  gatewayLastSeq: number;
}

// ---- task stream sync ----

export interface TaskSyncRequest {
  taskId: string;
  fromSeq: number;
  maxEvents?: number;
}

export type TaskSyncResponse =
  // only stream="task" events of THIS taskId, seq > fromSeq, contiguous
  | {
      mode: "replay";
      stream: "task";
      taskId: string;
      events: DurableTaskEventEnvelope[];
      /** = lastSeqSentInThisBatch (NOT lastSeq+1); resend fromSeq=nextSeq */
      nextSeq: number;
      hasMore: boolean;
    }
  | { mode: "snapshot"; snapshot: TaskSnapshot; lastSeq: number };

export interface TaskSnapshotRequest {
  taskId: string;
}

// ---- gateway stream sync ----

export interface GatewaySyncRequest {
  fromSeq: number;
  maxEvents?: number;
}

export type GatewaySyncResponse =
  // only durable stream="gateway" events, seq > fromSeq
  | {
      mode: "replay";
      stream: "gateway";
      events: DurableGatewayEventEnvelope[];
      nextSeq: number;
      hasMore: boolean;
    }
  // client asked for a seq already pruned → jump to head
  | {
      mode: "head";
      lastSeq: number;
      snapshot?: { providers: HelloResponse["providers"]; backends: HelloResponse["backends"]; features: Record<string, boolean> };
    };
