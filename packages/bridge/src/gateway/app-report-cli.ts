/**
 * app-report CLI — chromex-p21.
 *
 * Agent-facing helper so a task's agent can register dev servers it
 * started without hand-rolling the gateway IPC framing. Spawned as:
 *
 *   node dist/gateway/app-report-cli.js report --task <id> --name web \
 *     --url http://localhost:5173 [--port 5173] [--pid 1234] [--cwd /repo]
 *   node dist/gateway/app-report-cli.js list --task <id>
 *
 * Gateway home resolution mirrors the gateway: $CHROMEX_GATEWAY_HOME,
 * else ~/.chromex/gateway. Endpoint socket path comes from
 * <dataDir>/run/gateway.json; token from <dataDir>/auth/token.
 * Framing: uint32-LE length prefix + UTF-8 JSON envelope; the first
 * request on a connection must be `hello` carrying the token.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const FRAME_HEADER = 4;

function dataDir(): string {
  const env = process.env.CHROMEX_GATEWAY_HOME;
  return env ? path.resolve(env) : path.join(os.homedir(), ".chromex", "gateway");
}

function usage(): never {
  process.stderr.write(
    [
      "usage:",
      "  app-report-cli report --task <id> --name <n> --url <u> [--port N] [--pid N] [--cwd DIR] [--status S]",
      "  app-report-cli list   --task <id>",
      "",
    ].join("\n"),
  );
  process.exit(2);
}

function parseArgs(argv: string[]): { command: string; flags: Record<string, string> } {
  const [command, ...rest] = argv;
  if (command !== "report" && command !== "list") usage();
  const flags: Record<string, string> = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (!arg.startsWith("--")) usage();
    const key = arg.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--")) usage();
    flags[key] = value;
    i++;
  }
  return { command, flags };
}

class GatewayIpc {
  #socket: net.Socket | null = null;
  #buf = Buffer.alloc(0);
  #pending = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  // hello is per-connection: track WHICH socket was helloed so a
  // reconnect re-hellos, and never cache a rejected hello forever.
  #helloedSocket: net.Socket | null = null;
  #helloInflight = new Map<net.Socket, Promise<void>>();
  readonly #tokenFile: string;

  constructor(
    private readonly endpoint: string,
    tokenFile: string,
  ) {
    this.#tokenFile = tokenFile;
  }

  #readToken(): string {
    try {
      return fs.readFileSync(this.#tokenFile, "utf8").trim();
    } catch {
      return "";
    }
  }

  #connect(): Promise<net.Socket> {
    if (this.#socket && !this.#socket.destroyed) return Promise.resolve(this.#socket);
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(this.endpoint);
      sock.once("error", reject);
      sock.once("connect", () => {
        sock.off("error", reject);
        sock.on("error", () => this.#failAll(new Error("ipc socket error")));
        sock.on("data", (d) => this.#onData(d));
        sock.on("close", () => this.#failAll(new Error("ipc socket closed")));
        this.#socket = sock;
        resolve(sock);
      });
    });
  }

  #failAll(err: Error): void {
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
    this.#socket = null;
    this.#helloedSocket = null;
  }

  #onData(d: Buffer): void {
    this.#buf = Buffer.concat([this.#buf, d]);
    for (;;) {
      if (this.#buf.length < FRAME_HEADER) return;
      const len = this.#buf.readUInt32LE(0);
      if (this.#buf.length < FRAME_HEADER + len) return;
      const body = this.#buf.subarray(FRAME_HEADER, FRAME_HEADER + len);
      this.#buf = this.#buf.subarray(FRAME_HEADER + len);
      let env: {
        kind?: string;
        id?: string;
        result?: unknown;
        error?: { code?: string; message?: string };
      };
      try {
        env = JSON.parse(body.toString("utf8"));
      } catch {
        continue;
      }
      if (env.kind === "response" && typeof env.id === "string") {
        const p = this.#pending.get(env.id);
        if (!p) continue;
        this.#pending.delete(env.id);
        if (env.error) {
          p.reject(new Error(`${env.error.code ?? "error"}: ${env.error.message ?? ""}`));
        } else {
          p.resolve(env.result);
        }
      }
    }
  }

  #send(sock: net.Socket, env: unknown): void {
    const body = Buffer.from(JSON.stringify(env), "utf8");
    const frame = Buffer.alloc(FRAME_HEADER + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, FRAME_HEADER);
    sock.write(frame);
  }

  #helloOnce(sock: net.Socket): Promise<void> {
    let p = this.#helloInflight.get(sock);
    if (!p) {
      p = (async () => {
        const id = `hello-${randomUUID()}`;
        await new Promise<void>((resolve, reject) => {
          this.#pending.set(id, { resolve: () => resolve(), reject });
          this.#send(sock, {
            v: 1,
            kind: "request",
            id,
            method: "hello",
            payload: {
              protocolVersion: 1,
              clientVersion: "chromex-app-report/0.1.0",
              clientId: `app-report-${process.pid}`,
              profileId: "",
              browserInstanceId: null,
              hostInstanceId: "",
              token: this.#readToken(),
            },
          });
        });
        this.#helloedSocket = sock;
      })().finally(() => {
        this.#helloInflight.delete(sock);
      });
      this.#helloInflight.set(sock, p);
    }
    return p;
  }

  async #ensureHello(): Promise<void> {
    for (;;) {
      const sock = await this.#connect();
      if (this.#helloedSocket === sock) return;
      try {
        await this.#helloOnce(sock);
        return;
      } catch (err) {
        if (this.#socket === sock && !sock.destroyed) throw err;
      }
    }
  }

  async request(method: string, payload: unknown): Promise<unknown> {
    await this.#ensureHello();
    const sock = await this.#connect();
    const id = `req-${randomUUID()}`;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#send(sock, { v: 1, kind: "request", id, method, payload });
    });
  }

  dispose(): void {
    this.#socket?.destroy();
    this.#socket = null;
  }
}

function intFlag(flags: Record<string, string>, key: string): number | undefined {
  const raw = flags[key];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n)) usage();
  return n;
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv.slice(2));
  const taskId = flags.task;
  if (!taskId) usage();

  const home = dataDir();
  const endpointFile = JSON.parse(
    fs.readFileSync(path.join(home, "run", "gateway.json"), "utf8"),
  ) as { path?: string };
  if (!endpointFile.path || typeof endpointFile.path !== "string") {
    throw new Error("gateway endpoint missing .path in run/gateway.json");
  }
  const ipc = new GatewayIpc(endpointFile.path, path.join(home, "auth", "token"));

  if (command === "list") {
    const result = await ipc.request("app.list", { taskId });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    ipc.dispose();
    return;
  }

  const name = flags.name;
  const url = flags.url;
  if (!name || (!url && flags.port === undefined)) usage();
  const payload: Record<string, unknown> = { taskId, name };
  if (url) payload.url = url;
  const port = intFlag(flags, "port");
  if (port !== undefined) payload.port = port;
  const pid = intFlag(flags, "pid");
  if (pid !== undefined) payload.pid = pid;
  if (flags.cwd) payload.cwd = flags.cwd;
  if (flags.status) payload.status = flags.status;

  const result = await ipc.request("app.report", payload);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  ipc.dispose();
}

const invokedAsScript =
  process.argv[1] !== undefined &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (invokedAsScript) {
  main().catch((err) => {
    process.stderr.write(`app-report: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
