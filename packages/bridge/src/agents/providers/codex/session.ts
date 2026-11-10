/**
 * CodexAgentSession — AgentSession over CodexAppServerClient (P1-05).
 *
 * Wraps the existing app-server transport; does NOT reuse codex-plane's
 * PromptSendParams pipeline (that stays for legacy bridge mode). Turn
 * identity is Gateway-owned: startTurn binds providerTurnId→gatewayTurnId
 * in CodexEventMapper; provider events never mint turn ids.
 *
 * Permission flow: app-server server→client request
 * `item/tool/requestUserInput` → permission.requested (mirror in
 * getPendingPermissions) → Gateway decides → respondToPermission
 * resolves the JSON-RPC request. followUpPrompt is returned for the
 * Gateway to run as a NEW turn — never self-run here.
 */

import type {
  AgentCapabilityFlags,
  AgentEvent,
  AgentMode,
  AgentPersistenceHandle,
  AgentSession,
  AgentSessionConfig,
  LaunchContext,
  PermissionRequest,
  PermissionResponse,
  PermissionResponseResult,
  ProviderId,
  RuntimeInfo,
  TurnInput,
} from "@codex-sidepanel/shared";
import { NO_CAPABILITIES } from "@codex-sidepanel/shared";

import type { CodexAppServerClient } from "../../../codex-app-server.js";
import { requestTurnStartWithReasoningSummaryFallback } from "../../../turn-start.js";
import { CodexEventMapper } from "./mapper.js";

export const CODEX_CAPABILITIES: AgentCapabilityFlags = {
  ...NO_CAPABILITIES,
  streaming: true,
  reasoningSummary: true,
  toolEvents: true,
  interrupt: true,
  steer: true,
  resume: true,
  modelSelection: true,
  modeSelection: false,
  thinkingOption: true,
  permissionPrompts: true,
  mcpTools: true,
  imageInput: true,
  slashCommands: false,
  usage: false,
  streamHistory: true,
};

interface PendingUserInput {
  request: PermissionRequest;
  questionIds: string[];
  resolve: (value: unknown) => void;
}

interface CodexTurnInputItem {
  type: string;
  text?: string;
  path?: string;
  url?: string;
  name?: string;
}

export class CodexAgentSession implements AgentSession {
  readonly provider: ProviderId = "codex";
  readonly sessionKey: string;
  readonly capabilities: AgentCapabilityFlags = CODEX_CAPABILITIES;

  private readonly client: CodexAppServerClient;
  private readonly config: AgentSessionConfig;
  private readonly ctx: LaunchContext;
  private readonly mapper: CodexEventMapper;

  private threadId: string | null = null;
  private activeTurn: { gatewayTurnId: string; providerTurnId: string | null } | null = null;
  private persistence: AgentPersistenceHandle | null = null;
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  private readonly pendingPermissions = new Map<string, PendingUserInput>();
  private unsubscribeNotifications: (() => void) | null = null;
  private unsubscribeRequests: (() => void) | null = null;
  private closed = false;
  /** True while a client-requested turn/start is in flight — distinguishes
   *  our turns from provider-initiated ones (goal-loop continuations). */
  private startTurnInFlight = false;
  private readonly providerTurnsNotified = new Set<string>();
  /** Gateway hook: mints a gateway turnId for provider-initiated turns
   *  (goal-loop continuations) so their events flow as real turns. */
  private providerTurnHandler: ((providerTurnId: string) => string | null) | null = null;

