import { afterEach, describe, expect, test, vi } from "vitest";

import { GatewayClient } from "../../src/background/gateway/gateway-client.js";
import type { Envelope, HelloResponse } from "@codex-sidepanel/shared";

type PortMessage = Envelope & { result?: unknown };

function createFakePort() {
  const messageListeners = new Set<(m: PortMessage) => void>();
  const disconnectListeners = new Set<() => void>();
  return {
    postMessage: vi.fn(),
    onMessage: { addListener: (l: (m: PortMessage) => void) => messageListeners.add(l) },
    onDisconnect: { addListener: (l: () => void) => disconnectListeners.add(l) },
    emit(m: PortMessage) {
      for (const l of messageListeners) l(m);
    },
    disconnect() {
      for (const l of disconnectListeners) l();
    },
    _listeners: messageListeners,
  };
}

const HELLO_RESULT: HelloResponse = {
  gatewayVersion: "test",
  protocolVersion: 1,
  providers: [],
  backends: [],
  tasks: [],
  features: {},
  gatewayLastSeq: 0,
} as unknown as HelloResponse;

function stubChrome(port: ReturnType<typeof createFakePort>) {
  vi.stubGlobal("chrome", {
    runtime: { connectNative: vi.fn(() => port), lastError: null },
  });
}

function respondToHello(port: ReturnType<typeof createFakePort>) {
  const calls = port.postMessage.mock.calls.map((c) => c[0] as Envelope);
  const hello = calls.find((e) => e.kind === "request" && e.method === "hello");
  if (!hello || hello.kind !== "request") throw new Error("no hello posted");
  port.emit({ v: 1, kind: "response", id: hello.id, result: HELLO_RESULT } as PortMessage);
}

/** Auto-answer every hello so connect() resolves without manual steps
 *  (needed under fake timers). */
function autoHello(port: ReturnType<typeof createFakePort>) {
  const orig = port.postMessage.getMockImplementation();
  void orig;
  port.postMessage.mockImplementation((env: Envelope) => {
    if (env.kind === "request" && env.method === "hello") {
      queueMicrotask(() =>
        port.emit({ v: 1, kind: "response", id: env.id, result: HELLO_RESULT } as PortMessage),
      );
    }
  });
}

