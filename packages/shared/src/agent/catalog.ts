import type { AgentMode } from "./modes.js";
import type { AgentCapabilityFlags } from "./capabilities.js";
import type { ProviderId } from "./provider-id.js";
import type { SlashCommand } from "./commands.js";

export interface AgentModel {
  id: string;
  label: string;
  description?: string;
  /** e.g. context window, cost tier — provider-defined, opaque to Gateway */
  metadata?: Record<string, unknown>;
}

export interface ProviderCatalog {
  providerId: ProviderId;
  /** human label for pickers; falls back to providerId */
  displayName?: string;
  models: AgentModel[];
  modes: AgentMode[];
  defaultModel?: string | null;
  commands?: SlashCommand[];
  capabilities?: Partial<AgentCapabilityFlags>;
  /** content hash for cache invalidation */
  contentHash?: string;
  fetchedAt: number;
}

export interface FetchCatalogOptions {
  /** bypass TTL cache */
  forceRefresh?: boolean;
  signal?: AbortSignal;
}
