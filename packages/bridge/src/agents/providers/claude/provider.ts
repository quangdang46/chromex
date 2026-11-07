/**
 * ClaudeAgentProvider — AgentProvider over @anthropic-ai/claude-agent-sdk
 * (P3-01, mechanism per docs/adr/claude-mechanism.md).
 *
 * Each session owns one SDK query() fed by a streaming prompt queue —
 * sequential turns on the same Claude session_id. Availability requires
 * the `claude` CLI on PATH (SDK reuses Claude Code auth, no API key).
 */

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
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

const CLAUDE_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
] as const;

/** Model ids Claude Code will actually route — process env plus
 *  ~/.claude/settings.json `env` (the same sources the CLI reads). */
function discoverConfiguredClaudeModels(): string[] {
  const ids = new Set<string>();
  const consider = (value: unknown) => {
    if (typeof value === "string" && value.trim()) ids.add(value.trim());
  };
  for (const key of CLAUDE_MODEL_ENV_KEYS) consider(process.env[key]);
  try {
    const settings = JSON.parse(
      readFileSync(path.join(os.homedir(), ".claude", "settings.json"), "utf8"),
    ) as { env?: Record<string, unknown> };
    for (const key of CLAUDE_MODEL_ENV_KEYS) consider(settings.env?.[key]);
  } catch {
    // no settings file or unreadable — env-only discovery is fine
  }
  return [...ids];
}

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
    // Claude Code resolves tier aliases (sonnet/opus/haiku) to whatever the
    // user's settings/env configure — including router-mapped defaults.
    // No session is created for discovery.
    const alias = (id: string, label: string, isDefault = false) => ({
      id,
      label,
      description: `Claude Code "${id}" alias`,
      metadata: { isDefault },
    });
    const models = [alias("sonnet", "Sonnet", true), alias("opus", "Opus"), alias("haiku", "Haiku")];
    // Router/proxy users configure real model ids via env or
    // ~/.claude/settings.json — surface them so the picker is usable
    // without Anthropic-direct credentials.
    for (const id of discoverConfiguredClaudeModels()) {
      if (models.some((m) => m.id === id)) continue;
      models.push({
        id,
        label: id,
        description: "Model from Claude Code env/settings",
        metadata: { isDefault: false },
      });
    }
    return {
      providerId: "claude",
      displayName: "Claude",
      models,
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
