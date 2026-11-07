import type { ProviderId } from "../agent/provider-id.js";
import type { ProtocolError } from "../protocol/errors.js";
import type { BrowserBackendId } from "../browser/backend.js";
import type { BrowserBindingState, TabIntent } from "../browser/identity.js";

export type TaskStatus = "queued" | "active" | "paused" | "completed" | "failed" | "cancelled";
export type TurnStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "unknown";

export type PauseReason =
  | "user_requested"
  | "gateway_restart"
  | "browser_unavailable"
  | "provider_unavailable";

/**
 * Derived attention — NEVER persisted as a column (plan §4.7).
 * Computed by Gateway when returning snapshots, from:
 * approvals pending → "approval_pending"
 * binding.needs_confirmation → "needs_tab_confirmation"
 * browser host offline → "browser_offline"
 * last turn failed → "error"
 * last turn terminal AND lastReadSeq < terminalSeq → "turn_finished" (unread)
 * else → null
 */
export type TaskAttention =
  | "approval_pending"
  | "turn_finished"
  | "error"
  | "browser_offline"
  | "needs_tab_confirmation";

export interface BackendBinding {
  /** pinned at task.create; never changes mid-turn */
  backendId: BrowserBackendId;
  pinnedBy: "user" | "policy" | "default";
  /** playwright context id when applicable */
  backendInstanceId?: string;
}

export interface TaskRecord {
  taskId: string;
  createdAt: number;
  updatedAt: number;
  status: TaskStatus;
  /** only when status='paused' — DB CHECK enforces paused ⇔ reason */
  pauseReason?: PauseReason | null;
  title?: string | null;
  /** stable for installation lifetime — NOT permanent security identity */
  profileId: string;
  providerId: ProviderId;
  /** logical provider session key */
  conversationKey: string;
  cwd: string;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  providerOptions?: Record<string, unknown> | null;
  backend: BackendBinding;
  /** durable user intent — runtime tabIds are never persisted here */
  tabIntent: TabIntent;
  /** identity at task creation — IMMUTABLE (P1.5) */
  originBrowserInstanceId?: string | null;
  /** current runtime binding — updated on reconnect, not identity */
  binding: {
    browserInstanceId: string | null;
    connectionId?: string;
    state: BrowserBindingState;
  };
  lastSeq: number;
  /** UI read cursor from ack{stream:"task"}; init 0; = snapshot.lastSeq on snapshot sync */
  lastReadSeq: number;
  error?: ProtocolError | null;
  /** §5.5 archive: compacted, not deleted — user messages preserved */
  archived?: boolean;
}

export interface TurnRecord {
  turnId: string;
  taskId: string;
  status: TurnStatus;
  clientMessageId: string;
  createdAt: number;
  queuedAt?: number;
  /** null while status='queued' — matches DDL CHECK */
  startedAt: number | null;
  endedAt?: number | null;
  stopReason?: string;
  error?: ProtocolError | null;
}