describe("GatewayClient (P1-08)", () => {
  afterEach(() => vi.unstubAllGlobals());

  test("connect sends hello first, then request/response resolves", async () => {
    const port = createFakePort();
    stubChrome(port);
    const helloFn = vi.fn(async () => ({
      protocolVersion: 1 as const,
      clientId: "cli_x",
      profileId: "prof_x",
      browserInstanceId: null,
      hostInstanceId: "",
      lastSeqByTask: {}, lastSeqByGateway: 0,
    }));
    const client = new GatewayClient({ hello: helloFn, requestTimeoutMs: 1000 });
    const p = client.connect();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    respondToHello(port);
    await p;
    expect(client.state).toBe("ready");
    expect(client.hello).toEqual(HELLO_RESULT);
    // hello was the FIRST message on the wire
    const first = port.postMessage.mock.calls[0]?.[0] as Envelope;
    expect(first.method).toBe("hello");

    const req = client.request("task.list");
    await vi.waitFor(() => {
      const last = port.postMessage.mock.calls.at(-1)?.[0] as Envelope;
      expect(last.method).toBe("task.list");
    });
    const last = port.postMessage.mock.calls.at(-1)?.[0] as Envelope & { id: string };
    port.emit({ v: 1, kind: "response", id: last.id, result: { tasks: [] } } as PortMessage);
    await expect(req).resolves.toEqual({ tasks: [] });
  });

  test("request error envelope rejects with code", async () => {
    const port = createFakePort();
    stubChrome(port);
    const client = new GatewayClient({
      hello: async () => ({ protocolVersion: 1 as const, clientId: "c", profileId: "p", browserInstanceId: null, hostInstanceId: "", tasks: { lastSeqByTask: {}, lastSeqByGateway: 0 } }),
      requestTimeoutMs: 1000,
    });
    const p = client.connect();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    respondToHello(port);
    await p;
    const req = client.request("bogus.method");
    await vi.waitFor(() => expect(port.postMessage.mock.calls.length).toBeGreaterThanOrEqual(2));
    const last = port.postMessage.mock.calls.at(-1)?.[0] as Envelope & { id: string };
    port.emit({ v: 1, kind: "response", id: last.id, error: { code: "proto.unknown_method", message: "nope" } } as PortMessage);
    await expect(req).rejects.toThrow(/proto.unknown_method/);
  });

  test("port disconnect → state disconnected; next request reconnects + re-hellos", async () => {
    const port = createFakePort();
    stubChrome(port);
    const states: string[] = [];
    const client = new GatewayClient({
      hello: async () => ({ protocolVersion: 1 as const, clientId: "c", profileId: "p", browserInstanceId: null, hostInstanceId: "", lastSeqByTask: { t1: 9 }, lastSeqByGateway: 3 }),
      onStateChange: (s) => states.push(s),
      requestTimeoutMs: 1000,
    });
    const p = client.connect();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    respondToHello(port);
    await p;
    port.disconnect();
    expect(client.state).toBe("disconnected");
    expect(states).toContain("disconnected");

    // next request lazily reconnects — hello carries persisted cursors
    const req = client.request("task.list");
    await vi.waitFor(() => expect(port.postMessage.mock.calls.length).toBeGreaterThanOrEqual(2));
    const helloEnv = port.postMessage.mock.calls.at(-1)?.[0] as Envelope & { payload?: { tasks?: { lastSeqByTask?: Record<string, number> } } };
    // NOTE: reconnect creates a NEW port in real chrome; our stub returns same port
    void helloEnv;
    const helloCall = port.postMessage.mock.calls.map((c) => c[0] as Envelope).filter((e) => e.method === "hello");
    expect(helloCall.length).toBe(2);
    const secondHello = helloCall[1] as Envelope & { payload?: { lastSeqByTask?: Record<string, number>; lastSeqByGateway?: number } };
    expect(secondHello.payload?.lastSeqByTask?.t1).toBe(9);
    expect(secondHello.payload?.lastSeqByGateway).toBe(3);
    // answer second hello then the request
    const helloId = (secondHello as { id: string }).id;
    port.emit({ v: 1, kind: "response", id: helloId, result: HELLO_RESULT } as PortMessage);
    await vi.waitFor(() => {
      const last = port.postMessage.mock.calls.at(-1)?.[0] as Envelope;
      expect(last.method).toBe("task.list");
    });
    const last = port.postMessage.mock.calls.at(-1)?.[0] as Envelope & { id: string };
    port.emit({ v: 1, kind: "response", id: last.id, result: {} } as PortMessage);
    await req;
  });

  test("ack posts ack envelope without awaiting", async () => {
    const port = createFakePort();
    stubChrome(port);
    const client = new GatewayClient({
      hello: async () => ({ protocolVersion: 1 as const, clientId: "c", profileId: "p", browserInstanceId: null, hostInstanceId: "", tasks: { lastSeqByTask: {}, lastSeqByGateway: 0 } }),
    });
    const p = client.connect();
    await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalled());
    respondToHello(port);
    await p;
    client.ack("task", 12, "t1");
    const ack = port.postMessage.mock.calls.at(-1)?.[0] as Envelope;
    expect(ack.kind).toBe("ack");
    expect((ack as { stream?: string }).stream).toBe("task");
    expect((ack as { seq?: number }).seq).toBe(12);
  });

  test("request timeout rejects", async () => {
    vi.useFakeTimers();
    const port = createFakePort();
    stubChrome(port);
    autoHello(port);
    const client = new GatewayClient({
      hello: async () => ({ protocolVersion: 1 as const, clientId: "c", profileId: "p", browserInstanceId: null, hostInstanceId: "", tasks: { lastSeqByTask: {}, lastSeqByGateway: 0 } }),
      requestTimeoutMs: 50,
    });
    await client.connect();
    const req = client.request("task.get", { taskId: "x" });
    const assertion = expect(req).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    vi.useRealTimers();
  });
});
