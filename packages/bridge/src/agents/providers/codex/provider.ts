/**
 * CodexAgentProvider — AgentProvider over CodexAppServerClient (P1-05).
 *
 * One app-server client per provider instance; sessions share the
 * runtime process but own independent threads (thread/start|resume).
 * Catalog is fetched without creating a session (§8.4: never create a
 * session for catalog discovery) — models come from config/catalog
 * cache; live model list lands with provider.feature.codex.* RPCs.
 */

import type {
  AgenticRouteInput,
  AgenticRoutePlan,
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  BrowserDomActionPlan,
  BrowserDomSnapshot,
  FetchCatalogOptions,
  LaunchContext,
  ProviderCatalog,
} from "@codex-sidepanel/shared";

import { CodexAgenticRouterPlane } from "../../../agentic-router.js";
import { CodexBrowserActionPlane } from "../../../browser-actions.js";
import { CodexAppServerClient } from "../../../codex-app-server.js";
import { BridgeHarnessRuntime } from "../../../harness.js";
import { CODEX_CAPABILITIES, CodexAgentSession, probeCodexGoalSupport } from "./session.js";
import { invokeCodexFeature } from "./features.js";

/** Minimal secret-store surface the provider needs for the legacy
 *  apiKey-login contract (stores the OpenAI key for realtime
 *  translation; Codex auth itself stays ChatGPT OAuth — see
 *  CHROMEX_API_KEY_AUTH_DISABLED_ERROR in codex-plane). */
export interface CodexProviderSecrets {
  setOpenAiApiKey(apiKey: string): void;
  clearOpenAiApiKey(): void;
  hasOpenAiApiKey(): boolean;
}

/** Normalized app-server `account/login/completed` payload (chromex-fjr). */
export interface CodexAccountLoginCompleted {
  loginId: string;
  success: boolean;
  error: string | null;
}

export interface CodexProviderOptions {
  client?: CodexAppServerClient;
  /** provider-level overrides (command path etc.) applied to client */
  command?: string | null;
  /** sidecar-compatible secret store; enables apiKey login + the
   *  openAiApiKeyConfigured flag on account.status. */
  secrets?: CodexProviderSecrets;
  /** external skill scan roots merged into skills.list (sidecar
   *  listExternalSkillRoots parity — chromex-fya). */
  externalSkillRoots?: () => Promise<string[]>;
  /** app-server `account/login/completed` is provider-global (no task,
   *  no turn) — the host (gateway) persists/broadcasts it as a durable
   *  gateway-stream event so clients refresh account.status. */
  onAccountLoginCompleted?: (event: CodexAccountLoginCompleted) => void;
}

export class CodexAgentProvider implements AgentProvider {
  readonly id = "codex" as const;
  readonly displayName = "Codex";
  readonly capabilities = CODEX_CAPABILITIES;

  private readonly client: CodexAppServerClient;
  private readonly ownsClient: boolean;
  private readonly secrets: CodexProviderSecrets | null;
  private readonly externalSkillRoots: (() => Promise<string[]>) | null;
  private readonly onAccountLoginCompleted: CodexProviderOptions["onAccountLoginCompleted"];
  private unsubscribeAppServer: (() => void) | null = null;
  private sessionCounter = 0;
  /** one app-server probe per provider process — thread/goal/* is a
   *  version-dependent RPC surface, so the catalog/session capability
   *  flag reflects the actual binary, not a static assumption. */
  private goalProbe: Promise<boolean> | null = null;
  private routePlane?: CodexAgenticRouterPlane;
  private browserActionPlane?: CodexBrowserActionPlane;
  private planningHarness?: BridgeHarnessRuntime;

