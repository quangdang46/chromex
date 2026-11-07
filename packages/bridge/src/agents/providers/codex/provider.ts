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
    // No session is created for discovery. Static catalog until the
    // provider.feature.codex.* RPCs expose the live model list.
    return {
      providerId: "codex",
      models: [],
      modes: [],
      fetchedAt: Date.now(),
      capabilities: { ...CODEX_CAPABILITIES },
    };
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
