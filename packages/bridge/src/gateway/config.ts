/**
 * Gateway config — plan §5.8 (schema aligned to plan JSONC).
 *
 * `gateway.json` in CHROMEX_GATEWAY_HOME (default ~/.chromex/gateway).
 * All fields optional with safe defaults; unknown top-level keys rejected
 * so typos don't silently disable safety knobs.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MAX_ENVELOPE_BYTES_HARD } from "@codex-sidepanel/shared";

export interface GatewayProviderConfig {
  enabled: boolean;
  command: string | null;
  env: Record<string, string>;
  models: string[] | null;
  additionalModels: string[] | null;
  defaultModel: string | null;
}

/** Phase 4: extra ACP agent entries (docs/adr/acp-provider.md). */
export interface GatewayAcpProviderConfig extends GatewayProviderConfig {
  args: string[] | null;
}

export interface GatewayConfig {
  version: 1;
  gateway: {
    ipc: { transport: "auto" | "pipe" | "tcp" | "unix" };
    autoStart: boolean;
    /** 0 = never self-exit */
    idleExitMs: number;
    startupTimeoutMs: number;
    reconnectGraceMs: number;
    deltaFlushMs: number;
    /** merge delta chunks arriving within this window (plan §4.1: 50ms) */
    coalesceWindowMs: number;
    /** per-turn buffered delta char cap; excess → deltas_dropped notice */
    deltaBufferMaxPerTurn: number;
    maxEnvelopeBytes: number;
  };
  providers: {
    codex: GatewayProviderConfig;
    claude: GatewayProviderConfig;
    /** ACP agents keyed by provider id ("opencode", "gemini", …) */
    acp: Record<string, GatewayAcpProviderConfig>;
  };
  browser: {
    /** "auto" resolves via §6.6 intent-source ordering */
    defaultBackend: "auto" | "chrome-extension" | "playwright-isolated" | "playwright-cdp";
    allowedBackends: Array<"chrome-extension" | "playwright-isolated" | "playwright-cdp">;
    playwright: { enabledByUser: boolean };
    defaultTabScope: "active" | "selected" | "all";
    snapshot: { maxElements: number; maxTextChars: number };
    policy: {
      allowEvaluate: boolean;
      allowUpload: boolean;
      requireApprovalForDataEntryOnAutosave: boolean;
    };
  };
  tasks: {
    queueWhileRunning: boolean;
    retentionDays: number;
    maxEventsPerTask: number;
    /** wall-clock budget per running turn; 0 = disabled (P2-06) */
    turnTimeoutMs: number;
  };
  storeReasoning: boolean;
  /** P1-02: "memory" | "sqlite" — default memory until PR-D flips */
  store: "memory" | "sqlite";
  /** §10 migration flags */
  features: {
    /** inert — route.plan/browser.action.plan are served natively by the codex provider */
    legacySidecarPlanning: boolean;
    /** gateway-owned browser tool loop (P1-09) */
    toolLoop: boolean;
  };
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
  version: 1,
  gateway: {
    ipc: { transport: "auto" },
    autoStart: true,
    idleExitMs: 0,
    startupTimeoutMs: 15_000,
    reconnectGraceMs: 15_000,
    deltaFlushMs: 750,
    coalesceWindowMs: 50,
    deltaBufferMaxPerTurn: 65_536,
    maxEnvelopeBytes: MAX_ENVELOPE_BYTES_HARD,
  },
  providers: {
    codex: {
      enabled: true,
      command: null,
      env: {},
      models: null,
      additionalModels: null,
      defaultModel: null,
    },
    acp: {},
    claude: {
      enabled: false,
      command: null,
      env: {},
      models: null,
      additionalModels: null,
      defaultModel: null,
    },
  },
  browser: {
    defaultBackend: "auto",
    allowedBackends: ["chrome-extension", "playwright-isolated"],
    playwright: { enabledByUser: false },
    defaultTabScope: "active",
    snapshot: { maxElements: 80, maxTextChars: 12_000 },
    policy: {
      allowEvaluate: false,
      allowUpload: false,
      requireApprovalForDataEntryOnAutosave: true,
    },
  },
  tasks: {
    queueWhileRunning: true,
    retentionDays: 14,
    maxEventsPerTask: 20_000,
    turnTimeoutMs: 0,
  },
  storeReasoning: false,
  store: "memory",
  features: {
    legacySidecarPlanning: true,
    toolLoop: false,
  },
};

