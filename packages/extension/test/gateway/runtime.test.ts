import { afterEach, describe, expect, test, vi } from "vitest";

import { getGatewayRuntime, resetGatewayRuntime, setAgentBadge } from "../../src/background/gateway/runtime.js";
import { DEFAULT_SETTINGS } from "../../src/background/storage.js";

function fakePort() {
  const listeners = new Set<(m: { kind: string; id?: string; method?: string }) => void>();
  return {
    postMessage: vi.fn((env: { kind: string; id?: string; method?: string }) => {
      if (env.kind === "request" && env.method === "hello") {
        queueMicrotask(() =>
          [...listeners].forEach((l) =>
            l({ kind: "response", id: env.id, result: { gatewayVersion: "t", protocolVersion: 1, providers: [], backends: [], tasks: [], features: {}, gatewayLastSeq: 0 } }),
          ),
        );
      }
    }),
    onMessage: { addListener: (l: (m: never) => void) => listeners.add(l as never) },
    onDisconnect: { addListener: () => {} },
  };
}

function stubChrome(settings: Record<string, unknown>, port?: ReturnType<typeof fakePort>) {
  const m = new Map<string, unknown>(Object.entries(settings));
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: async (k: string | string[]) => {
          const keys = Array.isArray(k) ? k : [k];
          const out: Record<string, unknown> = {};
          for (const key of keys) if (m.has(key)) out[key] = m.get(key);
          return out;
        },
        set: async (obj: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(obj)) m.set(k, v);
        },
      },
    },
    runtime: { connectNative: vi.fn(() => port ?? fakePort()), lastError: null },
  });
  return m;
}

describe("GatewayRuntime flag gating (P1-08 dual-path)", () => {
  afterEach(() => {
    resetGatewayRuntime();
    vi.unstubAllGlobals();
  });

  test("stale stored gatewayMode:false is overridden → gateway runtime still builds", async () => {
    stubChrome({ "codex.sidepanel.settings": { ...DEFAULT_SETTINGS, gatewayMode: false } });
    const rt = await getGatewayRuntime();
    expect(rt).not.toBeNull();
    await vi.waitFor(() => expect(rt!.state()).toBe("ready"), { timeout: 2000 });
    resetGatewayRuntime();
  });

  test("gatewayMode missing entirely → still treated as on (gateway is default)", async () => {
    const { gatewayMode: _omit, ...rest } = DEFAULT_SETTINGS;
    stubChrome({ "codex.sidepanel.settings": rest });
    const rt = await getGatewayRuntime();
    expect(rt).not.toBeNull();
    resetGatewayRuntime();
  });

  test("gatewayMode on → runtime builds with identity + lazy client", async () => {
    stubChrome({ "codex.sidepanel.settings": { ...DEFAULT_SETTINGS, gatewayMode: true } });
    const rt = await getGatewayRuntime();
    expect(rt).not.toBeNull();
    // eager §11 startup sync: hello + gateway.sync/task.sync fire;
    // fake port answers hello, syncs return empty → ready
    await vi.waitFor(() => expect(rt!.state()).toBe("ready"), { timeout: 2000 });
    // identity persisted in storage.local
    const m = (chrome.storage.local as unknown as { get: (k: string) => Promise<Record<string, unknown>> });
    const got = await m.get("chromex.identity.v1");
    expect((got["chromex.identity.v1"] as { profileId: string }).profileId).toMatch(/^prof_/);
    resetGatewayRuntime();
    // rebuild returns same runtime shape (new singleton)
    const rt2 = await getGatewayRuntime();
    expect(rt2).not.toBeNull();
  });
});

describe("agent badge title hygiene", () => {
  afterEach(() => {
    setAgentBadge(null);
    vi.unstubAllGlobals();
  });

  function stubAction() {
    const titles: string[] = [];
    const texts: string[] = [];
    vi.stubGlobal("chrome", {
      action: {
        setBadgeText: vi.fn(async ({ text }: { text: string }) => { texts.push(text); }),
        setBadgeBackgroundColor: vi.fn(async () => {}),
        setTitle: vi.fn(async ({ title }: { title: string }) => { titles.push(title); }),
      },
      runtime: { getManifest: () => ({ name: "Chromex" }) },
    });
    return { titles, texts };
  }

  test("badge without title resets the title to the manifest name — no stale hover text", () => {
    const { titles, texts } = stubAction();
    setAgentBadge({ text: "w", title: "Working on it" });
    expect(titles).toEqual(["Working on it"]);
    setAgentBadge({ text: "w2" });
    expect(titles[1]).toBe("Chromex");
    setAgentBadge(null);
    expect(texts.at(-1)).toBe("");
    expect(titles.at(-1)).toBe("Chromex");
  });
});
