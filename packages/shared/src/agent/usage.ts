export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  reasoningTokens?: number;
  /** provider-defined extras */
  extra?: Record<string, unknown>;
}
