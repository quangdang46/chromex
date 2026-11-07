/**
 * ClaudeAgentProvider — AgentProvider over @anthropic-ai/claude-agent-sdk
 * (P3-01, mechanism per docs/adr/claude-mechanism.md).
 *
 * Each session owns one SDK query() fed by a streaming prompt queue —
 * sequential turns on the same Claude session_id. Availability requires
 * the `claude` CLI on PATH (SDK reuses Claude Code auth, no API key).
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  AgentProvider,
  AgentSession,
  AgentSessionConfig,
  FetchCatalogOptions,
  LaunchContext,
  ProviderCatalog,
} from "@codex-sidepanel/shared";

import { CLAUDE_CAPABILITIES, ClaudeAgentSession } from "./session.js";

const execFileAsync = promisify(execFile);

export interface ClaudeProviderOptions {
  /** override `claude` binary path; default resolves via PATH */
  command?: string;
}

export class ClaudeAgentProvider implements AgentProvider {
  readonly id = "claude" as const;
  readonly displayName = "Claude";
  readonly capabilities = CLAUDE_CAPABILITIES;

  private readonly command: string;
  private sessionCounter = 0;

  constructor(options: ClaudeProviderOptions = {}) {
    this.command = options.command ?? "claude";
  }

  async isAvailable(signal?: AbortSignal): Promise<{
    available: boolean;
    version?: string;
    reason?: string;
  }> {
    try {
      const { stdout } = await execFileAsync(this.command, ["--version"], {
        timeout: 10_000,
      });
      if (signal?.aborted) return { available: false, reason: "aborted" };
      return { available: true, version: stdout.trim() };
    } catch (error) {
      return {
        available: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async fetchCatalog(_opts: FetchCatalogOptions): Promise<ProviderCatalog> {
    // Models/modes come from the live SDK (supportedModels/supportedCommands)
    // per session — no session is created for catalog discovery.
    return {
      providerId: "claude",
      models: [],
      modes: [],
      fetchedAt: Date.now(),
      capabilities: { ...CLAUDE_CAPABILITIES },
    };
  }

  async createSession(
    config: AgentSessionConfig,
    ctx: LaunchContext,
  ): Promise<AgentSession> {
    this.sessionCounter += 1;
    const sessionKey = `claude-${Date.now().toString(36)}-${this.sessionCounter}`;
    return new ClaudeAgentSession(
      config,
      ctx,
      sessionKey,
      this.command === "claude" ? {} : { pathToClaudeCodeExecutable: this.command },
    );
  }

  async resumeSession(
    handle: Parameters<AgentProvider["resumeSession"]>[0],
    config: Parameters<AgentProvider["resumeSession"]>[1],
    ctx: LaunchContext,
  ): Promise<AgentSession> {
    return this.createSession(
      { ...config, provider: "claude", resume: { persistence: handle } },
      ctx,
    );
  }

  async callFeature(_method: string, _payload: unknown): Promise<unknown> {
    // No provider.feature.* methods registered for Claude yet (P3-04+).
    throw new Error("claude provider has no registered feature methods");
  }

  async shutdown(): Promise<void> {
    // Sessions own their SDK child processes; provider holds no shared
    // runtime to shut down.
  }
}
