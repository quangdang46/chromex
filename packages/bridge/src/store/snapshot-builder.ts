/**
 * TaskSnapshot builder — reconstructs the self-sufficient §4.6 view
 * from the durable task event stream + turns + approvals.
 *
 * Shared by SQLiteStore and InMemoryStore so both produce identical
 * snapshots. Never includes raw reasoning or full DOM snapshots;
 * tool inputs/outputs stay bounded (artifact refs preserved).
 */

import type {
  DurableTaskEventEnvelope,
  InlineTaskSnapshot,
  TaskSnapshotAssistantMessage,
  TaskSnapshotPermission,
  TaskSnapshotToolCall,
  TaskSnapshotTurn,
  TaskSnapshotUserMessage,
  TaskStatus,
} from "@codex-sidepanel/shared";
import type { TaskRecord, TurnRecord } from "@codex-sidepanel/shared";

export interface SnapshotSource {
  task: TaskRecord;
  turns: TurnRecord[];
  /** all durable task-stream envelopes, ascending seq */
  events: DurableTaskEventEnvelope[];
  /** approval rows for this task (request + decision + createdAt) */
  approvals: Array<{
    request: unknown;
    decision?: { optionId: string; kind: string; decidedAt: number } | null;
    status?: string;
    createdAt: number;
  }>;
  conversationState?: "opening" | "open" | "closed" | "stale";
  /** "archived_snapshot" when serving a compacted/archived task */
  rebuiltFrom?: "event_log" | "archived_snapshot";
  /** snapshot checkpoint: events ≤ this seq are already represented in
   *  `base` — skip re-extracting them (P1-11 prune correctness). */
  checkpointThroughSeq?: number;
  base?: Pick<
    InlineTaskSnapshot,
    "userMessages" | "assistantMessages" | "toolCalls" | "permissions" | "turnDiffs"
  >;
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** ~4KB bound for tool output kept in the snapshot — enough for command
 *  stdout tails/exit codes; oversized payloads keep only the artifact ref. */
const OUTPUT_SUMMARY_MAX_CHARS = 4096;

function boundOutputSummary(value: unknown): unknown {
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  if (s.length <= OUTPUT_SUMMARY_MAX_CHARS) return value;
  return {
    truncated: true,
    bytes: s.length,
    preview: `${s.slice(0, OUTPUT_SUMMARY_MAX_CHARS - 64)}…[truncated]`,
  };
}

export function buildSnapshotFromSource(src: SnapshotSource): InlineTaskSnapshot {
  const checkpointSeq = src.checkpointThroughSeq ?? 0;
  const userMessages: TaskSnapshotUserMessage[] = [
    ...(src.base?.userMessages ?? []),
  ];
  const assistantMessages: TaskSnapshotAssistantMessage[] = [
    ...(src.base?.assistantMessages ?? []),
  ];
  const toolCalls: TaskSnapshotToolCall[] = [...(src.base?.toolCalls ?? [])];
  const toolByCallId = new Map<string, TaskSnapshotToolCall>(
    toolCalls.map((c) => [c.toolCallId, c]),
  );
  const permissions: TaskSnapshotPermission[] = [
    ...(src.base?.permissions ?? []),
  ];
  const permissionByRequestId = new Map<string, TaskSnapshotPermission>(
    permissions.map((p) => [
      typeof (p.request as { requestId?: unknown }).requestId === "string"
        ? ((p.request as { requestId: string }).requestId)
        : "",
      p,
    ]),
  );
  // latest turn diff per turn — checkpoint base diffs merge under new events
  const turnDiffs = new Map<string, string>(
    (src.base?.turnDiffs ?? []).map((d) => [d.turnId, d.diff]),
  );

  for (const env of src.events) {
    if (env.seq <= checkpointSeq) continue; // covered by checkpoint
    const p = env.payload as Record<string, unknown>;
    const turnId = typeof p.turnId === "string" ? p.turnId : "";
    switch (env.type) {
      case "user.message.created": {
        const msg = asRecord(p.message);
        const clientMessageId =
          typeof p.clientMessageId === "string" ? p.clientMessageId : "";
        userMessages.push({
          turnId,
          clientMessageId,
          createdAt: env.ts,
          input: msg as unknown as TaskSnapshotUserMessage["input"],
          inputCompleteness: "full",
        });
        break;
      }
      case "assistant.message": {
        assistantMessages.push({
          turnId,
          createdAt: env.ts,
          text: typeof p.text === "string" ? p.text : "",
          ...(typeof p.assistantMessageRef === "string"
            ? { assistantMessageRef: p.assistantMessageRef }
            : {}),
        });
        break;
      }
      case "tool.started": {
        const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : "";
        if (!toolCallId || toolByCallId.has(toolCallId)) break;
        const call: TaskSnapshotToolCall = {
          turnId,
          toolCallId,
          tool: typeof p.tool === "string" ? p.tool : "unknown",
          source: p.source === "browser" ? "browser" : "provider",
          outcome: "unknown",
          ...(p.input !== undefined ? { inputSummary: p.input } : {}),
          ...(typeof p.inputArtifactRef === "string"
            ? { inputArtifactRef: p.inputArtifactRef }
            : {}),
        };
        toolCalls.push(call);
        toolByCallId.set(toolCallId, call);
        break;
      }
      case "tool.completed": {
        const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : "";
        const existing = toolByCallId.get(toolCallId);
        const outcome =
          p.outcome === "succeeded" || p.outcome === "failed" || p.outcome === "cancelled"
            ? p.outcome
            : "unknown";
        if (existing) {
          existing.outcome = outcome;
          if (p.source === "browser" || existing.source === "browser") {
            existing.source = "browser";
          }
          if (p.output !== undefined) existing.outputSummary = boundOutputSummary(p.output);
          if (p.outputArtifactRef) existing.outputArtifactRef = String(p.outputArtifactRef);
          if (p.verified)
            existing.verified = p.verified as NonNullable<TaskSnapshotToolCall["verified"]>;
        } else {
          const call: TaskSnapshotToolCall = {
            turnId,
            toolCallId,
            tool: typeof p.tool === "string" ? p.tool : "unknown",
            source: p.source === "browser" ? "browser" : "provider",
            outcome,
            ...(p.output !== undefined ? { outputSummary: boundOutputSummary(p.output) } : {}),
            ...(typeof p.outputArtifactRef === "string"
              ? { outputArtifactRef: p.outputArtifactRef }
              : {}),
            ...(p.verified
              ? { verified: p.verified as NonNullable<TaskSnapshotToolCall["verified"]> }
              : {}),
          };
          toolCalls.push(call);
          toolByCallId.set(toolCallId, call);
        }
        break;
      }
      case "tool.reconciled": {
        // Host-confirmed amendment of an `unknown` outcome — same merge
        // as tool.completed; seq ordering guarantees it lands after the
        // guess it corrects.
        const toolCallId = typeof p.toolCallId === "string" ? p.toolCallId : "";
        const existing = toolByCallId.get(toolCallId);
        const outcome =
          p.outcome === "succeeded" || p.outcome === "failed" || p.outcome === "cancelled"
            ? p.outcome
            : null;
        if (!existing || outcome === null) break;
        existing.outcome = outcome;
        if (p.output !== undefined) existing.outputSummary = boundOutputSummary(p.output);
        if (p.verified)
          existing.verified = p.verified as NonNullable<TaskSnapshotToolCall["verified"]>;
        break;
      }
      case "turn.diff.updated": {
        // keep the LATEST diff per turn — earlier diffs are superseded
        if (turnId && typeof p.diff === "string") turnDiffs.set(turnId, p.diff);
        break;
      }
      case "permission.requested": {
        const request = asRecord(p.request);
        const requestId = typeof request.requestId === "string" ? request.requestId : "";
        const perm: TaskSnapshotPermission = {
          request: request as unknown as TaskSnapshotPermission["request"],
          decision: null,
          createdAt: env.ts,
        };
        permissions.push(perm);
        if (requestId) permissionByRequestId.set(requestId, perm);
        break;
      }
      case "permission.resolved": {
        const requestId = typeof p.requestId === "string" ? p.requestId : "";
        const perm = permissionByRequestId.get(requestId);
        const decision = asRecord(p.decision);
        if (perm && typeof decision.optionId === "string") {
          perm.decision = {
            optionId: decision.optionId,
            kind: (typeof decision.kind === "string" ? decision.kind : "allow_once") as NonNullable<
              TaskSnapshotPermission["decision"]
            >["kind"],
            decidedAt: typeof decision.decidedAt === "number" ? decision.decidedAt : env.ts,
          };
        }
        break;
      }
      default:
        break;
    }
  }

  // approvals table rows not seen as events (edge) still count
  for (const row of src.approvals) {
    const request = asRecord(row.request);
    const requestId = typeof request.requestId === "string" ? request.requestId : "";
    if (requestId && permissionByRequestId.has(requestId)) continue;
    permissions.push({
      request: request as unknown as TaskSnapshotPermission["request"],
      decision: row.decision
        ? ({
            optionId: row.decision.optionId,
            kind: row.decision.kind,
            decidedAt: row.decision.decidedAt,
          } as TaskSnapshotPermission["decision"])
        : null,
      createdAt: row.createdAt,
    });
  }

  const turns: TaskSnapshotTurn[] = src.turns.map((t) => ({
    turnId: t.turnId,
    status: t.status,
    clientMessageId: t.clientMessageId,
    createdAt: t.createdAt,
    ...(t.queuedAt !== undefined ? { queuedAt: t.queuedAt } : {}),
    startedAt: t.startedAt,
    ...(t.endedAt !== undefined && t.endedAt !== null ? { endedAt: t.endedAt } : {}),
    ...(t.stopReason ? { stopReason: t.stopReason } : {}),
  }));

  const lastSeq = src.events.length ? src.events[src.events.length - 1]!.seq : 0;

  return {
    storage: { kind: "inline" },
    task: src.task,
    conversation: {
      sessionKey: src.task.conversationKey,
      provider: src.task.providerId,
      persistence: null,
      state: src.conversationState ?? "closed",
    },
    turns,
    userMessages,
    assistantMessages,
    toolCalls,
    permissions,
    turnDiffs: [...turnDiffs.entries()].map(([t, diff]) => ({ turnId: t, diff })),
    lastSeq,
    rebuiltFrom: src.rebuiltFrom ?? "event_log",
  };
}
