import { describe, expect, test, vi } from "vitest";

import {
  createDegradedReporter,
  createDegradedRuntimeConfigSnapshot,
  reportDegradedCatalogList,
} from "../src/background/degraded.js";

describe("createDegradedReporter", () => {
  test("reports each key once and prefixes messages as degraded", () => {
    const logger = vi.fn();
    const report = createDegradedReporter(logger);

    report("workspace.harness.read", "harness failed", new Error("sidecar down"));
    report("workspace.harness.read", "harness failed again", new Error("still down"));
    report("diagnostics.log.write", "diagnostic dropped");

    expect(logger).toHaveBeenCalledTimes(2);
    expect(logger).toHaveBeenNthCalledWith(
      1,
      "[degraded] harness failed",
      expect.any(Error),
    );
    expect(logger).toHaveBeenNthCalledWith(2, "[degraded] diagnostic dropped");
  });
});

describe("reportDegradedCatalogList", () => {
  test("keeps previous catalog data and reports the failure", () => {
    const report = vi.fn();
    const previous = [{ id: "app-1" }, { id: "app-2" }];

    const result = reportDegradedCatalogList(previous, "apps.list", new Error("boom"), report);

    expect(result).toEqual(previous);
    expect(result).not.toBe(previous);
    expect(report).toHaveBeenCalledWith(
      "catalog.apps.list",
      "apps.list failed; keeping previously loaded catalog data",
      expect.any(Error),
    );
  });
});

describe("createDegradedRuntimeConfigSnapshot", () => {
  test("marks the snapshot degraded and preserves configured paths", () => {
    const snapshot = createDegradedRuntimeConfigSnapshot({
      workspaceRoot: '  "/Users/me/workspace"  ',
      codexBinPath: " '/opt/codex/bin/codex' ",
    });

    expect(snapshot.degraded).toBe(true);
    expect(snapshot.workspaceRoot).toBe("/Users/me/workspace");
    expect(snapshot.codexBinPath).toBe("/opt/codex/bin/codex");
    expect(snapshot.resolvedCodexBinPath).toBe("/opt/codex/bin/codex");
    expect(snapshot.codexBinSource).toBe("configured");
    expect(snapshot.configuredCodexBinPathInvalid).toBe(false);
  });

  test("reports missing codex binary without configured path", () => {
    const snapshot = createDegradedRuntimeConfigSnapshot({});

    expect(snapshot.degraded).toBe(true);
    expect(snapshot.codexBinPath).toBe("");
    expect(snapshot.codexBinSource).toBe("missing");
  });
});
