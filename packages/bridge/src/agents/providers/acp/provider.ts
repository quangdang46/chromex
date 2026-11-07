/**
 * AcpAgentProvider — AgentProvider over Agent Client Protocol.
 * One adapter serves every ACP-capable agent binary (docs/adr/acp-provider.md).
 *
 * Provider entries are data, not code: id + command + args. Known agents
 * get sensible defaults via ACP_KNOWN_AGENTS; config can override.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  AgentCapabilityFlags,
  FetchCatalogOptions,
  LaunchContext,
  ProviderCatalog,
} from "@codex-sidepanel/shared";

import { ACP_BASE_CAPABILITIES, AcpAgentSession } from "./session.js";

const execFileAsync = promisify(execFile);

export interface AcpAgentSpec {
  /** provider id, e.g. "opencode", "gemini" */
  id: string;
  displayName?: string;
  /** binary on PATH; defaults to spec default or the provider id */
  command?: string | null;
  args?: string[];
  /** extra env merged into the child process env */
  env?: Record<string, string>;
  /** capability overrides discovered at spike time */
  capabilities?: Partial<AgentCapabilityFlags>;
  /** version probe args; default ["--version"] */
  versionArgs?: string[];
}

/** Known ACP agents — defaults only; config overrides win. */
export const ACP_KNOWN_AGENTS: Record<string, { command: string; args: string[]; displayName: string }> = {
  opencode: { command: "opencode", args: ["acp"], displayName: "OpenCode" },
  gemini: { command: "gemini", args: ["--acp"], displayName: "Gemini CLI" },
};

export class AcpAgentProvider implements AgentProvider {
  readonly id: string;
  readonly displayName: string;
  readonly capabilities: AgentCapabilityFlags;

  private readonly spec: { command: string; args: string[] } &
    Pick<AcpAgentSpec, "env" | "versionArgs">;
  private sessionCounter = 0;

  constructor(spec: AcpAgentSpec) {
    this.id = spec.id;
    const known = ACP_KNOWN_AGENTS[spec.id];
    this.displayName = spec.displayName ?? known?.displayName ?? spec.id;
    this.spec = {
      command: spec.command ?? known?.command ?? spec.id,
      args: spec.args ?? known?.args ?? [],
      ...(spec.env ? { env: spec.env } : {}),
      ...(spec.versionArgs ? { versionArgs: spec.versionArgs } : {}),
    };
    this.capabilities = {
      ...ACP_BASE_CAPABILITIES,
      ...(spec.capabilities ?? {}),
      // conservative: steer is never advertised for ACP
      steer: false,
      streamHistory: false,
      mcpTools: true, // mcpServers param on session/new|load
      modeSelection: false, // refined per-session via configOptions
      thinkingOption: false,
      imageInput: false, // refined per-session via promptCapabilities
    };
  }

  async isAvailable(signal?: AbortSignal): Promise<{
    available: boolean;
    version?: string;
    reason?: string;
  }> {
    try {
      const { stdout } = await execFileAsync(
        this.spec.command,
        this.spec.versionArgs ?? ["--version"],
        { timeout: 10_000 },
      );
      if (signal?.aborted) return { available: false, reason: "aborted" };
      const version = stdout.trim().split("\n")[0];
      return { available: true, ...(version ? { version } : {}) };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async fetchCatalog(_opts: FetchCatalogOptions): Promise<ProviderCatalog> {
    // Model/mode catalogs live in per-session configOptions — no catalog
    // without spawning a session. Honest empty catalog (same as Claude).
    return {
      providerId: this.id,
      displayName: this.displayName,
      models: [],
      modes: [],
      fetchedAt: Date.now(),
      capabilities: { ...this.capabilities },
    };
  }

  async createSession(
    config: AgentSessionConfig,
    ctx: LaunchContext,
  ): Promise<AgentSession> {
    this.sessionCounter += 1;
    const sessionKey = `${this.id}-${Date.now().toString(36)}-${this.sessionCounter}`;
    const mergedEnv =
      this.spec.env || ctx.env
        ? { ...(this.spec.env ?? {}), ...(ctx.env ?? {}) }
        : undefined;
    return new AcpAgentSession(
      this.id,
      {},
      config,
      { ...ctx, ...(mergedEnv ? { env: mergedEnv } : {}) },
      sessionKey,
      { command: this.spec.command, args: this.spec.args },
    );
  }

  async resumeSession(
    handle: Parameters<AgentProvider["resumeSession"]>[0],
    config: Parameters<AgentProvider["resumeSession"]>[1],
    ctx: LaunchContext,
  ): Promise<AgentSession> {
    return this.createSession(
      { ...config, provider: this.id, resume: { persistence: handle } },
      ctx,
    );
  }

  async shutdown(): Promise<void> {
    // Sessions own their ACP child processes.
  }
}
