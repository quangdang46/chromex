/**
 * SessionManager + Task/Turn state machines — plan P1-06 / §5.2/§5.3/§4.4.1/§4.7.
 *
 * Three independent state machines (task / turn / conversation); the
 * Gateway owns turn identity (`gatewayTurnId` = TurnRecord.turnId) and
 * persists provider-derived events after normalizing them.
 *
 * Turn lifecycle (§4.4.1):
 *   1a txn — user.message.created + turns row (queued, started_at NULL)
 *   1b txn — turn.started + started_at BEFORE the provider call
 *   provider events buffered until providerTurnId binds (adapter-side)
 *   terminal event → turn status + checkpoint
 *
 * Attention (§4.7) is DERIVED — never stored.
 */

import type {
  AgentEvent,
  AgentSession,
  DurableTaskEvent,
  DurableTaskEventEnvelope,
  PauseReason,
  ProtocolError,
  TaskAttention,
  TaskRecord,
  TaskStatus,
  TurnRecord,
  TurnStatus,
} from "@codex-sidepanel/shared";
import { EPHEMERAL_EVENT_TYPES } from "@codex-sidepanel/shared";

import type { ProviderRegistry } from "../agents/registry.js";
import type { GatewayConfig } from "./config.js";
import { ulid } from "./ulid.js";

// ---------- store surface (shared by InMemoryStore + SQLiteStore) ----------

export interface SessionStore {
  getTask(taskId: string): TaskRecord | undefined;
  putTask(task: TaskRecord): void;
  createTask(task: TaskRecord): void;
  listTasks?(): TaskRecord[];
  getTurn(turnId: string): TurnRecord | undefined;
  upsertTurn(turn: TurnRecord): void;
  listTurns(taskId?: string): TurnRecord[];
  findTurnByClientMessageId(taskId: string, clientMessageId: string): TurnRecord | undefined;
  activeTurn(taskId: string): TurnRecord | undefined;
  appendTaskEvent(taskId: string, event: DurableTaskEvent): DurableTaskEventEnvelope;
  taskEventsAfter(
    taskId: string,
    fromSeq: number,
    maxEvents?: number,
  ): { events: DurableTaskEventEnvelope[]; nextSeq: number; hasMore: boolean };
  lastTaskSeq(taskId: string): number;
  // approvals — optional so minimal test doubles keep working
  insertApproval?(row: {
    approvalId: string;
    taskId: string;
    turnId?: string;
    request: unknown;
    actionDigest: string;
    status: "pending" | "allowed" | "denied" | "expired";
    createdAt: number;
  }): void;
  resolveApproval?(
    approvalId: string,
    status: "allowed" | "denied" | "expired",
    decision?: { optionId: string; kind: string; decidedAt: number; scope?: string },
  ): void;
  listPendingApprovals?(taskId: string): unknown[];
}

// ---------- attention (§4.7 — derived, never persisted) ----------

export interface AttentionInput {
  task: TaskRecord;
  pendingApprovals: number;
  /** seq of the last terminal turn event on this task's stream */
  lastTurnTerminalSeq: number;
  /** true when browser host is offline past reconnectGraceMs */
  browserOffline?: boolean;
}

export function deriveAttention(input: AttentionInput): TaskAttention | null {
  const { task, pendingApprovals, lastTurnTerminalSeq, browserOffline } = input;
  if (pendingApprovals > 0) return "approval_pending";
  if (task.binding.state === "needs_confirmation") return "needs_tab_confirmation";
  if (browserOffline) return "browser_offline";
  if (task.error) return "error";
  // turn_finished: last turn terminal AND unread (lastReadSeq < terminalSeq)
  if (lastTurnTerminalSeq > 0 && task.lastReadSeq < lastTurnTerminalSeq) {
    return "turn_finished";
  }
  return null;
}

// ---------- state machines (§5.2) ----------

const TASK_TRANSITIONS: Record<TaskStatus, ReadonlySet<TaskStatus>> = {
  queued: new Set(["active", "paused", "cancelled", "failed"]),
  active: new Set(["completed", "failed", "cancelled", "paused"]),
  paused: new Set(["active", "cancelled", "failed"]),
  completed: new Set(["active"]), // task.send reopens
  failed: new Set(["active"]),
  cancelled: new Set(["active"]), // task.reopen
};

