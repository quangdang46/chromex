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
    this.unsubscribeNotifications = this.client.onNotification((n) =>
      this.mapper.mapNotification(n.method, n.params),
    );
    this.unsubscribeRequests =
      this.client.onRequest?.(
        (request) => this.#handleServerRequest(request),
        { concurrency: "parallel" },
      ) ?? null;
  }

  async #ensureThread(): Promise<string> {
    if (this.threadId) return this.threadId;
    const cwd = this.ctx.cwd;
    if (this.config.resume?.persistence) {
      const result = (await this.client.request("thread/resume", {
        threadId: this.config.resume.persistence.ref,
        excludeTurns: true,
        personality: "pragmatic",
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

    const turn = await requestTurnStartWithReasoningSummaryFallback(
      this.client,
      async () => undefined,
      {
        threadId,
        input: items,
        ...(cwd ? { cwd } : {}),
        ...(this.config.model ? { model: this.config.model } : {}),
        ...(this.config.thinkingOptionId ? { effort: this.config.thinkingOptionId } : {}),
        approvalPolicy: "never",
        personality: "pragmatic",
      },
    );

    this.activeTurn = { gatewayTurnId: input.gatewayTurnId, providerTurnId: turn.turn.id };
    this.mapper.bindTurn(turn.turn.id, input.gatewayTurnId);
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
    } finally {
      this.activeTurn = null;
      this.mapper.unbindTurn();
    }
    await terminal;
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
    const answers: Record<string, { answers: string[] }> = {};
    // compat path may pass an option label where an id is expected —
    // resolve either, then answer with the canonical option id.
    const option =
      pending.request.options.find((o) => o.id === response.optionId) ??
      pending.request.options.find((o) => o.label === response.optionId);
    const answerValue = option?.id ?? response.optionId;
    for (const qid of pending.questionIds) {
      answers[qid] = { answers: [answerValue] };
    }
    pending.resolve({ answers });
    for (const l of this.listeners) {
      l({
        type: "permission.resolved",
        requestId,
        decision: {
          optionId: response.optionId,
          kind: pending.request.options.find((o) => o.id === response.optionId)?.kind ?? "allow_once",
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
