/**
 * AcpAgentSession — AgentSession over Agent Client Protocol (stdio
 * JSON-RPC). Mechanism per docs/adr/acp-provider.md.
 *
 * One ACP subprocess per session. Turns are serialized: startTurn
 * enqueues onto an internal chain; session/prompt is request/response
 * and its resolution is the turn terminal. session/update notifications
 * stream deltas/tool events via AcpEventMapper.
 */

import type {
  AgentEvent,
  AgentSession,
  AgentSessionConfig,
  AgentCapabilityFlags,
  AgentMode,
  LaunchContext,
  PermissionRequest,
  PermissionResponse,
  PermissionResponseResult,
  ProviderId,
  RuntimeInfo,
  SlashCommand,
  TurnInput,
} from "@codex-sidepanel/shared";
import { NO_CAPABILITIES, protocolError } from "@codex-sidepanel/shared";

import { AcpClient, AcpRpcError } from "./client.js";
import { AcpEventMapper } from "./mapper.js";

export const ACP_BASE_CAPABILITIES: AgentCapabilityFlags = {
  ...NO_CAPABILITIES,
  streaming: true,
  reasoningSummary: true,
  toolEvents: true,
  interrupt: true,
  resume: true, // refined per-agent: loadSession capability
  modelSelection: true,
  permissionPrompts: true,
  slashCommands: true,
  usage: true,
};

const INTERRUPT_WAIT_MS = 30_000;

interface PendingPermission {
  request: PermissionRequest;
  resolve: (outcome: unknown) => void;
}

interface ConfigOption {
  id?: string;
  name?: string;
  category?: string;
  type?: string;
  currentValue?: string;
  options?: Array<{ value?: string; name?: string }>;
}

const ACP_OPTION_KINDS = new Set(["allow_once", "allow_always", "reject_once", "reject_always"]);

function acpKindToOurs(kind: string | undefined): "allow_once" | "allow_task" | "deny" {
  if (kind === "allow_once") return "allow_once";
  if (kind === "allow_always") return "allow_task";
  return "deny";
}

export class AcpAgentSession implements AgentSession {
  readonly provider: ProviderId;
  readonly sessionKey: string;
  readonly capabilities: AgentCapabilityFlags;

  private readonly config: AgentSessionConfig;
  private readonly ctx: LaunchContext;
  private readonly mapper = new AcpEventMapper();
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();

  private client: AcpClient | null = null;
  private started: Promise<void> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private activePrompt: { gatewayTurnId: string; done: Promise<void> } | null = null;
  private persistence: { provider: ProviderId; ref: string; kind: string } | null = null;
  private closed = false;
  private loadSessionSupported = false;

  constructor(
    providerId: ProviderId,
    displayCapabilities: Partial<AgentCapabilityFlags>,
    config: AgentSessionConfig,
    ctx: LaunchContext,
    sessionKey: string,
    private readonly spawnSpec: { command: string; args: string[] },
  ) {
    this.provider = providerId;
    this.config = config;
    this.ctx = ctx;
    this.sessionKey = sessionKey;
    this.capabilities = { ...ACP_BASE_CAPABILITIES, ...displayCapabilities };
    this.mapper.onEvent((item) => {
      if (
        !item.ephemeral &&
        this.activePrompt &&
        (item.event.type === "turn.completed" ||
          item.event.type === "turn.cancelled" ||
          item.event.type === "turn.failed") &&
        (item.event as { turnId?: string }).turnId === this.activePrompt.gatewayTurnId
      ) {
        this.activePrompt = null;
      }
      for (const l of this.listeners) {
        l(item.deltaOffset !== undefined ? ({ ...item.event, deltaOffset: item.deltaOffset } as AgentEvent) : item.event);
      }
    });
  }

  // ---- lifecycle ----

