import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Gateway-spawning suites boot a real startGateway (provider
    // registration, sqlite, locks) — under full-suite parallel load
    // that exceeds the 5s default and cascades into lock/cleanup
    // flakes (chromex-hy3).
    testTimeout: 30_000,
  },
});