  constructor(
    client: CodexAppServerClient,
    config: AgentSessionConfig,
    ctx: LaunchContext,
    sessionKey: string,
  ) {
    this.client = client;
    this.config = config;
    this.ctx = ctx;
    this.sessionKey = sessionKey;
    this.mapper = new CodexEventMapper(sessionKey);
    this.mapper.onEvent((e) => {
      // terminal turn events release the active-turn slot — the provider
      // may still flush trailing item events, but a new startTurn is safe
      // once the turn is terminal (§4.4 ownership).
      if (
        !e.ephemeral &&
        this.activeTurn &&
        (e.event.type === "turn.completed" ||
          e.event.type === "turn.cancelled" ||
          e.event.type === "turn.failed") &&
        (e.event as { turnId?: string }).turnId === this.activeTurn.gatewayTurnId
      ) {
        this.activeTurn = null;
      }
      for (const l of this.listeners)
        l(
          e.deltaOffset !== undefined
            ? ({ ...e.event, deltaOffset: e.deltaOffset } as AgentEvent)
            : e.event,
        );
    });
    this.unsubscribeNotifications = this.client.onNotification((n) => {
      // Provider-initiated turns (goal-loop continuations) arrive without
      // a gateway turn identity — they buffer in the mapper and never
      // surface. Emit one honest notice per such turn so the UI isn't
      // silently blind while the provider keeps working.
      if (n.method === "turn/started" && !this.activeTurn && !this.startTurnInFlight) {
        const params = n.params as Record<string, unknown> | undefined;
        const turn = params?.turn as Record<string, unknown> | undefined;
        const providerTurnId =
          (typeof turn?.id === "string" && turn.id) ||
          (typeof params?.turnId === "string" ? params.turnId : "");
        if (providerTurnId && !this.providerTurnsNotified.has(providerTurnId)) {
          if (this.providerTurnsNotified.size >= 32) this.providerTurnsNotified.clear();
          this.providerTurnsNotified.add(providerTurnId);
          // Adopt the turn when the gateway can mint an identity — its
          // events then flow as a normal turn. Otherwise emit one honest
          // notice so the UI isn't silently blind.
          const gatewayTurnId = this.providerTurnHandler?.(providerTurnId) ?? null;
          if (gatewayTurnId) {
            this.mapper.bindTurn(providerTurnId, gatewayTurnId);
          } else {
            for (const l of this.listeners) {
              l({
                type: "provider.notice",
                level: "info",
                message:
                  "Provider-initiated turn started (goal continuation) — per-turn detail is not itemized for provider-managed turns.",
              });
            }
          }
        }
      }
      this.mapper.mapNotification(n.method, n.params);
    });
    this.unsubscribeRequests =
      this.client.onRequest?.(
        (request) => this.#handleServerRequest(request),
        { concurrency: "parallel" },
      ) ?? null;
  }

