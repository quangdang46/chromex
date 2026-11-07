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

describe("LEGACY_COMPAT prompt.send planMode", () => {
  const promptEntry = LEGACY_COMPAT["prompt.send"]!;

  test("planMode:true → task.send ctx.metadata.planMode", () => {
    const r = promptEntry.toRequest({
      threadId: "t1",
      message: "hi",
      planMode: true,
    });
    expect(r.method).toBe("task.send");
    expect((r.payload as { ctx?: { metadata?: { planMode?: boolean } } }).ctx?.metadata?.planMode).toBe(true);
  });

  test("planMode absent/false → no ctx", () => {
    const r = promptEntry.toRequest({ threadId: "t1", message: "hi" });
    expect((r.payload as Record<string, unknown>).ctx).toBeUndefined();
    const r2 = promptEntry.toRequest({ threadId: "t1", message: "hi", planMode: false });
    expect((r2.payload as Record<string, unknown>).ctx).toBeUndefined();
  });
});

describe("LEGACY_COMPAT account.* (chromex-pnk)", () => {
  test("account.status maps account/read result to AccountStatus", () => {
    const e = LEGACY_COMPAT["account.status"]!;
    expect(e.toRequest({ refreshToken: true })).toEqual({
      method: "provider.feature.codex.account.status",
      payload: { refreshToken: true },
    });
    const out = e.fromResult(
      {
        account: { type: "chatgpt", email: "u@x.com", planType: "Plus" },
        requiresOpenaiAuth: true,
        openAiApiKeyConfigured: true,
      },
      {},
    ) as Record<string, unknown>;
    expect(out).toEqual({
      authMode: "chatgpt",
      codexAuthenticated: true,
      multimodalAvailable: true,
      openAiApiKeyConfigured: true,
      email: "u@x.com",
      planType: "plus",
    });
  });

  test("account.status unauthenticated + requiresOpenaiAuth=false", () => {
    const e = LEGACY_COMPAT["account.status"]!;
    const out = e.fromResult({ account: null, requiresOpenaiAuth: false }, {}) as Record<
      string,
      unknown
    >;
    expect(out.codexAuthenticated).toBe(true);
    expect(out.authMode).toBeNull();
  });

  test("account.status apiKey account maps authMode apikey", () => {
    const e = LEGACY_COMPAT["account.status"]!;
    const out = e.fromResult({ account: { type: "apiKey" } }, {}) as Record<string, unknown>;
    expect(out.authMode).toBe("apikey");
    expect(out.codexAuthenticated).toBe(true);
  });

  test("account.login.start/cancel/logout rewrite to codex account features", () => {
    expect(LEGACY_COMPAT["account.login.start"]!.toRequest({ type: "chatgpt" })).toEqual({
      method: "provider.feature.codex.account.login.start",
      payload: { type: "chatgpt" },
    });
    expect(
      LEGACY_COMPAT["account.login.cancel"]!.toRequest({ loginId: "l1" }),
    ).toEqual({
      method: "provider.feature.codex.account.login.cancel",
      payload: { loginId: "l1" },
    });
    expect(LEGACY_COMPAT["account.logout"]!.toRequest({})).toEqual({
      method: "provider.feature.codex.account.logout",
      payload: {},
    });
    // legacy contract: cancel/logout resolve {}
    expect(LEGACY_COMPAT["account.login.cancel"]!.fromResult({ anything: 1 }, {})).toEqual({});
    expect(LEGACY_COMPAT["account.logout"]!.fromResult(null, {})).toEqual({});
  });
});
