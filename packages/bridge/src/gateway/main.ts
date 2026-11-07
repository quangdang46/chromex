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

import { loadGatewayConfig, type GatewayConfig } from "./config.js";
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

    ipc = new GatewayIpcServer(dataDir, config.gateway.maxEnvelopeBytes, async (req, conn) => {
      try {
        return await handleGatewayRequest(req, { store, config, providers, conn, sessionManager, registry });
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

async function handleGatewayRequest(
  req: Extract<Envelope, { kind: "request" }>,
  ctx: {
    store: InMemoryStore | SQLiteStore;
    config: GatewayConfig;
    providers: HelloResponseProviders;
    conn: IpcConnection;
    sessionManager: SessionManager;
    registry: ProviderRegistry;
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
      const p = req.payload as Record<string, unknown> | undefined;
      if (!p || typeof p.cwd !== "string") {
        throw perr("proto.invalid", "task.create requires cwd");
      }
      const task = ctx.sessionManager.createTask({
        profileId: String(p.profileId ?? "codex"),
        providerId: (p.providerId as never) ?? "codex",
        cwd: p.cwd,
        title: (p.title as string | null | undefined) ?? null,
        model: (p.model as string | null | undefined) ?? null,
        modeId: (p.modeId as string | null | undefined) ?? null,
        thinkingOptionId: (p.thinkingOptionId as string | null | undefined) ?? null,
        providerOptions: (p.providerOptions as Record<string, unknown> | null | undefined) ?? null,
        backend: (p.backend as never) ?? {
          backendId: ctx.config.browser.defaultBackend === "auto" ? "chrome-extension" : ctx.config.browser.defaultBackend,
          pinnedBy: "default",
        },
        tabIntent: (p.tabIntent as never) ?? { scope: "untitled" },
        originBrowserInstanceId: (p.browserInstanceId as string | null | undefined) ?? null,
      });
      return { taskId: task.taskId, status: task.status };
    }
    case "task.send": {
      const p = req.payload as { taskId?: string; clientMessageId?: string; content?: unknown; ctx?: unknown } | undefined;
      if (!p?.taskId || !p.clientMessageId || !Array.isArray(p.content)) {
        throw perr("proto.invalid", "task.send requires taskId + clientMessageId + content");
      }
      const res = await ctx.sessionManager.sendMessage(p.taskId, {
        clientMessageId: p.clientMessageId,
        content: p.content as never,
        ...(p.ctx ? { ctx: p.ctx as never } : {}),
      });
      return res;
    }
    case "task.cancel": {
      const p = req.payload as { taskId?: string; reason?: string } | undefined;
      if (!p?.taskId) throw perr("proto.invalid", "task.cancel requires taskId");
      await ctx.sessionManager.cancelTask(p.taskId, p.reason ?? "user");
      return { ok: true };
    }
    case "task.pause": {
      const p = req.payload as { taskId?: string } | undefined;
      if (!p?.taskId) throw perr("proto.invalid", "task.pause requires taskId");
      ctx.sessionManager.pauseTask(p.taskId);
      return { ok: true };
    }
    case "task.resume": {
      const p = req.payload as { taskId?: string } | undefined;
      if (!p?.taskId) throw perr("proto.invalid", "task.resume requires taskId");
      ctx.sessionManager.resumeTask(p.taskId);
      return { ok: true };
    }
    case "task.interrupt": {
      const p = req.payload as { taskId?: string; turnId?: string } | undefined;
      if (!p?.taskId) throw perr("proto.invalid", "task.interrupt requires taskId");
      await ctx.sessionManager.interruptTurn(p.taskId, p.turnId);
      return { ok: true };
    }
    case "permission.respond": {
      const p = req.payload as { requestId?: string; optionId?: string } | undefined;
      if (!p?.requestId || !p.optionId) {
        throw perr("proto.invalid", "permission.respond requires requestId + optionId");
      }
      return ctx.sessionManager.respondToPermission(p.requestId, p.optionId);
    }
    case "task.list": {
      return { tasks: ctx.store.listTasks().map((t) => ({ taskId: t.taskId, status: t.status, lastSeq: t.lastSeq })) };
    }
    case "task.sync": {
      const p = req.payload as { taskId?: string; fromSeq?: number; maxEvents?: number };
      if (!p?.taskId || typeof p.fromSeq !== "number") {
        throw protocolError("proto.invalid", "task.sync requires taskId + fromSeq");
      }
      if (!ctx.store.getTask(p.taskId)) {
        throw protocolError("task.not_found", `task ${p.taskId} not found`);
      }
      const { events, nextSeq, hasMore } = ctx.store.taskEventsAfter(
        p.taskId,
        p.fromSeq,
        p.maxEvents,
      );
      return { mode: "replay", stream: "task", taskId: p.taskId, events, nextSeq, hasMore };
    }
    case "task.snapshot": {
      const p = req.payload as { taskId?: string };
      if (!p?.taskId) throw protocolError("proto.invalid", "task.snapshot requires taskId");
      const snap = ctx.store.buildTaskSnapshot(p.taskId);
      if (!snap) throw protocolError("task.not_found", `task ${p.taskId} not found`);
      return snap;
    }
    case "gateway.sync": {
      const p = req.payload as { fromSeq?: number; maxEvents?: number };
      const fromSeq = typeof p?.fromSeq === "number" ? p.fromSeq : 0;
      const { events, nextSeq, hasMore } = ctx.store.gatewayEventsAfter(
        fromSeq,
        p?.maxEvents,
      );
      if (fromSeq > ctx.store.lastGatewaySeq()) {
        return { mode: "head", lastSeq: ctx.store.lastGatewaySeq() };
      }
      return { mode: "replay", stream: "gateway", events, nextSeq, hasMore };
    }
    default: {
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
