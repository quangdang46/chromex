import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { GatewayIpcServer } from "../src/gateway/ipc-server.js";

let dir: string;
let gw: { ipc: GatewayIpcServer; shutdown: (r?: string) => Promise<void> } | null = null;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-planning-"));
});
afterEach(async () => {
  await gw?.shutdown("test").catch(() => {});
  gw = null;
  await fs.rm(dir, { recursive: true, force: true });
});

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

async function authedConn(): Promise<net.Socket> {
  const ep = gw!.ipc.endpointPath();
  const s = await connect(ep.path);
  const token = gw!.ipc.tokenBytes.toString("hex");
  await rpc(s, "hello", "hello", {
    token,
    clientVersion: "test",
    protocolVersion: 1,
    clientId: "c1",
    profileId: "p1",
    browserInstanceId: null,
    hostInstanceId: "",
  });
  return s;
}

async function start(config?: Record<string, unknown>) {
  if (config) {
    await fs.writeFile(path.join(dir, "gateway.json"), JSON.stringify(config));
  }
  const { startGateway } = await import("../src/gateway/main.js");
  gw = (await startGateway({ dataDir: dir, log: () => {} })) as typeof gw;
  return gw!;
}

const validRoutePayload = {
  message: "summarize this page",
  selectedProfileId: "default",
  selectedModel: "fast-model",
  models: [],
  readStrategyOverride: "auto",
  explicitAttachments: [],
  fileAttachments: [],
};

const validActionPayload = {
  message: "click search",
  snapshot: { metadata: { url: "https://example.com", title: "t", domain: "example.com" }, elements: [] },
};

describe("gateway planning RPCs (chromex-pwu)", () => {
  test("route.plan / browser.action.plan validate payloads → proto.invalid", async () => {
    await start();
    const s = await authedConn();
    try {
      await expect(rpc(s, "p1", "route.plan", {})).rejects.toMatchObject({
        code: "proto.invalid",
      });
      await expect(rpc(s, "p2", "browser.action.plan", {})).rejects.toMatchObject({
        code: "proto.invalid",
      });
    } finally {
      s.destroy();
    }
  });

  test("route.plan / browser.action.plan → provider.unavailable when codex disabled", async () => {
    await start({ providers: { codex: { enabled: false } } });
    const s = await authedConn();
    try {
      await expect(rpc(s, "p3", "route.plan", validRoutePayload)).rejects.toMatchObject({
        code: "provider.unavailable",
      });
      await expect(rpc(s, "p4", "browser.action.plan", validActionPayload)).rejects.toMatchObject({
        code: "provider.unavailable",
      });
    } finally {
      s.destroy();
    }
  });
});
