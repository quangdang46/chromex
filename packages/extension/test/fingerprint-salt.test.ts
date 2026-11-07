import { afterEach, describe, expect, test, vi } from "vitest";

import { FINGERPRINT_SALT_STORAGE_KEY } from "@codex-sidepanel/shared";

import {
  getFingerprintContext,
  resetFingerprintContextCache,
} from "../src/background/fingerprint-salt.js";

function stubStorage(initial: Record<string, unknown> = {}) {
  const m = new Map<string, unknown>(Object.entries(initial));
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
        setAccessLevel: vi.fn(async () => {}),
      },
    },
  });
  return m;
}

describe("fingerprint salt (§6.2)", () => {
  afterEach(() => {
    resetFingerprintContextCache();
    vi.unstubAllGlobals();
  });

  test("generates salt once, persists, stable across calls", async () => {
    const store = stubStorage();
    const a = await getFingerprintContext();
    const b = await getFingerprintContext();
    expect(a.salt).toBe(b.salt);
    expect(a.epoch).toBe(1);
    const stored = store.get(FINGERPRINT_SALT_STORAGE_KEY) as { salt: string; epoch: number };
    expect(stored.salt).toBe(a.salt);
    expect(stored.epoch).toBe(1);
  });

  test("existing salt+epoch preserved (no silent rotation)", async () => {
    stubStorage({
      [FINGERPRINT_SALT_STORAGE_KEY]: { salt: "existing-salt-value-0123456789abcdef", epoch: 7 },
    });
    const ctx = await getFingerprintContext();
    expect(ctx.salt).toBe("existing-salt-value-0123456789abcdef");
    expect(ctx.epoch).toBe(7);
  });

  test("corrupt/missing salt regenerates at epoch 1", async () => {
    stubStorage({ [FINGERPRINT_SALT_STORAGE_KEY]: { salt: "short", epoch: 3 } });
    const ctx = await getFingerprintContext();
    expect(ctx.salt.length).toBeGreaterThanOrEqual(32);
    expect(ctx.epoch).toBe(1);
  });

  test("setAccessLevel TRUSTED_CONTEXTS attempted", async () => {
    stubStorage();
    await getFingerprintContext();
    const local = (chrome.storage.local as unknown as { setAccessLevel: ReturnType<typeof vi.fn> });
    expect(local.setAccessLevel).toHaveBeenCalledWith({ accessLevel: "TRUSTED_CONTEXTS" });
  });
});
