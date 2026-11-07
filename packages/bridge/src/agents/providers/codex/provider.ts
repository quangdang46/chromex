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
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  FetchCatalogOptions,
  LaunchContext,
  ProviderCatalog,
} from "@codex-sidepanel/shared";

import { CodexAppServerClient } from "../../../codex-app-server.js";
import { CODEX_CAPABILITIES, CodexAgentSession } from "./session.js";
import { invokeCodexFeature } from "./features.js";

export interface CodexProviderOptions {
  client?: CodexAppServerClient;
  /** provider-level overrides (command path etc.) applied to client */
  command?: string | null;
}

export class CodexAgentProvider implements AgentProvider {
  readonly id = "codex" as const;
  readonly displayName = "Codex";
  readonly capabilities = CODEX_CAPABILITIES;

  private readonly client: CodexAppServerClient;
  private readonly ownsClient: boolean;
  private sessionCounter = 0;

  constructor(options: CodexProviderOptions = {}) {
    this.client = options.client ?? new CodexAppServerClient();
    this.ownsClient = !options.client;
    if (options.command !== undefined) {
      void this.client.configure({ command: options.command });
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

  async fetchCatalog(_opts: FetchCatalogOptions): Promise<ProviderCatalog> {
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
        capabilities: { ...CODEX_CAPABILITIES },
      };
    } catch {
      return {
        providerId: "codex",
        displayName: "Codex",
        models: [],
        modes: [],
        fetchedAt: Date.now(),
        capabilities: { ...CODEX_CAPABILITIES },
      };
    }
  }

  async createSession(
    config: AgentSessionConfig,
    ctx: LaunchContext,
  ): Promise<AgentSession> {
    this.sessionCounter += 1;
    const sessionKey = `codex-${Date.now().toString(36)}-${this.sessionCounter}`;
    return new CodexAgentSession(this.client, config, ctx, sessionKey);
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
   * Capability-gated feature RPC (§8.2). Only methods registered in
   * CODEX_FEATURES with their own Zod schema are reachable — there is
   * no free-form provider.feature.call.
   */
  async callFeature(method: string, payload: unknown): Promise<unknown> {
    return invokeCodexFeature(this.client, method, payload);
  }

  async shutdown(): Promise<void> {
    if (this.ownsClient) {
      await this.client.shutdown();
    }
  }
}
