/**
 * GatewayModeRelay dual-channel demux tests (chromex-rzf).
 *
 * One NM port carries two logical channels:
 *  - Envelope ({v:1,kind,...}) → Gateway IPC socket
 *  - legacy BridgeRequest ({id,method,params}) → spawned bridge sidecar
 *
 * The sidecar bridge is a fake .mjs child (BRIDGE_ENTRY override via
 * GatewayModeRelayOptions.bridgeEntry) speaking the line-delimited
 * bridge CLI contract. The gateway is intentionally absent — sidecar
 * traffic must still be served (lazy gateway connect).
 */

import { PassThrough } from "node:stream";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GatewayModeRelay } from "../src/gateway-mode.js";
import { encodeNativeMessage } from "../src/framing.js";

const FAKE_BRIDGE = `
import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const req = JSON.parse(line);
  if (req.method === "emit.event") {
    process.stdout.write(JSON.stringify({ event: { type: "sidecar.ping", id: req.id } }) + "\\n");
    return;
  }
  process.stdout.write(
    JSON.stringify({ id: req.id, result: { echo: req.method, params: req.params ?? null } }) + "\\n",
  );
});
`;

let dir: string;
let bridgePath: string;
let writes: Buffer[];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "gw-sidecar-"));
  bridgePath = path.join(dir, "fake-bridge.mjs");
  await fs.writeFile(bridgePath, FAKE_BRIDGE);
  writes = [];
  vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
    if (Buffer.isBuffer(chunk)) writes.push(chunk);
    else writes.push(Buffer.from(String(chunk)));
    return true;
  }) as typeof process.stdout.write);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

function nmMessages(): Array<Record<string, unknown>> {
  const all = Buffer.concat(writes);
  const out: Array<Record<string, unknown>> = [];
  let off = 0;
  while (off + 4 <= all.length) {
    const len = all.readUInt32LE(off);
    out.push(JSON.parse(all.subarray(off + 4, off + 4 + len).toString("utf8")));
    off += 4 + len;
  }
  return out;
}

describe("GatewayModeRelay sidecar demux (chromex-rzf)", () => {
  test("legacy BridgeRequest → bridge sidecar child, response verbatim", async () => {
    const stdin = new PassThrough();
    const relay = new GatewayModeRelay({
      dataDir: dir,
      gatewayBin: null, // never spawn a gateway
      startupTimeoutMs: 200,
      exitProcess: false,
      bridgeEntry: bridgePath,
    });
    await relay.start(stdin as never);

    stdin.write(
      encodeNativeMessage({ id: "s1", method: "runtime.config.read", params: { deep: true } }),
    );

    await vi.waitFor(() => {
      const msgs = nmMessages();
      expect(
        msgs.some(
          (m) =>
            m.id === "s1" &&
            typeof m.result === "object" &&
            (m.result as { echo?: string }).echo === "runtime.config.read",
        ),
      ).toBe(true);
    }, { timeout: 5000 });

    const resp = nmMessages().find((m) => m.id === "s1") as {
      result?: { echo?: string; params?: unknown };
    };
    // verbatim bridge response — NOT wrapped in an envelope
    expect(resp.result?.params).toEqual({ deep: true });
    expect(nmMessages().every((m) => m.v === undefined)).toBe(true);

    stdin.end();
  }, 10_000);

  test("sidecar {event} lines forward verbatim to the extension", async () => {
    const stdin = new PassThrough();
    const relay = new GatewayModeRelay({
      dataDir: dir,
      gatewayBin: null,
      startupTimeoutMs: 200,
      exitProcess: false,
      bridgeEntry: bridgePath,
    });
    await relay.start(stdin as never);

    stdin.write(encodeNativeMessage({ id: "e1", method: "emit.event", params: {} }));

    await vi.waitFor(() => {
      expect(
        nmMessages().some(
          (m) => (m.event as { type?: string } | undefined)?.type === "sidecar.ping",
        ),
      ).toBe(true);
    }, { timeout: 5000 });

    stdin.end();
  }, 10_000);

  test("Envelope request with no gateway → error response, sidecar unaffected", async () => {
    const stdin = new PassThrough();
    const relay = new GatewayModeRelay({
      dataDir: dir,
      gatewayBin: null,
      startupTimeoutMs: 300,
      exitProcess: false,
      bridgeEntry: bridgePath,
    });
    await relay.start(stdin as never);

    stdin.write(
      encodeNativeMessage({
        v: 1,
        kind: "request",
        id: "g1",
        method: "hello",
        payload: { clientVersion: "test" },
      }),
    );

    // gateway unreachable (no endpoint/token in dir) → proto error envelope
    await vi.waitFor(() => {
      const msgs = nmMessages();
      expect(
        msgs.some((m) => m.kind === "response" && m.id === "g1" && m.error),
      ).toBe(true);
    }, { timeout: 5000 });

    // ...and the sidecar channel still works afterwards
    stdin.write(encodeNativeMessage({ id: "s2", method: "diagnostics.log.write", params: {} }));
    await vi.waitFor(() => {
      expect(nmMessages().some((m) => m.id === "s2" && m.result)).toBe(true);
    }, { timeout: 5000 });

    stdin.end();
  }, 10_000);
});
