/**
 * ensureGateway tests — real child-process spawn of a fake gateway bin
 * (a standalone .mjs Node script speaking the §3.4/§4.1 wire contract:
 * uint32 LE + JSON envelope, hello-token auth, atomic endpoint publish).
 *
 * The fake bin records the hello payload to <home>/hello.json so tests can
 * assert token injection, and logs spawn markers to <dataDir>/gateway.log
 * via the real ensureGateway spawn path.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { ensureGateway } from "../src/index.js";

const TOKEN = "c".repeat(64);

/** Standalone fake gateway: publishes endpoint+token, serves hello auth. */
const FAKE_GATEWAY_BIN = `
import net from "node:net";
import fs from "node:fs";
import path from "node:path";

const home = process.env.CHROMEX_GATEWAY_HOME;
if (!home) process.exit(2);
fs.mkdirSync(path.join(home, "run"), { recursive: true });
fs.mkdirSync(path.join(home, "auth"), { recursive: true });
const token = "${TOKEN}";
fs.writeFileSync(path.join(home, "auth", "token"), token, { mode: 0o600 });

const sockPath = path.join(home, "run", "gw.sock");
const server = net.createServer((socket) => {
  let buf = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const body = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      const env = JSON.parse(body.toString("utf8"));
      if (env.kind !== "request") continue;
      const respond = (result, error = null) => {
        const res = error
          ? { v: 1, kind: "response", id: env.id, error }
          : { v: 1, kind: "response", id: env.id, result };
        const b = Buffer.from(JSON.stringify(res), "utf8");
        const h = Buffer.allocUnsafe(4);
        h.writeUInt32LE(b.length, 0);
        socket.write(Buffer.concat([h, b]));
      };
      if (env.method === "hello") {
        fs.writeFileSync(path.join(home, "hello.json"), JSON.stringify(env.payload));
        if (env.payload && env.payload.token === token) {
          respond({
            gatewayVersion: "fake", protocolVersion: 1,
            providers: [], backends: [], tasks: [], features: {},
            gatewayLastSeq: 0,
          });
        } else {
          respond(null, { code: "proto.auth_failed", message: "bad token", retryable: false, requiresUserAction: false, sideEffectState: "none" });
          socket.destroy();
        }
        continue;
      }
      respond({ ok: true });
    }
  });
});
server.listen(sockPath, () => {
  const ep = {
    transport: "unix", path: sockPath, gatewayPid: process.pid,
    startedAt: Date.now(), gatewayVersion: "fake", tokenRef: "auth/token",
  };
  // atomic publish like the real gateway
  const tmp = path.join(home, "run", "gateway.json.tmp");
  fs.writeFileSync(tmp, JSON.stringify(ep));
  fs.renameSync(tmp, path.join(home, "run", "gateway.json"));
});

// Self-terminate once the test removes the data dir, so the detached
// child does not outlive the test run.
setInterval(() => {
  try { fs.accessSync(home); } catch { process.exit(0); }
}, 250).unref();
`;

const HELLO = {
  protocolVersion: 1 as const,
  clientId: "ensure-test",
  profileId: "ensure-profile",
  browserInstanceId: null,
  hostInstanceId: "host-ensure",
};

async function writeEndpoint(
  dir: string,
  socketPath: string,
  gatewayPid = process.pid,
): Promise<void> {
  await fs.mkdir(path.join(dir, "run"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "run", "gateway.json"),
    JSON.stringify({
      transport: "unix",
      path: socketPath,
      gatewayPid,
      startedAt: Date.now(),
      gatewayVersion: "stale",
      tokenRef: "auth/token",
    }),
  );
}

async function writeToken(dir: string, token = TOKEN): Promise<void> {
  await fs.mkdir(path.join(dir, "auth"), { recursive: true });
  await fs.writeFile(path.join(dir, "auth", "token"), token, { mode: 0o600 });
}

describe("ensureGateway", () => {
  let dir: string;
  let binPath: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "ensure-gw-"));
    binPath = path.join(dir, "fake-gateway.mjs");
    await fs.writeFile(binPath, FAKE_GATEWAY_BIN);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("endpoint_missing spawns gatewayBin and connects with token hello", async () => {
    // Empty dataDir: no endpoint, no token — the spawned gateway provides both.
    const logs: string[] = [];
    const started = Date.now();
    const conn = await ensureGateway(dir, {
      hello: HELLO,
      gatewayBin: binPath,
      startupTimeoutMs: 15_000,
      log: (m) => logs.push(m),
    });

    expect(conn.hello.gatewayVersion).toBe("fake");
    expect(Date.now() - started).toBeLessThan(15_000);

    // The hello the gateway received carried the auth token from auth/token
    // plus the caller's hello fields.
    const helloPayload = JSON.parse(await fs.readFile(path.join(dir, "hello.json"), "utf8"));
    expect(helloPayload.token).toBe(TOKEN);
    expect(helloPayload.clientId).toBe("ensure-test");
    expect(helloPayload.clientVersion).toBe("native-host");

    // Spawn path logged its intent and wrote a marker to gateway.log.
    expect(logs.some((m) => m.includes("spawning gateway"))).toBe(true);
    const log = await fs.readFile(path.join(dir, "gateway.log"), "utf8");
    expect(log).toContain("--- spawn");

    // Post-connect requests work over the same socket.
    await expect(conn.request("task.list", {})).resolves.toEqual({ ok: true });
    conn.close();
  });

  test("connect_failed retries until the startup deadline, then throws", async () => {
    // Endpoint points at a socket nothing listens on; no bin → pure retry loop.
    await writeEndpoint(dir, path.join(dir, "run", "nobody.sock"));
    await writeToken(dir);

    const started = Date.now();
    await expect(
      ensureGateway(dir, {
        hello: HELLO,
        gatewayBin: null,
        startupTimeoutMs: 1_200,
      }),
    ).rejects.toMatchObject({ code: "connect_failed" });

    const elapsed = Date.now() - started;
    // Retried for the full deadline rather than failing fast.
    expect(elapsed).toBeGreaterThanOrEqual(1_000);
    expect(elapsed).toBeLessThan(5_000);
  });

  test("non-retryable auth_failed fails fast without spawning", async () => {
    // Valid endpoint + live pid, but a malformed token → auth_failed is
    // retryable:false, so ensureGateway must not spawn or retry.
    await writeEndpoint(dir, path.join(dir, "run", "gw.sock"));
    await writeToken(dir, "not-a-hex-token");

    const started = Date.now();
    await expect(
      ensureGateway(dir, {
        hello: HELLO,
        gatewayBin: binPath,
        startupTimeoutMs: 15_000,
      }),
    ).rejects.toMatchObject({ code: "auth_failed", retryable: false });

    expect(Date.now() - started).toBeLessThan(2_000);
    // No spawn → no gateway.log, no hello.json.
    await expect(fs.access(path.join(dir, "gateway.log"))).rejects.toThrow();
    await expect(fs.access(path.join(dir, "hello.json"))).rejects.toThrow();
  });

  test("endpoint_missing with gatewayBin null retries until deadline", async () => {
    const started = Date.now();
    await expect(
      ensureGateway(dir, {
        hello: HELLO,
        gatewayBin: null,
        startupTimeoutMs: 1_000,
      }),
    ).rejects.toMatchObject({ code: "endpoint_missing" });

    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(5_000);
  });
});
