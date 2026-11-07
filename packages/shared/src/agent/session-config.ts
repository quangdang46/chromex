import type { ProviderId } from "./provider-id.js";

export interface AgentSessionConfig {
  provider: ProviderId;
  model?: string | null;
  modeId?: string | null;
  thinkingOptionId?: string | null;
  /** resume an existing conversation instead of creating a new one */
  resume?: {
    persistence: import("./persistence.js").AgentPersistenceHandle;
  };
  /** provider-specific options (opaque to Gateway core) */
  options?: Record<string, unknown>;
}
