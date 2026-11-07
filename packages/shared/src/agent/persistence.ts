import type { ProviderId } from "./provider-id.js";

/**
 * Opaque-to-Gateway handle proving a conversation can be resumed.
 * `describePersistence()` MUST return null until resumability is actually proven.
 */
export interface AgentPersistenceHandle {
  provider: ProviderId;
  /** provider-native resume token (thread id, session id, file path…) */
  ref: string;
  kind: string;
  createdAt?: number;
  metadata?: Record<string, unknown>;
}
