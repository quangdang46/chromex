/**
 * chromex-f5ad — graceful shutdown regression test.
 *
 * Spawns the real gateway process (vite-node → src/gateway/bin.ts),
 * sends SIGTERM, and asserts the process exits promptly with code 0,
 * releases gateway.lock, and a fresh gateway can boot on the same
 * dataDir. A second case SIGTERMs mid-turn with a live provider child
 * — the exact live-observed hang (provider process + timers kept the
 * event loop alive after shutdown()).
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { acquireOwnershipLock } from "../src/gateway/lock.js";

const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VITE_NODE = path.resolve(BRIDGE_DIR, "../../node_modules/vite-node/vite-node.mjs");
const FIXTURE = path.join(BRIDGE_DIR, "test", "fixtures", "fake-acp-crash-agent.mjs");
const BOOT_TIMEOUT_MS = 30_000;
/** SIGTERM must produce exit well inside the 5s force deadline + slack */
const TERM_EXIT_TIMEOUT_MS = 15_000;

let dir: string;
let children: ChildProcess[] = [];
let sockets: net.Socket[] = [];
let db: DatabaseSync | null = null;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "chromex-sigterm-"));
});

afterEach(async () => {
  for (const s of sockets.splice(0)) s.destroy();
  for (const c of children.splice(0)) {
    if (c.exitCode === null && !c.killed) c.kill("SIGKILL");
  }
  db?.close();
  db = null;
  await fs.rm(dir, { recursive: true, force: true });
});

// ---------- gateway child process (same harness shape as gateway-kill9) ----------

function writeConfig(opts: { acp?: boolean } = {}): Promise<void> {
  const config = {
    store: "sqlite",
    providers: {
      codex: { enabled: false },
      claude: { enabled: false },
      ...(opts.acp
        ? {
            acp: {
              fakeacp: {
                enabled: true,
                command: process.execPath,
                args: [FIXTURE],
                env: { FAKE_ACP_MODE: "hang-match", FAKE_ACP_LOG: path.join(dir, "prompts.jsonl") },
              },
            },
          }
        : {}),
    },
  };
  return fs.writeFile(path.join(dir, "gateway.json"), JSON.stringify(config));
}

