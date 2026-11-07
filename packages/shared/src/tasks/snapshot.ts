import type { TurnInput } from "../agent/turn-input.js";
import type { ToolOutcome, VerificationResult } from "../agent/events.js";
import type { PermissionRequest, PermissionDecision } from "../agent/permission.js";
import type { AgentPersistenceHandle } from "../agent/persistence.js";
import type { ProviderId } from "../agent/provider-id.js";
import type { TaskRecord, TurnRecord, TurnStatus } from "./record.js";

/**
 * TaskSnapshot — plan §4.6. Discriminated union on `storage.kind`.
 *
 * The snapshot must be SELF-SUFFICIENT to rebuild the conversation even
 * after event-log pruning: every user prompt, every assistant final
 * message, tool summaries+outcomes, permission history, turn lifecycle.
 * Never contains raw reasoning.
 */

export interface TaskSnapshotTurn {
  turnId: string;
  status: TurnStatus;
  clientMessageId: string;
  createdAt: number;
  queuedAt?: number;
  startedAt: number | null;
  endedAt?: number | null;
  stopReason?: string;
}

export interface TaskSnapshotUserMessage {
  turnId: string;
  clientMessageId: string;
  createdAt: number;
  /** normalized exactly as the provider received it */
  input: TurnInput;
  /** true = partially redacted; see redactedFields */
  redacted?: boolean;
  redactedFields?: string[];
  /** how faithfully the provider input can be reconstructed */
  inputCompleteness: "full" | "partial" | "text_only";
  toolCallIds?: string[];
}

export interface TaskSnapshotAssistantMessage {
  turnId: string;
  createdAt: number;
  /** may be empty when content lives in the artifact */
  text: string;
  assistantMessageRef?: string;
  sha256?: string;
  bytes?: number;
  /** true when original content is gone and artifact no longer exists */
  missing?: boolean;
}

export interface TaskSnapshotToolCall {
  turnId: string;
  toolCallId: string;
  tool: string;
  source: "provider" | "browser";
  outcome: ToolOutcome;
  verified?: VerificationResult;
  /** bounded normalized input — enough to understand what the call did */
  inputSummary?: unknown;
  inputArtifactRef?: string;
  inputMissing?: boolean;
  summary?: string;
  /** bounded (~4KB) normalized output — command stdout/exit codes etc.
   *  survive event-log pruning; large outputs keep only outputArtifactRef */
  outputSummary?: unknown;
  outputArtifactRef?: string;
  outputMissing?: boolean;
}

export interface TaskSnapshotPermission {
  request: PermissionRequest;
  decision: PermissionDecision | null;
  createdAt: number;
}

export interface TaskSnapshotConversation {
  sessionKey: string;
  provider: ProviderId;
  persistence: AgentPersistenceHandle | null;
  state: "opening" | "open" | "closed" | "stale";
}

/** Base payload shared by all snapshot transport forms. */
export interface TaskSnapshotData {
  task: TaskRecord;
  conversation: TaskSnapshotConversation;
  turns: TaskSnapshotTurn[];
  /** MANDATORY: every user prompt — never pruned from snapshot data */
  userMessages: TaskSnapshotUserMessage[];
  /** MANDATORY: every assistant final message (incl. artifact-backed) */
  assistantMessages: TaskSnapshotAssistantMessage[];
  /** tool call summary + outcome — the single name for "context/tool calls" */
  toolCalls: TaskSnapshotToolCall[];
  /** permission requests + decisions — SINGLE SOURCE (pendingApprovals derived) */
  permissions: TaskSnapshotPermission[];
  /** latest turn.diff.updated per turn — the deliverable diff survives
   *  event-log pruning (S8). Absent on pre-diff snapshots. */
  turnDiffs?: Array<{ turnId: string; diff: string }>;
  lastSeq: number;
  /** whether this snapshot was built after pruning, and what was lost */
  rebuiltFrom: "event_log" | "archived_snapshot";
  truncatedDeltas?: boolean;
}

export interface InlineTaskSnapshot extends TaskSnapshotData {
  storage: { kind: "inline" };
}

export interface ChunkedTaskSnapshotManifest {
  storage: {
    kind: "chunked";
    snapshotRef: string;
    chunkCount: number;
    totalBytes: number;
    snapshotSha256: string;
  };
  /** minimal metadata so UI can render before fetching everything */
  taskId: string;
  lastSeq: number;
  rebuiltFrom: "event_log" | "archived_snapshot";
}

export interface ArtifactTaskSnapshotManifest {
  storage: { kind: "artifact"; artifactRef: string; sha256: string; bytes: number };
  taskId: string;
  lastSeq: number;
  rebuiltFrom: "event_log" | "archived_snapshot";
}

/** TaskSnapshot union — chunked/artifact forms do NOT carry full data. */
export type TaskSnapshot = InlineTaskSnapshot | ChunkedTaskSnapshotManifest | ArtifactTaskSnapshotManifest;

// ---- chunk transport (plan §4.6) ----

export interface TaskSnapshotChunkRequest {
  taskId: string;
  snapshotRef: string;
  chunkIndex: number;
}

export interface TaskSnapshotChunkResponse {
  taskId: string;
  snapshotRef: string;
  chunkIndex: number;
  chunkCount: number;
  data: string;
  /** sha256 of THIS chunk */
  sha256: string;
  /** verify after reassembly */
  snapshotSha256: string;
}
