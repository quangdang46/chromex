/**
 * Gateway/sidecar degraded fallbacks — chromex-ur7.
 *
 * In gatewayMode every request still crosses the native host: agent
 * methods go to the Gateway, LEGACY_SIDECAR_METHODS go to the bridge
 * sidecar child. When the sidecar is down or a method fails, callers
 * fall back to locally-derived state. These helpers keep that fallback
 * honest: failures are reported to the service-worker log (once per
 * key — a dead sidecar must not spam the console on every catalog
 * refresh) and list-shaped payloads keep their previous contents
 * instead of silently rendering as empty.
 */

import { normalizeCatalogSettingsPath } from "./catalog-refresh.js";
import type { RuntimeConfigSnapshot } from "../types.js";

export type DegradedReporter = (key: string, message: string, error?: unknown) => void;

/**
 * Returns a reporter that forwards each `key` to `logger` exactly once
 * per service-worker lifetime. Repeated failures of the same method
 * (e.g. diagnostics.log.write on every prompt) stay silent after the
 * first report.
 */
export function createDegradedReporter(
  logger: (message: string, ...args: unknown[]) => void = (message, ...args) => console.warn(message, ...args),
): DegradedReporter {
  const reported = new Set<string>();
  return (key, message, error) => {
    if (reported.has(key)) {
      return;
    }
    reported.add(key);
    if (error === undefined) {
      logger(`[degraded] ${message}`);
    } else {
      logger(`[degraded] ${message}`, error);
    }
  };
}

/**
 * Catch-handler for catalog list RPCs (apps.list, plugins.list,
 * skills.list, ...). A failed refresh must not wipe data the UI already
 * has — return the previous list and report the degradation once.
 */
export function reportDegradedCatalogList<T>(
  previous: readonly T[],
  label: string,
  error: unknown,
  report: DegradedReporter,
): T[] {
  report(`catalog.${label}`, `${label} failed; keeping previously loaded catalog data`, error);
  return [...previous];
}

/**
 * runtime.config.read fallback: rebuild the snapshot from extension
 * settings and mark it degraded so the UI/logs can tell the sidecar's
 * real resolution (env/PATH/common codex binary) is unknown.
 */
export function createDegradedRuntimeConfigSnapshot(input: {
  workspaceRoot?: string;
  codexBinPath?: string;
}): RuntimeConfigSnapshot {
  const workspaceRoot = normalizeCatalogSettingsPath(input.workspaceRoot);
  const codexBinPath = normalizeCatalogSettingsPath(input.codexBinPath);
  return {
    workspaceRoot,
    codexBinPath,
    resolvedCodexBinPath: codexBinPath,
    codexBinSource: codexBinPath ? "configured" : "missing",
    configuredCodexBinPathInvalid: false,
    degraded: true,
  };
}
