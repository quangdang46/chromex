import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  installNetworkLog,
  listNetworkRequests,
  resetNetworkLogForTests,
  resetNetworkTab,
  setNetworkLogStore,
  type NetworkLogEntry,
  type NetworkLogStore,
} from "../src/background/network-log.js";

type Listener = (details: Record<string, unknown>) => unknown;

const listeners: {
  before?: Listener;
  completed?: Listener;
  error?: Listener;
} = {};

function installFakeWebRequest(): void {
  const g = globalThis as { chrome?: unknown };
  g.chrome = {
    webRequest: {
      onBeforeRequest: { addListener: (fn: Listener) => { listeners.before = fn; } },
      onCompleted: { addListener: (fn: Listener) => { listeners.completed = fn; } },
      onErrorOccurred: { addListener: (fn: Listener) => { listeners.error = fn; } },
    },
  };
}

function completedDetails(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tabId: 7,
    requestId: "r1",
    method: "GET",
    url: "https://app.example.com/api/data?token=SECRET#frag",
    type: "xhr",
    statusCode: 200,
    frameId: 3,
    ...over,
  };
}

function makeStore(initial: Record<string, NetworkLogEntry[]> = {}): NetworkLogStore & {
  saved: Record<string, NetworkLogEntry[]>[];
} {
  const saved: Record<string, NetworkLogEntry[]>[] = [];
  let data = initial;
  return {
    saved,
    load: async () => data,
    save: async (snapshot) => {
      saved.push(snapshot);
      data = snapshot;
    },
  };
}

describe("network-log session persistence", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetNetworkLogForTests();
    listeners.before = undefined;
    listeners.completed = undefined;
    listeners.error = undefined;
    installFakeWebRequest();
  });

  afterEach(() => {
    resetNetworkLogForTests();
    vi.useRealTimers();
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("persists a bounded sanitized tail after the debounce", async () => {
    const store = makeStore();
    setNetworkLogStore(store);
    installNetworkLog();
    listeners.before?.({ tabId: 7, requestId: "r1" });
    listeners.completed?.(completedDetails());

    // URL is sanitized at capture — query token never reaches storage.
    const entries = listNetworkRequests(7, { limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.url).toBe("https://app.example.com/api/data");
    expect(entries[0]!.frameId).toBe(3);

    await vi.advanceTimersByTimeAsync(3_100);
    expect(store.saved).toHaveLength(1);
    expect(store.saved[0]!["7"]).toHaveLength(1);
    expect(store.saved[0]!["7"]![0]!.url).toBe("https://app.example.com/api/data");
  });

  it("restores the persisted tail after a simulated SW restart", async () => {
    const store = makeStore();
    setNetworkLogStore(store);
    installNetworkLog();
    listeners.completed?.(completedDetails({ requestId: "r1" }));
    await vi.advanceTimersByTimeAsync(3_100);
    expect(store.saved).toHaveLength(1);

    // Simulate MV3 service-worker death + respawn: module state wiped,
    // chrome.storage.session (the store) survives.
    resetNetworkLogForTests();
    listeners.before = undefined;
    listeners.completed = undefined;
    listeners.error = undefined;
    installFakeWebRequest();
    const restored = makeStore(store.saved.at(-1));
    setNetworkLogStore(restored);
    installNetworkLog();
    await vi.advanceTimersByTimeAsync(0); // let restoreNetworkLog resolve

    const entries = listNetworkRequests(7, { limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.url).toBe("https://app.example.com/api/data");
    expect(entries[0]!.frameId).toBe(3);
  });

  it("persists immediately on tab reset so a reused tabId inherits nothing", async () => {
    const store = makeStore();
    setNetworkLogStore(store);
    installNetworkLog();
    listeners.completed?.(completedDetails());
    resetNetworkTab(7);

    // persistNow fires without waiting for the debounce.
    await vi.advanceTimersByTimeAsync(0);
    expect(store.saved.length).toBeGreaterThanOrEqual(1);
    expect(store.saved.at(-1)!["7"]).toBeUndefined();
    expect(listNetworkRequests(7, { limit: 10 })).toHaveLength(0);
  });

  it("skips malformed persisted entries on restore", async () => {
    const store = makeStore({
      "9": [
        { method: "GET", url: "https://a.example/x", type: "xhr", ts: 1 },
        { bogus: true } as unknown as NetworkLogEntry,
        "not-an-entry" as unknown as NetworkLogEntry,
      ],
    });
    setNetworkLogStore(store);
    installNetworkLog();
    await vi.advanceTimersByTimeAsync(0);

    const entries = listNetworkRequests(9, { limit: 10 });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.url).toBe("https://a.example/x");
  });
});
