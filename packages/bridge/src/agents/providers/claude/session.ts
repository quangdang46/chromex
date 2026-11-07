/**
 * ClaudeAgentSession — AgentSession over @anthropic-ai/claude-agent-sdk.
 * Mechanism per docs/adr/claude-mechanism.md (spike-B3, Option A).
 *
 * One query() per session with a streaming (AsyncIterable) prompt:
 * startTurn enqueues an SDKUserMessage stamped with a per-turn UUID;
 * the SDK processes turns sequentially. interrupt() → query.interrupt()
 * + bounded ownership wait for the terminal result. Steer is NOT
 * native — returns unavailable (ADR: steer = interrupt → new turn,
 * which SessionManager already does for followUpPrompt).
 */

import { randomUUID } from "node:crypto";

import {
  query,
  type EffortLevel,
  type Options,
  type PermissionResult,
  type Query,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentEvent,
  AgentSession,
  AgentSessionConfig,
  AgentCapabilityFlags,
  LaunchContext,
  PermissionRequest,
  PermissionResponse,
  PermissionResponseResult,
  ProviderId,
  RuntimeInfo,
  TurnInput,
} from "@codex-sidepanel/shared";
import { NO_CAPABILITIES } from "@codex-sidepanel/shared";

import { ClaudeEventMapper, permissionRequestForToolCall } from "./mapper.js";

export const CLAUDE_CAPABILITIES: AgentCapabilityFlags = {
  ...NO_CAPABILITIES,
  streaming: true,
  reasoningSummary: true, // thinking blocks → reasoning.summary (bounded)
  toolEvents: true,
  interrupt: true,
  resume: true, // resume: session_id once observed
  modelSelection: true,
  thinkingOption: true, // effort via thinking option → mapped in provider options
  permissionPrompts: true, // canUseTool → permission.requested
  mcpTools: true, // options.mcpServers
  imageInput: true,
  slashCommands: true, // supportedCommands()
  usage: true, // result.usage
};

const INTERRUPT_WAIT_MS = 30_000;

interface PendingPermission {
  request: PermissionRequest;
  resolve: (r: PermissionResult | null) => void;
  /** set when the pending request is an AskUserQuestion dialog — the
   *  SDK contract is canUseTool → allow + updatedInput.answers keyed by
   *  question text (agent-sdk user-input docs). */
  askUser?: {
    questions: AskUserQuestionEntry[];
    /** raw questions array from tool input, passed back verbatim */
    inputQuestions: unknown;
  };
}

/** Normalized AskUserQuestion entry — id is positional (q0..q3) since
 *  the SDK question shape has no id; answers map back via questionText. */
interface AskUserQuestionEntry {
  id: string;
  questionText: string;
  header: string;
  options: Array<{ id: string; label: string; description?: string }>;
  multiSelect?: boolean;
}

/** Minimal async queue feeding the SDK streaming prompt. */
class PromptQueue {
  private readonly items: SDKUserMessage[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(msg: SDKUserMessage): void {
    this.items.push(msg);
    this.waiter?.();
  }

  close(): void {
    this.closed = true;
    this.waiter?.();
  }

  itemsLength(): number {
    return this.items.length;
  }

  async *iterate(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      while (this.items.length > 0) yield this.items.shift()!;
      if (this.closed) return;
      await new Promise<void>((r) => {
        this.waiter = r;
      });
      this.waiter = null;
    }
  }
}

export class ClaudeAgentSession implements AgentSession {
  readonly provider: ProviderId = "claude";
  readonly sessionKey: string;
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly config: AgentSessionConfig;
  private readonly ctx: LaunchContext;
  private readonly mapper = new ClaudeEventMapper();
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly queue = new PromptQueue();

  private sdkQuery: Query | null = null;
  private pumpDone: Promise<void> | null = null;
  private activeTurn: { gatewayTurnId: string; providerTurnId: string } | null = null;
  private persistence: { provider: "claude"; ref: string; kind: string } | null = null;
  private closed = false;
  /** extra env from provider config.command/env handled by provider */
  constructor(
    config: AgentSessionConfig,
    ctx: LaunchContext,
    sessionKey: string,
    private readonly sdkOptions: {
      pathToClaudeCodeExecutable?: string;
      /** test seam: override the SDK query factory */
      queryFactory?: (args: { prompt: AsyncIterable<SDKUserMessage>; options: Options }) => Query;
    } = {},
  ) {
    this.config = config;
    this.ctx = ctx;
    this.sessionKey = sessionKey;
    this.mapper.onEvent((item) => {
      if (
        !item.ephemeral &&
        this.activeTurn &&
        (item.event.type === "turn.completed" ||
          item.event.type === "turn.cancelled" ||
          item.event.type === "turn.failed") &&
        (item.event as { turnId?: string }).turnId === this.activeTurn.gatewayTurnId
      ) {
        this.activeTurn = null;
      }
      for (const l of this.listeners) {
        l(item.deltaOffset !== undefined ? ({ ...item.event, deltaOffset: item.deltaOffset } as AgentEvent) : item.event);
      }
    });
  }

