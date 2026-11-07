/**
 * §7.3 cases #2/#3 tails — REAL kill -9 integration tests.
 *
 * Unlike store-sqlite.test.ts (which fabricates post-crash rows), these
 * tests spawn an actual gateway process (vite-node → src/gateway/bin.ts),
 * drive it over the real framed IPC socket, SIGKILL it mid-operation,
 * restart it on the same dataDir, and assert §5.6 recovery:
 *
 *  A. running turn + queued turn at kill → restart: turn→unknown,
 *     queued turn stays queued, task→paused(gateway_restart), and the
 *     provider sees NO replayed prompt until the user resumes — resume
 *     dispatches the queued turn exactly once.
 *  B. pending approval at kill → restart: approval row stays pending
 *     and permission.respond still resolves it (durable row path; the
 *     provider session died with the gateway).
 *
 * Provider = test/fixtures/fake-acp-crash-agent.mjs (ACP over stdio),
 * configured via providers.acp in gateway.json — no real agent CLIs.
 */

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

const BRIDGE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const VITE_NODE = path.resolve(BRIDGE_DIR, "../../node_modules/vite-node/vite-node.mjs");
const FIXTURE = path.join(BRIDGE_DIR, "test", "fixtures", "fake-acp-crash-agent.mjs");
const BOOT_TIMEOUT_MS = 30_000;

let dir: string;
let children: ChildProcess[] = [];
let sockets: net.Socket[] = [];
let db: DatabaseSync | null = null;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "chromex-kill9-"));
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

// ---------- gateway child process ----------