  constructor(options: CodexProviderOptions = {}) {
    // experimentalApi matches the legacy sidecar client (cli.ts,
    // codex-plane.ts) — required for turn/start collaborationMode
    // (plan mode → requestUserInput).
    this.client = options.client ?? new CodexAppServerClient({ experimentalApi: true });
    this.ownsClient = !options.client;
    this.secrets = options.secrets ?? null;
    this.externalSkillRoots = options.externalSkillRoots ?? null;
    this.onAccountLoginCompleted = options.onAccountLoginCompleted;
    if (options.command !== undefined) {
      void this.client.configure({ command: options.command });
    }
    // Provider-global notifications never pass through a session's
    // CodexEventMapper (no turnId → dropped), so the provider subscribes
    // directly on the shared client (chromex-fjr).
    if (this.onAccountLoginCompleted) {
      this.unsubscribeAppServer = this.client.onNotification((n) => {
        if (n.method !== "account/login/completed") return;
        const p = (n.params ?? {}) as Record<string, unknown>;
        this.onAccountLoginCompleted?.({
          loginId: typeof p.loginId === "string" ? p.loginId : "",
          success: p.success === true,
          error: p.error === undefined || p.error === null ? null : String(p.error),
        });
      });
    }
  }

  async isAvailable(signal?: AbortSignal): Promise<{
    available: boolean;
    version?: string;
    reason?: string;
  }> {
    try {
      const resolution = await this.client.inspectRuntime();
      if (signal?.aborted) return { available: false, reason: "aborted" };
      return resolution.resolvedCommand
        ? { available: true, version: resolution.source }
        : { available: false, reason: "codex command not resolved" };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /** Memoized thread/goal/* probe — true unless the app-server
   *  explicitly lacks the methods (older codex binaries). */
  private goalModeSupported(): Promise<boolean> {
    this.goalProbe ??= probeCodexGoalSupport(this.client).catch(() => true);
    return this.goalProbe;
  }

  async fetchCatalog(_opts: FetchCatalogOptions): Promise<ProviderCatalog> {
    const capabilities = {
      ...CODEX_CAPABILITIES,
      goalMode: await this.goalModeSupported(),
    };
    // Live app-server model/list — no session created (§8.4). Models the
    // configured model_provider cannot serve are filtered downstream by
    // the §5.8 `models` allowlist in the registry.
    try {
      const result = (await this.client.request("model/list", {
        limit: 50,
        includeHidden: false,
      })) as { data?: Array<Record<string, unknown>> };
      const models = (result.data ?? [])
        .map((m) => {
          const id = String(m.model ?? m.id ?? "").trim();
          if (!id || m.hidden === true) return null;
          const efforts = Array.isArray(m.supportedReasoningEfforts)
            ? m.supportedReasoningEfforts
                .map((o) =>
                  typeof o === "string"
                    ? o
                    : String(
                        (o as Record<string, unknown>).reasoningEffort ??
                          (o as Record<string, unknown>).value ??
                          (o as Record<string, unknown>).id ??
                          "",
                      ),
                )
                .filter((e) => e.length > 0)
            : [];
          return {
            id,
            label: String(m.displayName ?? "").trim() || id,
            description: String(m.description ?? "").trim(),
            metadata: {
              isDefault: m.isDefault === true,
              supportsImages: Array.isArray(m.inputModalities) && m.inputModalities.includes("image"),
              reasoningEfforts: efforts,
              ...(typeof m.defaultReasoningEffort === "string"
                ? { defaultReasoningEffort: m.defaultReasoningEffort }
                : {}),
            },
          };
        })
        .filter((m): m is NonNullable<typeof m> => m !== null);
      const defaultModel =
        models.find((m) => m.metadata.isDefault === true)?.id ?? null;
      return {
        providerId: "codex",
        displayName: "Codex",
        models,
        modes: [],
        defaultModel,
        fetchedAt: Date.now(),
        capabilities,
      };
    } catch {
      return {
        providerId: "codex",
        displayName: "Codex",
        models: [],
        modes: [],
        fetchedAt: Date.now(),
        capabilities,
      };
    }
  }

  async createSession(
    config: AgentSessionConfig,
    ctx: LaunchContext,
  ): Promise<AgentSession> {
    this.sessionCounter += 1;
    const sessionKey = `codex-${Date.now().toString(36)}-${this.sessionCounter}`;
    const session = new CodexAgentSession(this.client, config, ctx, sessionKey);
    session.goalModeSupported = await this.goalModeSupported();
    return session;
  }

  async resumeSession(
    handle: Parameters<AgentProvider["resumeSession"]>[0],
    config: Parameters<AgentProvider["resumeSession"]>[1],
    ctx: LaunchContext,
  ): Promise<AgentSession> {
    return this.createSession(
      { ...config, provider: "codex", resume: { persistence: handle } },
      ctx,
    );
  }

  /**
   * route.plan — agentic pre-prompt routing. Runs on the provider's shared
   * app-server client (ephemeral planner threads, same runtime as
   * sessions). BridgeEvents are dropped: the gateway response carries the
   * plan, and gatewayMode clients do not consume legacy route events.
   */
  async planRoute(input: AgenticRouteInput): Promise<AgenticRoutePlan> {
    this.routePlane ??= new CodexAgenticRouterPlane({
      client: this.client,
      harness: this.planningRuntime(),
    });
    return this.routePlane.plan(input, () => undefined);
  }

  /** browser.action.plan — DOM action planner on the same shared runtime. */
  async planBrowserAction(params: {
    message: string;
    snapshot: BrowserDomSnapshot;
    locale?: string;
    generatedText?: string;
  }): Promise<BrowserDomActionPlan> {
    this.browserActionPlane ??= new CodexBrowserActionPlane({
      client: this.client,
      harness: this.planningRuntime(),
    });
    return this.browserActionPlane.plan(params, () => undefined);
  }

  private planningRuntime(): BridgeHarnessRuntime {
    this.planningHarness ??= new BridgeHarnessRuntime();
    return this.planningHarness;
  }

  /**
   * Capability-gated feature RPC (§8.2). Only methods registered in
   * CODEX_FEATURES with their own Zod schema are reachable — there is
   * no free-form provider.feature.call.
   *
   * account.* carve-outs (legacy sidecar parity):
   * - login.start type=apiKey never reaches the app-server — it stores
   *   the OpenAI key in the secret store (realtime-translation key),
   *   same as AppServerCodexPlane.login.
   * - logout also clears that stored key.
   * - account.status is enriched with openAiApiKeyConfigured, which the
   *   raw account/read result cannot know.
   */
  async callFeature(method: string, payload: unknown): Promise<unknown> {
    if (method === "provider.feature.codex.account.login.start") {
      const p = payload as { type?: unknown; apiKey?: unknown } | null;
      if (p?.type === "apiKey") {
        const apiKey = typeof p.apiKey === "string" ? p.apiKey : "";
        if (!apiKey) {
          throw new Error("API key login requires params.apiKey");
        }
        if (!this.secrets) {
          throw new Error("API-key login requires the bridge secret store (not configured for this provider)");
        }
        this.secrets.setOpenAiApiKey(apiKey);
        return { stored: true };
      }
    }
    if (method === "provider.feature.codex.skills.list" && this.externalSkillRoots) {
      const p = (payload ?? {}) as Record<string, unknown>;
      if (!Array.isArray(p.extraUserRoots)) {
        const roots = await this.externalSkillRoots().catch(() => [] as string[]);
        if (roots.length) {
          payload = { ...p, extraUserRoots: roots };
        }
      }
    }
    const result = await invokeCodexFeature(this.client, method, payload);
    if (method === "provider.feature.codex.account.logout") {
      this.secrets?.clearOpenAiApiKey();
    }
    if (
      method === "provider.feature.codex.account.status" &&
      result !== null &&
      typeof result === "object"
    ) {
      return {
        ...(result as Record<string, unknown>),
        openAiApiKeyConfigured: this.secrets?.hasOpenAiApiKey() ?? false,
      };
    }
    return result;
  }

  async shutdown(): Promise<void> {
    this.unsubscribeAppServer?.();
    this.unsubscribeAppServer = null;
    if (this.ownsClient) {
      await this.client.shutdown();
    }
  }
}