  async #ensureStarted(): Promise<AcpClient> {
    if (this.client) return this.client;
    if (!this.started) {
      this.started = this.#start();
    }
    await this.started;
    return this.client!;
  }

  async #start(): Promise<void> {
    const client = new AcpClient({
      command: this.spawnSpec.command,
      args: this.spawnSpec.args,
      ...(this.ctx.cwd ? { cwd: this.ctx.cwd } : {}),
      ...(this.ctx.env ? { env: this.ctx.env } : {}),
    });
    this.client = client;
    client.start();

    const init = (await client.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
      },
    })) as {
      protocolVersion?: number;
      agentCapabilities?: {
        loadSession?: boolean;
        promptCapabilities?: { image?: boolean };
      };
      authMethods?: Array<{ id?: string; name?: string }>;
      agentInfo?: { name?: string; version?: string };
    };
    this.loadSessionSupported = init.agentCapabilities?.loadSession === true;
    if (!this.loadSessionSupported) {
      // honest downgrade — resume claims would be false
      this.capabilities.resume = false;
    }
    if (init.agentCapabilities?.promptCapabilities?.image !== true) {
      this.capabilities.imageInput = false;
    }

    client.onNotification("session/update", (params) => {
      // ACP wraps the update: {sessionId, update: {sessionUpdate, ...}}
      const inner = (params as { update?: unknown } | null)?.update;
      this.mapper.mapUpdate(inner ?? params);
    });
    client.onAgentRequest("session/request_permission", (params) =>
      this.#handlePermissionRequest(params),
    );
    // fs/terminal requests are not serviced — explicit refusal is better
    // than silence (agent falls back to its own tools).
    for (const m of ["fs/read_text_file", "fs/write_text_file", "terminal/create", "terminal/output", "terminal/release", "terminal/wait_for_exit", "terminal/kill"]) {
      client.onAgentRequest(m, () => {
        throw new Error(`Chromex does not service ${m}`);
      });
    }

    const resumeRef = this.config.resume?.persistence?.ref;
    let sessionResult: { sessionId?: string; configOptions?: unknown; modes?: unknown };
    if (resumeRef && this.loadSessionSupported) {
      sessionResult = (await client.request("session/load", {
        sessionId: resumeRef,
        cwd: this.ctx.cwd ?? process.cwd(),
        mcpServers: this.#mcpServers(),
      })) as typeof sessionResult;
    } else {
      sessionResult = (await client.request("session/new", {
        cwd: this.ctx.cwd ?? process.cwd(),
        mcpServers: this.#mcpServers(),
      })) as typeof sessionResult;
    }
    const sessionId = String(sessionResult.sessionId ?? "");
    if (!sessionId) throw new Error("ACP session/new returned no sessionId");
    this.mapper.seedSession(sessionId, sessionResult.configOptions);
    if (sessionResult.configOptions) {
      // apply configured model/mode before first turn
      await this.#applyConfigOptions(sessionResult.configOptions as ConfigOption[]);
    }
    this.persistence = { provider: this.provider, ref: sessionId, kind: "session" };
  }

  /** config.options.mcpServers → ACP session/new|load `mcpServers`.
   *  ACP stdio McpServer shape: {name, command, args, env} where env is
   *  EnvVariable[] ({name,value} pairs) — NOT a record. */
  #mcpServers(): unknown[] {
    const servers = this.config.options?.mcpServers as
      | Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>
      | undefined;
    if (!servers) return [];
    const out: unknown[] = [];
    for (const [name, srv] of Object.entries(servers)) {
      if (!srv?.command) continue;
      out.push({
        name,
        command: srv.command,
        args: srv.args ?? [],
        env: Object.entries(srv.env ?? {}).map(([k, v]) => ({ name: k, value: v })),
      });
    }
    return out;
  }

  async #applyConfigOptions(options: ConfigOption[]): Promise<void> {
    if (!this.client) return;
    const sessionId = this.mapper.info.sessionId;
    if (!sessionId) return;
    for (const opt of options) {
      const id = String(opt.id ?? "");
      if (id === "model" && this.config.model) {
        await this.#setConfigOption("model", this.config.model);
      } else if ((opt.category === "mode" || id === "mode") && this.config.modeId) {
        await this.client.request("session/set_mode", {
          sessionId,
          modeId: this.config.modeId,
        }).catch(() => this.#setConfigOption(id, this.config.modeId!));
      }
    }
  }

  async #setConfigOption(configId: string, value: string): Promise<void> {
    const sessionId = this.mapper.info.sessionId;
    if (!this.client || !sessionId) return;
    await this.client.request("session/set_config_option", {
      sessionId,
      configId,
      value,
    });
  }

  // ---- AgentSession ----

  startTurn(input: TurnInput): Promise<{ accepted: true; providerTurnId?: string }> {
    const run = this.chain.then(() => this.#runTurn(input));
    this.chain = run.catch(() => {});
    return Promise.resolve({ accepted: true as const });
  }

  async #runTurn(input: TurnInput): Promise<void> {
    const client = await this.#ensureStarted();
    const sessionId = this.mapper.info.sessionId;
    if (!sessionId) {
      this.mapper.bindTurn(input.gatewayTurnId);
      this.mapper.finishTurn(undefined, true, "ACP session missing sessionId");
      this.mapper.unbindTurn();
      return;
    }
    const text = input.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    const promptText = input.ctx?.instructions ? `${input.ctx.instructions}\n\n${text}` : text;
    const prompt = [{ type: "text", text: promptText }];

    this.mapper.bindTurn(input.gatewayTurnId);
    let doneResolve!: () => void;
    const done = new Promise<void>((r) => {
      doneResolve = r;
    });
    this.activePrompt = { gatewayTurnId: input.gatewayTurnId, done };

    try {
      const result = (await client.request("session/prompt", {
        sessionId,
        prompt,
      })) as { stopReason?: string };
      this.mapper.finishTurn(result?.stopReason);
    } catch (error) {
      this.mapper.finishTurn(
        undefined,
        true,
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      doneResolve();
      this.mapper.unbindTurn();
      this.activePrompt = null;
    }
  }

  async steer(_input: TurnInput): Promise<{ status: "accepted" | "unavailable" }> {
    return { status: "unavailable" };
  }

  async interrupt(): Promise<void> {
    const active = this.activePrompt;
    if (!active || !this.client) return;
    this.mapper.markInterruptRequested();
    const sessionId = this.mapper.info.sessionId;
    if (sessionId) {
      this.client.notify("session/cancel", { sessionId });
    }
    await Promise.race([
      active.done,
      new Promise<void>((r) => setTimeout(r, INTERRUPT_WAIT_MS).unref()),
    ]);
  }

  canStopRuntime(): boolean {
    return this.activePrompt === null;
  }

  // ---- permissions ----

  async #handlePermissionRequest(params: unknown): Promise<unknown> {
    const p = params as {
      sessionId?: string;
      toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown };
      options?: Array<{ optionId?: string; name?: string; kind?: string }>;
    };
    const requestId = `acp-perm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const turnId = this.activePrompt?.gatewayTurnId;
    const acpOptions = Array.isArray(p.options) ? p.options : [];
    const request: PermissionRequest = {
      requestId,
      taskId: "",
      ...(turnId ? { turnId } : {}),
      kind: "provider_permission",
      risk: "low",
      summary: `Agent requests permission: ${p.toolCall?.title ?? p.toolCall?.kind ?? "tool call"}`,
      actionDigest: "",
      details: {
        tool: String(p.toolCall?.kind ?? p.toolCall?.title ?? "tool"),
        argsPreview: p.toolCall?.rawInput ?? {},
        origin: "provider",
      },
      options: acpOptions
        .filter((o) => typeof o.optionId === "string" && o.optionId)
        .map((o) => ({
          id: String(o.optionId),
          label: String(o.name ?? o.optionId),
          kind: ACP_OPTION_KINDS.has(String(o.kind)) ? acpKindToOurs(o.kind) : ("deny" as const),
        })),
    };
    if (request.options.length === 0) {
      request.options = [
        { id: "allow_once", label: "Allow once", kind: "allow_once" },
        { id: "deny", label: "Deny", kind: "deny" },
      ];
    }
    const outcome = new Promise<unknown>((resolve) => {
      this.pendingPermissions.set(requestId, { request, resolve });
    });
    for (const l of this.listeners) {
      l({
        type: "permission.requested",
        ...(turnId ? { turnId } : {}),
        request,
      } as AgentEvent);
    }
    return outcome ?? { outcome: { outcome: "cancelled" } };
  }

  async respondToPermission(
    requestId: string,
    response: PermissionResponse,
  ): Promise<PermissionResponseResult> {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return {};
    this.pendingPermissions.delete(requestId);
    const optionId = response.optionId ?? "";
    const allow = optionId !== "" && optionId !== "deny" && !optionId.startsWith("reject");
    pending.resolve({
      outcome: allow
        ? { outcome: "selected", optionId }
        : { outcome: "cancelled" },
    });
    const option = pending.request.options.find((o) => o.id === optionId);
    for (const l of this.listeners) {
      l({
        type: "permission.resolved",
        requestId,
        decision: {
          optionId: optionId || "cancelled",
          kind: option?.kind ?? (allow ? "allow_once" : "deny"),
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
    const info = this.mapper.info;
    const modelOpt = info.configOptions.find((o) => o.id === "model" || o.category === "model");
    return {
      provider: this.provider,
      sessionId: info.sessionId,
      model: this.config.model ?? modelOpt?.currentValue ?? null,
      modeId: info.currentModeId ?? this.config.modeId ?? null,
      ...(this.config.thinkingOptionId ? { thinkingOptionId: this.config.thinkingOptionId } : {}),
    };
  }

  async getAvailableModes(): Promise<AgentMode[]> {
    const info = this.mapper.info;
    const modeOpt = info.configOptions.find((o) => o.category === "mode" || o.id === "mode");
    if (modeOpt?.options?.length) {
      return modeOpt.options
        .filter((o) => typeof o.value === "string")
        .map((o) => ({ id: String(o.value), label: String(o.name ?? o.value) }));
    }
    if (info.currentModeId) return [{ id: info.currentModeId, label: info.currentModeId }];
    return [];
  }

  async getCurrentMode(): Promise<string | null> {
    return this.mapper.info.currentModeId ?? this.config.modeId ?? null;
  }

  async setMode(modeId: string): Promise<void> {
    const sessionId = this.mapper.info.sessionId;
    if (!this.client || !sessionId) return;
    try {
      await this.client.request("session/set_mode", { sessionId, modeId });
    } catch {
      await this.#setConfigOption("mode", modeId);
    }
  }

  async setModel(model: string | null): Promise<void> {
    if (model) await this.#setConfigOption("model", model);
  }

  async setThinkingOption(id: string | null): Promise<void> {
    if (!id) return;
    const opt = this.mapper.info.configOptions.find(
      (o) => o.category === "thought_level" || o.category === "thinking" || o.id === "thinking",
    );
    if (opt?.id) await this.#setConfigOption(String(opt.id), id);
  }

  async listCommands(): Promise<SlashCommand[]> {
    return this.mapper.info.commands;
  }

  describePersistence(): { provider: ProviderId; ref: string; kind: string } | null {
    return this.persistence;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pendingPermissions) {
      p.resolve({ outcome: { outcome: "cancelled" } });
    }
    this.pendingPermissions.clear();
    const client = this.client;
    const sessionId = this.mapper.info.sessionId;
    if (client && sessionId) {
      try {
        await client.request("session/close", { sessionId });
      } catch {
        /* best effort */
      }
    }
    try {
      await client?.close();
    } catch {
      /* best effort */
    }
    await this.chain.catch(() => {});
    for (const l of this.listeners) {
      l({ type: "conversation.closed", sessionKey: this.sessionKey, reason: "closed" });
    }
  }
}