function writeConfig(mode: string, logFile: string): Promise<void> {
  const config = {
    store: "sqlite",
    providers: {
      codex: { enabled: false },
      claude: { enabled: false },
      acp: {
        fakeacp: {
          enabled: true,
          command: process.execPath,
          args: [FIXTURE],
          env: { FAKE_ACP_MODE: mode, FAKE_ACP_LOG: logFile },
        },
      },
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
  // keep boot diagnostics for failure messages
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

async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = BOOT_TIMEOUT_MS, what = "condition"): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await pred()) return;
    if (Date.now() - start > timeoutMs) {
      const child = children.at(-1) as (ChildProcess & { __logTail?: string[] }) | undefined;
      throw new Error(
        `timeout waiting for ${what}\n--- gateway log tail ---\n${(child?.__logTail ?? []).join("\n")}`,
      );
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
      // after a restart the OLD endpoint/token files still exist — only
      // trust the publish once it names THIS process (token is written
      // before publishEndpoint, so a matching pid means fresh creds).
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

async function kill9(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

// ---------- framed IPC client (same wire format as gateway-rpc.test.ts) ----------

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
        // match by id — broadcasts (gateway.diagnostics etc.) interleave
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

/** Connect + hello; retries while the gateway is still `starting`
 *  (endpoint file is published before markReady). */
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
        clientVersion: "kill9-test",
        protocolVersion: 1,
        clientId: `kill9-${sockets.length}`,
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

// ---------- sqlite assertions (read the same durable store the gateway writes) ----------

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

function taskRow(taskId: string): { status: string; pause_reason: string | null } | undefined {
  return openDb()
    .prepare("SELECT status, pause_reason FROM tasks WHERE task_id = ?")
    .get(taskId) as { status: string; pause_reason: string | null } | undefined;
}

function approvalRows(taskId: string): Array<{ approval_id: string; status: string; decision_json: string | null }> {
  return openDb()
    .prepare("SELECT approval_id, status, decision_json FROM approvals WHERE task_id = ? ORDER BY created_at")
    .all(taskId) as Array<{ approval_id: string; status: string; decision_json: string | null }>;
}

function taskEventTypes(taskId: string): string[] {
  return (
    openDb()
      .prepare("SELECT type FROM events WHERE stream='task' AND task_id = ? ORDER BY seq")
      .all(taskId) as Array<{ type: string }>
  ).map((r) => r.type);
}

async function promptLog(logFile: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(logFile, "utf8");
    return raw
      .split("\n")
      .filter(Boolean)
      .map((l) => (JSON.parse(l) as { text: string }).text);
  } catch {
    return [];
  }
}

// ---------- tests ----------

describe("gateway kill -9 recovery (§7.3 #2/#3 tails)", () => {
  test(
    "A: SIGKILL mid-turn → restart recovers turn=unknown, queued stays queued, task paused(gateway_restart), no replay",
    async () => {
      const logFile = path.join(dir, "prompts.jsonl");
      await writeConfig("hang-match", logFile);

      // ---- boot 1: running turn + queued turn, then SIGKILL ----
      const gw1 = await bootGateway();
      const s1 = await authedConn(gw1.pid);
      const created = (await rpc(s1, "c1", "task.create", {
        cwd: "/tmp",
        title: "kill9-A",
        profileId: "fakeacp",
        providerId: "fakeacp",
      })) as { taskId: string };
      const taskId = created.taskId;

      const t1 = (await rpc(s1, "s1", "task.send", {
        taskId,
        clientMessageId: "cm-1",
        content: [{ type: "text", text: "please hang here" }], // matches FAKE_ACP_HANG_MATCH → never completes
      })) as { turnId: string; queued: boolean };
      expect(t1.queued).toBe(false);

      const t2 = (await rpc(s1, "s2", "task.send", {
        taskId,
        clientMessageId: "cm-2",
        content: [{ type: "text", text: "finish the report" }],
      })) as { turnId: string; queued: boolean };
      expect(t2.queued).toBe(true);

      // wait until the provider actually received the first prompt —
      // guarantees we kill mid-turn, not before dispatch
      await waitFor(async () => (await promptLog(logFile)).length === 1, 15_000, "first prompt at provider");
      await waitFor(() => turnRow(t1.turnId)?.status === "running", 10_000, "turn1 running");
      expect(turnRow(t2.turnId)?.status).toBe("queued");

      await kill9(gw1);
      s1.destroy();

      // ---- boot 2: §5.6 recovery on the same dataDir ----
      const gw2 = await bootGateway();
      const s2 = await authedConn(gw2.pid);

      // turn running at kill → unknown(gateway_restart); queued turn
      // untouched; task → paused(gateway_restart)
      await waitFor(() => turnRow(t1.turnId)?.status === "unknown", 10_000, "turn1 recovered to unknown");
      const r1 = turnRow(t1.turnId)!;
      expect(r1.status).toBe("unknown");
      expect(r1.stop_reason).toBe("gateway_restart");

      const r2 = turnRow(t2.turnId)!;
      expect(r2.status).toBe("queued"); // survives queued — never auto-runs

      const task = taskRow(taskId)!;
      expect(task.status).toBe("paused");
      expect(task.pause_reason).toBe("gateway_restart");

      const types = taskEventTypes(taskId);
      expect(types).toContain("turn.unknown");
      expect(types).toContain("task.status_changed");

      // RPC surface agrees
      const got = (await rpc(s2, "g1", "task.get", { taskId })) as {
        task: { status: string; pauseReason: string | null };
      };
      expect(got.task.status).toBe("paused");
      expect(got.task.pauseReason).toBe("gateway_restart");

      // recovery itself must NOT replay: settle, then the provider log
      // still shows exactly the one prompt sent before the kill
      await new Promise((r) => setTimeout(r, 1_000));
      expect(await promptLog(logFile)).toEqual(["please hang here"]);

      // ---- user resume: queued turn dispatches exactly once ----
      await rpc(s2, "rs", "task.resume", { taskId });
      await waitFor(() => turnRow(t2.turnId)?.status === "completed", 20_000, "queued turn completes after resume");

      // the interrupted turn's message is NOT resent (queued turn took
      // the resume slot); the queued prompt reached the provider once
      expect(await promptLog(logFile)).toEqual(["please hang here", "finish the report"]);
      expect(turnRow(t1.turnId)?.status).toBe("unknown"); // stays honest-unknown
      s2.destroy();
      void gw2;
    },
    120_000,
  );

  test(
    "B: SIGKILL with pending approval → restart keeps approval pending + permission.respond resolves it",
    async () => {
      const logFile = path.join(dir, "prompts.jsonl");
      await writeConfig("permission", logFile);

      const gw1 = await bootGateway();
      const s1 = await authedConn(gw1.pid);
      const created = (await rpc(s1, "c1", "task.create", {
        cwd: "/tmp",
        title: "kill9-B",
        profileId: "fakeacp",
        providerId: "fakeacp",
      })) as { taskId: string };
      const taskId = created.taskId;

      const t1 = (await rpc(s1, "s1", "task.send", {
        taskId,
        clientMessageId: "cm-1",
        content: [{ type: "text", text: "delete the file" }],
      })) as { turnId: string };

      // wait for the durable pending approval row (§5.7 mirror)
      await waitFor(() => approvalRows(taskId).some((a) => a.status === "pending"), 20_000, "pending approval row");
      const pending = approvalRows(taskId).find((a) => a.status === "pending")!;
      const requestId = pending.approval_id;
      expect(turnRow(t1.turnId)?.status).toBe("running");

      await kill9(gw1);
      s1.destroy();

      // ---- boot 2 ----
      const gw2 = await bootGateway();
      const s2 = await authedConn(gw2.pid);

      // recovery: turn → unknown, task → paused; approval UNTOUCHED (§5.6)
      await waitFor(() => turnRow(t1.turnId)?.status === "unknown", 10_000, "turn recovered to unknown");
      const approvals = approvalRows(taskId);
      expect(approvals).toHaveLength(1);
      expect(approvals[0]!.approval_id).toBe(requestId);
      expect(approvals[0]!.status).toBe("pending");
      expect(taskRow(taskId)?.pause_reason).toBe("gateway_restart");

      // no replay while paused
      await new Promise((r) => setTimeout(r, 1_000));
      expect(await promptLog(logFile)).toEqual(["delete the file"]);

      // the pending approval is still respondable: permission.respond
      // resolves the durable row even though the provider session is gone
      await rpc(s2, "pr", "permission.respond", { requestId, optionId: "allow_once" });

      await waitFor(() => approvalRows(taskId)[0]?.status === "allowed", 10_000, "approval resolved");
      const decided = approvalRows(taskId)[0]!;
      expect(decided.status).toBe("allowed");
      expect(decided.decision_json).toContain("allow_once");

      // durable permission.resolved lands on the task stream for replayed clients
      await waitFor(() => taskEventTypes(taskId).includes("permission.resolved"), 10_000, "permission.resolved event");

      // exactly one provider prompt ever — respond did not re-drive the turn
      expect(await promptLog(logFile)).toEqual(["delete the file"]);
      s2.destroy();
      void gw2;
    },
    120_000,
  );
});