  // ---- query lifecycle ----

  #ensureQuery(): Query {
    if (this.sdkQuery) return this.sdkQuery;
    const options: Options = {
      ...(this.ctx.cwd ? { cwd: this.ctx.cwd } : {}),
      permissionMode: "default",
      includePartialMessages: true,
      canUseTool: (toolName, input, opts) => this.#canUseTool(toolName, input, opts),
      ...(this.config.model ? { model: this.config.model } : {}),
      ...(this.config.resume?.persistence?.ref
        ? { resume: this.config.resume.persistence.ref }
        : {}),
      ...(this.sdkOptions.pathToClaudeCodeExecutable
        ? { pathToClaudeCodeExecutable: this.sdkOptions.pathToClaudeCodeExecutable }
        : {}),
    };
    const mcpServers = this.#mcpServers();
    if (mcpServers) options.mcpServers = mcpServers;
    const effort = this.#effort();
    if (effort) options.effort = effort;
    const env =
      this.ctx.env && Object.keys(this.ctx.env).length
        ? ({ ...process.env, ...this.ctx.env } as Record<string, string>)
        : undefined;
    if (env) options.env = env;
    this.sdkQuery = this.sdkOptions.queryFactory
      ? this.sdkOptions.queryFactory({ prompt: this.queue.iterate(), options })
      : query({ prompt: this.queue.iterate(), options });
    this.pumpDone = this.#pump();
    return this.sdkQuery;
  }

  async #pump(): Promise<void> {
    try {
      for await (const msg of this.sdkQuery!) {
        this.mapper.mapMessage(msg);
        if (!this.persistence && this.mapper.sessionId) {
          this.persistence = { provider: "claude", ref: this.mapper.sessionId, kind: "session" };
        }
      }
    } catch {
      /* iterator errors surface via result/error messages or close */
    }
  }

  /** thinkingOptionId → SDK effort level; unknown ids are ignored
   *  (honest: no silent mapping to a different budget). */
  #effort(): EffortLevel | undefined {
    const id = this.config.thinkingOptionId;
    if (id === "low" || id === "medium" || id === "high" || id === "xhigh" || id === "max") {
      return id;
    }
    return undefined;
  }

  #mcpServers(): Options["mcpServers"] {
    const servers = this.config.options?.mcpServers as
      | Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
      | undefined;
    if (!servers) return undefined;
    const out: Record<string, unknown> = {};
    for (const [name, srv] of Object.entries(servers)) {
      if (!srv?.command) continue;
      out[name] = {
        type: "stdio",
        command: srv.command,
        ...(srv.args?.length ? { args: srv.args } : {}),
        ...(srv.env ? { env: srv.env } : {}),
      };
    }
    return Object.keys(out).length ? (out as Options["mcpServers"]) : undefined;
  }

  // ---- AgentSession ----

  async startTurn(input: TurnInput): Promise<{ accepted: true; providerTurnId?: string }> {
    const q = this.#ensureQuery();
    void q;
    const uuid = randomUUID();
    const text = input.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    const message: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      uuid,
      ...(input.ctx?.instructions ? { client_composed: true } : {}),
    };
    // instructions ride along as a second text part is not supported on
    // user messages — prepend into content instead.
    if (input.ctx?.instructions) {
      (message.message as { content: string }).content = `${input.ctx.instructions}\n\n${text}`;
    }
    this.mapper.bindTurn(input.gatewayTurnId, uuid);
    this.activeTurn = { gatewayTurnId: input.gatewayTurnId, providerTurnId: uuid };
    this.queue.push(message);
    return { accepted: true as const, providerTurnId: uuid };
  }

  async steer(_input: TurnInput): Promise<{ status: "accepted" | "unavailable" }> {
    // ADR claude-mechanism: no native mid-turn steer — Gateway treats
    // followUpPrompt as a new turn instead.
    return { status: "unavailable" };
  }

  async interrupt(): Promise<void> {
    const turn = this.activeTurn;
    if (!turn || !this.sdkQuery) return;
    this.mapper.markInterruptRequested();
    const terminal = new Promise<void>((resolve) => {
      const unsub = this.mapper.onEvent((item) => {
        if (
          !item.ephemeral &&
          (item.event.type === "turn.completed" ||
            item.event.type === "turn.cancelled" ||
            item.event.type === "turn.failed") &&
          (item.event as { turnId?: string }).turnId === turn.gatewayTurnId
        ) {
          unsub();
          resolve();
        }
      });
      setTimeout(() => {
        unsub();
        resolve();
      }, INTERRUPT_WAIT_MS).unref();
    });
    try {
      await this.sdkQuery.interrupt();
      // keep the turn bound until the terminal result arrives so the
      // mapper can still attribute it
      await terminal;
    } finally {
      this.activeTurn = null;
      this.mapper.unbindTurn();
    }
  }

  canStopRuntime(): boolean {
    return this.activeTurn === null && this.queue.itemsLength() === 0;
  }

  // ---- permissions (canUseTool → permission.requested) ----

  async #canUseTool(
    toolName: string,
    input: Record<string, unknown>,
    opts: { toolUseID: string; requestId?: string; prompt?: string; description?: string },
  ): Promise<PermissionResult | null> {
    if (toolName === "AskUserQuestion") {
      return this.#canUseAskUserQuestion(input, opts);
    }
    const requestId = `perm-${opts.toolUseID || randomUUID()}`;
    const turnId = this.activeTurn?.gatewayTurnId;
    const request = permissionRequestForToolCall({
      requestId,
      ...(turnId ? { turnId } : {}),
      toolName,
      input,
      ...(opts.prompt ? { prompt: opts.prompt } : {}),
      ...(opts.description ? { description: opts.description } : {}),
    });
    const promise = new Promise<PermissionResult | null>((resolve) => {
      this.pendingPermissions.set(requestId, { request, resolve });
    });
    for (const l of this.listeners) {
      l({ type: "permission.requested", ...(turnId ? { turnId } : {}), request } as AgentEvent);
    }
    return promise;
  }

  /**
   * AskUserQuestion → permission.requested in the shared ask-user shape
   * (details.argsPreview.questions, same contract as codex
   * requestUserInput). Answers return through canUseTool as
   * `{behavior:"allow", updatedInput:{questions, answers}}` where
   * answers is keyed by question TEXT → selected label(s).
   */
  async #canUseAskUserQuestion(
    input: Record<string, unknown>,
    opts: { toolUseID: string },
  ): Promise<PermissionResult | null> {
    const requestId = `perm-${opts.toolUseID || randomUUID()}`;
    const turnId = this.activeTurn?.gatewayTurnId;
    const questions = normalizeAskUserQuestions(input.questions);
    if (questions.length === 0) {
      return { behavior: "deny", message: "AskUserQuestion input had no questions" };
    }
    const request: PermissionRequest = {
      requestId,
      taskId: "", // Gateway stamps at persist time
      ...(turnId ? { turnId } : {}),
      kind: "provider_permission",
      risk: "low",
      summary: questions[0]!.questionText,
      actionDigest: "",
      details: {
        tool: "AskUserQuestion",
        argsPreview: {
          questionCount: questions.length,
          questions: questions.map((q) => ({
            id: q.id,
            header: q.header,
            question: q.questionText,
            options: q.options.map((o) => ({
              id: o.id,
              label: o.label,
              ...(o.description ? { description: o.description } : {}),
            })),
            ...(q.multiSelect ? { multiSelect: true } : {}),
          })),
        },
        origin: "provider",
      },
      options: [
        { id: "submit", label: "Submit answers", kind: "allow_once" },
        { id: "deny", label: "Dismiss", kind: "deny" },
      ],
    };
    const promise = new Promise<PermissionResult | null>((resolve) => {
      this.pendingPermissions.set(requestId, {
        request,
        resolve,
        askUser: { questions, inputQuestions: input.questions },
      });
    });
    for (const l of this.listeners) {
      l({ type: "permission.requested", ...(turnId ? { turnId } : {}), request } as AgentEvent);
    }
    return promise;
  }

  async respondToPermission(
    requestId: string,
    response: PermissionResponse,
  ): Promise<PermissionResponseResult> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return {};
    this.pendingPermissions.delete(requestId);
    const optionId = response.optionId ?? "";
    const result: PermissionResult = pending.askUser
      ? this.#askUserResult(pending.askUser, response)
      : optionId === "allow" || optionId === "allow_once"
        ? { behavior: "allow" }
        : { behavior: "deny", message: "denied by user via Chromex" };
    pending.resolve(result);
    const option = pending.request.options.find((o) => o.id === optionId);
    const denied = result.behavior === "deny";
    for (const l of this.listeners) {
      l({
        type: "permission.resolved",
        requestId,
        decision: {
          optionId: optionId || (denied ? "deny" : "answered"),
          kind: option?.kind ?? (denied ? "deny" : "allow_once"),
          decidedAt: Date.now(),
          decidedBy: "user",
        },
      });
    }
    return {};
  }

  /** AskUserQuestion resolution: deny on dismiss/no answers, else allow
   *  with updatedInput.answers keyed by question text (SDK contract). */
  #askUserResult(
    askUser: NonNullable<PendingPermission["askUser"]>,
    response: PermissionResponse,
  ): PermissionResult {
    const optionId = response.optionId ?? "";
    const dismissed = optionId === "deny" || optionId.startsWith("reject");
    const provided = response.answers ?? {};
    const hasAnswers = askUser.questions.some((q) =>
      (provided[q.id] ?? []).some((a) => a.trim().length > 0),
    );
    if (dismissed || !hasAnswers) {
      return {
        behavior: "deny",
        message: dismissed ? "dismissed by user via Chromex" : "no answers provided",
      };
    }
    const answers: Record<string, string> = {};
    for (const q of askUser.questions) {
      const values = (provided[q.id] ?? [])
        .map((a) => a.trim())
        .filter((a) => a.length > 0);
      if (values.length > 0) {
        answers[q.questionText] = values.join(", ");
      }
    }
    return {
      behavior: "allow",
      updatedInput: {
        questions: askUser.inputQuestions,
        answers,
      },
    };
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
      provider: "claude",
      sessionId: this.mapper.sessionId,
      model: this.config.model ?? null,
      modeId: this.config.modeId ?? null,
      thinkingOptionId: this.config.thinkingOptionId ?? null,
    };
  }

  async getAvailableModes(): Promise<import("@codex-sidepanel/shared").AgentMode[]> {
    return []; // permission modes surfaced via config, not a picker yet (P3-04)
  }

  async getCurrentMode(): Promise<string | null> {
    return this.config.modeId ?? null;
  }

  async listCommands(): Promise<import("@codex-sidepanel/shared").SlashCommand[]> {
    if (!this.sdkQuery) return [];
    try {
      return await this.sdkQuery.supportedCommands();
    } catch {
      return [];
    }
  }

  describePersistence(): { provider: "claude"; ref: string; kind: string } | null {
    return this.persistence;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pendingPermissions) {
      p.resolve({ behavior: "deny", message: "session closed" });
    }
    this.pendingPermissions.clear();
    this.queue.close();
    try {
      await this.sdkQuery?.interrupt();
    } catch {
      /* best effort */
    }
    try {
      this.sdkQuery?.close();
    } catch {
      /* best effort */
    }
    await this.pumpDone?.catch(() => {});
    for (const l of this.listeners) {
      l({ type: "conversation.closed", sessionKey: this.sessionKey, reason: "closed" });
    }
  }
}

/** SDK AskUserQuestion input.questions → shared ask-user shape.
 *  Option id = label (the SDK answers contract uses labels as values). */
function normalizeAskUserQuestions(value: unknown): AskUserQuestionEntry[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((q, index) => {
      const r = q as Record<string, unknown>;
      const questionText = String(r.question ?? "").trim();
      if (!questionText) return null;
      const options = Array.isArray(r.options)
        ? (r.options as Array<Record<string, unknown>>)
            .map((o) => {
              const label = String(o.label ?? "").trim();
              if (!label) return null;
              const description = typeof o.description === "string" ? o.description.trim() : "";
              return {
                id: label,
                label,
                ...(description ? { description } : {}),
              };
            })
            .filter((o): o is NonNullable<typeof o> => o !== null)
        : [];
      const header = typeof r.header === "string" && r.header.trim() ? r.header.trim() : `Q${index + 1}`;
      const entry: AskUserQuestionEntry = {
        id: `q${index}`,
        questionText,
        header,
        options,
        ...(r.multiSelect === true ? { multiSelect: true } : {}),
      };
      return entry;
    })
    .filter((q): q is AskUserQuestionEntry => q !== null);
}
