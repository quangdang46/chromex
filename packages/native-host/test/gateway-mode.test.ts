import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GatewayModeRelay } from "../src/gateway-mode.js";
import { encodeNativeMessage } from "../src/framing.js";
import type { Envelope } from "@codex-sidepanel/shared";

let dir: string;
let writes: Buffer[];
let gw: { shutdown: (r?: string) => Promise<void> } | null = null;

beforeEach(async () => {
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-mode-"));
  writes = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) writes.push(chunk);
    else writes.push(Buffer.from(String(chunk)));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await gw?.shutdown("test").catch(() => {});
  gw = null;
  const fs = await import("node:fs/promises");
  await fs.rm(dir, { recursive: true, force: true });
});

function nmFrames(): Envelope[] {
  // concatenate all written NM frames and decode
  const all = Buffer.concat(writes);
  const out: Envelope[] = [];
  let off = 0;
  while (off + 4 <= all.length) {
    const len = all.readUInt32LE(off);
    out.push(JSON.parse(all.subarray(off + 4, off + 4 + len).toString("utf8")));
    off += 4 + len;
  }
  return out;
}

describe("GatewayModeRelay (P1-03)", () => {
  test("extension hello → token injected → HelloResponse; task.create passes through", async () => {
    const { startGateway } = await import("../../bridge/src/gateway/main.js");
    const started = await startGateway({ dataDir: dir, log: () => {} });
    gw = started;

    const stdin = new PassThrough();
    const relay = new GatewayModeRelay({ dataDir: dir, startupTimeoutMs: 10_000, exitProcess: false });
    // start() reads process.stdin listeners — we pass our PassThrough
    const startP = relay.start(stdin as never);
    // give ensureGateway a moment
    await new Promise((r) => setTimeout(r, 300));

    const helloReq: Envelope = {
      v: 1,
      kind: "request",
      id: "h1",
      method: "hello",
      payload: {
        clientVersion: "ext-test",
        protocolVersion: 1,
        clientId: "ext-1",
        profileId: "prof-1",
        browserInstanceId: null,
        hostInstanceId: "should-be-overridden",
        lastSeqByTask: {},
        lastSeqByGateway: 0,
      },
    };
    stdin.write(encodeNativeMessage(helloReq));

    // wait for response frame
    await vi.waitFor(() => {
      const envs = nmFrames();
      expect(envs.some((e) => e.kind === "response" && e.id === "h1")).toBe(true);
    }, { timeout: 5000 });

    const resp = nmFrames().find((e) => e.kind === "response" && e.id === "h1") as {
      result?: { gatewayVersion?: string; tasks?: unknown[] };
      error?: { code?: string };
    };
    expect(resp.error).toBeUndefined();
    expect(resp.result?.gatewayVersion).toBeTruthy();

    // task.create through the relay
    const createReq: Envelope = {
      v: 1,
      kind: "request",
      id: "t1",
      method: "task.create",
      payload: { cwd: "/tmp", title: "relay" },
    };
    stdin.write(encodeNativeMessage(createReq));
    await vi.waitFor(() => {
      expect(nmFrames().some((e) => e.kind === "response" && e.id === "t1")).toBe(true);
    }, { timeout: 5000 });
    const cresp = nmFrames().find((e) => e.kind === "response" && e.id === "t1") as {
      result?: { taskId?: string };
      error?: { code?: string };
    };
    expect(cresp.error).toBeUndefined();
    expect(cresp.result?.taskId).toBeTruthy();

    stdin.end();
    await startP.catch(() => {});
  }, 20_000);
});
