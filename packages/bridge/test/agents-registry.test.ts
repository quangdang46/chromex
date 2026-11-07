import { describe, expect, test, vi } from "vitest";

import type { AgentProvider, ProviderCatalog } from "@codex-sidepanel/shared";
import { NO_CAPABILITIES } from "@codex-sidepanel/shared";

import { ProviderRegistry, effectiveCapabilities } from "../src/agents/registry.js";
import { CatalogCache, CATALOG_TTL_MS } from "../src/agents/catalog-cache.js";
import type { GatewayProviderConfig } from "../src/gateway/config.js";

function providerCfg(enabled = true): GatewayProviderConfig {
  return { enabled, command: null, env: {}, models: null, additionalModels: null, defaultModel: null };
}

function fakeProvider(id: string): AgentProvider {
  return {
    id,
    displayName: id,
    capabilities: NO_CAPABILITIES,
    isAvailable: async () => ({ available: true }),
    fetchCatalog: async () => ({
      providerId: id,
      models: [],
      modes: [],
      fetchedAt: Date.now(),
    } satisfies ProviderCatalog),
    createSession: async () => {
      throw new Error("not implemented");
    },
    resumeSession: async () => {
      throw new Error("not implemented");
    },
  };
}

describe("ProviderRegistry", () => {
  test("resolves bare providerId with config defaults", async () => {
    const reg = new ProviderRegistry({
      codex: { ...providerCfg(), defaultModel: "gpt-5" },
    });
    await reg.register("codex", async () => fakeProvider("codex"));
    const target = reg.resolve("codex");
    expect(target?.providerId).toBe("codex");
    expect(target?.config.model).toBe("gpt-5");
    expect(target?.persistenceProviderId).toBe("codex");
  });

  test("derived profile keeps ORIGINAL provider for persistence", async () => {
    const reg = new ProviderRegistry({ codex: providerCfg() });
    await reg.register("codex", async () => fakeProvider("codex"));
    reg.addProfile({
      profileId: "codex:fast",
      providerId: "codex",
      overrides: { model: "gpt-5-mini", modeId: "fast" },
    });
    const target = reg.resolve("codex:fast");
    expect(target?.providerId).toBe("codex");
    expect(target?.persistenceProviderId).toBe("codex");
    expect(target?.profileOf).toBe("codex:fast");
    expect(target?.config.model).toBe("gpt-5-mini");
    expect(target?.config.modeId).toBe("fast");
  });

  test("disabled provider resolves to null", async () => {
    const reg = new ProviderRegistry({ codex: providerCfg(false) });
    await reg.register("codex", async () => fakeProvider("codex"));
    expect(reg.resolve("codex")).toBeNull();
    expect(reg.resolve("codex:fast")).toBeNull();
  });

  test("unknown id resolves to null", async () => {
    const reg = new ProviderRegistry({});
    expect(reg.resolve("nope")).toBeNull();
  });
});

describe("effectiveCapabilities", () => {
  test("runtime can only narrow static caps", () => {
    const staticCaps = { ...NO_CAPABILITIES, streaming: true, steer: true };
    const eff = effectiveCapabilities(staticCaps, { streaming: false, steer: true });
    expect(eff.streaming).toBe(false);
    expect(eff.steer).toBe(true);
  });
});

describe("CatalogCache", () => {
  function makeCache(fetchImpl: () => Promise<ProviderCatalog>, now?: () => number) {
    const provider: AgentProvider = {
      ...fakeProvider("codex"),
      fetchCatalog: fetchImpl,
    };
    const cache = new CatalogCache(() => [provider], now);
    return { cache, provider };
  }

  test("single-flight: concurrent fetches share one provider call", async () => {
    let calls = 0;
    const { cache } = makeCache(async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 20));
      return { providerId: "codex", models: [], modes: [], fetchedAt: Date.now() };
    });
    const [a, b, c] = await Promise.all([
      cache.fetch("codex"),
      cache.fetch("codex"),
      cache.fetch("codex"),
    ]);
    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("TTL: second fetch within 10min uses cache; after TTL refetches", async () => {
    let now = 1_000_000;
    let calls = 0;
    const { cache } = makeCache(
      async () => {
        calls += 1;
        return { providerId: "codex", models: [], modes: [], fetchedAt: now };
      },
      () => now,
    );
    await cache.fetch("codex");
    await cache.fetch("codex");
    expect(calls).toBe(1);
    now += CATALOG_TTL_MS + 1;
    await cache.fetch("codex");
    expect(calls).toBe(2);
  });

  test("invalidate drops cache; forceRefresh bypasses TTL", async () => {
    let calls = 0;
    const { cache } = makeCache(async () => {
      calls += 1;
      return { providerId: "codex", models: [], modes: [], fetchedAt: Date.now() };
    });
    await cache.fetch("codex");
    await cache.fetch("codex", { forceRefresh: true });
    expect(calls).toBe(2);
    cache.invalidate("codex");
    await cache.fetch("codex");
    expect(calls).toBe(3);
  });

  test("deadline: hanging fetch rejects with CatalogFetchTimeoutError", async () => {
    vi.useFakeTimers();
    try {
      const { cache } = makeCache(() => new Promise(() => {}));
      const p = cache.fetch("codex");
      const assertion = expect(p).rejects.toThrow(/deadline/);
      await vi.advanceTimersByTimeAsync(121_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
