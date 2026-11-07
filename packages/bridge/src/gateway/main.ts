/**
 * Gateway process entry — plan P1-01.
 *
 * Lifecycle: acquire STARTUP lock → load/validate config → acquire
 * LIFETIME lock → in-memory store → IPC listen → hello/auth → recovery
 * (no-op until P1-02 store) → markReady → serve until shutdown.
 *
 * Shutdown policy: no self-exit while active tasks or pending approvals
 * exist; SIGTERM/SIGINT initiate graceful drain.
 */

import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { protocolError } from "@codex-sidepanel/shared";
import type {
  AgenticRouteInput,
  BrowserDomSnapshot,
  DurableTaskEvent,
  Envelope,
  ProtocolError,
  TaskRecord,
} from "@codex-sidepanel/shared";
import { z } from "zod";

import { LEGACY_COMPAT, LEGACY_SIDECAR_METHODS } from "./compat.js";
import { loadGatewayConfig, updateGatewayConfig, type GatewayConfig } from "./config.js";
import { SnapshotChunkStore } from "./chunks.js";
import { ulid } from "./ulid.js";
import {
  browserBackendSchema,
  appReportSchema,
  configReadSchema,
  configUpdateSchema,
  gatewaySyncSchema,
  permissionRespondSchema,
  routePlanSchema,
  browserActionPlanSchema,
  providerCatalogSchema,
  artifactUploadSchema,
  taskCreateSchema,
  taskIdSchema,
  browserToolCallSchema,
  taskPurgeSchema,
  taskSendSchema,
  taskSnapshotChunkSchema,
  taskSnapshotSchema,
  taskSteerSchema,
  taskSyncSchema,
  turnInterruptSchema,
} from "./schemas.js";
import { PlaywrightRuntimeManager } from "../playwright-runtime.js";
import {
  acquireOwnershipLock,
  LockHeldError,
  StaleFenceError,
  type OwnershipLock,
} from "./lock.js";
import { GatewayIpcServer, type IpcConnection } from "./ipc-server.js";
import {
  buildHelloResponse,
  GATEWAY_VERSION,
  helloError,
  parseHelloRequest,
} from "./hello.js";
import { InMemoryStore } from "./store-memory.js";
import { openGatewayDb, runIntegrityChecks } from "../store/db.js";
import { SQLiteStore } from "../store/sqlite-store.js";
import { runRecoveryScan } from "../store/recovery.js";
import { runRetentionSweep } from "../store/retention.js";
import { runPruneSweep } from "./prune.js";
import { APPROVAL_POST_TERMINAL_MS, ARTIFACT_TTL_MS } from "../store/retention.js";
import type { GatewayDb } from "../store/db.js";
import { CODEX_CAPABILITIES } from "../agents/providers/codex/session.js";
import { CLAUDE_CAPABILITIES as CLAUDE_SESSION_CAPABILITIES } from "../agents/providers/claude/session.js";
import { CodexAgentProvider } from "../agents/providers/codex/provider.js";
import { InMemoryBridgeSecrets } from "../secrets.js";
import { ProviderRegistry } from "../agents/registry.js";
import { SessionManager } from "./session-manager.js";
import { AppServiceRegistry } from "./app-services.js";
import { ToolTokenManager } from "../browser/tool-token.js";
import { DeltaCoalescer } from "./delta-coalescer.js";
import { GatewayDiagnostics } from "./diagnostics.js";
import {
  BrowserToolServer,
  buildArgsPreview,
  type ToolCallOutcome,
} from "../browser/tool-server.js";
import { boundJsonPreview } from "../store/event-payload.js";
import { BrowserHostRegistry } from "../browser/host-registry.js";
import { PlaywrightIsolatedBackend } from "../browser/backends/playwright/isolated.js";
import { resolveBackendSelection, backendMismatchFor } from "../browser/backend-selection.js";
import { ToolTokenRefresher } from "../browser/tool-refresh.js";
import {
  writeMcpScopeFile,
  updateMcpScopeToken,
  mcpScopePath,
  supportedToolsForBackend,
} from "../browser/mcp-scope.js";
import { protocolError as perr } from "@codex-sidepanel/shared";

export interface GatewayOptions {
  /** override CHROMEX_GATEWAY_HOME */
  dataDir?: string;
  log?: (msg: string) => void;
}

export interface RunningGateway {
  dataDir: string;
  config: GatewayConfig;
  store: InMemoryStore | SQLiteStore;
  db: GatewayDb | null;
  ipc: GatewayIpcServer;
  lifetimeLock: OwnershipLock;
  shutdown(reason?: string): Promise<void>;
}

function resolveDataDir(opt?: string): string {
  if (opt) return path.resolve(opt);
  const env = process.env.CHROMEX_GATEWAY_HOME;
  if (env) return path.resolve(env);
  return path.join(os.homedir(), ".chromex", "gateway");
}