const KNOWN_KEYS = new Set([
  "version",
  "gateway",
  "providers",
  "browser",
  "tasks",
  "storeReasoning",
  "store",
  "features",
]);

const BACKEND_IDS = ["chrome-extension", "playwright-isolated", "playwright-cdp"] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, min: number, max: number, dflt: number): number {
  return typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? v : dflt;
}

function bool(v: unknown, dflt: boolean): boolean {
  return typeof v === "boolean" ? v : dflt;
}

function strOrNull(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function strListOrNull(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  const out = v.filter((x): x is string => typeof x === "string" && x.length > 0);
  return out.length ? out : null;
}

function envRecord(v: unknown): Record<string, string> {
  if (!isRecord(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v)) {
    if (typeof val === "string") out[k] = val;
  }
  return out;
}

function acpProviderConfig(raw: unknown): GatewayAcpProviderConfig {
  const base = providerConfig(raw, {
    enabled: false,
    command: null,
    env: {},
    models: null,
    additionalModels: null,
    defaultModel: null,
  });
  const args = isRecord(raw) ? strListOrNull(raw.args) : null;
  return { ...base, args };
}

function providerConfig(raw: unknown, dflt: GatewayProviderConfig): GatewayProviderConfig {
  if (!isRecord(raw)) return { ...dflt };
  return {
    enabled: bool(raw.enabled, dflt.enabled),
    command: raw.command === undefined ? dflt.command : strOrNull(raw.command),
    env: isRecord(raw.env) ? envRecord(raw.env) : dflt.env,
    models: raw.models === undefined ? dflt.models : strListOrNull(raw.models),
    additionalModels:
      raw.additionalModels === undefined ? dflt.additionalModels : strListOrNull(raw.additionalModels),
    defaultModel: raw.defaultModel === undefined ? dflt.defaultModel : strOrNull(raw.defaultModel),
  };
}

/** Deep-merge user config over §5.8 defaults, validating ranges. */
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
  const ipc = isRecord(g.ipc) ? g.ipc : {};
  const p = isRecord(raw.providers) ? raw.providers : {};
  const b = isRecord(raw.browser) ? raw.browser : {};
  const pw = isRecord(b.playwright) ? b.playwright : {};
  const snap = isRecord(b.snapshot) ? b.snapshot : {};
  const pol = isRecord(b.policy) ? b.policy : {};
  const t = isRecord(raw.tasks) ? raw.tasks : {};

  const maxEnvelope = num(g.maxEnvelopeBytes, 1024, MAX_ENVELOPE_BYTES_HARD, MAX_ENVELOPE_BYTES_HARD);

  const allowedBackends = Array.isArray(b.allowedBackends)
    ? b.allowedBackends.filter((x): x is (typeof BACKEND_IDS)[number] =>
        (BACKEND_IDS as readonly string[]).includes(x as string),
      )
    : base.browser.allowedBackends;

  const defaultBackend =
    typeof b.defaultBackend === "string" &&
    (["auto", ...BACKEND_IDS] as const).includes(b.defaultBackend as never)
      ? (b.defaultBackend as GatewayConfig["browser"]["defaultBackend"])
      : base.browser.defaultBackend;

  return {
    version: 1,
    gateway: {
      ipc: {
        transport:
          typeof ipc.transport === "string" &&
          (["auto", "pipe", "tcp", "unix"] as const).includes(ipc.transport as never)
            ? (ipc.transport as GatewayConfig["gateway"]["ipc"]["transport"])
            : "auto",
      },
      autoStart: bool(g.autoStart, true),
      idleExitMs: num(g.idleExitMs, 0, 24 * 60 * 60 * 1000, 0),
      startupTimeoutMs: num(g.startupTimeoutMs, 100, 120_000, 15_000),
      reconnectGraceMs: num(g.reconnectGraceMs, 0, 600_000, 15_000),
      deltaFlushMs: num(g.deltaFlushMs, 0, 10_000, 750),
      coalesceWindowMs: num(g.coalesceWindowMs, 0, 10_000, 50),
      deltaBufferMaxPerTurn: num(g.deltaBufferMaxPerTurn, 1024, 4 * 1024 * 1024, 65_536),
      maxEnvelopeBytes: maxEnvelope,
    },
    providers: {
      codex: providerConfig(p.codex, base.providers.codex),
      claude: providerConfig(p.claude, base.providers.claude),
      acp: Object.fromEntries(
        Object.entries(isRecord(p.acp) ? p.acp : {}).map(([id, cfg]) => [
          id,
          acpProviderConfig(cfg),
        ]),
      ),
    },
    browser: {
      defaultBackend,
      allowedBackends: allowedBackends.length ? allowedBackends : base.browser.allowedBackends,
      playwright: { enabledByUser: bool(pw.enabledByUser, false) },
      defaultTabScope:
        typeof b.defaultTabScope === "string" &&
        (["active", "selected", "all"] as const).includes(b.defaultTabScope as never)
          ? (b.defaultTabScope as GatewayConfig["browser"]["defaultTabScope"])
          : "active",
      snapshot: {
        maxElements: num(snap.maxElements, 1, 10_000, 80),
        maxTextChars: num(snap.maxTextChars, 100, 1_000_000, 12_000),
      },
      policy: {
        allowEvaluate: bool(pol.allowEvaluate, false),
        allowUpload: bool(pol.allowUpload, false),
        requireApprovalForDataEntryOnAutosave: bool(
          pol.requireApprovalForDataEntryOnAutosave,
          true,
        ),
      },
    },
    tasks: {
      queueWhileRunning: bool(t.queueWhileRunning, true),
      retentionDays: num(t.retentionDays, 1, 3650, 14),
      maxEventsPerTask: num(t.maxEventsPerTask, 100, 10_000_000, 20_000),
      turnTimeoutMs: num(t.turnTimeoutMs, 0, 24 * 60 * 60 * 1000, 0),
    },
    storeReasoning: bool(raw.storeReasoning, false),
    store: raw.store === "sqlite" ? "sqlite" : "memory",
    features: (() => {
      const f = isRecord(raw.features) ? raw.features : {};
      return {
        legacySidecarPlanning: bool(f.legacySidecarPlanning, true),
        toolLoop: bool(f.toolLoop, false),
      };
    })(),
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

/**
 * config.update — merge a partial patch over the current config,
 * re-resolve through the same validator, write atomically (0600).
 * Returns the resolved config. Unknown keys are rejected by
 * resolveGatewayConfig's strict shape.
 */
export async function updateGatewayConfig(
  dataDir: string,
  patch: unknown,
): Promise<GatewayConfig> {
  const current = await loadGatewayConfig(dataDir);
  if (patch === null || typeof patch !== "object" || Array.isArray(patch)) {
    throw new Error("config.update requires an object patch");
  }
  const merged = resolveGatewayConfig(deepMerge(current, patch as Record<string, unknown>));
  const file = path.join(dataDir, "gateway.json");
  await fs.mkdir(dataDir, { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
  await fs.rename(tmp, file);
  return merged;
}

function deepMerge(base: unknown, patch: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    const bv = out[k];
    out[k] =
      v !== null && typeof v === "object" && !Array.isArray(v) &&
      bv !== null && typeof bv === "object" && !Array.isArray(bv)
        ? deepMerge(bv, v as Record<string, unknown>)
        : v;
  }
  return out;
}
