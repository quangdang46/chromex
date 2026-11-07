import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, test } from "vitest";

const refsSource = readFileSync(resolve(process.cwd(), "src/content/refs.ts"), "utf8");
const actionsSource = readFileSync(resolve(process.cwd(), "src/content/actions.ts"), "utf8");

// chromex-ykj: element targeting must detect ambiguity instead of
// silently picking the first match. The content script reports
// browser.ambiguous_target in the step result; tool-host forwards the
// code to the tool caller (locked by gateway/tool-host.test.ts).
describe("DOM action target ambiguity (chromex-ykj)", () => {
  test("refs.ts resolves targets with an ambiguity verdict", () => {
    expect(refsSource).toContain("resolveDomActionTargetDetailed");
    expect(refsSource).toContain('"ambiguous"');
    // selector and label paths must count ALL matches, not first-match
    expect(refsSource).toContain("querySelectorAll(step.selector)");
    expect(refsSource).toContain("collectInteractiveElements().filter");
  });

  test("actions.ts surfaces browser.ambiguous_target instead of acting", () => {
    expect(actionsSource).toContain("browser.ambiguous_target");
    expect(actionsSource).toContain("resolveDomActionTargetDetailed");
  });
});