async function startGatewayChild(): Promise<ChildProcess> {
  const child = spawn(
    process.execPath,
    [VITE_NODE, path.join(BRIDGE_DIR, "src", "gateway", "bin.ts")],
    {
      cwd: BRIDGE_DIR,
      env: { ...process.env, CHROMEX_GATEWAY_HOME: dir },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  const tail: string[] = [];
  const onData = (chunk: Buffer) => {
    for (const line of chunk.toString("utf8").split("\n")) {
      if (line.trim()) {
        tail.push(line);
        if (tail.length > 40) tail.shift();
      }
    }
  };
  child.stdout?.on("data", onData);
  child.stderr?.on("data", onData);
  (child as unknown as { __logTail: string[] }).__logTail = tail;
  return child;
}

function logTail(child: ChildProcess | undefined): string {
  return ((child as (ChildProcess & { __logTail?: string[] }) | undefined)?.__logTail ?? []).join("\n");
}

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = BOOT_TIMEOUT_MS, what = "condition"): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timeout waiting for ${what}\n--- gateway log tail ---\n${logTail(children.at(-1))}`);
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function waitForEndpoint(pid?: number): Promise<{ path: string }> {
  const epFile = path.join(dir, "run", "gateway.json");
  const tokenFile = path.join(dir, "auth", "token");
  await waitFor(async () => {
    try {
      await fs.access(epFile);
      await fs.access(tokenFile);
      if (pid !== undefined) {
        const ep = JSON.parse(await fs.readFile(epFile, "utf8")) as { gatewayPid?: number };
        if (ep.gatewayPid !== pid) return false;
      }
      return true;
    } catch {
      return false;
    }
  }, BOOT_TIMEOUT_MS, "gateway endpoint+token files");
  return JSON.parse(await fs.readFile(epFile, "utf8"));
}

async function bootGateway(): Promise<ChildProcess> {
  const child = await startGatewayChild();
  await waitForEndpoint(child.pid);
  return child;
}

/** SIGTERM the child; resolves with the exit code/signal, fails on timeout. */
async function sigterm(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  if (child.exitCode !== null) return { code: child.exitCode, signal: null };
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  child.kill("SIGTERM");
  const result = await Promise.race([
    exited,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`gateway did not exit within ${TERM_EXIT_TIMEOUT_MS}ms of SIGTERM`)), TERM_EXIT_TIMEOUT_MS),
    ),
  ]);
  return result;
}

// ---------- framed IPC client (same wire format as gateway-kill9) ----------

function connect(socketPath: string): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(socketPath, () => resolve(s));
    s.once("error", reject);
  });
}

function rpc(socket: net.Socket, id: string, method: string, payload?: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(
      JSON.stringify({ v: 1, kind: "request", id, method, ...(payload !== undefined ? { payload } : {}) }),
    );
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length, 0);
    let buf = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 4) return;
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) return;
        const env = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
        buf = buf.subarray(4 + len);
        if (env.kind === "response" && env.id === id) {
          socket.off("data", onData);
          if (env.error) reject(env.error);
          else resolve(env.result ?? env);
          return;
        }
      }
    };
    socket.on("data", onData);
    socket.write(Buffer.concat([header, body]));
  });
}

async function authedConn(pid?: number): Promise<net.Socket> {
  const ep = await waitForEndpoint(pid);
  const token = (await fs.readFile(path.join(dir, "auth", "token"), "utf8")).trim();
  const deadline = Date.now() + BOOT_TIMEOUT_MS;
  let lastErr: unknown = null;
  for (;;) {
    try {
      const s = await connect(ep.path);
      sockets.push(s);
      await rpc(s, `hello-${sockets.length}`, "hello", {
        token,
        clientVersion: "sigterm-test",
        protocolVersion: 1,
        clientId: `sigterm-${sockets.length}`,
        profileId: "fakeacp",
        browserInstanceId: null,
        hostInstanceId: "",
      });
      return s;
    } catch (err) {
      lastErr = err;
      if (Date.now() > deadline) throw lastErr;
      await new Promise((r) => setTimeout(r, 150));
    }
  }
}

// ---------- sqlite assertions ----------

function openDb(): DatabaseSync {
  db?.close();
  db = new DatabaseSync(path.join(dir, "gateway.db"));
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function turnRow(turnId: string): { status: string; stop_reason: string | null } | undefined {
  return openDb()
    .prepare("SELECT status, stop_reason FROM turns WHERE turn_id = ?")
    .get(turnId) as { status: string; stop_reason: string | null } | undefined;
}

// ---------- tests ----------

describe("gateway SIGTERM graceful shutdown (chromex-f5ad)", () => {
  test("idle gateway exits 0 on SIGTERM, releases gateway.lock, respawns cleanly", async () => {
    await writeConfig();
    const gw1 = await bootGateway();

    const res = await sigterm(gw1);
    expect(res.code).toBe(0);
    expect(res.signal).toBeNull();

    // lifetime lock released — a fresh owner can acquire it
    const probe = await acquireOwnershipLock(dir, "lifetime");
    await probe.release();

    // next spawn on the same dataDir succeeds (endpoint published for new pid)
    const gw2 = await bootGateway();
    expect(gw2.pid).not.toBe(gw1.pid);
    await sigterm(gw2);
  }, 90_000);

  test("SIGTERM mid-turn with live provider child still exits; restart recovers turn=unknown", async () => {
    await writeConfig({ acp: true });
    const gw1 = await bootGateway();
    const s1 = await authedConn(gw1.pid);
    const created = (await rpc(s1, "c1", "task.create", {
      cwd: "/tmp",
      title: "sigterm-midturn",
      profileId: "fakeacp",
      providerId: "fakeacp",
    })) as { taskId: string };
    const taskId = created.taskId;

    const t1 = (await rpc(s1, "s1", "task.send", {
      taskId,
      clientMessageId: "cm-1",
      content: [{ type: "text", text: "please hang here" }], // hang-match → never completes
    })) as { turnId: string; queued: boolean };
    expect(t1.queued).toBe(false);

    // provider child is live and the turn is running — the case that
    // kept the old process alive after shutdown()
    await waitFor(() => turnRow(t1.turnId)?.status === "running", 15_000, "turn running");
    const logFile = path.join(dir, "prompts.jsonl");
    await waitFor(async () => {
      try {
        return (await fs.readFile(logFile, "utf8")).trim().length > 0;
      } catch {
        return false;
      }
    }, 15_000, "prompt at provider");

    s1.destroy();
    const res = await sigterm(gw1);
    expect(res.code).toBe(0);

    // locks released + respawn works
    const probe = await acquireOwnershipLock(dir, "lifetime");
    await probe.release();
    const gw2 = await bootGateway();
    const s2 = await authedConn(gw2.pid);

    // §5.6 recovery: the in-flight turn is honestly unknown, task paused
    await waitFor(() => turnRow(t1.turnId)?.status === "unknown", 10_000, "turn recovered to unknown");
    const r1 = turnRow(t1.turnId)!;
    expect(r1.stop_reason).toBe("gateway_restart");
    s2.destroy();
    await sigterm(gw2);
  }, 120_000);
});
