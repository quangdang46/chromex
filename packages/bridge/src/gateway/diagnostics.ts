/**
 * Gateway diagnostics — P2-08.
 *
 * In-memory metrics + live store/lock/endpoint state, surfaced via the
 * `diagnostics.snapshot` RPC. Everything here is counts, ids, seq
 * numbers and timings — never tokens, field values, or URLs — so the
 * snapshot is safe to return to any authed client and to log.
 */

import type { ToolCallOutcome } from "../browser/tool-server.js";

export interface DiagnosticsStoreView {
  listTasks(): Array<{ taskId: string }>;
  lastTaskSeq(taskId: string): number;
  lastGatewaySeq(): number;
}

export interface DiagnosticsLockView {
  /** lifetime lock currently held by this process */
  held: boolean;
  fence?: string;
}

export interface DiagnosticsEndpointView {
  /** IPC endpoint path clients connect to (no token material). */
  path: string;
  authedConnections: number;
}

export interface GatewayDiagnosticsSnapshot {
  at: number;
  uptimeMs: number;
  locks: { lifetime: DiagnosticsLockView; startup: DiagnosticsLockView | null };
  endpoint: DiagnosticsEndpointView | null;
  recovery: { turnsUnknown: number; tasksPaused: number; scannedAt: number } | null;
  streams: {
    gateway: { lastSeq: number };
    tasks: Array<{ taskId: string; lastSeq: number }>;
  };
  tools: {
    total: number;
    byStatus: Record<string, number>;
    byTool: Record<string, number>;
    /** execute() wall-time across finished calls — separates browser
     *  dispatch cost from model/MCP round-trips when reading a slow
     *  turn. Only calls that reached finish() with a start stamp count. */
    latencyMs: { count: number; total: number; max: number; last: number | null };
    /** subset of latencyMs spent inside the approval hook. */
    approvalWaitMs: { count: number; total: number; max: number; last: number | null };
  };
  approvals: {
    requested: number;
    resolved: number;
    latencyMs: { count: number; total: number; max: number; last: number | null };
  };
  /** wall-time from turn.started → terminal store status. Combined with
   *  tools.latencyMs this splits a slow turn into provider/model+MCP
   *  overhead vs measured browser execution. */
  turns: {
    total: number;
    byStatus: Record<string, number>;
    durationMs: { count: number; total: number; max: number; last: number | null };
  };
  deltas: { droppedTurns: number };
}

const MAX_TRACKED_TOOLS = 200;
const MAX_TRACKED_TASK_STREAMS = 500;

export class GatewayDiagnostics {
  private readonly startedAt = Date.now();
  private toolTotal = 0;
  private readonly toolByStatus = new Map<string, number>();
  private readonly toolByName = new Map<string, number>();
  private approvalsRequested = 0;
  private approvalsResolved = 0;
  private approvalLatencyTotal = 0;
  private approvalLatencyMax = 0;
  private approvalLatencyLast: number | null = null;
  private approvalLatencyCount = 0;
  private toolLatencyCount = 0;
  private toolLatencyTotal = 0;
  private toolLatencyMax = 0;
  private toolLatencyLast: number | null = null;
  private toolApprovalWaitCount = 0;
  private toolApprovalWaitTotal = 0;
  private toolApprovalWaitMax = 0;
  private toolApprovalWaitLast: number | null = null;
  private recovery: { turnsUnknown: number; tasksPaused: number; scannedAt: number } | null = null;
  private turnTotal = 0;
  private readonly turnByStatus = new Map<string, number>();
  private turnDurationCount = 0;
  private turnDurationTotal = 0;
  private turnDurationMax = 0;
  private turnDurationLast: number | null = null;
  private deltaDroppedTurns = 0;

