import type { ProviderId } from "./provider-id.js";
import type { AgentCapabilityFlags } from "./capabilities.js";
import type { AgentSessionConfig } from "./session-config.js";
import type { LaunchContext } from "./launch.js";
import type { AgentPersistenceHandle } from "./persistence.js";
import type { AgentMode } from "./modes.js";
import type { AgentModel, ProviderCatalog, FetchCatalogOptions } from "./catalog.js";
import type { AgentEvent } from "./events.js";
import type { PermissionRequest, PermissionResponse, PermissionDecision } from "./permission.js";
import type { TurnInput } from "./turn-input.js";
import type { SlashCommand } from "./commands.js";

export interface RuntimeInfo {
  provider: ProviderId;
  sessionId: string | null;
  model: string | null;
  modeId: string | null;
  thinkingOptionId?: string | null;
  extra?: Record<string, unknown>;
}

/**
 * Result of respondToPermission — Paseo semantics (plan §2.2):
 * providers may return a follow-up prompt after answering a permission
 * (e.g. select → comment chain). GATEWAY executes the follow-up turn
 * with a NEW gatewayTurnId — adapters never self-run turns.
 */
export interface PermissionResponseResult {
  followUpPrompt?: TurnInput;
}

/**
 * AgentSession — plan §4.3, semantics aligned with Paseo agent-sdk-types.
 * See GateB-B1 conformance skeleton for the member-by-member checklist.
 */
export interface AgentSession {
  readonly provider: ProviderId;
  readonly sessionKey: string;
  readonly capabilities: AgentCapabilityFlags;

  /**
   * Gateway owns the official `turnId` and passes it via
   * `input.gatewayTurnId`. The promise resolves with the PROVIDER's turn
   * id (if any) — it must NOT return a turnId that could be confused
   * with the gateway identity.
   */
  startTurn(input: TurnInput): Promise<{ accepted: true; providerTurnId?: string }>;
  steer?(input: TurnInput): Promise<{ status: "accepted" | "unavailable" }>;
  /**
   * Ownership guarantee: when this resolves, no old foreground turn will
   * continue running; pending steers are cancelled; the adapter cleared
   * its internal queue. Stronger than "sent a signal".
   */
  interrupt(): Promise<void>;
  /** decides whether idle runtime shutdown is safe */
  /** sync or async — adapters may need to query runtime state */
  canStopRuntime?(): boolean | Promise<boolean>;

  /**
   * Provider-initiated turns (e.g. codex goal-loop continuations) have no
   * gateway turn identity. When implemented, the adapter invokes the
   * handler on turn/started for such turns; returning a gateway turnId
   * adopts the turn so its events flow normally, returning null leaves
   * it unadopted (adapter emits an honest provider.notice instead).
   * Sync — called from the notification path.
   */
  onProviderTurn?(handler: (providerTurnId: string) => string | null): void;

  respondToPermission(requestId: string, response: PermissionResponse): Promise<PermissionResponseResult>;
  /** mirror only — Gateway approval store is the source of truth */
  getPendingPermissions(): PermissionRequest[];

  subscribe(listener: (e: AgentEvent) => void): () => void;
  /** optional: import/history streaming */
  streamHistory?(): AsyncGenerator<AgentEvent>;

  getRuntimeInfo(): Promise<RuntimeInfo>;
  getAvailableModes(): Promise<AgentMode[]>;
  getCurrentMode(): Promise<string | null>;
  setMode?(modeId: string): Promise<void | import("./events.js").AgentEvent>;
  setModel?(model: string | null): Promise<void>;
  setThinkingOption?(id: string | null): Promise<void | import("./events.js").AgentEvent>;
  listCommands?(): Promise<SlashCommand[]>;

  /** null until resumability is actually proven */
  describePersistence(): AgentPersistenceHandle | null;
  close(): Promise<void>;
}

export interface AgentProvider {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly capabilities: AgentCapabilityFlags;
  isAvailable(signal?: AbortSignal): Promise<{ available: boolean; version?: string; reason?: string }>;
  fetchCatalog(opts: FetchCatalogOptions): Promise<ProviderCatalog>;
  createSession(config: AgentSessionConfig, ctx: LaunchContext): Promise<AgentSession>;
  resumeSession(
    handle: AgentPersistenceHandle,
    config: Partial<AgentSessionConfig>,
    ctx: LaunchContext,
  ): Promise<AgentSession>;
  getDiagnostic?(): Promise<{ diagnostic: string }>;
  shutdown?(): Promise<void>;
}

export type { AgentModel, ProviderCatalog, FetchCatalogOptions, AgentMode, PermissionDecision };