const TURN_TRANSITIONS: Record<TurnStatus, ReadonlySet<TurnStatus>> = {
  queued: new Set(["running", "cancelled", "failed"]),
  running: new Set(["completed", "failed", "cancelled", "unknown"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
  unknown: new Set(),
};

export class StateTransitionError extends Error {
  constructor(kind: "task" | "turn", from: string, to: string) {
    super(`invalid ${kind} transition ${from} → ${to}`);
    this.name = "StateTransitionError";
  }
}

export function transitionTask(task: TaskRecord, to: TaskStatus, pauseReason?: PauseReason): TaskRecord {
  if (!TASK_TRANSITIONS[task.status].has(to)) {
    throw new StateTransitionError("task", task.status, to);
  }
  const next: TaskRecord = { ...task, status: to, updatedAt: Date.now() };
  if (to === "paused") {
    if (!pauseReason) throw new Error("paused requires pauseReason");
    next.pauseReason = pauseReason;
  } else {
    next.pauseReason = null;
  }
  return next;
}

export function transitionTurn(turn: TurnRecord, to: TurnStatus, patch: Partial<TurnRecord> = {}): TurnRecord {
  if (!TURN_TRANSITIONS[turn.status].has(to)) {
    throw new StateTransitionError("turn", turn.status, to);
  }
  return {
    ...turn,
    ...patch,
    status: to,
    ...(to !== "queued" && to !== "running" ? { endedAt: patch.endedAt ?? Date.now() } : {}),
  };
}

// ---------- session manager ----------

export interface LiveConversation {
  session: AgentSession;
  conversationKey: string;
}

export interface SendMessageInput {
  clientMessageId: string;
  content: import("@codex-sidepanel/shared").TurnInput["content"];
  ctx?: import("@codex-sidepanel/shared").TurnInput["ctx"];
}

export interface SendMessageResult {
  turnId: string;
  /** true when queued behind a running turn */
  queued: boolean;
  /** true when clientMessageId was already seen (idempotent replay) */
  duplicate: boolean;
}

export interface SessionManagerOptions {
  store: SessionStore;
  registry: ProviderRegistry;
  config: GatewayConfig;
  /** publish durable envelopes + ephemeral events to connected clients */
  publish?: (taskId: string, event: AgentEvent | DurableTaskEventEnvelope, ephemeral: boolean) => void;
  /** count pending approvals for attention derivation (default 0) */
  pendingApprovals?: (taskId: string) => number;
  /** override id generator (tests) */
  newId?: () => string;
  /** interrupt ownership timeout (§5.3) — default 30s */
  interruptTimeoutMs?: number;
  /** §9.3: spawn a scoped browser-tool MCP descriptor for a task;
   *  null when the task/provider shouldn't get browser tools. The
   *  result lands in session config.options.mcpServers. */
  browserMcpSpawn?: (task: TaskRecord) => Promise<Record<string, unknown> | null>;
  /** P2-06: fired when a task is interrupted/cancelled — the gateway
   *  uses it to propagate browser.tool.cancel to in-flight tool calls. */
  onTaskStop?: (taskId: string) => void;
  /** chromex-p21: rendered PRIVATE APP CONTEXT block for the task's
   *  agent-reported dev servers. Prepended to ctx.instructions at
   *  dispatch/steer — harness-trusted, never inside untrusted fences. */
  appContextForTask?: (taskId: string) => string | null;
}

const INTERRUPT_TIMEOUT_MS = 30_000;
const TASK_TERMINAL_EVENTS = new Set(["turn.completed", "turn.failed", "turn.cancelled", "turn.unknown"]);

export class SessionManager {
  private readonly conversations = new Map<string, LiveConversation>();
  /** taskId → provider turn binding for the ACTIVE turn */
  private readonly activeTurns = new Map<string, { turnId: string; providerTurnId: string | null }>();
  private readonly unsubscribers = new Map<string, () => void>();
  /** taskIds mid-cancel — suppresses auto-complete while interrupt drains */
  private readonly cancelling = new Set<string>();
  /** last emitted attention per task — for task.attention_changed diffs */
  private readonly lastAttention = new Map<string, TaskAttention | null>();
  /** P2-06 turn budget timers, keyed by gateway turnId */
  private readonly turnTimers = new Map<string, NodeJS.Timeout>();

  constructor(private readonly opts: SessionManagerOptions) {}

  #id(): string {
    return this.opts.newId?.() ?? ulid();
  }

  #publish(taskId: string, event: AgentEvent | DurableTaskEventEnvelope, ephemeral: boolean): void {
    this.opts.publish?.(taskId, event, ephemeral);
  }

  // ---- task lifecycle ----

  createTask(params: {
    profileId: string;
    providerId: TaskRecord["providerId"];
    conversationKey?: string;
    cwd: string;
    title?: string | null;
    model?: string | null;
    modeId?: string | null;
    thinkingOptionId?: string | null;
    providerOptions?: Record<string, unknown> | null;
    backend: TaskRecord["backend"];
    tabIntent: TaskRecord["tabIntent"];
    originBrowserInstanceId?: string | null;
    binding?: TaskRecord["binding"];
  }): TaskRecord {
    const now = Date.now();
    const taskId = this.#id();
    const task: TaskRecord = {
      taskId,
      createdAt: now,
      updatedAt: now,
      status: "queued",
      pauseReason: null,
      title: params.title ?? null,
      profileId: params.profileId,
      providerId: params.providerId,
      conversationKey: params.conversationKey ?? `conv-${taskId}`,
      cwd: params.cwd,
      model: params.model ?? null,
      modeId: params.modeId ?? null,
      thinkingOptionId: params.thinkingOptionId ?? null,
      providerOptions: params.providerOptions ?? null,
      backend: params.backend,
      tabIntent: params.tabIntent,
      originBrowserInstanceId: params.originBrowserInstanceId ?? null,
      binding: params.binding ?? { browserInstanceId: params.originBrowserInstanceId ?? null, state: "none" },
      lastSeq: 0,
      lastReadSeq: 0,
      error: null,
    };
    this.opts.store.createTask(task);
    this.#persist(taskId, { type: "task.created", taskId, profileId: task.profileId, providerId: task.providerId, backend: task.backend });
    this.#setTaskStatus(task, "active");
    return this.opts.store.getTask(taskId)!;
  }

  // ---- conversation ----

  async ensureConversation(task: TaskRecord): Promise<LiveConversation> {
    const existing = this.conversations.get(task.conversationKey);
    if (existing) return existing;

    // §5.7: a NEW provider session never inherits approvals mirrored
    // from a dead one — the old requestIds are unanswerable provider-
    // side, so expire them honestly instead of leaving cards pending.
    this.#expireConversationApprovals(task.conversationKey, "restart");

    const target = this.opts.registry.resolve(task.profileId, {
      provider: task.providerId,
      ...(task.model !== undefined ? { model: task.model } : {}),
      ...(task.modeId !== undefined ? { modeId: task.modeId } : {}),
      ...(task.thinkingOptionId !== undefined ? { thinkingOptionId: task.thinkingOptionId } : {}),
    });
    if (!target) throw new Error(`no provider for profile ${task.profileId}`);

    // Only providers that declare mcpTools get the browser MCP spawn —
    // others would silently drop options.mcpServers anyway, and skipping
    // avoids minting a scope token/file nobody consumes.
    const mcpServers =
      target.provider.capabilities.mcpTools && this.opts.browserMcpSpawn
        ? await this.opts.browserMcpSpawn(task).catch(() => null)
        : null;
    const session = await target.provider.createSession(
      {
        ...target.config,
        provider: target.providerId,
        options: {
          ...(target.config.options ?? {}),
          ...(mcpServers ? { mcpServers } : {}),
        },
      },
      { cwd: task.cwd },
    );
    const live: LiveConversation = { session, conversationKey: task.conversationKey };
    this.conversations.set(task.conversationKey, live);

    // route provider events → normalize → persist → publish
    this.unsubscribers.set(
      task.conversationKey,
      session.subscribe((e) => this.#handleAgentEvent(task.taskId, e)),
    );
    return live;
  }

  // ---- turns ----

  /**
   * §4.4.1 + §5.3: serialize per task, persist-first.
   * Returns queued=true when a turn is already running and
   * tasks.queueWhileRunning allows queuing.
   */
  async sendMessage(taskId: string, input: SendMessageInput): Promise<SendMessageResult> {
    const task = this.#requireTask(taskId);
    const store = this.opts.store;

    // idempotency: same clientMessageId → same turn, no re-dispatch
    const dup = store.findTurnByClientMessageId(taskId, input.clientMessageId);
    if (dup) return { turnId: dup.turnId, queued: dup.status === "queued", duplicate: true };

    const now = Date.now();
    const turnId = this.#id();

    // 1a: user.message.created + queued turn row (started_at NULL)
    const turn: TurnRecord = {
      turnId,
      taskId,
      status: "queued",
      clientMessageId: input.clientMessageId,
      createdAt: now,
      queuedAt: now,
      startedAt: null,
    };
    store.upsertTurn(turn);
    this.#persist(taskId, {
      type: "user.message.created",
      turnId,
      message: {
        gatewayTurnId: turnId,
        clientMessageId: input.clientMessageId,
        content: input.content,
        ...(input.ctx ? { ctx: input.ctx } : {}),
      },
      clientMessageId: input.clientMessageId,
    });

    const running = store.activeTurn(taskId);
    if (running && running.turnId !== turnId) {
      // another turn occupies the slot
      if (this.opts.config.tasks.queueWhileRunning) {
        return { turnId, queued: true, duplicate: false };
      }
      store.upsertTurn(transitionTurn(turn, "failed", { error: busyError() }));
      this.#persist(taskId, {
        type: "turn.failed",
        turnId,
        error: busyError(),
      } as DurableTaskEvent);
      return { turnId, queued: false, duplicate: false };
    }

    return this.#dispatchTurn(task, turn, input);
  }

  /** Dequeue + run the next queued turn for a task (post-terminal drain). */
  async #dispatchTurn(task: TaskRecord, turn: TurnRecord, input: SendMessageInput): Promise<SendMessageResult> {
    const store = this.opts.store;
    const live = await this.ensureConversation(task);

    // 1b: turn.started + started_at BEFORE provider call (§4.4.1 step 5)
    const started = transitionTurn(turn, "running", { startedAt: Date.now() });
    store.upsertTurn(started);
    this.#persist(task.taskId, { type: "turn.started", turnId: turn.turnId } as DurableTaskEvent);
    this.#armTurnTimeout(task.taskId, turn.turnId);
    if (task.status === "queued") {
      this.#setTaskStatus(task, "active");
    }

    const ctx = this.#withAppContext(task.taskId, input.ctx);
    try {
      const res = await live.session.startTurn({
        gatewayTurnId: turn.turnId,
        clientMessageId: turn.clientMessageId,
        content: input.content,
        ...(ctx ? { ctx } : {}),
      });
      this.activeTurns.set(task.taskId, {
        turnId: turn.turnId,
        providerTurnId: res.providerTurnId ?? null,
      });
      return { turnId: turn.turnId, queued: false, duplicate: false };
    } catch (err) {
      // startTurn rejected → turn.failed (§4.4.1)
      const failed = transitionTurn(started, "failed", {
        error: toProtocolError(err, "provider.turn_start_failed"),
      });
      store.upsertTurn(failed);
      this.#persist(task.taskId, {
        type: "turn.failed",
        turnId: turn.turnId,
        error: failed.error!,
      } as DurableTaskEvent);
      this.activeTurns.delete(task.taskId);
      this.#clearTurnTimeout(turn.turnId);
      throw err;
    }
  }

  async steer(taskId: string, input: SendMessageInput): Promise<{ status: "accepted" | "unavailable" }> {
    const task = this.#requireTask(taskId);
    const live = await this.ensureConversation(task);
    if (!live.session.steer) return { status: "unavailable" };
    const active = this.opts.store.activeTurn(taskId);
    if (!active || active.status !== "running") return { status: "unavailable" };
    const ctx = this.#withAppContext(taskId, input.ctx);
    return live.session.steer({
      gatewayTurnId: active.turnId,
      clientMessageId: input.clientMessageId,
      content: input.content,
      ...(ctx ? { ctx } : {}),
    });
  }

  /** chromex-p21: merge the harness-rendered app context into the
   *  turn's ctx.instructions. Applied at dispatch only — the durable
   *  user.message.created event keeps the client-supplied ctx, and
   *  re-dispatches (queued/resume/follow-up) re-inject fresh state. */
  #withAppContext(
    taskId: string,
    ctx: import("@codex-sidepanel/shared").TurnInput["ctx"],
  ): import("@codex-sidepanel/shared").TurnInput["ctx"] | undefined {
    const appContext = this.opts.appContextForTask?.(taskId);
    if (!appContext) return ctx;
    const instructions = [appContext, ctx?.instructions]
      .map((s) => s?.trim())
      .filter((s): s is string => !!s)
      .join("\n\n");
    return { ...(ctx ?? {}), instructions };
  }

  /**
   * §5.3: adapter interrupt + ownership wait. Timeout → turn.unknown +
   * task paused (never guess the turn stopped).
   */
  async interruptTurn(taskId: string, turnId?: string): Promise<void> {
    const task = this.#requireTask(taskId);
    this.opts.onTaskStop?.(taskId);
    const target = turnId ?? this.opts.store.activeTurn(taskId)?.turnId;
    if (!target) return;
    const live = this.conversations.get(task.conversationKey);
    const timeoutMs = this.opts.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS;

    const interrupted = live?.session.interrupt().then(() => true).catch(() => false);
    const timeout = new Promise<false>((r) => setTimeout(() => r(false), timeoutMs).unref());
    const ok = interrupted ? await Promise.race([interrupted, timeout]) : false;

    const turn = this.opts.store.getTurn(target);
    if (!turn || ["completed", "failed", "cancelled"].includes(turn.status)) return;

    if (ok) {
      // terminal event arrives via subscription; if it already did, turn is terminal
      const after = this.opts.store.getTurn(target);
      if (after && !["completed", "failed", "cancelled", "unknown"].includes(after.status)) {
        // adapter resolved but no terminal event observed — mark unknown
        this.#markTurnUnknown(taskId, target, "interrupt_no_terminal");
      }
      return;
    }
    this.#markTurnUnknown(taskId, target, "turn.interrupt_timeout");
    this.#pauseTask(task, "provider_unavailable");
  }

  /** task.cancel: interrupt active turn + cancel queued turns + status. */
  async cancelTask(taskId: string, reason = "user"): Promise<void> {
    const task = this.#requireTask(taskId);
    const store = this.opts.store;
    this.opts.onTaskStop?.(taskId);
    this.cancelling.add(taskId);
    try {
      const active = store.activeTurn(taskId);
      if (active?.status === "running") {
        await this.interruptTurn(taskId, active.turnId);
      }
    } finally {
      // keep the guard until status is written below
    }
    // queued turns → cancelled with started_at NULL (§5.2)
    for (const t of store.listTurns(taskId)) {
      if (t.status === "queued") {
        store.upsertTurn(transitionTurn(t, "cancelled", { endedAt: Date.now(), stopReason: reason }));
        this.#persist(taskId, { type: "turn.cancelled", turnId: t.turnId, reason } as DurableTaskEvent);
      }
    }
    // any still-running turn the interrupt couldn't confirm → unknown
    for (const t of store.listTurns(taskId)) {
      if (t.status === "running") {
        this.#markTurnUnknown(taskId, t.turnId, "task.cancel");
      }
    }
    const fresh = this.#requireTask(taskId);
    try {
      if (["active", "paused", "queued"].includes(fresh.status)) {
        this.#setTaskStatus(fresh, "cancelled");
        this.#persist(taskId, { type: "task.cancelled", reason } as DurableTaskEvent);
      }
    } finally {
      this.cancelling.delete(taskId);
    }
  }

  /** task.pause (user): no new turns, no interrupt (§5.2.1). */
  pauseTask(taskId: string, reason: PauseReason = "user_requested"): void {
    const task = this.#requireTask(taskId);
    if (["completed", "failed", "cancelled"].includes(task.status)) return;
    this.#setTaskStatus(task, "paused", reason);
  }

  /**
   * task.resume: back to active, then auto-resume what recovery left
   * behind. The provider session died with the gateway, so a paused task
   * cannot continue in place — the honest resume is re-dispatching work
   * as NEW turns (new turnIds), never fake continuation.
   * Returns a promise for tests; the RPC handler ignores it.
   */
  resumeTask(taskId: string): Promise<void> {
    const task = this.#requireTask(taskId);
    if (task.status !== "paused") return Promise.resolve();
    this.#setTaskStatus(task, "active");
    return this.#autoResume(taskId).catch(() => {});
  }

  /**
   * Post-resume drain, in order:
   *  1. a queued turn that survived recovery dispatches first — it was
   *     persisted but never sent (§5.6);
   *  2. a last turn left `unknown`/`failed` re-sends its user message as
   *     a NEW turn via sendMessage (new turnId, new clientMessageId).
   * Idempotent: a user retry creates a newer turn, so the last-turn check
   * no-ops instead of double-sending. Missing user.message.created
   * (pruned events) → nothing to honestly re-send; task stays active.
   */
  async #autoResume(taskId: string): Promise<void> {
    const task = this.opts.store.getTask(taskId);
    if (!task || task.status !== "active") return;
    const store = this.opts.store;

    const turns = [...store.listTurns(taskId)].sort((a, b) => a.createdAt - b.createdAt);
    const queued = turns.find((t) => t.status === "queued");
    if (queued) {
      await this.#resumeQueued(task, queued);
      return;
    }
    if (store.activeTurn(taskId)) return; // a turn is already in flight
    const last = turns.at(-1);
    if (!last || (last.status !== "unknown" && last.status !== "failed")) return;
    const msg = this.#userMessageForTurn(taskId, last.turnId);
    if (!msg) return;
    try {
      await this.sendMessage(taskId, {
        clientMessageId: `resume-${last.turnId}`,
        content: msg.content,
        ...(msg.ctx ? { ctx: msg.ctx } : {}),
      });
    } catch {
      // provider unavailable — #dispatchTurn already persisted turn.failed;
      // the task stays active for the next explicit user action.
    }
  }

  /** Rebuild a TurnInput's content/ctx from its durable
   *  user.message.created event (§5.6 durability). */
  #userMessageForTurn(taskId: string, turnId: string) {
    const { events } = this.opts.store.taskEventsAfter(taskId, 0, 100_000);
    const created = events.find(
      (e) => e.type === "user.message.created" && e.payload.turnId === turnId,
    );
    if (!created || created.type !== "user.message.created") return null;
    return created.payload.message;
  }

  /**
   * task.reopen (§5.2: cancelled/failed/completed → active). The next
   * task.send starts a fresh turn on the SAME conversation; provider
   * resume-ability is enforced by the session, not here.
   */
  reopenTask(taskId: string): TaskRecord {
    const task = this.#requireTask(taskId);
    this.#setTaskStatus(task, "active");
    if (task.error) {
      const cleared = { ...task, error: null };
      this.opts.store.putTask(cleared);
    }
    return this.opts.store.getTask(taskId)!;
  }

  /**
   * task.setBackend (§6.6): user action re-pins the backend mid-task.
   * Refused while a turn is running — the binding must be stable for
   * the duration of in-flight tool calls.
   */
  setBackend(taskId: string, backend: TaskRecord["backend"]): TaskRecord {
    const task = this.#requireTask(taskId);
    if (this.opts.store.activeTurn(taskId)?.status === "running") {
      throw new Error("task.setBackend refused while a turn is running");
    }
    const next = { ...task, backend, updatedAt: Date.now() };
    this.opts.store.putTask(next);
    this.#persist(taskId, {
      type: "task.backend_changed",
      from: task.backend,
      to: backend,
      by: "user",
    } as DurableTaskEvent);
    return next;
  }

  /**
   * Route a permission decision to the owning session. The approval
   * store (P1-06 full) is the source of truth; this resolves the
   * provider-side mirror. Returns false when no session owns requestId.
   */
  async respondToPermission(
    requestId: string,
    response: { optionId?: string; answers?: Record<string, string[]> },
  ): Promise<{ followUpPrompt?: import("@codex-sidepanel/shared").TurnInput }> {
    for (const [conversationKey, live] of this.conversations) {
      if (!live.session.getPendingPermissions().some((p) => p.requestId === requestId)) continue;
      const result = await live.session.respondToPermission(requestId, {
        requestId,
        ...(response.optionId !== undefined ? { optionId: response.optionId } : {}),
        ...(response.answers !== undefined ? { answers: response.answers } : {}),
      });
      // §4.8: a followUpPrompt is a NEW turn with a NEW gatewayTurnId —
      // never folded into the resolved turn.
      if (result.followUpPrompt) {
        const task = this.opts.store
          .listTasks?.()
          .find((t) => t.conversationKey === conversationKey);
        if (task) {
          const fp = result.followUpPrompt;
          void this.sendMessage(task.taskId, {
            clientMessageId: `followup-${requestId}`,
            content: fp.content,
            ...(fp.ctx ? { ctx: fp.ctx } : {}),
          }).catch(() => {});
        }
      }
      return result;
    }
    return {};
  }

  /** Exposed for gateway wiring: provider feature RPC entry. */
  providerFor(profileOrProviderId: string) {
    return this.opts.registry.resolve(profileOrProviderId);
  }

  // ---- provider event intake ----

  /**
   * Events arrive on the conversation's subscription, but the task that
   * owns the turn may differ from the task that created the session
   * (conversationKey is shared across tasks). Attribute by turnId so a
   * follow-up task's turn doesn't persist under the first task.
   */
  #owningTaskId(fallback: string, event: AgentEvent): string {
    const turnId = (event as { turnId?: unknown }).turnId;
    if (typeof turnId === "string" && turnId) {
      const turn = this.opts.store.getTurn(turnId);
      if (turn) return turn.taskId;
    }
    return fallback;
  }

  /** First terminal event wins — providers occasionally emit frames
   *  after their terminal result (late tool completions, duplicate
   *  results); persisting them corrupts the durable stream. */
  #isPostTerminal(event: AgentEvent): boolean {
    const turnId = (event as { turnId?: unknown }).turnId;
    if (typeof turnId !== "string" || !turnId) return false;
    const turn = this.opts.store.getTurn(turnId);
    return !!turn && ["completed", "failed", "cancelled", "unknown"].includes(turn.status);
  }

  #handleAgentEvent(subscribedTaskId: string, event: AgentEvent): void {
    if (this.#isPostTerminal(event)) return;
    const taskId = this.#owningTaskId(subscribedTaskId, event);
    const ephemeral = (EPHEMERAL_EVENT_TYPES as readonly string[]).includes(event.type);
    if (ephemeral) {
      this.#publish(taskId, event, true);
      return;
    }
    // adapter-emitted turn.started is a duplicate of the Gateway's 1b
    // persist — skip when the turn row already started.
    if (event.type === "turn.started") {
      const turn = this.opts.store.getTurn((event as { turnId: string }).turnId);
      if (turn?.startedAt) {
        // duplicate of Gateway's own 1b persist — already on the stream
        return;
      }
    }
    const env = this.#persist(taskId, event as DurableTaskEvent);
    this.#publish(taskId, env, false);
    this.#mirrorApproval(taskId, event);
    this.#afterPersistedEvent(taskId, event);
    // provider session gone → its pending approvals can never be
    // answered; expire them instead of pinning attention forever.
    if (event.type === "conversation.closed") {
      this.#expirePendingApprovals(taskId, "provider_unavailable");
    }
    this.#maybeEmitAttention(taskId);
  }

  /**
   * §5.7: permission.requested/resolved mirror into the approvals
   * table — the durable record of every approval + decision.
   */
  #mirrorApproval(taskId: string, event: AgentEvent): void {
    const store = this.opts.store;
    if (event.type === "permission.requested") {
      const req = (event as { request?: { requestId?: string; actionDigest?: string; turnId?: string } }).request;
      if (req?.requestId && store.insertApproval) {
        store.insertApproval({
          approvalId: req.requestId,
          taskId,
          ...(req.turnId ? { turnId: req.turnId } : {}),
          request: event,
          actionDigest: req.actionDigest ?? "",
          status: "pending",
          createdAt: Date.now(),
        });
      }
      return;
    }
    if (event.type === "permission.resolved") {
      const e = event as { requestId?: string; decision?: { kind?: string } };
      if (e.requestId && store.resolveApproval) {
        store.resolveApproval(
          e.requestId,
          e.decision?.kind === "deny" ? "denied" : "allowed",
        );
      }
      return;
    }
    if (event.type === "permission.expired") {
      const e = event as { requestId?: string };
      if (e.requestId && store.resolveApproval) {
        store.resolveApproval(e.requestId, "expired");
      }
    }
  }

  /**
   * §5.7: expire every pending approval on a task — resolves the row
   * (idempotent: resolveApproval only transitions pending rows) and
   * persists + publishes permission.expired so replayed and live
   * clients clear the card. Never leaves an approval silently pending.
   */
  #expirePendingApprovals(
    taskId: string,
    reason: "task_terminal" | "restart" | "provider_unavailable" | "timeout",
  ): void {
    const store = this.opts.store;
    const list = store.listPendingApprovals?.bind(store);
    const resolve = store.resolveApproval?.bind(store);
    if (!list || !resolve) return;
    for (const row of list(taskId)) {
      const r = row as { approval_id?: unknown; approvalId?: unknown };
      const requestId =
        typeof r.approval_id === "string"
          ? r.approval_id
          : typeof r.approvalId === "string"
            ? r.approvalId
            : null;
      if (!requestId) continue;
      resolve(requestId, "expired", {
        optionId: reason,
        kind: "deny",
        decidedAt: Date.now(),
      });
      const env = this.#persist(taskId, {
        type: "permission.expired",
        requestId,
        reason,
      } as DurableTaskEvent);
      this.#publish(taskId, env, false);
    }
  }

  /** Expire pending approvals across every task sharing a conversation —
   *  used when a new provider session replaces a dead one (restart). */
  #expireConversationApprovals(
    conversationKey: string,
    reason: "task_terminal" | "restart" | "provider_unavailable" | "timeout",
  ): void {
    for (const t of this.opts.store.listTasks?.() ?? []) {
      if (t.conversationKey === conversationKey) {
        this.#expirePendingApprovals(t.taskId, reason);
      }
    }
  }

  /** §4.7: attention is derived — emit task.attention_changed on diff. */
  #maybeEmitAttention(taskId: string): void {
    const next = this.attentionFor(taskId);
    const prev = this.lastAttention.get(taskId) ?? null;
    if (JSON.stringify(next) === JSON.stringify(prev)) return;
    this.lastAttention.set(taskId, next);
    const env = this.#persist(taskId, {
      type: "task.attention_changed",
      attention: next,
    } as DurableTaskEvent);
    this.#publish(taskId, env, false);
  }

  #afterPersistedEvent(taskId: string, event: AgentEvent): void {
    if (!TASK_TERMINAL_EVENTS.has(event.type)) return;
    const turnId = (event as { turnId?: string }).turnId;
    if (!turnId) return;
    const turn = this.opts.store.getTurn(turnId);
    if (!turn || turn.status === "queued") return;

    const statusMap: Record<string, TurnStatus> = {
      "turn.completed": "completed",
      "turn.failed": "failed",
      "turn.cancelled": "cancelled",
      "turn.unknown": "unknown",
    };
    const to = statusMap[event.type];
    if (!to || turn.status === to || !TURN_TRANSITIONS[turn.status].has(to)) return;

    const patch: Partial<TurnRecord> = { endedAt: Date.now() };
    if (event.type === "turn.failed") {
      patch.error = (event as { error?: ProtocolError }).error ?? null;
      patch.stopReason = "provider_error";
    }
    if (event.type === "turn.cancelled") {
      patch.stopReason = (event as { reason?: string }).reason ?? "interrupted";
    }
    if (event.type === "turn.unknown") {
      patch.stopReason = (event as { reason?: string }).reason ?? "unknown";
    }
    this.opts.store.upsertTurn(transitionTurn(turn, to, patch));
    this.activeTurns.delete(taskId);
    this.#clearTurnTimeout(turnId);

    // drain queue or complete task (§5.2: all turns terminal → completed)
    const task = this.opts.store.getTask(taskId);
    if (!task) return;
    // task.cancel owns queued turns itself — never auto-dispatch one
    // mid-cancel (§5.2: queued → cancelled keeps started_at NULL).
    if (this.cancelling.has(taskId)) return;
    // provider-reported turn.unknown is an unconfirmed stop — pause for
    // explicit resume, never auto-complete or drain (§5.3 honesty).
    // Its pending approvals expire provider_unavailable even when the
    // task is already paused (crash while paused still kills them).
    if (event.type === "turn.unknown") {
      this.#expirePendingApprovals(taskId, "provider_unavailable");
      if (task.status === "active") {
        this.#pauseTask(task, "provider_unavailable");
        return;
      }
    }
    // auto-drain only while the task is active — a paused task keeps its
    // queued turns for explicit task.resume (chromex-94z)
    const queued =
      task.status === "active"
        ? this.opts.store.listTurns(taskId).find((t) => t.status === "queued")
        : undefined;
    if (queued) {
      void this.#resumeQueued(task, queued);
      return;
    }
    if (task.status === "active" && !this.cancelling.has(taskId)) {
      this.#setTaskStatus(task, "completed");
      this.#persist(taskId, { type: "task.completed" } as DurableTaskEvent);
    }
  }

  async #resumeQueued(task: TaskRecord, turn: TurnRecord): Promise<void> {
    // Rebuild TurnInput from the durable user.message.created event —
    // the prompt payload is persisted before dispatch (§5.6 durability).
    const msg = this.#userMessageForTurn(task.taskId, turn.turnId);
    if (!msg) return;
    try {
      await this.#dispatchTurn(task, turn, {
        clientMessageId: msg.clientMessageId,
        content: msg.content,
        ...(msg.ctx ? { ctx: msg.ctx } : {}),
      });
    } catch {
      // dispatch failure already persisted turn.failed; task stays active
      // for the next queued turn or explicit user action.
    }
  }

  // ---- internals ----

  #requireTask(taskId: string): TaskRecord {
    const task = this.opts.store.getTask(taskId);
    if (!task) throw new Error(`task ${taskId} not found`);
    return task;
  }

  #persist(taskId: string, event: DurableTaskEvent): DurableTaskEventEnvelope {
    return this.opts.store.appendTaskEvent(taskId, event);
  }

  #setTaskStatus(task: TaskRecord, to: TaskStatus, pauseReason?: PauseReason): TaskRecord {
    const next = transitionTask(task, to, pauseReason);
    this.opts.store.putTask(next);
    if (task.status !== to) {
      this.#persist(task.taskId, {
        type: "task.status_changed",
        from: task.status,
        to,
        ...(pauseReason ? { pauseReason } : {}),
      } as DurableTaskEvent);
      // §5.7: terminal task ⇒ every pending approval is moot.
      if (to === "completed" || to === "failed" || to === "cancelled") {
        this.#expirePendingApprovals(task.taskId, "task_terminal");
      }
      this.#maybeEmitAttention(task.taskId);
    }
    return next;
  }

  /** P2-06 turn budget: armed at turn.started, cleared on any terminal
   *  transition. On expiry we attempt interrupt; a confirmed stop is
   *  recorded as provider.notice, an unconfirmed one as turn.unknown —
   *  same honesty rule as §5.3 interrupt ownership. */
  #armTurnTimeout(taskId: string, turnId: string): void {
    const ms = this.opts.config.tasks.turnTimeoutMs;
    if (!ms || ms <= 0) return;
    this.#clearTurnTimeout(turnId);
    const timer = setTimeout(() => {
      this.turnTimers.delete(turnId);
      void this.#onTurnTimeout(taskId, turnId, ms).catch(() => {});
    }, ms);
    timer.unref?.();
    this.turnTimers.set(turnId, timer);
  }

  #clearTurnTimeout(turnId: string): void {
    const t = this.turnTimers.get(turnId);
    if (t) {
      clearTimeout(t);
      this.turnTimers.delete(turnId);
    }
  }

  async #onTurnTimeout(taskId: string, turnId: string, budgetMs: number): Promise<void> {
    const task = this.opts.store.getTask(taskId);
    const turn = this.opts.store.getTurn(turnId);
    if (!task || !turn) return;
    if (["completed", "failed", "cancelled", "unknown"].includes(turn.status)) return;

    const live = this.conversations.get(task.conversationKey);
    const interruptWait = live?.session.interrupt?.().then(() => true).catch(() => false);
    const grace = new Promise<false>((r) =>
      setTimeout(() => r(false), this.opts.interruptTimeoutMs ?? INTERRUPT_TIMEOUT_MS).unref(),
    );
    if (interruptWait) await Promise.race([interruptWait, grace]);
    const after = this.opts.store.getTurn(turnId);
    if (after && ["completed", "failed", "cancelled", "unknown"].includes(after.status)) {
      this.#persist(taskId, {
        type: "provider.notice",
        level: "warn",
        message: `turn exceeded budget ${budgetMs}ms; stop confirmed`,
      } as DurableTaskEvent);
      return;
    }
    this.#markTurnUnknown(taskId, turnId, "turn.timeout");
    this.#pauseTask(task, "provider_unavailable");
  }

  #pauseTask(task: TaskRecord, reason: PauseReason): void {
    // §5.7: provider_unavailable pause means the provider can't answer
    // approvals — expire them (idempotent across repeat pauses).
    if (reason === "provider_unavailable") {
      this.#expirePendingApprovals(task.taskId, "provider_unavailable");
    }
    if (task.status === "paused") return;
    if (["completed", "failed", "cancelled"].includes(task.status)) return;
    this.#setTaskStatus(task, "paused", reason);
  }

  #markTurnUnknown(taskId: string, turnId: string, reason: string): void {
    const turn = this.opts.store.getTurn(turnId);
    if (!turn) return;
    this.#clearTurnTimeout(turnId);
    if (TURN_TRANSITIONS[turn.status].has("unknown")) {
      this.opts.store.upsertTurn(transitionTurn(turn, "unknown", { stopReason: reason }));
    } else if (turn.status === "running") {
      this.opts.store.upsertTurn({ ...turn, status: "unknown", endedAt: Date.now(), stopReason: reason });
    }
    this.#persist(taskId, { type: "turn.unknown", turnId, reason } as DurableTaskEvent);
  }

  /** Attention for snapshots/hello — derived per §4.7. */
  attentionFor(taskId: string): TaskAttention | null {
    const task = this.opts.store.getTask(taskId);
    if (!task) return null;
    return deriveAttention({
      task,
      pendingApprovals: this.opts.pendingApprovals?.(taskId) ?? 0,
      lastTurnTerminalSeq: this.#lastTurnTerminalSeq(taskId),
    });
  }

  #lastTurnTerminalSeq(taskId: string): number {
    // §4.7: attention compares lastReadSeq against the seq of the last
    // TERMINAL turn event on this task's durable stream. Scan is O(events)
    // — acceptable until P1-11 adds a terminal-seq index.
    const { events } = this.opts.store.taskEventsAfter(taskId, 0, 100_000);
    let seq = 0;
    for (const e of events) {
      if (
        e.type === "turn.completed" ||
        e.type === "turn.failed" ||
        e.type === "turn.cancelled" ||
        e.type === "turn.unknown"
      ) {
        seq = e.seq;
      }
    }
    return seq;
  }
}

function busyError(): ProtocolError {
  return {
    code: "task.busy",
    message: "another turn is running",
    retryable: true,
    requiresUserAction: false,
    sideEffectState: "none",
  } as ProtocolError;
}

function toProtocolError(err: unknown, code: string): ProtocolError {
  return {
    code: code as ProtocolError["code"],
    message: err instanceof Error ? err.message : String(err),
    retryable: true,
    requiresUserAction: false,
    sideEffectState: "unknown",
  } as ProtocolError;
}
