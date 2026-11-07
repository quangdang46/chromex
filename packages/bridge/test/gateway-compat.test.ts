/**
 * LEGACY_COMPAT unit tests — focused coverage for the ask-user rewrite
 * (plan.user_input.respond → permission.respond with per-question
 * answers). Other entries are exercised through gateway-rpc tests.
 */

import { describe, expect, test } from "vitest";

import { LEGACY_COMPAT } from "../src/gateway/compat.js";

const entry = LEGACY_COMPAT["plan.user_input.respond"]!;

describe("LEGACY_COMPAT plan.user_input.respond", () => {
  test("forwards per-question answers verbatim", () => {
    const r = entry.toRequest({
      requestId: "r1",
      answers: {
        q1: { answers: ["a1", "a2"] },
        q2: { answers: [] },
      },
    });
    expect(r).toEqual({
      method: "permission.respond",
      payload: {
        requestId: "r1",
        optionId: "a1",
        answers: { q1: ["a1", "a2"], q2: [] },
      },
    });
  });

  test("all-empty answers map → dismiss as deny", () => {
    const r = entry.toRequest({ requestId: "r1", answers: { q1: { answers: [] } } });
    expect(r).toEqual({
      method: "permission.respond",
      payload: { requestId: "r1", optionId: "deny" },
    });
  });

  test("explicit optionId is preserved when no answers", () => {
    const r = entry.toRequest({ requestId: "r1", optionId: "allow_once" });
    expect(r).toEqual({
      method: "permission.respond",
      payload: { requestId: "r1", optionId: "allow_once" },
    });
  });

  test("missing requestId → proto.invalid", () => {
    expect(() => entry.toRequest({ answers: { q: { answers: ["x"] } } })).toThrow();
  });
});