  /** §9.3: config.options.mcpServers (spawn descriptors from
   *  browser.mcp.spawn) → codex config override `mcp_servers.*`.
   *  thread/start|resume both accept `config` per the app-server
   *  protocol schema. */
  #mcpConfigOverride(): Record<string, unknown> | undefined {
    const servers = this.config.options?.mcpServers as
      | Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
      | undefined;
    if (!servers || Object.keys(servers).length === 0) return undefined;
    const mcp_servers: Record<string, unknown> = {};
    for (const [name, srv] of Object.entries(servers)) {
      if (!srv?.command) continue;
      mcp_servers[name] = {
        command: srv.command,
        ...(srv.args?.length ? { args: srv.args } : {}),
        ...(srv.env ? { env: srv.env } : {}),
      };
    }
    return Object.keys(mcp_servers).length ? { mcp_servers } : undefined;
  }

  async #ensureThread(): Promise<string> {
    if (this.threadId) return this.threadId;
    const cwd = this.ctx.cwd;
    const configOverride = this.#mcpConfigOverride();
    if (this.config.resume?.persistence) {
      const result = (await this.client.request("thread/resume", {
        threadId: this.config.resume.persistence.ref,
        excludeTurns: true,
        personality: "pragmatic",
        ...(configOverride ? { config: configOverride } : {}),
      })) as { thread: { id: string } };
      this.threadId = result.thread.id;
    } else {
      const result = (await this.client.request("thread/start", {
        ...(cwd ? { cwd } : {}),
        ...(this.config.model ? { model: this.config.model } : {}),
        approvalPolicy: "never",
        personality: "pragmatic",
        serviceName: "chromex-gateway",
        sessionStartSource: "startup",
        ...(configOverride ? { config: configOverride } : {}),
      })) as { thread: { id: string } };
      this.threadId = result.thread.id;
    }
    // Resumability proven once thread/start|resume returns an id — the
    // rollout is written by the app-server before responding (§8.2).
    this.persistence = {
      provider: "codex",
      ref: this.threadId,
      kind: "thread",
      createdAt: Date.now(),
      ...(this.config.resume?.persistence?.metadata
        ? { metadata: this.config.resume.persistence.metadata }
        : {}),
    };
    return this.threadId;
  }

  async startTurn(input: TurnInput): Promise<{ accepted: true; providerTurnId?: string }> {
    if (this.closed) throw new Error("session closed");
    if (this.activeTurn) throw new Error("turn already active — steer or interrupt first");

    const threadId = await this.#ensureThread();
    const items = buildCodexInputItems(input);
    const cwd = this.ctx.cwd;

    // Goal mode (legacy /goal parity): set the thread goal BEFORE the
    // turn so the provider's goal loop drives this turn. Objective falls
    // back to the message text like codex-plane did. A failed set fails
    // the turn honestly rather than silently running without the goal.
    if (input.ctx?.metadata?.useGoal === true) {
      const metaObjective =
        typeof input.ctx.metadata.goalObjective === "string"
          ? input.ctx.metadata.goalObjective.trim()
          : "";
      const fallback = items
        .map((item) => (typeof item === "object" && item !== null && "text" in item ? String((item as { text?: unknown }).text ?? "") : ""))
        .join(" ")
        .trim();
      const objective = metaObjective || fallback;
      if (objective) {
        // origin:"user" — /goal is an explicit user action; the app-server
        // treats missing provenance as non-user (schema: "Missing
        // provenance does not supply user authorization").
        const rawBudget = input.ctx?.metadata?.goalTokenBudget;
        const tokenBudget =
          typeof rawBudget === "number" && Number.isInteger(rawBudget) && rawBudget > 0
            ? rawBudget
            : undefined;
        await this.client.request("thread/goal/set", {
          threadId,
          objective,
          origin: "user",
          ...(tokenBudget !== undefined ? { tokenBudget } : {}),
        });
      }
    }

    this.startTurnInFlight = true;
    let turn;
    try {
      turn = await requestTurnStartWithReasoningSummaryFallback(
        this.client,
        async () => undefined,
        {
          threadId,
          input: items,
          ...(cwd ? { cwd } : {}),
          ...(this.config.model ? { model: this.config.model } : {}),
          ...(this.config.thinkingOptionId
            ? { effort: this.config.thinkingOptionId }
            : {}),
          approvalPolicy: "never",
          personality: "pragmatic",
          // plan mode → collaborationMode unlocks requestUserInput (the
          // feature-flagged ask-user path is off by default in codex-cli).
          ...(input.ctx?.metadata?.planMode === true
            ? {
                collaborationMode: {
                  mode: "plan",
                  settings: {
                    model: this.config.model ?? "",
                    reasoning_effort: this.config.thinkingOptionId ?? "medium",
                    developer_instructions:
                      "In plan mode, always produce a visible plan or a visible clarification. If the user's objective is underspecified, ask exactly one concise clarification question using request_user_input or assistant text. Do not finish with only an internal/tool-only plan item. When enough context is available, return 3-7 concrete steps and wait for the user to accept or revise before execution.",
                  },
                },
              }
            : {}),
        },
      );

      this.activeTurn = {
        gatewayTurnId: input.gatewayTurnId,
        providerTurnId: turn.turn.id,
      };
      this.mapper.bindTurn(turn.turn.id, input.gatewayTurnId);
    } finally {
      this.startTurnInFlight = false;
    }
    return { accepted: true as const, providerTurnId: turn.turn.id };
  }

  async steer(input: TurnInput): Promise<{ status: "accepted" | "unavailable" }> {
    if (!this.activeTurn?.providerTurnId || !this.threadId) {
      return { status: "unavailable" };
    }
    const items = buildCodexInputItems(input);
    await this.client.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.activeTurn.providerTurnId,
      input: items,
      ...(this.ctx.cwd ? { cwd: this.ctx.cwd } : {}),
    });
    return { status: "accepted" };
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn || !this.threadId) return;
    // Ownership guarantee: resolve only after the provider confirms a
    // terminal turn state (turn/completed observed by the mapper).
    const terminal = new Promise<void>((resolve) => {
      const unsub = this.mapper.onEvent((e) => {
        if (
          !e.ephemeral &&
          (e.event.type === "turn.completed" ||
            e.event.type === "turn.cancelled" ||
            e.event.type === "turn.failed") &&
          (e.event as { turnId?: string }).turnId === turn.gatewayTurnId
        ) {
          unsub();
          resolve();
        }
      });
      setTimeout(() => {
        unsub();
        resolve(); // bounded wait — provider may already be terminal
      }, 30_000).unref();
    });
    try {
      await this.client.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: turn.providerTurnId ?? turn.gatewayTurnId,
      });
    } catch (err) {
      this.activeTurn = null;
      this.mapper.unbindTurn();
      throw err;
    }
    // Keep the turn↔provider binding until the terminal notification is
    // observed: the app-server answers turn/interrupt first and emits
    // turn/completed{interrupted} afterwards — unbinding early would
    // buffer that terminal event under a null gatewayTurnId and the
    // gateway would record interrupt_no_terminal for a clean stop.
    await terminal;
    this.activeTurn = null;
    this.mapper.unbindTurn();
  }

  canStopRuntime(): boolean {
    return this.activeTurn === null;
  }

  async respondToPermission(
    requestId: string,
    response: PermissionResponse,
  ): Promise<PermissionResponseResult> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return {};
    this.pendingPermissions.delete(requestId);
    // compat path may pass an option label where an id is expected —
    // resolve either, then answer with the canonical option id.
    const optionId = response.optionId ?? "";
    const option =
      pending.request.options.find((o) => o.id === optionId) ??
      pending.request.options.find((o) => o.label === optionId);
    const fallback = option?.id ?? optionId;
    const answers: Record<string, { answers: string[] }> = {};
    if (response.answers) {
      // per-question answers (permission.respond answers field) — used
      // verbatim; questions the client left blank resolve empty.
      for (const qid of pending.questionIds) {
        answers[qid] = { answers: response.answers[qid] ?? [] };
      }
    } else {
      // single-option path: the same answer goes to every question.
      for (const qid of pending.questionIds) {
        answers[qid] = { answers: fallback ? [fallback] : [] };
      }
    }
    pending.resolve({ answers });
    for (const l of this.listeners) {
      l({
        type: "permission.resolved",
        requestId,
        decision: {
          optionId: response.optionId ?? option?.id ?? "answered",
          kind: option?.kind ?? "allow_once",
          decidedAt: Date.now(),
          decidedBy: "user",
        },
      });
    }
    return {};
  }

  getPendingPermissions(): PermissionRequest[] {
    return [...this.pendingPermissions.values()].map((p) => p.request);
  }

  subscribe(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onProviderTurn(handler: (providerTurnId: string) => string | null): void {
    this.providerTurnHandler = handler;
  }

  async getRuntimeInfo(): Promise<RuntimeInfo> {
    return {
      provider: "codex",
      sessionId: this.threadId,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
      thinkingOptionId: this.config.thinkingOptionId ?? null,
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    return []; // codex collaboration modes not yet surfaced (P1-05 slice)
  }

  async getCurrentMode(): Promise<string | null> {
    return this.config.modeId ?? null;
  }

  describePersistence(): AgentPersistenceHandle | null {
    return this.persistence;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeNotifications?.();
    this.unsubscribeRequests?.();
    // fail any pending permission requests so the app-server isn't hung
    for (const [, p] of this.pendingPermissions) {
      p.resolve({ answers: {} });
    }
    this.pendingPermissions.clear();
    // client lifecycle owned by provider — session close does not kill
    // a shared runtime other sessions may use.
  }

  #handleServerRequest(request: {
    id: string | number;
    method?: string;
    params?: Record<string, unknown>;
  }): Promise<unknown> | unknown {
    if (request.method !== "item/tool/requestUserInput") {
      return undefined;
    }
    const params = request.params ?? {};
    const requestId = String(request.id);
    const questions = normalizeQuestions(params.questions);
    const turnId = this.activeTurn?.gatewayTurnId;
    if (questions.length === 0 || !turnId) {
      return { answers: {} };
    }
    const permissionRequest: PermissionRequest = {
      requestId,
      taskId: "", // Gateway stamps at persist time (P1-06)
      turnId,
      kind: "provider_permission",
      risk: "low",
      summary: questions[0]?.question ?? "Codex requests user input",
      actionDigest: "",
      details: {
        tool: "requestUserInput",
        argsPreview: { questionCount: questions.length, questions },
        origin: "provider",
      },
      options: questions.flatMap((q) =>
        q.options.map((o) => ({
          id: o.id,
          label: o.label,
          kind: classifyOptionKind(o.id + " " + o.label),
        })),
      ),
    };
    const promise = new Promise<unknown>((resolve) => {
      this.pendingPermissions.set(requestId, {
        request: permissionRequest,
        questionIds: questions.map((q) => q.id),
        resolve,
      });
    });
    for (const l of this.listeners) {
      l({
        type: "permission.requested",
        turnId,
        request: permissionRequest,
      });
    }
    // also emit permission.resolved when answered — handled in respondToPermission below
    return promise;
  }
}

