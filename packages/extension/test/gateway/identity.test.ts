import { afterEach, describe, expect, test, vi } from "vitest";

import { loadOrCreateIdentity } from "../../src/background/gateway/identity.js";

function memStorage() {
  const m = new Map<string, unknown>();
  return {
    get: async (k: string | string[]) => {
      const keys = Array.isArray(k) ? k : [k];
      const out: Record<string, unknown> = {};
      for (const key of keys) if (m.has(key)) out[key] = m.get(key);
      return out;
    },
    set: async (obj: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(obj)) m.set(k, v);
    },
    _map: m,
  };
}

describe("loadOrCreateIdentity (P1-08)", () => {
  test("creates prof_/cli_ ids once and reuses them (SW restart)", async () => {
    const storage = memStorage();
    const a = await loadOrCreateIdentity(storage as never);
    expect(a.profileId).toMatch(/^prof_[0-9a-f]{32}$/);
    expect(a.clientId).toMatch(/^cli_[0-9a-f]{32}$/);
    // "restart": fresh call against same storage returns identical ids
    const b = await loadOrCreateIdentity(storage as never);
    expect(b).toEqual(a);
  });

  test("storage reset (uninstall/clear) produces fresh ids", async () => {
    const storage = memStorage();
    const a = await loadOrCreateIdentity(storage as never);
    storage._map.clear();
    const b = await loadOrCreateIdentity(storage as never);
    expect(b.profileId).not.toBe(a.profileId);
    expect(b.clientId).not.toBe(a.clientId);
  });
});