  recordToolOutcome(outcome: ToolCallOutcome): void {
    this.toolTotal += 1;
    this.toolByStatus.set(outcome.status, (this.toolByStatus.get(outcome.status) ?? 0) + 1);
    this.toolByName.set(outcome.tool, (this.toolByName.get(outcome.tool) ?? 0) + 1);
    if (this.toolByName.size > MAX_TRACKED_TOOLS) {
      // bound memory: drop the coldest entries deterministically
      const excess = this.toolByName.size - MAX_TRACKED_TOOLS;
      let i = 0;
      for (const key of this.toolByName.keys()) {
        if (i++ >= excess) break;
        this.toolByName.delete(key);
      }
    }
    if (typeof outcome.durationMs === "number" && Number.isFinite(outcome.durationMs)) {
      this.toolLatencyCount += 1;
      this.toolLatencyTotal += outcome.durationMs;
      this.toolLatencyMax = Math.max(this.toolLatencyMax, outcome.durationMs);
      this.toolLatencyLast = outcome.durationMs;
    }
    if (
      typeof outcome.approvalWaitMs === "number" &&
      Number.isFinite(outcome.approvalWaitMs)
    ) {
      this.toolApprovalWaitCount += 1;
      this.toolApprovalWaitTotal += outcome.approvalWaitMs;
      this.toolApprovalWaitMax = Math.max(this.toolApprovalWaitMax, outcome.approvalWaitMs);
      this.toolApprovalWaitLast = outcome.approvalWaitMs;
    }
  }

  recordApprovalRequested(): void {
    this.approvalsRequested += 1;
  }

  /** ms from approval request → resolution (approved/denied/timeout). */
  recordApprovalLatency(ms: number): void {
    this.approvalsResolved += 1;
    this.approvalLatencyCount += 1;
    this.approvalLatencyTotal += ms;
    this.approvalLatencyMax = Math.max(this.approvalLatencyMax, ms);
    this.approvalLatencyLast = ms;
  }

  recordRecovery(turnsUnknown: number, tasksPaused: number): void {
    this.recovery = { turnsUnknown, tasksPaused, scannedAt: Date.now() };
  }

  /** turn.started → terminal store status wall-time (provider + MCP +
   *  tool dispatch + approvals all inside this window). */
  recordTurnTerminal(info: { status: string; durationMs: number }): void {
    this.turnTotal += 1;
    this.turnByStatus.set(info.status, (this.turnByStatus.get(info.status) ?? 0) + 1);
    if (Number.isFinite(info.durationMs) && info.durationMs >= 0) {
      this.turnDurationCount += 1;
      this.turnDurationTotal += info.durationMs;
      this.turnDurationMax = Math.max(this.turnDurationMax, info.durationMs);
      this.turnDurationLast = info.durationMs;
    }
  }

  recordDeltaDropped(): void {
    this.deltaDroppedTurns += 1;
  }

  snapshot(deps: {
    store: DiagnosticsStoreView;
    lifetime: DiagnosticsLockView;
    endpoint: DiagnosticsEndpointView | null;
  }): GatewayDiagnosticsSnapshot {
    const tasks = deps.store
      .listTasks()
      .slice(0, MAX_TRACKED_TASK_STREAMS)
      .map((t) => ({ taskId: t.taskId, lastSeq: deps.store.lastTaskSeq(t.taskId) }));
    return {
      at: Date.now(),
      uptimeMs: Date.now() - this.startedAt,
      locks: { lifetime: deps.lifetime, startup: null },
      endpoint: deps.endpoint,
      recovery: this.recovery,
      streams: {
        gateway: { lastSeq: deps.store.lastGatewaySeq() },
        tasks,
      },
      tools: {
        total: this.toolTotal,
        byStatus: Object.fromEntries(this.toolByStatus),
        byTool: Object.fromEntries(this.toolByName),
        latencyMs: {
          count: this.toolLatencyCount,
          total: this.toolLatencyTotal,
          max: this.toolLatencyMax,
          last: this.toolLatencyLast,
        },
        approvalWaitMs: {
          count: this.toolApprovalWaitCount,
          total: this.toolApprovalWaitTotal,
          max: this.toolApprovalWaitMax,
          last: this.toolApprovalWaitLast,
        },
      },
      approvals: {
        requested: this.approvalsRequested,
        resolved: this.approvalsResolved,
        latencyMs: {
          count: this.approvalLatencyCount,
          total: this.approvalLatencyTotal,
          max: this.approvalLatencyMax,
          last: this.approvalLatencyLast,
        },
      },
      turns: {
        total: this.turnTotal,
        byStatus: Object.fromEntries(this.turnByStatus),
        durationMs: {
          count: this.turnDurationCount,
          total: this.turnDurationTotal,
          max: this.turnDurationMax,
          last: this.turnDurationLast,
        },
      },
      deltas: { droppedTurns: this.deltaDroppedTurns },
    };
  }
}
