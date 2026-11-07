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
    let store: InMemoryStore | SQLiteStore;
    let db: GatewayDb | null = null;
    let recoveredTurns = 0;
    let recoveredTasks = 0;
    if (config.store === "sqlite") {
      db = await openGatewayDb(dataDir);
      const sqlite = new SQLiteStore(db);
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
      store = new InMemoryStore();
    }

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
      return handleGatewayRequest(req, { store, config, providers, conn });
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

const CODEX_CAPABILITIES = {
  streaming: true,
  reasoningSummary: true,
  toolEvents: true,
  interrupt: true,
  steer: true,
  resume: true,
  modelSelection: true,
  modeSelection: true,
  thinkingOption: true,
  permissionPrompts: true,
  mcpTools: true,
  imageInput: true,
  slashCommands: true,
  usage: true,
  streamHistory: true,
} as const;

const CLAUDE_CAPABILITIES = {
  streaming: false,
  reasoningSummary: false,
  toolEvents: false,
  interrupt: false,
  steer: false,
  resume: false,
  modelSelection: false,
  modeSelection: false,
  thinkingOption: false,
  permissionPrompts: false,
  mcpTools: false,
  imageInput: false,
  slashCommands: false,
  usage: false,
  streamHistory: false,
} as const;

async function handleGatewayRequest(
  req: Extract<Envelope, { kind: "request" }>,
  ctx: {
    store: InMemoryStore | SQLiteStore;
    config: GatewayConfig;
    providers: HelloResponseProviders;
    conn: IpcConnection;
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
    default:
      throw protocolError("proto.unknown_method", `unknown method ${req.method}`);
  }
}

export { LockHeldError };
export type { ProtocolError };