export async function startGateway(options: GatewayOptions = {}): Promise<RunningGateway> {
  const log = options.log ?? ((m: string) => console.log(`[gateway] ${m}`));
  const dataDir = resolveDataDir(options.dataDir);

  // 1. startup lock serializes boot
  const startupLock = await acquireOwnershipLock(dataDir, "startup");
  let lifetimeLock: OwnershipLock | null = null;
  let ipc: GatewayIpcServer | null = null;

  try {
    const config = await loadGatewayConfig(dataDir);

    // 2. lifetime lock — the real ownership claim
    lifetimeLock = await acquireOwnershipLock(dataDir, "lifetime");

    // store: memory|sqlite flag (§P1-02). SQLite path runs integrity
    // checks + §5.6 recovery BEFORE ready.
    // Stale-fence guard (§3.3.2): every durable write re-verifies our
    // fence; a mismatch throws StaleFenceError → request fails AND the
    // gateway self-shuts-down (set after ipc creation below).
    const lock = lifetimeLock;
    const assertOwnership = () => {
      if (!lock.checkFence()) {
        // self-shutdown is initiated by the IPC error path below; the
        // guard itself only needs to refuse the write.
        throw new StaleFenceError("lifetime");
      }
    };
    // P2-08 diagnostics: in-memory counters + live lock/endpoint/stream
    // state; snapshot is counts/ids/seqs only — no tokens or values.
    const diagnostics = new GatewayDiagnostics();
    let store: InMemoryStore | SQLiteStore;
    let db: GatewayDb | null = null;
    let recoveredTurns = 0;
    let recoveredTasks = 0;
    if (config.store === "sqlite") {
      db = await openGatewayDb(dataDir);
      const sqlite = new SQLiteStore(db, { assertOwnership });
      const violations = runIntegrityChecks(db);
      if (violations.length) {
        log(`integrity violations: ${violations.join("; ")}`);
      }
      const recovery = runRecoveryScan(sqlite, db);
      recoveredTurns = recovery.recoveredTurns;
      recoveredTasks = recovery.recoveredTasks;
      if (recoveredTurns || recoveredTasks) {
        log(`recovery: ${recoveredTurns} turns unknown, ${recoveredTasks} tasks paused`);
      }
      diagnostics.recordRecovery(recoveredTurns, recoveredTasks);
      store = sqlite;
    } else {
      store = new InMemoryStore({ assertOwnership });
    }

    // provider registry + session manager (P1-04/P1-05/P1-06)
    // flat provider-config map: built-ins + Phase 4 ACP entries keyed by id
    const providerConfigs: Record<string, GatewayConfig["providers"]["codex"]> = {
      codex: config.providers.codex,
      claude: config.providers.claude,
      ...config.providers.acp,
    };
    const registry = new ProviderRegistry(providerConfigs);
    if (config.providers.codex.enabled) {
      // external skill roots live under the sidepanel config dir
      // (same root the legacy sidecar's ExternalSkillArchiveStore uses)
      const { resolveCodexSidepanelConfigDir } = await import("../platform.js");
      const { ExternalSkillArchiveStore } = await import("../skill-archives.js");
      const externalSkills = new ExternalSkillArchiveStore(
        path.join(resolveCodexSidepanelConfigDir(), "external-skills"),
      );
      await registry.register(
        "codex",
        async () =>
          new CodexAgentProvider({
            externalSkillRoots: () => externalSkills.listScanRoots(),
            // same secrets.json the sidecar uses — apiKey login +
            // openAiApiKeyConfigured stay consistent across modes
            secrets: new InMemoryBridgeSecrets(),
            // chromex-fjr: app-server account/login/completed is
            // provider-global — persist on the gateway stream + broadcast
            // so clients refresh account.status without polling.
            onAccountLoginCompleted: (login) => {
              const env = store.appendGatewayEvent({
                type: "account.login.completed",
                providerId: "codex",
                loginId: login.loginId,
                success: login.success,
                error: login.error,
              });
              ipc?.broadcast(env);
            },
          }),
      );
    }
    if (config.providers.claude.enabled) {
      const { ClaudeAgentProvider } = await import("../agents/providers/claude/provider.js");
      await registry.register(
        "claude",
        async () =>
          new ClaudeAgentProvider(
            config.providers.claude.command ? { command: config.providers.claude.command } : {},
          ),
      );
    }
    // Phase 4: ACP agents — one adapter, data-driven entries (P4-00/01/02)
    for (const [acpId, acpCfg] of Object.entries(config.providers.acp)) {
      if (!acpCfg.enabled) continue;
      const { AcpAgentProvider } = await import("../agents/providers/acp/provider.js");
      await registry.register(
        acpId,
        async () =>
          new AcpAgentProvider({
            id: acpId,
            command: acpCfg.command,
            ...(acpCfg.args ? { args: acpCfg.args } : {}),
            ...(Object.keys(acpCfg.env).length ? { env: acpCfg.env } : {}),
          }),
      );
    }
    // assigned once toolRefresher exists (below); sessions opened
    // earlier simply get no browser MCP — honest, never fake.
    let spawnBrowserMcpForTask: ((task: TaskRecord) => Promise<Record<string, unknown> | null>) | null =
      null;
    // P2-06: ephemeral deltas are coalesced (50ms silence window, 750ms
    // cap, per-turn char budget → deltas_dropped notice) before broadcast.
    const deltaCoalescer = new DeltaCoalescer({
      flushMs: config.gateway.deltaFlushMs,
      coalesceWindowMs: config.gateway.coalesceWindowMs,
      maxCharsPerTurn: config.gateway.deltaBufferMaxPerTurn,
      emit: (envelope) => {
        const e = envelope as { type?: string; backpressure?: string };
        if (e.type === "gateway.notice" && e.backpressure === "deltas_dropped") {
          diagnostics.recordDeltaDropped();
        }
        ipc?.broadcast(envelope);
      },
    });
    // chromex-p21: per-task dev-server registry. In-memory for the
    // gateway lifetime — reported services are re-reported by the agent
    // after a restart, and the durable stream never stores them.
    // cliPath points at the compiled agent helper (dist layout mirrors
    // src); the injected context teaches agents the exact report command.
    const appServices = new AppServiceRegistry({
      cliPath: fileURLToPath(new URL("./app-report-cli.js", import.meta.url)),
    });
    const sessionManager = new SessionManager({
      store: store as ConstructorParameters<typeof SessionManager>[0]["store"],
      registry,
      config,
      appContextForTask: (taskId) => appServices.contextForTask(taskId),
      browserMcpSpawn: (task) => spawnBrowserMcpForTask?.(task) ?? Promise.resolve(null),
      // P2-06: interrupt/cancel propagates browser.tool.cancel to
      // in-flight tool calls; unconfirmed stops resolve `unknown`.
      onTaskStop: (taskId) => toolServer.cancelForTask(taskId),
      publish: (taskId, event, ephemeral) => {
        if (ephemeral) {
          // §4.1/§4.6: deltas are RAM-only — wrapped as
          // EphemeralDeltaEnvelope, buffered by the coalescer, never stored.
          const e = event as { type?: string; turnId?: string; deltaOffset?: number; text?: string };
          if (
            (e.type === "assistant.delta" || e.type === "reasoning.delta") &&
            typeof e.turnId === "string"
          ) {
            deltaCoalescer.push({
              v: 1,
              kind: "event",
              reliability: "ephemeral",
              taskId,
              turnId: e.turnId,
              type: e.type,
              deltaOffset: typeof e.deltaOffset === "number" ? e.deltaOffset : 0,
              text: typeof e.text === "string" ? e.text : "",
              ts: Date.now(),
            } as import("@codex-sidepanel/shared").Envelope);
          }
          return;
        }
        // durable event → flush pending deltas first so clients see
        // causal order (deltas before the terminal/durable marker)
        deltaCoalescer.flushTask(taskId);
        if (typeof event === "object" && "kind" in event) {
          ipc?.broadcast(event as import("@codex-sidepanel/shared").Envelope);
        }
      },
      pendingApprovals: (taskId) =>
        typeof (store as { countPendingApprovals?: (id: string) => number }).countPendingApprovals ===
        "function"
          ? (store as { countPendingApprovals: (id: string) => number }).countPendingApprovals(taskId)
          : 0,
    });

    const providers: HelloResponseProviders = [
      {
        id: "codex",
        available: config.providers.codex.enabled,
        capabilities: CODEX_CAPABILITIES,
      },
      {
        id: "claude",
        available: config.providers.claude.enabled,
        capabilities: CLAUDE_SESSION_CAPABILITIES,
      },
    ];

    const snapshotChunks = new SnapshotChunkStore();
    const playwrightRuntime = new PlaywrightRuntimeManager();

    // ---- browser tool server (P1-09) ----
    // Signed tokens (dataDir/auth/tool-secret, 0600); dispatch goes to
    // the first authed connection as the browser host until P2-03 lands
    // real host affinity. Approval = durable permission.requested +
    // approvals row; resolution via permission.respond (browser path
    // handled in the router below). Full §4.8 engine is P2-04.
    const toolTokens = await ToolTokenManager.create(dataDir);
    // §9.1: Gateway-initiated refresh 2min before expiry; delivery =
    // scope-file rewrite (MCP stdio re-reads per call = hot-update).
    const toolRefresher = new ToolTokenRefresher({
      tokens: toolTokens,
      notify: (notice) => {
        void updateMcpScopeToken(dataDir, notice.taskId, notice.token, notice.expiresAt).catch(
          (err) => log(`tool token refresh scope update failed: ${err instanceof Error ? err.message : String(err)}`),
        );
      },
    });

    /** §9.3 shared spawn path — used by SessionManager (per-session
     *  MCP registration) and the browser.mcp.spawn RPC. */
    spawnBrowserMcpForTask = async (task: TaskRecord) => {
      // browser tools only make sense for providers that speak MCP —
      // capability comes from the provider registry at session open;
      // here we gate on the task actually having a browser backend.
      const backendId = task.backend.backendId ?? "chrome-extension";
      if (backendId !== "chrome-extension" && backendId !== "playwright-cdp" && backendId !== "playwright-isolated") {
        return null;
      }
      // chromex-51ua: advertise exactly what the pinned backend can
      // execute — tools/list and the token's allowedTools both derive
      // from this set, so an unsupported tool fails proto.unsupported
      // instead of being listed and dying at dispatch.
      const allowedTools = supportedToolsForBackend(backendId);
      const issued = toolRefresher.track({
        taskId: task.taskId,
        profileId: task.profileId,
        backendId: backendId as never,
        allowedTools,
      });
      const scopeFile = await writeMcpScopeFile(dataDir, {
        taskId: task.taskId,
        token: issued.token,
        tokenExpiresAt: issued.expiresAt,
        profileId: task.profileId,
        backendId: backendId as never,
        allowedTools,
        gatewayEndpoint: ipcEndpointPath(dataDir),
        gatewayTokenFile: path.join(dataDir, "auth", "token"),
      });
      const mcpStdioJs = fileURLToPath(new URL("../browser/mcp-stdio.js", import.meta.url));
      return {
        chromex_browser: {
          command: process.execPath,
          args: [mcpStdioJs],
          env: { CHROMEX_MCP_SCOPE_FILE: scopeFile },
        },
      };
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    // P2-08: surface metrics on the gateway stream — throttled to one
    // broadcast per 5s so tool-heavy turns don't flood clients.
    let lastDiagBroadcast = 0;
    const broadcastDiagnostics = () => {
      const now = Date.now();
      if (!ipc || now - lastDiagBroadcast < 5000) return;
      lastDiagBroadcast = now;
      const ep = ipc.endpointPath();
      ipc.broadcast({
        v: 1,
        kind: "event",
        reliability: "ephemeral",
        stream: "gateway",
        type: "gateway.diagnostics",
        ts: now,
        diagnostics: diagnostics.snapshot({
          store,
          lifetime: { held: true, fence: lifetimeLock!.fence },
          endpoint: {
            path: `${ep.transport}://${ep.path}`,
            authedConnections: ipc.authedConnections().length,
          },
        }),
      });
    };
    const hostRegistry = new BrowserHostRegistry();
    // P2-07: isolated playwright backend — lazy playwright-core load;
    // absent dep surfaces browser.backend_unavailable at execute time.
    const playwrightBackend = new PlaywrightIsolatedBackend({
      executablePath: async () => (await playwrightRuntime.readStatus()).browserExecutablePath || null,
    });
    const toolServer = new BrowserToolServer({
      tokens: toolTokens,
      agentEgressDestination: config.browser.agentEgressDestination,
      sensitiveOrigins: config.browser.sensitiveOrigins,
      backendGate: (req) => {
        // §6.6: pinned backend vs tool requirement. tabIntent-bound
        // tasks (active_resolved/explicit) need the user's real tabs —
        // an isolated pin cannot serve them.
        const task = store.getTask(req.taskId);
        if (!task) return null;
        const needsRealTab = task.tabIntent.scope !== "untitled";
        const mismatch = backendMismatchFor(task.backend.backendId, needsRealTab);
        if (mismatch) {
          return { code: mismatch, message: `task pinned to ${task.backend.backendId} cannot serve tab-bound work` };
        }
        return null;
      },
      resolveHost: (taskId) => {
        // §6.1 host registry: affinity + scope matching; stranded tabs
        // report no_host until a same-browserInstanceId host returns.
        const task = store.getTask(taskId);
        // P2-07: playwright-isolated tasks dispatch to the isolated
        // backend — no extension host involved, no user session.
        if (task?.backend.backendId === "playwright-isolated") {
          return {
            hostInstanceId: "playwright-isolated",
            send: async (_method, payload) => {
              const p = payload as { tool?: string; args?: Record<string, unknown> };
              return playwrightBackend.execute(taskId, p.tool as never, p.args ?? {});
            },
            onDisconnect: () => {},
          };
        }
        const res = hostRegistry.resolveHost({
          profileId: task?.profileId ?? "codex",
          browserInstanceId: task?.originBrowserInstanceId ?? task?.binding.browserInstanceId ?? null,
          backendId: task?.backend.backendId ?? "chrome-extension",
        });
        if (res.kind !== "host") {
          // chromex-jtl: typed rejections reach the tool caller — a
          // profile mismatch is wrong_profile, everything else no_host.
          if (res.kind === "wrong_profile") {
            return {
              error: {
                code: "browser.wrong_profile",
                message: `no host serves profile ${res.expected} (registered: ${res.got})`,
              },
            };
          }
          return {
            error: {
              code: "browser.no_host",
              message: `no browser host for task scope (${res.kind})`,
            },
          };
        }
        const conn = ipc?.authedConnections().find(
          (c) => c.hostInstanceId !== "" && c.remoteAddress === res.hostInstanceId,
        );
        // hostInstanceId is the conn remoteAddress in the channel impl;
        // match by hostInstanceId field instead when available.
        const hostConn =
          conn ??
          ipc?.authedConnections().find((c) => {
            // registry keyed by remoteAddress today; fall back to any host conn
            return c.hostInstanceId !== "";
          });
        if (!hostConn) return null;
        hostRegistry.noteTabAffinity(
          {
            profileId: task?.profileId ?? "codex",
            browserInstanceId: task?.originBrowserInstanceId ?? task?.binding.browserInstanceId ?? null,
            backendId: task?.backend.backendId ?? "chrome-extension",
          },
          res.hostInstanceId,
        );
        return {
          hostInstanceId: res.hostInstanceId,
          send: (method, payload) => hostConn.request(method, payload, 15_000),
          onDisconnect: (listener) => hostConn.onClose(() => listener("disconnect")),
        };
      },
      requestApproval: async (tctx) => {
        const approvalId = `appr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const approvalStartedAt = Date.now();
        diagnostics.recordApprovalRequested();
        const options: Array<{
          id: string;
          label: string;
          kind: "allow_once" | "allow_task" | "allow_egress_task" | "deny";
        }> = [
          { id: "allow_once", label: "Allow once", kind: "allow_once" },
          ...(tctx.allowTaskScope
            ? [{ id: "allow_task", label: "Allow for this task", kind: "allow_task" as const }]
            : []),
          // §4.8 egress consent: one pick covers clean page-text egress
          // to this destination for the task's lifetime. The classifier
          // only sets egressTaskScope for non-sensitive page-text —
          // screenshots and sensitiveContent never see this option.
          ...(tctx.egressTaskScope
            ? [
                {
                  id: "allow_egress_task",
                  label: "Allow page content for this task",
                  kind: "allow_egress_task" as const,
                },
              ]
            : []),
          { id: "deny", label: "Deny", kind: "deny" },
        ];
        const storeAny = store as unknown as {
          insertApproval?: (r: {
            approvalId: string; taskId: string; turnId?: string;
            request: unknown; actionDigest: string;
            status: "pending" | "allowed" | "denied" | "expired"; createdAt: number;
          }) => void;
          appendTaskEvent?: (taskId: string, e: unknown) => unknown;
          approvalStatus?: (id: string) => string | null;
          approvalDecision?: (id: string) => { optionId: string; scope?: string } | null;
          resolveApproval?: (
            id: string,
            s: "allowed" | "denied" | "expired",
            d?: { optionId: string; kind: string; decidedAt: number; scope?: string },
          ) => void;
        };
        const request = {
          requestId: approvalId,
          taskId: tctx.taskId,
          ...(tctx.turnId ? { turnId: tctx.turnId } : {}),
          kind: tctx.kind,
          risk: tctx.risk,
          summary: `${tctx.tool} requires approval (${tctx.reason})`,
          actionDigest: tctx.actionDigest,
          options,
          details: {
            tool: tctx.tool,
            argsPreview: tctx.details.argsPreview,
            origin: tctx.details.origin,
            ...(tctx.details.targetLabel ? { targetLabel: tctx.details.targetLabel } : {}),
            ...(tctx.details.allowTaskScope ? { allowTaskScope: tctx.details.allowTaskScope } : {}),
            ...(tctx.details.egressTaskScope ? { egressTaskScope: tctx.details.egressTaskScope } : {}),
          },
        };
        storeAny.insertApproval?.({
          approvalId,
          taskId: tctx.taskId,
          ...(tctx.turnId ? { turnId: tctx.turnId } : {}),
          request,
          actionDigest: tctx.actionDigest,
          status: "pending",
          createdAt: Date.now(),
        });
        const requestedEnv = (
          store as { appendTaskEvent?: (id: string, e: unknown) => { kind?: string } | null }
        ).appendTaskEvent?.(tctx.taskId, {
          type: "permission.requested",
          ...(tctx.turnId ? { turnId: tctx.turnId } : {}),
          request,
        });
        // live clients must see the card immediately — durable persist
        // alone only reaches them via task.sync replay (chromex-7kf)
        if (requestedEnv && requestedEnv.kind === "event") {
          ipc?.broadcast(requestedEnv as import("@codex-sidepanel/shared").Envelope);
        }
        // poll for resolution up to 60s (UI answers via permission.respond)
        for (let i = 0; i < 240; i++) {
          const st = storeAny.approvalStatus?.(approvalId);
          if (st === "allowed" || st === "denied" || st === "expired") {
            diagnostics.recordApprovalLatency(Date.now() - approvalStartedAt);
            broadcastDiagnostics();
            const optionId = storeAny.approvalDecision?.(approvalId)?.optionId;
            return st === "allowed"
              ? { verdict: "approved" as const, ...(optionId ? { optionId } : {}) }
              : { verdict: "denied" as const, ...(optionId ? { optionId } : {}) };
          }
          await sleep(250);
        }
        diagnostics.recordApprovalLatency(Date.now() - approvalStartedAt);
        broadcastDiagnostics();
        // A permission.respond may have landed during the final poll
        // sleep — re-check so permission.expired never follows
        // permission.resolved on the same request (§5.7 no double-resolve).
        const lateStatus = storeAny.approvalStatus?.(approvalId);
        if (lateStatus === "allowed" || lateStatus === "denied" || lateStatus === "expired") {
          const lateOptionId = storeAny.approvalDecision?.(approvalId)?.optionId;
          return lateStatus === "allowed"
            ? { verdict: "approved" as const, ...(lateOptionId ? { optionId: lateOptionId } : {}) }
            : { verdict: "denied" as const, ...(lateOptionId ? { optionId: lateOptionId } : {}) };
        }
        // 60s poll expired — close the row + emit permission.expired so
        // replayed clients clear the card instead of waiting forever.
        storeAny.resolveApproval?.(approvalId, "expired", {
          optionId: "timeout",
          kind: "deny",
          decidedAt: Date.now(),
        });
        const expiredEnv = (
          store as { appendTaskEvent?: (id: string, e: unknown) => { kind?: string } | null }
        ).appendTaskEvent?.(tctx.taskId, {
          type: "permission.expired",
          requestId: approvalId,
          reason: "timeout",
        });
        if (expiredEnv && expiredEnv.kind === "event") {
          ipc?.broadcast(expiredEnv as import("@codex-sidepanel/shared").Envelope);
        }
        return { verdict: "timeout" as const };
      },
      allowTaskGranted: async (taskId, scope, actionDigest) => {
        const rows = (store as { listApprovals?: (id: string) => Array<{ status: string; request?: unknown; decision: { optionId: string; scope?: string } | null }> }).listApprovals?.(taskId) ?? [];
        return rows.some((r) => {
          if (
            r.status !== "allowed" ||
            r.decision?.optionId !== "allow_task" ||
            r.decision.scope !== scope
          ) {
            return false;
          }
          // §4.8: the grant is bound to the approved action's digest —
          // changed args/snapshot/url/egress invalidate reuse.
          const grantedDigest = (r.request as { actionDigest?: unknown } | null | undefined)
            ?.actionDigest;
          return grantedDigest === actionDigest;
        });
      },
      grantAllowTask: (taskId, scope) => {
        // grant is recorded by permission.respond → resolveApproval
        // decision.scope; this hook exists for symmetry/audit.
        void taskId;
        void scope;
      },
      egressTaskGranted: async (taskId, scope) => {
        // Same approvals-table source as allowTaskGranted, but the
        // grant is scope-bound only (no actionDigest): it covers the
        // egress class for the task lifetime by design.
        const rows = (store as { listApprovals?: (id: string) => Array<{ status: string; request?: unknown; decision: { optionId: string; scope?: string } | null }> }).listApprovals?.(taskId) ?? [];
        return rows.some(
          (r) =>
            r.status === "allowed" &&
            r.decision?.optionId === "allow_egress_task" &&
            r.decision.scope === scope,
        );
      },
      grantEgressTask: (taskId, scope) => {
        // grant is recorded by permission.respond → resolveApproval
        // decision.scope; this hook exists for symmetry/audit.
        void taskId;
        void scope;
      },
      onClassified: (taskId, actx, v) => {
        // §4.8 audit: redacted ActionContext — args values are NOT
        // logged, only classification + target metadata.
        const storeAny = store as { appendTaskEvent?: (id: string, e: unknown) => unknown };
        storeAny.appendTaskEvent?.(taskId, {
          type: "browser.tool.classified",
          action: actx.action,
          risk: v.risk,
          needsApproval: v.needsApproval,
          reason: v.reason,
          origin: actx.origin || null,
          targetLabel: actx.target?.label ?? null,
          contextResolved: actx.contextResolved,
        });
      },
      onOutcome: (outcome) => {
        diagnostics.recordToolOutcome(outcome);
        broadcastDiagnostics();
      },
    });

    // S8: browser tool calls are first-class durable evidence — every
    // call emits tool.started at dispatch and tool.completed with the
    // real outcome + verified flag at finish, so the task stream (and
    // the rebuilt snapshot) shows what the agent did in the browser.
    // Keyed by toolCallId so browser.tool.cancel can close the record
    // the call handler opened; a later real outcome still wins honesty
    // (cancelled is only emitted when the server actually finished it).
    const browserToolCalls = new Map<
      string,
      { taskId: string; turnId: string; tool: string }
    >();
    const appendTaskEventBroadcast = (taskId: string, event: DurableTaskEvent): void => {
      const env = (
        store as {
          appendTaskEvent?: (id: string, e: DurableTaskEvent) => { kind?: string } | null;
        }
      ).appendTaskEvent?.(taskId, event);
      if (env && env.kind === "event") {
        ipc?.broadcast(env as import("@codex-sidepanel/shared").Envelope);
      }
    };

    // config is mutable via config.update; the resolved object is
    // replaced (never mutated) so in-flight readers see a consistent
    // snapshot.
    let liveConfig = config;

    ipc = new GatewayIpcServer(dataDir, config.gateway.maxEnvelopeBytes, async (req, conn) => {
      try {
        return await handleGatewayRequest(req, {
          store,
          diagnostics,
          lifetimeLock: lifetimeLock!,
          getIpc: () => ipc!,
          config: liveConfig,
          getConfig: () => liveConfig,
          setConfig: (next) => {
            liveConfig = next;
          },
          dataDir,
          providers,
          conn,
          sessionManager,
          registry,
          snapshotChunks,
          playwrightRuntime,
          toolServer,
          toolRefresher,
          hostRegistry,
          browserToolCalls,
          appendTaskEventBroadcast,
          appServices,
          spawnBrowserMcp: (task) => spawnBrowserMcpForTask?.(task) ?? Promise.resolve(null),
        });
      } catch (err) {
        if (err instanceof StaleFenceError) {
          log("stale fence detected — self-shutdown");
          // defer one turn so the refusal response reaches the client
          // before ipc.close() tears the socket down
          setImmediate(() => void shutdown("stale-fence"));
          throw err;
        }
        throw err;
      }
    });
    await ipc.writeTokenFile();
    await ipc.listen();

    // §5.5 retention sweep: archive terminal tasks past retentionDays,
    // then checkpoint+prune unprotected events (P1-11). Idempotent;
    // runs once per gateway start (periodic sweep is follow-up).
    try {
      const archivedIds = runRetentionSweep(store as never);
      if (archivedIds.length > 0) log(`retention sweep archived ${archivedIds.length} task(s)`);
      const pruned = runPruneSweep(store as never);
      if (pruned.eventsDeleted > 0 || pruned.checkpointsWritten > 0) {
        log(
          `prune sweep: ${pruned.eventsDeleted} events deleted, ` +
            `${pruned.checkpointsWritten} checkpoints, ${pruned.milestones.length} milestones`,
        );
      }
      // §5.5 approval + artifact TTL sweeps (SQLite store only —
      // in-memory has nothing durable to expire).
      const s = store as {
        sweepResolvedApprovals?: (ms: number) => number;
        sweepExpiredArtifacts?: (ms: number) => Promise<{ rows: number; filesDeleted: number }>;
      };
      if (s.sweepResolvedApprovals) {
        const n = s.sweepResolvedApprovals(Date.now() - APPROVAL_POST_TERMINAL_MS);
        if (n > 0) log(`approval sweep removed ${n} resolved approval(s)`);
      }
      if (s.sweepExpiredArtifacts) {
        const a = await s.sweepExpiredArtifacts(Date.now() - ARTIFACT_TTL_MS);
        if (a.rows > 0) log(`artifact sweep removed ${a.rows} row(s), ${a.filesDeleted} file(s)`);
      }
    } catch (err) {
      log(`retention/prune sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // recovery runs before ready (P1-02 wires real recovery); in-memory
    // store starts empty so nothing to recover yet.
    store.appendGatewayEvent({
      type: "gateway.started",
      version: GATEWAY_VERSION,
      recoveredTurns,
      recoveredTasks,
    });

    ipc.markReady();
    // §3.3.2: republish the endpoint with the real version + ownership
    // fence — listen() publishes a placeholder before the lock fence is
    // handed to clients; the atomic rename makes the upgrade invisible.
    await ipc
      .publishEndpoint(GATEWAY_VERSION, lifetimeLock.fence)
      .catch((err) => log(`endpoint republish failed: ${err instanceof Error ? err.message : String(err)}`));
    log(`ready pid=${process.pid} dir=${dataDir} fence=${lifetimeLock.fence}`);

    let shuttingDown = false;
    const shutdown = async (reason = "user") => {
      if (shuttingDown) return;
      shuttingDown = true;
      ipc?.markStarting();
      // no self-exit while active work — in-memory store has no active
      // turns yet; real check lands with P1-05 SessionManager.
      deltaCoalescer.dispose();
      db?.close();
      await ipc?.close().catch(() => {});
      await lifetimeLock?.release().catch(() => {});
      await startupLock.release().catch(() => {});
      log(`shutdown (${reason})`);
    };

    const onSignal = () => void shutdown("signal");
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);

    return {
      dataDir,
      config,
      store,
      db,
      ipc,
      lifetimeLock: lifetimeLock!,
      shutdown,
    };
  } catch (err) {
    await ipc?.close().catch(() => {});
    await lifetimeLock?.release().catch(() => {});
    await startupLock.release().catch(() => {});
    throw err;
  }
}

type HelloResponseProviders = import("@codex-sidepanel/shared").HelloResponse["providers"];

// Honest capability advertisement — sourced from the provider
// implementations, not hand-maintained literals (§8.1 intersection).

function invalidRequest(issues: string): ProtocolError {
  return perr("proto.invalid", `invalid request payload: ${issues}`);
}

/**
 * route.plan / browser.action.plan are codex-shaped planning calls —
 * only the codex provider exposes the app-server planning planes.
 */
function codexPlanningProvider(registry: ProviderRegistry): CodexAgentProvider {
  const entry = registry.get("codex");
  const provider = entry?.provider;
  if (!entry?.config.enabled || !(provider instanceof CodexAgentProvider)) {
    throw perr("provider.unavailable", "route planning requires an enabled codex provider");
  }
  return provider;
}

/** zod → proto.invalid helper; returns parsed payload or throws. */
function parsePayload<S extends { safeParse: (v: unknown) => { success: boolean; data?: unknown; error?: { issues: Array<{ path: PropertyKey[]; message: string }> } } }>(
  schema: S,
  payload: unknown,
): unknown {
  const r = schema.safeParse(payload ?? {});
  if (!r.success) {
    const issues = (r.error?.issues ?? [])
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw invalidRequest(issues);
  }
  return r.data;
}

/** Same derivation as GatewayIpcServer.endpointPath — kept in sync. */
function ipcEndpointPath(dataDir: string): string {
  const hash = createHash("sha256").update(dataDir).digest("hex").slice(0, 16);
  if (process.platform === "win32") return `\\.\pipe\chromex-gateway-${hash}`;
  return path.join(dataDir, "run", `gw-${hash}.sock`);
}

/** Per-field budget for browser tool output on the durable stream —
 *  page snapshots/extracts can be large; the snapshot layer keeps only
 *  ~4KB anyway, so 32KB here preserves evidence without log bloat. */
const BROWSER_TOOL_OUTPUT_MAX_CHARS = 32 * 1024;

function browserToolOutputPayload(outcome: ToolCallOutcome): unknown {
  const parts: Record<string, unknown> = {};
  if (outcome.result !== undefined) {
    parts.result = boundJsonPreview(outcome.result, BROWSER_TOOL_OUTPUT_MAX_CHARS);
  }
  if (outcome.error) parts.error = outcome.error;
  return Object.keys(parts).length > 0 ? parts : undefined;
}

function browserToolOutcomeStatus(
  status: ToolCallOutcome["status"],
): "succeeded" | "failed" | "cancelled" | "unknown" {
  // ToolOutcome vocabulary: provider "completed" == "succeeded".
  return status === "completed" ? "succeeded" : status;
}

async function handleGatewayRequest(
  req: Extract<Envelope, { kind: "request" }>,
  ctx: {
    store: InMemoryStore | SQLiteStore;
    diagnostics: GatewayDiagnostics;
    lifetimeLock: { fence: string; held?: boolean };
    getIpc: () => GatewayIpcServer;
    config: GatewayConfig;
    getConfig: () => GatewayConfig;
    setConfig: (next: GatewayConfig) => void;
    dataDir: string;
    providers: HelloResponseProviders;
    conn: IpcConnection;
    sessionManager: SessionManager;
    registry: ProviderRegistry;
    snapshotChunks: SnapshotChunkStore;
    playwrightRuntime: PlaywrightRuntimeManager;
    toolServer: BrowserToolServer;
    hostRegistry: BrowserHostRegistry;
    toolRefresher: ToolTokenRefresher;
    /** S8 evidence ledger: toolCallId → owning task/turn/tool for
     *  browser.tool.* durable events (main.ts scope). */
    browserToolCalls: Map<string, { taskId: string; turnId: string; tool: string }>;
    appendTaskEventBroadcast: (taskId: string, event: DurableTaskEvent) => void;
    appServices: AppServiceRegistry;
    spawnBrowserMcp?: (task: TaskRecord) => Promise<Record<string, unknown> | null>;
  },
): Promise<unknown> {
  switch (req.method) {
    case "hello": {
      const parsed = parseHelloRequest(req.payload);
      if ("error" in parsed) throw helloError(parsed);
      if (parsed.protocolVersion !== 1) {
        throw protocolError("proto.version_mismatch", "protocol major mismatch", {
          client: parsed.protocolVersion,
          gateway: 1,
        });
      }
      if (ctx.conn.hostInstanceId) {
        ctx.hostRegistry.register({
          hostInstanceId: ctx.conn.remoteAddress,
          connectionId: ctx.conn.remoteAddress,
          browserInstanceId: ctx.conn.browserInstanceId,
          // NOTE: hello.profileId is the extension-installation id
          // ("prof-…"), NOT the task profileId (provider key "codex"/…)
          // — different namespaces; registering it would make every
          // host look wrong_profile. Browser-profile isolation is
          // already carried by browserInstanceId + connection.
        });
        ctx.conn.onClose(() => ctx.hostRegistry.unregisterByConnection(ctx.conn.remoteAddress));
      }
      return buildHelloResponse(parsed, {
        store: ctx.store,
        config: ctx.config,
        providers: ctx.providers,
      });
    }
    case "task.create": {
      const p = parsePayload(taskCreateSchema, req.payload) as z.infer<typeof taskCreateSchema>;
      const cfg = ctx.getConfig();
      const task = ctx.sessionManager.createTask({
        profileId: p.profileId ?? "codex",
        providerId: (p.providerId as never) ?? "codex",
        ...(p.conversationKey ? { conversationKey: p.conversationKey } : {}),
        cwd: p.cwd,
        title: p.title ?? null,
        model: p.model ?? null,
        modeId: p.modeId ?? null,
        thinkingOptionId: p.thinkingOptionId ?? null,
        providerOptions: p.providerOptions ?? null,
        backend: resolveBackendSelection({
          requested: p.backend ?? null,
          defaultBackend: cfg.browser.defaultBackend,
          allowedBackends: cfg.browser.allowedBackends,
          playwrightEnabledByUser: cfg.browser.playwright.enabledByUser,
          playwrightRuntimeAvailable: (await ctx.playwrightRuntime.readStatus()).available,
        }).backend,
        tabIntent: (p.tabIntent as never) ?? { scope: "untitled" },
        originBrowserInstanceId: p.browserInstanceId ?? null,
      });
      return { taskId: task.taskId, status: task.status };
    }
    case "task.get": {
      const p = parsePayload(taskIdSchema, req.payload) as { taskId: string };
      const task = ctx.store.getTask(p.taskId);
      if (!task) throw perr("task.not_found", `task ${p.taskId} not found`);
      return {
        task,
        attention: ctx.sessionManager.attentionFor(p.taskId),
        activeTurn: ctx.store.activeTurn(p.taskId) ?? null,
      };
    }
    case "task.list": {
      const p = req.payload as { status?: string; limit?: number } | undefined;
      let tasks = ctx.store.listTasks();
      if (p?.status) tasks = tasks.filter((t) => t.status === p.status);
      if (p?.limit) tasks = tasks.slice(0, p.limit);
      return {
        tasks: tasks.map((t) => ({
          taskId: t.taskId,
          status: t.status,
          title: t.title,
          profileId: t.profileId,
          providerId: t.providerId,
          lastSeq: t.lastSeq,
          updatedAt: t.updatedAt,
        })),
      };
    }
    case "app.report": {
      // chromex-p21: agent registers a dev server it started. Upserts
      // by (taskId, name); the next turn's PRIVATE APP CONTEXT carries
      // it to the provider. In-memory only — see AppServiceRegistry.
      const p = parsePayload(appReportSchema, req.payload) as z.infer<typeof appReportSchema>;
      if (!ctx.store.getTask(p.taskId)) {
        throw perr("task.not_found", `task ${p.taskId} not found`);
      }
      const service = ctx.appServices.report(p.taskId, p);
      return { ok: true, service };
    }
    case "app.list": {
      const p = parsePayload(taskIdSchema, req.payload) as { taskId: string };
      if (!ctx.store.getTask(p.taskId)) {
        throw perr("task.not_found", `task ${p.taskId} not found`);
      }
      return { services: ctx.appServices.list(p.taskId) };
    }
    case "task.send": {
      const p = parsePayload(taskSendSchema, req.payload) as z.infer<typeof taskSendSchema>;
      return ctx.sessionManager.sendMessage(p.taskId, {
        clientMessageId: p.clientMessageId,
        content: p.content as never,
        ...(p.ctx ? { ctx: p.ctx as never } : {}),
      });
    }
    case "task.steer": {
      // §10: legacy turn.steer → task.steer (capability-gated).
      const p = parsePayload(taskSteerSchema, req.payload) as z.infer<typeof taskSteerSchema>;
      return ctx.sessionManager.steer(p.taskId, {
        clientMessageId: p.clientMessageId,
        content: p.content as never,
        ...(p.ctx ? { ctx: p.ctx as never } : {}),
      });
    }
    case "task.cancel": {
      const p = parsePayload(taskIdSchema, req.payload) as { taskId: string };
      const reason = (req.payload as { reason?: string } | undefined)?.reason ?? "user";
      await ctx.sessionManager.cancelTask(p.taskId, reason);
      return { ok: true };
    }
    case "task.pause": {
      const p = parsePayload(taskIdSchema, req.payload) as { taskId: string };
      ctx.sessionManager.pauseTask(p.taskId);
      return { ok: true };
    }
    case "task.resume": {
      const p = parsePayload(taskIdSchema, req.payload) as { taskId: string };
      ctx.sessionManager.resumeTask(p.taskId);
      return { ok: true };
    }
    case "task.reopen": {
      const p = parsePayload(taskIdSchema, req.payload) as { taskId: string };
      const task = ctx.sessionManager.reopenTask(p.taskId);
      return { taskId: task.taskId, status: task.status };
    }
    case "task.setBackend": {
      // §6.6: user-only — host/provider connections must not re-pin
      // the backend mid-task.
      if (ctx.conn.hostInstanceId) {
        throw protocolError("proto.forbidden", "task.setBackend is user-only");
      }
      const p = req.payload as { taskId?: string; backend?: unknown } | undefined;
      if (!p?.taskId || !p.backend || typeof p.backend !== "object") {
        throw invalidRequest("taskId + backend required");
      }
      const requested = p.backend as { backendId?: string; pinnedBy?: string };
      const cfg = ctx.getConfig();
      const validated = resolveBackendSelection({
        requested: {
          backendId: requested.backendId as never,
          pinnedBy: (requested.pinnedBy as "user" | "policy" | "default" | undefined) ?? "user",
        },
        defaultBackend: cfg.browser.defaultBackend,
        allowedBackends: cfg.browser.allowedBackends,
        playwrightEnabledByUser: cfg.browser.playwright.enabledByUser,
        playwrightRuntimeAvailable: (await ctx.playwrightRuntime.readStatus()).available,
      }).backend;
      const task = ctx.sessionManager.setBackend(p.taskId, validated);
      return { taskId: task.taskId, backend: task.backend };
    }
    case "turn.interrupt": {
      const p = parsePayload(turnInterruptSchema, req.payload) as z.infer<typeof turnInterruptSchema>;
      await ctx.sessionManager.interruptTurn(p.taskId, p.turnId);
      return { ok: true };
    }
    case "task.interrupt": {
      // legacy alias kept for in-flight clients during migration
      const p = parsePayload(turnInterruptSchema, req.payload) as z.infer<typeof turnInterruptSchema>;
      await ctx.sessionManager.interruptTurn(p.taskId, p.turnId);
      return { ok: true };
    }
    case "permission.respond": {
      const p = parsePayload(permissionRespondSchema, req.payload) as z.infer<typeof permissionRespondSchema>;
      // browser-tool approvals live in the approvals table, not provider
      // sessions — resolve the row directly (idempotent no-op if the
      // provider path already handled it).
      const storeAny = ctx.store as {
        approvalStatus?: (id: string) => string | null;
        approvalRequest?: (id: string) => unknown;
        resolveApproval?: (
          id: string,
          s: "allowed" | "denied" | "expired",
          d?: { optionId: string; kind: string; decidedAt: number; scope?: string },
        ) => void;
      };
      const hasApprovalStore = typeof storeAny.approvalStatus === "function";
      // §5.7: snapshot BEFORE dispatching — a provider-owned approval is
      // resolved by the session mirror during respondToPermission, so
      // the post-call status alone cannot distinguish first-resolve
      // from already-decided.
      const statusBefore = hasApprovalStore ? storeAny.approvalStatus!(p.requestId) : null;
      if (hasApprovalStore && statusBefore !== null && statusBefore !== "pending") {
        throw perr(
          "approval.already_decided",
          `approval ${p.requestId} already ${statusBefore}`,
        );
      }
      // allow_task scope comes from the stored request details —
      // the digest-bound scope, never client-supplied. Provider-
      // mirrored approvals store the whole permission.requested
      // AgentEvent, so details may sit one level down under `request`.
      const reqRow =
        statusBefore === "pending"
          ? (storeAny.approvalRequest?.(p.requestId) as
              | {
                  taskId?: string;
                  turnId?: string;
                  options?: Array<{ id?: string; kind?: string }>;
                  details?: { allowTaskScope?: string; egressTaskScope?: string };
                  request?: {
                    taskId?: string;
                    turnId?: string;
                    options?: Array<{ id?: string; kind?: string }>;
                    details?: { allowTaskScope?: string; egressTaskScope?: string };
                  };
                }
              | null
              | undefined)
          : undefined;
      const offered = reqRow?.options ?? reqRow?.request?.options;
      const matched =
        p.optionId !== undefined && Array.isArray(offered)
          ? offered.find((o) => o && typeof o === "object" && o.id === p.optionId)
          : undefined;
      // §5.7: optionId must be one of the options the request actually
      // offered — validated BEFORE dispatch so a bogus optionId never
      // reaches the provider session either.
      if (
        p.optionId !== undefined &&
        Array.isArray(offered) &&
        offered.length > 0 &&
        !matched
      ) {
        throw perr(
          "proto.invalid",
          `optionId ${JSON.stringify(p.optionId)} is not offered by approval ${p.requestId}`,
        );
      }
      const optionId = String(p.optionId ?? "");
      const matchedKind = matched?.kind;
      const denied = matchedKind === "deny" || optionId.toLowerCase() === "deny";
      const kind =
        matchedKind === "allow_once" ||
        matchedKind === "allow_task" ||
        matchedKind === "allow_egress_task" ||
        matchedKind === "deny"
          ? matchedKind
          : denied
            ? "deny"
            : optionId === "allow_task" || optionId === "allow_egress_task"
              ? optionId
              : "allow_once";
      // allow_task / allow_egress_task scopes come from the stored
      // request details — never client-supplied. The two grants persist
      // under different details keys.
      const scope =
        optionId === "allow_task"
          ? (reqRow?.details?.allowTaskScope ?? reqRow?.request?.details?.allowTaskScope)
          : optionId === "allow_egress_task"
            ? (reqRow?.details?.egressTaskScope ?? reqRow?.request?.details?.egressTaskScope)
            : undefined;
      const result = await ctx.sessionManager.respondToPermission(p.requestId, {
        ...(p.optionId !== undefined ? { optionId: p.optionId } : {}),
        ...(p.answers !== undefined ? { answers: p.answers } : {}),
      });
      if (!hasApprovalStore) return result;
      if (statusBefore === null) {
        // neither the approvals table nor any provider session owns
        // this requestId — never silently drop the response.
        throw perr("approval.not_found", `approval ${p.requestId} not found`);
      }
      // Provider path already resolved the row via the permission.resolved
      // mirror — nothing left to do. Still pending ⇒ browser-tool
      // approval (or a provider that resolved without emitting the
      // event); resolve + emit the durable lifecycle event ourselves.
      if (statusBefore === "pending" && storeAny.approvalStatus!(p.requestId) === "pending") {
        storeAny.resolveApproval?.(
          p.requestId,
          denied ? "denied" : "allowed",
          {
            optionId,
            kind,
            decidedAt: Date.now(),
            ...(scope ? { scope } : {}),
          },
        );
        // durable permission.resolved on the task stream — replayed
        // clients clear the approval card; the approvals table alone
        // is not visible to task.sync consumers. Browser-tool approvals
        // store the request object (taskId at top level); provider-
        // mirrored approvals store the permission.requested AgentEvent
        // whose inner request.taskId is "" — recover via the turn row.
        const reqTurnId = reqRow?.turnId ?? reqRow?.request?.turnId;
        const reqTaskId =
          reqRow?.taskId ||
          reqRow?.request?.taskId ||
          (reqTurnId ? ctx.store.getTurn(reqTurnId)?.taskId : undefined);
        if (reqTaskId) {
          const resolvedEnv = (
            ctx.store as {
              appendTaskEvent?: (id: string, e: unknown) => { kind?: string } | null;
            }
          ).appendTaskEvent?.(reqTaskId, {
            type: "permission.resolved",
            requestId: p.requestId,
            decision: {
              kind,
            },
          });
          if (resolvedEnv && resolvedEnv.kind === "event") {
            ctx.getIpc().broadcast(resolvedEnv as import("@codex-sidepanel/shared").Envelope);
          }
        }
      }
      return result;
    }
    case "artifact.upload": {
      const p = parsePayload(artifactUploadSchema, req.payload) as z.infer<typeof artifactUploadSchema>;
      const task = ctx.store.getTask(p.taskId);
      if (!task) throw perr("task.not_found", `task ${p.taskId} not found`);
      // §4.1: bounded artifacts — 512KiB decoded max per upload.
      const MAX_B64 = 720_000;
      if (p.dataBase64.length > MAX_B64) {
        throw perr("artifact.too_large", `artifact exceeds ${MAX_B64} base64 chars`);
      }
      const buf = Buffer.from(p.dataBase64, "base64");
      if (buf.length > 512 * 1024) {
        throw perr("artifact.too_large", "artifact exceeds 512KiB decoded");
      }
      const sha256 = createHash("sha256").update(buf).digest("hex");
      const artifactId = `art-${ulid()}`;
      const ext = p.mimeType.includes("jpeg") ? "jpg" : p.mimeType.includes("png") ? "png" : "bin";
      const dir = path.join(ctx.dataDir, "artifacts");
      await fs.mkdir(dir, { recursive: true });
      const filePath = path.join(dir, `${artifactId}.${ext}`);
      await fs.writeFile(filePath, buf);
      const storeAny = ctx.store as {
        insertArtifact?: (r: {
          artifactId: string; taskId: string; kind: string; sha256: string;
          path: string; mime?: string; bytes?: number; createdAt: number;
        }) => void;
      };
      storeAny.insertArtifact?.({
        artifactId,
        taskId: p.taskId,
        kind: p.kind,
        sha256,
        path: filePath,
        mime: p.mimeType,
        bytes: buf.length,
        createdAt: Date.now(),
      });
      return { artifactRef: `artifact:${artifactId}`, sha256, bytes: buf.length, mimeType: p.mimeType };
    }
    case "browser.tool.call": {
      const p = parsePayload(browserToolCallSchema, req.payload) as z.infer<typeof browserToolCallSchema>;
      const task = ctx.store.getTask(p.taskId);
      if (!task) throw perr("task.not_found", `task ${p.taskId} not found`);
      const toolCallId =
        p.toolCallId ?? `rpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      // attribute to the caller's turn, else the task's live turn —
      // MCP-spawned calls carry no turnId (scope file has none).
      const turnId = p.turnId ?? ctx.store.activeTurn(p.taskId)?.turnId ?? "";
      ctx.browserToolCalls.set(toolCallId, { taskId: p.taskId, turnId, tool: p.tool });
      ctx.appendTaskEventBroadcast(p.taskId, {
        type: "tool.started",
        turnId,
        toolCallId,
        tool: p.tool,
        source: "browser",
        input: buildArgsPreview(p.args ?? {}),
      });
      let outcome: ToolCallOutcome;
      try {
        outcome = await ctx.toolServer.execute({
          toolCallId,
          taskId: p.taskId,
          ...(p.turnId ? { turnId: p.turnId } : {}),
          tool: p.tool,
          args: p.args ?? {},
          token: p.token,
          profileId: task.profileId,
          backendId: task.backend.backendId ?? "chrome-extension",
          browserInstanceId:
            task.originBrowserInstanceId ?? task.binding.browserInstanceId ?? null,
        });
      } catch (err) {
        // dispatch threw before a ToolCallOutcome existed — the stop is
        // unconfirmed, so record `unknown`, never a guessed failure.
        ctx.browserToolCalls.delete(toolCallId);
        ctx.appendTaskEventBroadcast(p.taskId, {
          type: "tool.completed",
          turnId,
          toolCallId,
          tool: p.tool,
          source: "browser",
          outcome: "unknown",
          output: {
            error: {
              code: "gateway.tool_error",
              message: err instanceof Error ? err.message : String(err),
            },
          },
          verified: "unknown",
        });
        throw err;
      }
      // a cancel RPC may have already closed this record — first writer
      // wins so the stream never shows two completions for one call.
      if (ctx.browserToolCalls.delete(toolCallId)) {
        ctx.appendTaskEventBroadcast(p.taskId, {
          type: "tool.completed",
          turnId,
          toolCallId,
          tool: p.tool,
          source: "browser",
          outcome: browserToolOutcomeStatus(outcome.status),
          ...(browserToolOutputPayload(outcome) !== undefined
            ? { output: browserToolOutputPayload(outcome) }
            : {}),
          verified: outcome.verified === undefined ? "unknown" : outcome.verified,
        });
      }
      return outcome;
    }
    case "browser.tool.cancel": {
      const p = parsePayload(
        z.object({ toolCallId: z.string().min(1), taskId: z.string().min(1) }),
        req.payload,
      ) as { toolCallId: string; taskId: string };
      const task = ctx.store.getTask(p.taskId);
      if (!task) throw perr("task.not_found", `task ${p.taskId} not found`);
      const outcome = ctx.toolServer.cancel(p.toolCallId);
      // close the durable record only when the server actually finished
      // the pending call — a null outcome means it was still in approval
      // or dispatch, and the call handler will record the real result.
      const tracked = ctx.browserToolCalls.get(p.toolCallId);
      if (outcome && tracked && tracked.taskId === p.taskId && ctx.browserToolCalls.delete(p.toolCallId)) {
        ctx.appendTaskEventBroadcast(tracked.taskId, {
          type: "tool.completed",
          turnId: tracked.turnId,
          toolCallId: p.toolCallId,
          tool: tracked.tool,
          source: "browser",
          outcome: "cancelled",
          verified: "unknown",
        });
      }
      return { cancelled: outcome !== null, outcome: outcome ?? null };
    }
    case "browser.mcp.spawn": {
      // §9.3: same path SessionManager uses at session open — issue a
      // scoped token, write the 0600 scope file, return the descriptor.
      const p = parsePayload(z.object({ taskId: z.string().min(1) }), req.payload) as {
        taskId: string;
      };
      const task = ctx.store.getTask(p.taskId);
      if (!task) throw perr("task.not_found", `task ${p.taskId} not found`);
      const servers = ctx.spawnBrowserMcp ? await ctx.spawnBrowserMcp(task) : null;
      if (!servers) {
        throw perr("proto.unsupported", "browser MCP not available for this task");
      }
      const scopeFile = mcpScopePath(ctx.dataDir, task.taskId);
      const entry = Object.values(servers)[0] as {
        command: string;
        args: string[];
        env: Record<string, string>;
      };
      return { scopeFile, command: entry.command, args: entry.args, env: entry.env };
    }
    case "browser.mcp.stop": {
      const p = parsePayload(z.object({ taskId: z.string().min(1) }), req.payload) as {
        taskId: string;
      };
      ctx.toolRefresher.untrack(p.taskId);
      return { stopped: true, taskId: p.taskId };
    }
    case "task.sync": {
      const p = parsePayload(taskSyncSchema, req.payload) as z.infer<typeof taskSyncSchema>;
      if (!ctx.store.getTask(p.taskId)) {
        throw perr("task.not_found", `task ${p.taskId} not found`);
      }
      const { events, nextSeq, hasMore } = ctx.store.taskEventsAfter(
        p.taskId,
        p.fromSeq,
        p.maxEvents,
      );
      return { mode: "replay", stream: "task", taskId: p.taskId, events, nextSeq, hasMore };
    }
    case "task.purge": {
      const p = parsePayload(taskPurgeSchema, req.payload) as z.infer<typeof taskPurgeSchema>;
      if (!ctx.store.getTask(p.taskId)) {
        throw perr("task.not_found", `task ${p.taskId} not found`);
      }
      ctx.store.purgeTask(p.taskId);
      ctx.toolRefresher.untrack(p.taskId);
      // chromex-9e3: release the task's runtime tab scope so its tabs
      // can bind to a future task.
      ctx.toolServer.releaseTask(p.taskId);
      // chromex-p21: drop the task's reported dev-server registry too.
      ctx.appServices.clearTask(p.taskId);
      // §4.4/§7.2: durable tombstone on the GATEWAY stream — replayable,
      // own retention; NOT a task-stream event.
      ctx.store.appendGatewayEvent({
        type: "gateway.task_purged",
        taskId: p.taskId,
        purgedAt: Date.now(),
        reason: "user",
      } as never);
      return { purged: true, taskId: p.taskId };
    }
    case "task.snapshot": {
      const p = parsePayload(taskSnapshotSchema, req.payload) as { taskId: string };
      const snap = ctx.store.buildTaskSnapshot(p.taskId);
      if (!snap) throw perr("task.not_found", `task ${p.taskId} not found`);
      if (snap.storage.kind !== "inline") return snap;
      return ctx.snapshotChunks.put(p.taskId, snap as import("@codex-sidepanel/shared").InlineTaskSnapshot);
    }
    case "task.snapshot.chunk": {
      const p = parsePayload(taskSnapshotChunkSchema, req.payload) as z.infer<typeof taskSnapshotChunkSchema>;
      const chunk = ctx.snapshotChunks.get(p.taskId, p.snapshotRef, p.chunkIndex);
      if (!chunk) throw perr("task.not_found", "snapshot chunk not found (expired or wrong ref)");
      return chunk;
    }
    case "gateway.sync": {
      const p = parsePayload(gatewaySyncSchema, req.payload) as z.infer<typeof gatewaySyncSchema>;
      const fromSeq = p.fromSeq ?? 0;
      const { events, nextSeq, hasMore } = ctx.store.gatewayEventsAfter(fromSeq, p.maxEvents);
      if (fromSeq > ctx.store.lastGatewaySeq()) {
        return { mode: "head", lastSeq: ctx.store.lastGatewaySeq() };
      }
      return { mode: "replay", stream: "gateway", events, nextSeq, hasMore };
    }
    case "provider.catalog": {
      const p = parsePayload(providerCatalogSchema, req.payload) as z.infer<typeof providerCatalogSchema>;
      const ids = p.providerId ? [p.providerId as import("@codex-sidepanel/shared").ProviderId] : ctx.registry.list();
      const catalogs = await Promise.all(
        ids.map(async (id) => {
          try {
            return await ctx.registry.catalog(id, { forceRefresh: p.forceRefresh ?? false });
          } catch {
            return null;
          }
        }),
      );
      return { catalogs: catalogs.filter((c) => c !== null) };
    }
    case "config.read": {
      parsePayload(configReadSchema, req.payload);
      // redact provider env secrets — config.read is a UI surface
      const cfg = ctx.getConfig();
      const redact = (pc: GatewayConfig["providers"]["codex"]) => ({
        ...pc,
        env: Object.fromEntries(Object.keys(pc.env).map((k) => [k, "•••"])),
      });
      const acpRedacted = Object.fromEntries(
        Object.entries(cfg.providers.acp).map(([id, pc]) => [id, redact(pc)]),
      );
      return {
        config: {
          ...cfg,
          providers: {
            codex: redact(cfg.providers.codex),
            claude: redact(cfg.providers.claude),
            acp: acpRedacted,
          },
        },
      };
    }
    case "config.update": {
      const p = parsePayload(configUpdateSchema, req.payload) as { patch: Record<string, unknown> };
      const next = await updateGatewayConfig(ctx.dataDir, p.patch);
      ctx.setConfig(next);
      ctx.registry.invalidateCatalog();
      return { config: next };
    }
    case "browser.backend.status": {
      parsePayload(browserBackendSchema, req.payload);
      return { playwrightIsolated: await ctx.playwrightRuntime.readStatus() };
    }
    case "diagnostics.snapshot": {
      parsePayload(configReadSchema, req.payload);
      const server = ctx.getIpc();
      const ep = server.endpointPath();
      return {
        diagnostics: ctx.diagnostics.snapshot({
          store: ctx.store,
          lifetime: { held: true, fence: ctx.lifetimeLock.fence },
          endpoint: {
            path: `${ep.transport}://${ep.path}`,
            authedConnections: server.authedConnections().length,
          },
        }),
      };
    }
    case "browser.backend.install": {
      const p = parsePayload(browserBackendSchema, req.payload) as z.infer<typeof browserBackendSchema>;
      if (p.backend && p.backend !== "playwright-isolated") {
        throw perr("proto.invalid", `browser.backend.install only supports playwright-isolated (got ${p.backend})`);
      }
      return { playwrightIsolated: await ctx.playwrightRuntime.installChromium() };
    }
    default: {
      // COMPAT(legacy-rpc): §10 migration map — rewrite legacy method to
      // its new-contract equivalent, dispatch, adapt result shape.
      const compat = LEGACY_COMPAT[req.method];
      if (compat) {
        const rewrite = compat.toRequest(req.payload);
        const inner = await handleGatewayRequest(
          { ...req, method: rewrite.method, payload: rewrite.payload },
          ctx,
        );
        return compat.fromResult(inner, req.payload);
      }
      // §10/P1: route.plan / browser.action.plan run natively on the
      // codex provider — planning needs app-server access, which only
      // the gateway owns (chromex-pwu). legacySidecarPlanning/toolLoop
      // flags no longer gate these methods.
      if (req.method === "route.plan") {
        const p = parsePayload(routePlanSchema, req.payload) as unknown as AgenticRouteInput;
        return codexPlanningProvider(ctx.registry).planRoute(p);
      }
      if (req.method === "browser.action.plan") {
        const p = parsePayload(browserActionPlanSchema, req.payload) as unknown as {
          message: string;
          snapshot: BrowserDomSnapshot;
          locale?: string;
          generatedText?: string;
        };
        return codexPlanningProvider(ctx.registry).planBrowserAction(p);
      }
      if (LEGACY_SIDECAR_METHODS.has(req.method)) {
        // non-agent domains stay on the legacy bridge sidecar during
        // dual-path migration — the Gateway does not serve them.
        throw perr(
          "proto.unsupported",
          `legacy method ${req.method} is served by the bridge sidecar, not the gateway`,
        );
      }
      // capability-gated provider feature RPCs (§8.2/§10): dotted
      // provider.feature.<provider>.<feature> — each feature validated
      // by its own Zod schema inside the provider; no free-form call.
      const m = /^provider\.feature\.([a-z0-9-]+)\.(.+)$/u.exec(req.method);
      if (m) {
        const target = ctx.sessionManager.providerFor(m[1]!);
        if (!target) throw perr("provider.unavailable", `provider ${m[1]} not registered`);
        const provider = target.provider as { callFeature?: (method: string, payload: unknown) => Promise<unknown> };
        if (!provider.callFeature) {
          throw perr("proto.unsupported", `provider ${m[1]} has no feature RPCs`);
        }
        return provider.callFeature(req.method, req.payload);
      }
      throw protocolError("proto.unknown_method", `unknown method ${req.method}`);
    }
  }
}

export { LockHeldError };
export type { ProtocolError };
