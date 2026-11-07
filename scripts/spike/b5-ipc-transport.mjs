#!/usr/bin/env node
/**
 * Spike B5 — IPC transport verification (chromex-vy2).
 *
 * Runs the mandatory spike tests that are executable on this platform
 * (macOS, single user). Multi-user isolation (test 1) and Windows named
 * pipe ACL (test 5) are documented as platform-limited in the ADR.
 *
 * Uses the REAL built gateway (packages/bridge/dist) so evidence covers
 * production code paths, not mocks.
 *
 * Run: node scripts/spike/b5-ipc-transport.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const dir = await fs.mkdtemp(path.join(os.tmpdir(), "b5-gw-"));
const gateway = spawn(process.execPath, [path.join(ROOT, "packages/bridge/dist/gateway/bin.js")], {
  env: { ...process.env, CHROMEX_GATEWAY_HOME: dir },
  stdio: ["ignore", "pipe", "pipe"],
});
let gwLog = "";
gateway.stdout.on("data", (d) => (gwLog += d));
gateway.stderr.on("data", (d) => (gwLog += d));

const endpointPath = path.join(dir, "run", "gateway.json");
async function waitEndpoint(timeoutMs = 10_000) {
  const start = Date.now();
  for (;;) {
    try {
      const ep = JSON.parse(await fs.readFile(endpointPath, "utf8"));
      if (ep.path) return ep;
    } catch {}
    if (Date.now() - start > timeoutMs) throw new Error("endpoint timeout\n" + gwLog);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function rpc(sockPath, id, method, payload) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(sockPath, () => {
      const body = Buffer.from(JSON.stringify({ v: 1, kind: "request", id, method, payload }));
      const h = Buffer.alloc(4);
      h.writeUInt32LE(body.length, 0);
      s.write(Buffer.concat([h, body]));
    });
    let buf = Buffer.alloc(0);
    s.on("data", (c) => {
      buf = Buffer.concat([buf, c]);
      if (buf.length < 4) return;
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) return;
      const env = JSON.parse(buf.subarray(4, 4 + len).toString("utf8"));
      s.destroy();
      env.error ? reject(env.error) : resolve(env.result);
    });
    s.on("error", reject);
    setTimeout(() => reject(new Error("rpc timeout")), 5000);
  });
}

const HELLO_BASE = {
  clientVersion: "b5-spike",
  protocolVersion: 1,
  clientId: "spike",
  profileId: "profile-A",
  browserInstanceId: null,
  hostInstanceId: "host-1",
};

try {
  const ep = await waitEndpoint();
  check("gateway publishes endpoint atomically", ep.transport === "unix" && ep.path.endsWith(".sock"));

  // token file perms
  const tokenStat = await fs.stat(path.join(dir, "auth", "token"));
  check("token file mode 0600", (tokenStat.mode & 0o777) === 0o600, `mode=${(tokenStat.mode & 0o777).toString(8)}`);
  const token = (await fs.readFile(path.join(dir, "auth", "token"), "utf8")).trim();

  // test 2: same-user no/wrong token → rejected, socket closed
  try {
    await rpc(ep.path, "bad1", "hello", { ...HELLO_BASE, token: "0".repeat(64) });
    check("wrong token rejected", false, "request succeeded?!");
  } catch (e) {
    check("wrong token rejected", e.code === "proto.auth_failed", e.code);
  }

  // test 4: two profiles, same user → both connect; profileId separates
  const helloA = await rpc(ep.path, "hA", "hello", { ...HELLO_BASE, token });
  const helloB = await rpc(ep.path, "hB", "hello", { ...HELLO_BASE, profileId: "profile-B", token });
  check("two connections same user different profileId", !!helloA && !!helloB);

  // test 3: stale socket file → reconnect works after restart
  gateway.kill("SIGTERM");
  await new Promise((r) => gateway.on("exit", r));
  // leave stale .sock file; restart must rm+rebind
  const gw2 = spawn(process.execPath, [path.join(ROOT, "packages/bridge/dist/gateway/bin.js")], {
    env: { ...process.env, CHROMEX_GATEWAY_HOME: dir },
    stdio: ["ignore", "ignore", "ignore"],
  });
  try {
    const ep2 = await waitEndpoint(10_000);
    // token rotates per gateway boot (HelloResponse.tokenRotated exists
    // for this) — re-read after restart
    const token2 = (await fs.readFile(path.join(dir, "auth", "token"), "utf8")).trim();
    const hello2 = await rpc(ep2.path, "h2", "hello", { ...HELLO_BASE, token: token2 });
    check("restart with stale socket → clean rebind", !!hello2);
  } finally {
    gw2.kill("SIGTERM");
  }

  // documented platform limits
  console.log("NOTE test1 (cross-user rejection): POSIX relies on 0600 token + 0700 dir; multi-user matrix needs Linux CI.");
  console.log("NOTE test5 (Windows pipe ACL): not executable on macOS; named-pipe path implemented, ACL pending Windows spike/CI.");
} finally {
  gateway.kill("SIGKILL").toString();
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.pass);
console.log(`\nB5 spike: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
