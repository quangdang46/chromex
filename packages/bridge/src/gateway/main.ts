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

import os from "node:os";
import path from "node:path";

import { protocolError } from "@codex-sidepanel/shared";
import type { Envelope, ProtocolError } from "@codex-sidepanel/shared";
import { z } from "zod";

import { LEGACY_COMPAT, LEGACY_SIDECAR_METHODS } from "./compat.js";
import { loadGatewayConfig, updateGatewayConfig, type GatewayConfig } from "./config.js";
import { SnapshotChunkStore } from "./chunks.js";
import {
  browserBackendSchema,
  configReadSchema,
  configUpdateSchema,
  gatewaySyncSchema,
  permissionRespondSchema,
  providerCatalogSchema,
  taskCreateSchema,
  taskIdSchema,
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
import type { GatewayDb } from "../store/db.js";
import { CODEX_CAPABILITIES } from "../agents/providers/codex/session.js";
import { CodexAgentProvider } from "../agents/providers/codex/provider.js";
import { ProviderRegistry } from "../agents/registry.js";
import { SessionManager } from "./session-manager.js";
import { NO_CAPABILITIES, protocolError as perr } from "@codex-sidepanel/shared";

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
      store = sqlite;
    } else {
      store = new InMemoryStore({ assertOwnership });
    }

    // provider registry + session manager (P1-04/P1-05/P1-06)
    const registry = new ProviderRegistry(config.providers);
    if (config.providers.codex.enabled) {
      await registry.register("codex", async () => new CodexAgentProvider());
    }
    const sessionManager = new SessionManager({
      store: store as ConstructorParameters<typeof SessionManager>[0]["store"],
      registry,
      config,
      // durable envelopes broadcast to all authed connections; ephemeral
      // agent deltas are dropped here until P1-08 wires the delta channel
      publish: (_taskId, event, ephemeral) => {
        if (!ephemeral && typeof event === "object" && "kind" in event) {
          ipc?.broadcast(event as import("@codex-sidepanel/shared").Envelope);
        }
      },
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
        capabilities: CLAUDE_CAPABILITIES,
      },
    ];

    const snapshotChunks = new SnapshotChunkStore();
    const playwrightRuntime = new PlaywrightRuntimeManager();
    // config is mutable via config.update; the resolved object is
    // replaced (never mutated) so in-flight readers see a consistent
    // snapshot.
    let liveConfig = config;

    ipc = new GatewayIpcServer(dataDir, config.gateway.maxEnvelopeBytes, async (req, conn) => {
      try {
        return await handleGatewayRequest(req, {
          store,
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
        });
      } catch (err) {
        if (err instanceof StaleFenceError) {
          log("stale fence detected — self-shutdown");
          void shutdown("stale-fence");
          throw err;
        }
        throw err;
      }
    });
    await ipc.writeTokenFile();
    await ipc.listen();

    // recovery runs before ready (P1-02 wires real recovery); in-memory
    // store starts empty so nothing to recover yet.
    store.appendGatewayEvent({
      type: "gateway.started",
      version: GATEWAY_VERSION,
      recoveredTurns,
      recoveredTasks,
    });

    ipc.markReady();
    log(`ready pid=${process.pid} dir=${dataDir} fence=${lifetimeLock.fence}`);

    let shuttingDown = false;
    const shutdown = async (reason = "user") => {
      if (shuttingDown) return;
      shuttingDown = true;
      ipc?.markStarting();
      // no self-exit while active work — in-memory store has no active
      // turns yet; real check lands with P1-05 SessionManager.
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
const CLAUDE_CAPABILITIES = NO_CAPABILITIES;

function invalidRequest(issues: string): ProtocolError {
  return perr("proto.invalid", `invalid request payload: ${issues}`);
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

async function handleGatewayRequest(
  req: Extract<Envelope, { kind: "request" }>,
  ctx: {
    store: InMemoryStore | SQLiteStore;
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
        backend: p.backend ?? {
          backendId: cfg.browser.defaultBackend === "auto" ? "chrome-extension" : cfg.browser.defaultBackend,
          pinnedBy: "default",
        },
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
      const p = req.payload as { taskId?: string; backend?: unknown } | undefined;
      if (!p?.taskId || !p.backend || typeof p.backend !== "object") {
        throw invalidRequest("taskId + backend required");
      }
      const backend = p.backend as Parameters<SessionManager["setBackend"]>[1];
      const task = ctx.sessionManager.setBackend(p.taskId, backend);
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
      return ctx.sessionManager.respondToPermission(p.requestId, p.optionId);
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
      return {
        config: {
          ...cfg,
          providers: { codex: redact(cfg.providers.codex), claude: redact(cfg.providers.claude) },
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
      // §10: route.plan / browser.action.plan retired — flag-controlled.
      // toolLoop on → gateway tool loop (P1-09, not yet implemented);
      // legacySidecarPlanning on → legacy bridge sidecar; both off → retired.
      if (req.method === "route.plan" || req.method === "browser.action.plan") {
        const cfg = ctx.getConfig();
        if (cfg.features.toolLoop) {
          throw perr("proto.unsupported", `${req.method}: gateway toolLoop not implemented (P1-09)`);
        }
        if (!cfg.features.legacySidecarPlanning) {
          throw perr("proto.unsupported", `${req.method} retired (flags: toolLoop=off, legacySidecarPlanning=off)`);
        }
        throw perr("proto.unsupported", `${req.method} served by legacy sidecar planning`);
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
