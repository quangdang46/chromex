/**
 * Gateway config — plan §5.8.
 *
 * `gateway.json` in CHROMEX_GATEWAY_HOME (default ~/.chromex/gateway).
 * All fields optional with safe defaults; unknown fields rejected so
 * typos don't silently disable safety knobs.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MAX_ENVELOPE_BYTES_HARD } from "@codex-sidepanel/shared";

export interface GatewayConfig {
  version: 1;
  gateway: {
    ipc: "auto" | "socket" | "pipe";
    autoStart: boolean;
    idleExitMs: number;
    startupTimeoutMs: number;
    reconnectGraceMs: number;
    deltaFlushMs: number;
    maxEnvelopeBytes: number;
  };
  providers: {
    codex: { enabled: boolean; binPath?: string };
    claude: { enabled: boolean };
  };
  browser: {
    defaultBackend: string;
    allowedBackends: string[];
    playwright: { enabled: boolean; isolatedProfile: boolean };
    defaultTabScope: "active" | "selected" | "all";
    snapshot: { maxElements: number; includeHidden: boolean };
    policy: "ask" | "auto-review" | "full";
  };
  tasks: {
    queueWhileRunning: boolean;
    retentionDays: number;
    maxEventsPerTask: number;
  };
  storeReasoning: boolean;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  version: 1,
  gateway: {
    ipc: "auto",
    autoStart: true,
    idleExitMs: 10 * 60 * 1000,
    startupTimeoutMs: 15 * 1000,
    reconnectGraceMs: 30 * 1000,
    deltaFlushMs: 50,
    maxEnvelopeBytes: MAX_ENVELOPE_BYTES_HARD,
  },
  providers: {
    codex: { enabled: true },
    claude: { enabled: false },
  },
  browser: {
    defaultBackend: "chrome-extension",
    allowedBackends: ["chrome-extension", "playwright-isolated"],
    playwright: { enabled: false, isolatedProfile: true },
    defaultTabScope: "active",
    snapshot: { maxElements: 500, includeHidden: false },
    policy: "ask",
  },
  tasks: {
    queueWhileRunning: true,
    retentionDays: 30,
    maxEventsPerTask: 100_000,
  },
  storeReasoning: false,
};

const KNOWN_KEYS = new Set([
  "version",
  "gateway",
  "providers",
  "browser",
  "tasks",
  "storeReasoning",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, min: number, max: number, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : dflt;
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

function str<T extends string>(v: unknown, dflt: T, allowed?: readonly T[]): T {
  if (typeof v !== "string") return dflt;
  if (allowed && !(allowed as readonly string[]).includes(v)) return dflt;
  return v as T;
}

function strArr(v: unknown, dflt: string[]): string[] {
  if (!Array.isArray(v)) return dflt;
  return v.filter((x): x is string => typeof x === "string");
}

/** Deep-merge user config over defaults, validating ranges. */
export function resolveGatewayConfig(raw: unknown): GatewayConfig {
  const base = structuredClone(DEFAULT_GATEWAY_CONFIG);
  if (!isRecord(raw)) return base;
  for (const key of Object.keys(raw)) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`gateway config: unknown key "${key}"`);
    }
  }
  if (raw.version !== undefined && raw.version !== 1) {
    throw new Error(`gateway config: unsupported version ${String(raw.version)}`);
  }
  const g = isRecord(raw.gateway) ? raw.gateway : {};
  const p = isRecord(raw.providers) ? raw.providers : {};
  const codex = isRecord(p.codex) ? p.codex : {};
  const claude = isRecord(p.claude) ? p.claude : {};
  const b = isRecord(raw.browser) ? raw.browser : {};
  const pw = isRecord(b.playwright) ? b.playwright : {};
  const snap = isRecord(b.snapshot) ? b.snapshot : {};
  const t = isRecord(raw.tasks) ? raw.tasks : {};

  const maxEnvelope = num(g.maxEnvelopeBytes, 1024, MAX_ENVELOPE_BYTES_HARD, MAX_ENVELOPE_BYTES_HARD);
  if (maxEnvelope > MAX_ENVELOPE_BYTES_HARD) {
    // num() already clamps to hard cap; explicit guard for clarity
    throw new Error("gateway.maxEnvelopeBytes cannot exceed hard cap");
  }

  return {
    version: 1,
    gateway: {
      ipc: str(g.ipc, "auto", ["auto", "socket", "pipe"]),
      autoStart: bool(g.autoStart, true),
      idleExitMs: num(g.idleExitMs, 0, 24 * 60 * 60 * 1000, 10 * 60 * 1000),
      startupTimeoutMs: num(g.startupTimeoutMs, 100, 120_000, 15_000),
      reconnectGraceMs: num(g.reconnectGraceMs, 0, 600_000, 30_000),
      deltaFlushMs: num(g.deltaFlushMs, 0, 10_000, 50),
      maxEnvelopeBytes: maxEnvelope,
    },
    providers: {
      codex: {
        enabled: bool(codex.enabled, true),
        ...(typeof codex.binPath === "string" ? { binPath: codex.binPath } : {}),
      },
      claude: { enabled: bool(claude.enabled, false) },
    },
    browser: {
      defaultBackend: str(b.defaultBackend, "chrome-extension", [
        "chrome-extension",
        "playwright-isolated",
        "playwright-cdp",
      ]),
      allowedBackends: strArr(b.allowedBackends, ["chrome-extension", "playwright-isolated"]).filter(
        (x) => ["chrome-extension", "playwright-isolated", "playwright-cdp"].includes(x),
      ),
      playwright: {
        enabled: bool(pw.enabled, false),
        isolatedProfile: bool(pw.isolatedProfile, true),
      },
      defaultTabScope: str(b.defaultTabScope, "active", ["active", "selected", "all"]),
      snapshot: {
        maxElements: num(snap.maxElements, 1, 10_000, 500),
        includeHidden: bool(snap.includeHidden, false),
      },
      policy: str(b.policy, "ask", ["ask", "auto-review", "full"]),
    },
    tasks: {
      queueWhileRunning: bool(t.queueWhileRunning, true),
      retentionDays: num(t.retentionDays, 1, 3650, 30),
      maxEventsPerTask: num(t.maxEventsPerTask, 100, 10_000_000, 100_000),
    },
    storeReasoning: bool(raw.storeReasoning, false),
  };
}

export function defaultGatewayHome(): string {
  return path.join(os.homedir(), ".chromex", "gateway");
}

export async function loadGatewayConfig(dataDir: string): Promise<GatewayConfig> {
  const file = path.join(dataDir, "gateway.json");
  let raw: unknown = null;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return resolveGatewayConfig(raw);
}
