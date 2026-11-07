/** Context handed to provider factories/session creation. */
export interface LaunchContext {
  /** working directory for the provider process/session */
  cwd?: string;
  /** extra env allowlist entries — never forwarded wholesale */
  env?: Record<string, string>;
  signal?: AbortSignal;
  /** opaque per-launch metadata (e.g. tool token file path, profile dir) */
  metadata?: Record<string, unknown>;
}