function normalizeQuestions(value: unknown): Array<{
  id: string;
  question: string;
  options: Array<{ id: string; label: string }>;
}> {
  if (!Array.isArray(value)) return [];
  return value
    .map((q) => {
      const r = q as Record<string, unknown>;
      const options = Array.isArray(r.options)
        ? (r.options as Array<Record<string, unknown>>).map((o) => ({
            id: String(o.id ?? ""),
            label: String(o.label ?? o.id ?? ""),
          }))
        : [];
      return {
        id: String(r.id ?? ""),
        question: String(r.question ?? ""),
        options: options.filter((o) => o.id),
      };
    })
    .filter((q) => q.id);
}

function classifyOptionKind(text: string): "allow_once" | "allow_task" | "deny" {
  if (/deny|reject|no|cancel/iu.test(text)) return "deny";
  if (/always|every|task|session|all/iu.test(text)) return "allow_task";
  return "allow_once";
}

export function buildCodexInputItems(input: TurnInput): CodexTurnInputItem[] {
  const items: CodexTurnInputItem[] = [];
  const textParts: string[] = [];
  for (const part of input.content) {
    if (part.type === "text") {
      textParts.push(part.text);
    } else if (part.type === "image") {
      items.push(
        part.artifactRef.startsWith("http://") || part.artifactRef.startsWith("https://")
          ? { type: "image", url: part.artifactRef }
          : { type: "localImage", path: part.artifactRef },
      );
    } else if (part.type === "file") {
      items.push({ type: "mention", name: part.name, path: part.artifactRef });
    } else if (part.type === "structured") {
      textParts.push(`\`\`\`json\n${JSON.stringify(part.data, null, 2)}\n\`\`\``);
    }
  }
  const text = [...textParts, input.ctx?.instructions ?? ""]
    .filter((s) => s.trim().length > 0)
    .join("\n\n");
  if (text) {
    items.unshift({ type: "text", text });
  }
  return items;
}
