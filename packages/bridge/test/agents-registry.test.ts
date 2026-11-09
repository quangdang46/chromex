import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test, vi } from "vitest";

import type { AgentProvider, ProviderCatalog } from "@codex-sidepanel/shared";
import { NO_CAPABILITIES } from "@codex-sidepanel/shared";

import { ProviderRegistry, effectiveCapabilities } from "../src/agents/registry.js";
import {
  CatalogCache,
  CATALOG_TTL_MS,
  FileCatalogSnapshotStore,
} from "../src/agents/catalog-cache.js";
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

  test("snapshot store: fresh disk snapshot is served without a provider fetch", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-snap-"));
    try {
      let now = 1_000_000;
      let calls = 0;
      const provider: AgentProvider = {
        ...fakeProvider("codex"),
        fetchCatalog: async () => {
          calls += 1;
          return {
            providerId: "codex",
            models: [{ id: "gpt-5", label: "GPT-5" }],
            modes: [],
            fetchedAt: now,
          };
        },
      };
      const store = new FileCatalogSnapshotStore(dir);
      const first = new CatalogCache(() => [provider], () => now, store);
      await first.fetch("codex");
      expect(calls).toBe(1);
      // let the fire-and-forget save land
      await vi.waitFor(async () => {
        expect(await store.load("codex")).not.toBeNull();
      });

      // "restart": brand-new cache over the same dir
      const second = new CatalogCache(() => [provider], () => now, store);
      const catalog = await second.fetch("codex");
      expect(calls).toBe(1);
      expect(catalog.models[0]?.id).toBe("gpt-5");

      // stale snapshot (> TTL) is ignored → provider refetch
      now += CATALOG_TTL_MS + 1;
      const third = new CatalogCache(() => [provider], () => now, store);
      await third.fetch("codex");
      expect(calls).toBe(2);
      // the refetch's snapshot save is fire-and-forget — wait for it to
      // land before rm or the recursive delete races the rename (ENOTEMPTY)
      await vi.waitFor(async () => {
        expect((await store.load("codex"))?.fetchedAt).toBe(now);
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("snapshot store: corrupt/missing files load as null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "catalog-snap-"));
    try {
      const store = new FileCatalogSnapshotStore(dir);
      expect(await store.load("codex")).toBeNull();
      await store.save("codex", {
        catalog: { providerId: "codex", models: [], modes: [], fetchedAt: 1 },
        fetchedAt: 1,
      });
      expect(await store.load("codex")).not.toBeNull();
      // overwrite with garbage → tolerant null
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(dir, "codex.json"), "not json");
      expect(await store.load("codex")).toBeNull();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

describe("B4 capability flags match ADR outcome", () => {
  test("playwright-isolated: ariaSnapshot-based a11y, iframe all via frameId (OOPIF auto-attach), upload + filePicker yes", async () => {
    const { DEFAULT_BACKEND_CAPABILITIES } = await import("@codex-sidepanel/shared");
    const caps = DEFAULT_BACKEND_CAPABILITIES["playwright-isolated"];
    expect(caps.accessibility).toBe(true);
    expect(caps.iframe).toBe("all");
    expect(caps.upload).toBe(true);
    expect(caps.filePicker).toBe(true); // waitForEvent('filechooser') + setFiles
  });
});
