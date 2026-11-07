import { describe, expect, test } from "vitest";
import { invokeCodexFeature, CodexFeatureError, CODEX_FEATURES } from "../src/agents/providers/codex/features.js";

class FakeClient {
  calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  async request(method: string, params: Record<string, unknown> = {}) {
    this.calls.push({ method, params });
    return { ok: true };
  }
}

describe("codex feature RPCs", () => {
  test("registered features cover plan §8.2 namespaces", () => {
    const names = Object.keys(CODEX_FEATURES);
    for (const prefix of [
      "provider.feature.codex.compact",
      "provider.feature.codex.goal.",
      "provider.feature.codex.account.status",
      "provider.feature.codex.mcp.",
      "provider.feature.codex.skills.",
    ]) {
      expect(names.some((n) => n.startsWith(prefix)), prefix).toBe(true);
    }
  });

  test("each feature has own zod schema; unknown method rejects", async () => {
    const client = new FakeClient();
    await expect(
      invokeCodexFeature(client as never, "provider.feature.codex.unknown", {}),
    ).rejects.toMatchObject({ code: "unknown_feature" });
    await expect(
      invokeCodexFeature(client as never, "provider.feature.call", { method: "x" }),
    ).rejects.toBeInstanceOf(CodexFeatureError);
    expect(client.calls).toHaveLength(0);
  });

  test("schema validation blocks bad payloads before app-server", async () => {
    const client = new FakeClient();
    await expect(
      invokeCodexFeature(client as never, "provider.feature.codex.compact", { threadId: "" }),
    ).rejects.toMatchObject({ code: "invalid_payload" });
    expect(client.calls).toHaveLength(0);
  });

  test("valid call forwards to correct app-server method", async () => {
    const client = new FakeClient();
    const res = await invokeCodexFeature(client as never, "provider.feature.codex.account.status", {});
    expect(res).toEqual({ ok: true });
    expect(client.calls[0]).toEqual({ method: "account/read", params: { refreshToken: false } });
  });

  test("goal.set forwards objective", async () => {
    const client = new FakeClient();
    await invokeCodexFeature(client as never, "provider.feature.codex.goal.set", {
      threadId: "th-1",
      objective: "ship it",
    });
    expect(client.calls[0]!.method).toBe("thread/goal/set");
    expect(client.calls[0]!.params).toMatchObject({ threadId: "th-1", objective: "ship it" });
  });

  test("skills.list maps extraUserRoots to perCwdExtraUserRoots", async () => {
    const client = new FakeClient();
    await invokeCodexFeature(client as never, "provider.feature.codex.skills.list", {
      cwd: "/repo",
      forceReload: true,
      extraUserRoots: ["/u/skills/a", "/u/skills/b"],
    });
    expect(client.calls[0]).toEqual({
      method: "skills/list",
      params: {
        cwds: ["/repo"],
        forceReload: true,
        perCwdExtraUserRoots: [{ cwd: "/repo", extraUserRoots: ["/u/skills/a", "/u/skills/b"] }],
      },
    });
  });

  test("skills.list without cwd drops extraUserRoots (app-server requires cwd pairing)", async () => {
    const client = new FakeClient();
    await invokeCodexFeature(client as never, "provider.feature.codex.skills.list", {
      extraUserRoots: ["/u/skills/a"],
    });
    expect(client.calls[0]!.params).not.toHaveProperty("perCwdExtraUserRoots");
  });

  test("account login/logout features forward to app-server account methods", async () => {
    const client = new FakeClient();
    await invokeCodexFeature(client as never, "provider.feature.codex.account.login.start", {
      type: "chatgpt",
    });
    expect(client.calls[0]).toEqual({
      method: "account/login/start",
      params: { type: "chatgpt" },
    });
    await invokeCodexFeature(client as never, "provider.feature.codex.account.login.cancel", {
      loginId: "login-1",
    });
    expect(client.calls[1]).toEqual({
      method: "account/login/cancel",
      params: { loginId: "login-1" },
    });
    await invokeCodexFeature(client as never, "provider.feature.codex.account.logout", {});
    expect(client.calls[2]).toEqual({ method: "account/logout", params: {} });
    await invokeCodexFeature(client as never, "provider.feature.codex.account.rate_limits", {});
    expect(client.calls[3]).toEqual({ method: "account/rateLimits/read", params: {} });
  });

  test("account.login.start rejects apiKey type at the feature boundary", async () => {
    const client = new FakeClient();
    // apiKey login is a provider-level secret-store write, never an
    // app-server call — the feature schema must not accept it.
    await expect(
      invokeCodexFeature(client as never, "provider.feature.codex.account.login.start", {
        type: "apiKey",
        apiKey: "sk-test",
      }),
    ).rejects.toMatchObject({ code: "invalid_payload" });
    expect(client.calls).toHaveLength(0);
  });
});
