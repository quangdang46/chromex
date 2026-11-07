import { describe, expect, test } from "vitest";

import { pressModifierInit } from "../src/content/actions.js";

/**
 * chromex-cly: press modifier normalization is pure — the DOM dispatch
 * itself needs a real page and is covered by the tool-host mapping tests.
 */
describe("pressModifierInit", () => {
  test("maps known modifiers case-insensitively, drops unknown", () => {
    expect(pressModifierInit(["Control", "SHIFT", "bogus", "Meta"])).toEqual({
      ctrlKey: true,
      shiftKey: true,
      metaKey: true,
    });
  });

  test("empty/undefined modifiers → empty init", () => {
    expect(pressModifierInit(undefined)).toEqual({});
    expect(pressModifierInit([])).toEqual({});
  });
});
