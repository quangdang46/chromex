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
import { CodexAgentProvider } from "../agents/providers/codex/provider.js";
import { ProviderRegistry } from "../agents/registry.js";
import { SessionManager } from "./session-manager.js";
import { ToolTokenManager } from "../browser/tool-token.js";
import { BrowserToolServer } from "../browser/tool-server.js";
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
      publish: (taskId, event, ephemeral) => {
        if (ephemeral) {
          // §4.1/§4.6: deltas are RAM-only — wrapped as
          // EphemeralDeltaEnvelope, broadcast to clients, never stored.
          const e = event as { type?: string; turnId?: string; deltaOffset?: number; text?: string };
          if (
            (e.type === "assistant.delta" || e.type === "reasoning.delta") &&
            typeof e.turnId === "string"
          ) {
            ipc?.broadcast({
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
        capabilities: CLAUDE_CAPABILITIES,
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
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const toolServer = new BrowserToolServer({
      tokens: toolTokens,
      resolveHost: () => {
        // host = authed conn whose hello declared a hostInstanceId
        // (native host injects it; UI-only clients leave it empty)
        const conn = ipc?.authedConnections().find((c) => c.hostInstanceId !== "");
        if (!conn) return null;
        return {
          hostInstanceId: conn.remoteAddress,
          send: (method, payload) => conn.request(method, payload, 15_000),
          onDisconnect: (listener) => conn.onClose(() => listener("disconnect")),
        };
      },
      requestApproval: async (tctx) => {
        const approvalId = `appr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const actionDigest = createHash("sha256")
          .update(JSON.stringify({ tool: tctx.tool, args: tctx.args }))
          .digest("hex");
        const storeAny = store as unknown as {
          insertApproval?: (r: {
            approvalId: string; taskId: string; turnId?: string;
            request: unknown; actionDigest: string;
            status: "pending" | "allowed" | "denied" | "expired"; createdAt: number;
          }) => void;
          appendTaskEvent?: (taskId: string, e: unknown) => unknown;
          approvalStatus?: (id: string) => string | null;
        };
        storeAny.insertApproval?.({
          approvalId,
          taskId: tctx.taskId,
          ...(tctx.turnId ? { turnId: tctx.turnId } : {}),
          request: { tool: tctx.tool, args: tctx.args },
          actionDigest,
          status: "pending",
          createdAt: Date.now(),
        });
        storeAny.appendTaskEvent?.(tctx.taskId, {
          type: "permission.requested",
          ...(tctx.turnId ? { turnId: tctx.turnId } : {}),
          request: {
            requestId: approvalId,
            taskId: tctx.taskId,
            ...(tctx.turnId ? { turnId: tctx.turnId } : {}),
            kind: "browser_action",
            risk: "external_mutation",
            summary: `Browser tool ${tctx.tool} requires approval`,
            actionDigest,
            details: { tool: tctx.tool },
          },
        });
        // poll for resolution up to 60s (UI answers via permission.respond)
        for (let i = 0; i < 240; i++) {
          const st = storeAny.approvalStatus?.(approvalId);
          if (st === "allowed") return "approved";
          if (st === "denied" || st === "expired") return "denied";
          await sleep(250);
        }
        return "timeout";
      },
      onOutcome: (outcome) => {
        const storeAny = store as { appendTaskEvent?: (taskId: string, e: unknown) => unknown };
        // outcome doesn't carry taskId — toolCallId prefix mcp-*; task
        // resolution happens in the RPC handler which wraps execute()
      },
    });
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
          toolServer,
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
    toolServer: BrowserToolServer;
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
      const result = await ctx.sessionManager.respondToPermission(p.requestId, p.optionId);
      // browser-tool approvals live in the approvals table, not provider
      // sessions — resolve the row directly (idempotent no-op if the
      // provider path already handled it).
      const storeAny = ctx.store as { approvalStatus?: (id: string) => string | null; resolveApproval?: (id: string, s: "allowed" | "denied" | "expired") => void };
      if (storeAny.approvalStatus?.(p.requestId) === "pending") {
        storeAny.resolveApproval?.(p.requestId, p.optionId === "deny" ? "denied" : "allowed");
      }
      return result;
    }
    case "browser.tool.call": {
      const p = parsePayload(browserToolCallSchema, req.payload) as z.infer<typeof browserToolCallSchema>;
      const task = ctx.store.getTask(p.taskId);
      if (!task) throw perr("task.not_found", `task ${p.taskId} not found`);
      const outcome = await ctx.toolServer.execute({
        toolCallId: p.toolCallId ?? `rpc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        taskId: p.taskId,
        ...(p.turnId ? { turnId: p.turnId } : {}),
        tool: p.tool,
        args: p.args ?? {},
        token: p.token,
        profileId: task.profileId,
        backendId: task.backend.backendId ?? "chrome-extension",
      });
      return outcome;
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
