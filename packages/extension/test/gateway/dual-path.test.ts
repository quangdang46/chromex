import { describe, expect, test, vi } from "vitest";

import { NativeBridgeClient } from "../../src/background/native-bridge-client.js";

describe("NativeBridgeClient gateway delegation (P1-08 dual-path)", () => {
  test("delegate set → request() goes to gateway, port untouched", async () => {
    const connectNative = vi.fn(() => {
      throw new Error("must not open NM port in gateway mode");
    });
    vi.stubGlobal("chrome", { runtime: { connectNative, lastError: null } });
    const delegate = { request: vi.fn(async (m: string, p?: unknown) => ({ echoed: m, p })) };
    const client = new NativeBridgeClient();
    client.setGatewayDelegate(delegate);
    const res = await client.request<{ echoed: string }>("prompt.send", { message: "hi" });
    expect(res.echoed).toBe("prompt.send");
    expect(delegate.request).toHaveBeenCalledWith("prompt.send", { message: "hi" });
    expect(connectNative).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  test("delegate timeout option still applies", async () => {
    vi.stubGlobal("chrome", { runtime: { connectNative: vi.fn(), lastError: null } });
    const client = new NativeBridgeClient();
    client.setGatewayDelegate({ request: () => new Promise(() => {}) });
    await expect(
      client.request("slow.method", {}, { timeoutMs: 20, timeoutMessage: "too slow" }),
    ).rejects.toThrow("too slow");
    vi.unstubAllGlobals();
  });

  test("sidecar method bypasses delegate → legacy NM port (chromex-rzf)", async () => {
    const listeners = new Set<(m: { id?: string; result?: unknown }) => void>();
    const port = {
      postMessage: vi.fn((m: { id: string }) => {
        queueMicrotask(() => {
          for (const l of listeners) l({ id: m.id, result: { sidecar: true } });
        });
      }),
      onMessage: { addListener: (l: (m: never) => void) => listeners.add(l as never) },
      onDisconnect: { addListener: () => {} },
    };
    const connectNative = vi.fn(() => port);
    vi.stubGlobal("chrome", { runtime: { connectNative, lastError: null } });
    const delegate = { request: vi.fn(async () => ({ gw: true })) };
    const client = new NativeBridgeClient();
    client.setGatewayDelegate(delegate);

    for (const method of ["runtime.config.read", "image.asset.read", "workspace.harness.read", "diagnostics.log.write"]) {
      const res = await client.request<{ sidecar?: boolean }>(method, { q: 1 });
      expect(res.sidecar).toBe(true);
    }
    expect(delegate.request).not.toHaveBeenCalled();
    expect(connectNative).toHaveBeenCalledTimes(1);
    expect(port.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ method: "runtime.config.read", params: { q: 1 } }),
    );
    vi.unstubAllGlobals();
  });

  test("agent-domain method still goes to gateway while sidecar uses NM", async () => {
    const listeners = new Set<(m: { id?: string; result?: unknown }) => void>();
    const port = {
      postMessage: vi.fn((m: { id: string }) => {
        queueMicrotask(() => {
          for (const l of listeners) l({ id: m.id, result: { sidecar: true } });
        });
      }),
      onMessage: { addListener: (l: (m: never) => void) => listeners.add(l as never) },
      onDisconnect: { addListener: () => {} },
    };
    vi.stubGlobal("chrome", { runtime: { connectNative: vi.fn(() => port), lastError: null } });
    const delegate = { request: vi.fn(async (m: string) => ({ via: m })) };
    const client = new NativeBridgeClient();
    client.setGatewayDelegate(delegate);

    const agent = await client.request<{ via: string }>("prompt.send", { message: "hi" });
    expect(agent.via).toBe("prompt.send");
    const sidecar = await client.request<{ sidecar?: boolean }>("diagnostics.log.write", {});
    expect(sidecar.sidecar).toBe(true);
    expect(delegate.request).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });

  test("delegate cleared → legacy NM path resumes", async () => {
    const listeners = new Set<(m: { id?: string; result?: unknown }) => void>();
    const port = {
      postMessage: vi.fn((m: { id: string }) => {
        queueMicrotask(() => {
          for (const l of listeners) l({ id: m.id, result: { legacy: true } });
        });
      }),
      onMessage: { addListener: (l: (m: never) => void) => listeners.add(l as never) },
      onDisconnect: { addListener: () => {} },
    };
    vi.stubGlobal("chrome", { runtime: { connectNative: vi.fn(() => port), lastError: null } });
    const client = new NativeBridgeClient();
    client.setGatewayDelegate({ request: async () => ({ gw: true }) });
    client.setGatewayDelegate(null);
    const res = await client.request<{ legacy?: boolean }>("model.list");
    expect(res.legacy).toBe(true);
    vi.unstubAllGlobals();
  });
});
