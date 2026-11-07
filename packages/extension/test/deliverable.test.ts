import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

import {
  parseUnifiedDiffPaths,
  summarizeTurnDeliverable,
} from "../src/sidepanel/deliverable.js";
import type { ConversationMessageTraceItem } from "../src/types.js";

function readNormalizedSource(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8").replace(/\r\n/g, "\n");
}

const sidepanelSource = readNormalizedSource("src/sidepanel/index.ts");
const deliverableSource = readNormalizedSource("src/sidepanel/deliverable.ts");
const i18nSource = readNormalizedSource("src/sidepanel/i18n.ts");
const stylesSource = readNormalizedSource("public/sidepanel.css");

function trace(
  kind: ConversationMessageTraceItem["kind"],
  overrides: Partial<ConversationMessageTraceItem> = {},
): ConversationMessageTraceItem {
  return {
    id: overrides.id ?? `${kind}-${Math.random().toString(36).slice(2)}`,
    kind,
    title: overrides.title ?? "",
    detail: overrides.detail ?? "",
    status: overrides.status ?? "completed",
    timestampMs: overrides.timestampMs ?? 1,
    ...overrides,
  };
}

describe("turn deliverable summary", () => {
  test("returns null for reasoning-only or empty traces", () => {
    expect(summarizeTurnDeliverable(undefined)).toBeNull();
    expect(summarizeTurnDeliverable([])).toBeNull();
    expect(
      summarizeTurnDeliverable([
        trace("reasoning", { title: "Plan", detail: "step", status: "completed" }),
        trace("response", { title: "Final answer ready", status: "completed" }),
      ]),
    ).toBeNull();
  });

  test("collects files, commands with exit codes, and browser actions from rich trace items", () => {
    const result = summarizeTurnDeliverable([
      trace("file", {
        id: "t1",
        tool: "Edit",
        title: "File changes complete",
        detail: "",
        input: JSON.stringify({ file_path: "/repo/src/app.ts" }),
        status: "completed",
      }),
      trace("command", {
        id: "t2",
        tool: "commandExecution",
        title: "Command complete",
        detail: "",
        input: JSON.stringify({ command: "npm test" }),
        output: JSON.stringify({ aggregatedOutput: "ok", exitCode: 0 }),
        status: "completed",
      }),
      trace("browser", {
        id: "t3",
        tool: "browser.click",
        title: "Browser action complete",
        detail: "#submit",
        status: "completed",
      }),
      trace("tool", {
        id: "t4",
        tool: "Read",
        title: "File exploration complete",
        detail: "/repo/src/app.ts",
        status: "completed",
      }),
    ]);

    expect(result).not.toBeNull();
    expect(result?.files).toEqual([{ path: "/repo/src/app.ts", status: "completed" }]);
    expect(result?.commands).toEqual([{ command: "npm test", status: "completed", exitCode: 0 }]);
    expect(result?.browserActions).toEqual([
      { tool: "browser.click", detail: "#submit", status: "completed" },
    ]);
    expect(result?.otherStepCount).toBe(1);
    expect(result?.failedCount).toBe(0);
  });

  test("does not count file reads as changed files", () => {
    const result = summarizeTurnDeliverable([
      trace("file", {
        tool: "Read",
        title: "File exploration complete",
        detail: "/repo/src/app.ts",
        status: "completed",
      }),
      trace("file", {
        tool: "Grep",
        title: "File exploration complete",
        detail: "pattern",
        status: "completed",
      }),
    ]);

    expect(result?.files).toEqual([]);
    expect(result?.otherStepCount).toBe(2);
  });

  test("marks failed items and reports the failed count", () => {
    const result = summarizeTurnDeliverable([
      trace("command", {
        id: "t1",
        tool: "Bash",
        title: "Command complete",
        detail: "npm run build",
        status: "failed",
      }),
    ]);

    expect(result?.commands[0]?.status).toBe("failed");
    expect(result?.failedCount).toBe(1);
  });

  test("falls back to trace detail for legacy command rows without tool payloads", () => {
    const result = summarizeTurnDeliverable([
      trace("command", {
        title: "Command complete",
        detail: "git status",
        status: "completed",
      }),
    ]);

    expect(result?.commands).toEqual([{ command: "git status", status: "completed" }]);
  });

  test("merges diff-file extras and approval records", () => {
    const result = summarizeTurnDeliverable(
      [
        trace("file", {
          id: "turn-diff",
          kind: "file",
          title: "File changes",
          detail: "diff --git a/src/a.ts b/src/a.ts",
          status: "completed",
        }),
      ],
      {
        diffFiles: ["src/a.ts", "src/b.ts"],
        approvals: [{ question: "Allow browser action?", answer: "allow_once" }],
      },
    );

    expect(result?.files.map((f) => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result?.approvals).toEqual([{ question: "Allow browser action?", answer: "allow_once" }]);
  });

  test("skips the synthetic turn-diff row when extracting edit paths", () => {
    const result = summarizeTurnDeliverable([
      trace("file", {
        id: "turn-diff",
        title: "File changes",
        detail: "src/a.ts",
        status: "completed",
      }),
    ]);

    expect(result?.files).toEqual([]);
  });
});

describe("parseUnifiedDiffPaths", () => {
  test("extracts paths from git diff headers", () => {
    const diff = [
      "diff --git a/src/app.ts b/src/app.ts",
      "index 111..222 100644",
      "--- a/src/app.ts",
      "+++ b/src/app.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/docs/guide.md b/docs/guide.md",
      "--- a/docs/guide.md",
      "+++ b/docs/guide.md",
      "new file",
    ].join("\n");

    expect(parseUnifiedDiffPaths(diff).sort()).toEqual(["docs/guide.md", "src/app.ts"]);
  });

  test("returns empty for non-diff text", () => {
    expect(parseUnifiedDiffPaths("just some output")).toEqual([]);
  });
});

describe("deliverable rendering wiring", () => {
  test("sidepanel renders a deliverable card inside completed turn-trace messages", () => {
    expect(sidepanelSource).toContain("renderTurnDeliverable");
    expect(sidepanelSource).toContain("deliverable-card");
    expect(sidepanelSource).toContain("summarizeTurnDeliverable");
    expect(sidepanelSource).toContain("recordDeliverableDiffFiles");
    expect(sidepanelSource).toContain("recordDeliverableApprovalAnswer");
    expect(sidepanelSource).toContain("recordPendingDeliverableApproval");
    expect(deliverableSource).toContain("parseUnifiedDiffPaths");
  });

  test("deliverable strings exist for en and ko with english fallback registered", () => {
    expect(i18nSource).toContain('title: "Deliverable"');
    expect(i18nSource).toContain('title: "작업 결과"');
    expect(i18nSource).toContain('"deliverable.filesChanged"');
    expect(i18nSource).toContain('"deliverable.approvals"');
  });

  test("deliverable styles are defined", () => {
    expect(stylesSource).toContain(".deliverable-card");
    expect(stylesSource).toContain(".deliverable-list");
    expect(stylesSource).toContain(".deliverable-exit");
  });
});
