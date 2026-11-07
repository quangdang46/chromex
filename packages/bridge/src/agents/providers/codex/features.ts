/**
 * Codex provider feature RPCs — plan §8.2 / P1-05.
 *
 * Every feature is an explicit dotted method with its OWN Zod schema.
 * There is deliberately NO free-form `provider.feature.call` — unknown
 * methods reject before reaching the app-server. Handlers are thin
 * pass-throughs to the real app-server JSON-RPC methods (same ones
 * codex-plane uses today).
 */

import { z } from "zod";

import type { CodexAppServerClient } from "../../../codex-app-server.js";

export interface FeatureDefinition {
  /** zod schema for the RPC payload */
  schema: z.ZodTypeAny;
  /** app-server method invoked after validation */
  appServerMethod: string;
  /** map validated payload → app-server params */
  toParams: (payload: unknown) => Record<string, unknown>;
}

const threadId = z.string().min(1);

export const CODEX_FEATURES: Record<string, FeatureDefinition> = {
  "provider.feature.codex.compact": {
    schema: z.object({ threadId, waitForCompletion: z.boolean().optional() }),
    appServerMethod: "thread/compact/start",
    toParams: (p) => {
      const v = p as { threadId: string };
      return { threadId: v.threadId };
    },
  },
  "provider.feature.codex.goal.set": {
    schema: z.object({
      threadId,
      objective: z.string().min(1),
      tokenBudget: z.number().int().positive().optional(),
    }),
    appServerMethod: "thread/goal/set",
    toParams: (p) => p as Record<string, unknown>,
  },
  "provider.feature.codex.goal.get": {
    schema: z.object({ threadId }),
    appServerMethod: "thread/goal/get",
    toParams: (p) => p as Record<string, unknown>,
  },
  "provider.feature.codex.goal.clear": {
    schema: z.object({ threadId }),
    appServerMethod: "thread/goal/clear",
    toParams: (p) => p as Record<string, unknown>,
  },
  "provider.feature.codex.account.status": {
    schema: z.object({ refreshToken: z.boolean().optional() }),
    appServerMethod: "account/read",
    toParams: (p) => {
      const v = p as { refreshToken?: boolean };
      return { refreshToken: v.refreshToken ?? false };
    },
  },
  // OAuth/device-code login only — apiKey login is intercepted by the
  // provider (it writes the sidecar secret store, not the app-server).
  "provider.feature.codex.account.login.start": {
    schema: z.object({
      type: z.enum(["chatgpt", "chatgptDeviceCode"]),
    }),
    appServerMethod: "account/login/start",
    toParams: (p) => p as Record<string, unknown>,
  },
  "provider.feature.codex.account.login.cancel": {
    schema: z.object({ loginId: z.string().min(1) }),
    appServerMethod: "account/login/cancel",
    toParams: (p) => p as Record<string, unknown>,
  },
  "provider.feature.codex.account.logout": {
    schema: z.object({}),
    appServerMethod: "account/logout",
    toParams: () => ({}),
  },
  "provider.feature.codex.account.rate_limits": {
    schema: z.object({}),
    appServerMethod: "account/rateLimits/read",
    toParams: () => ({}),
  },
  "provider.feature.codex.mcp.list": {
    schema: z.object({
      detail: z.enum(["full", "toolsAndAuthOnly"]).optional(),
      limit: z.number().int().positive().optional(),
      cursor: z.string().optional(),
    }),
    appServerMethod: "mcpServerStatus/list",
    toParams: (p) => p as Record<string, unknown>,
  },
  "provider.feature.codex.mcp.oauth.login": {
    schema: z.object({ serverName: z.string().min(1) }),
    appServerMethod: "mcpServer/oauth/login",
    toParams: (p) => p as Record<string, unknown>,
  },
  "provider.feature.codex.mcp.tool.call": {
    schema: z.object({
      serverName: z.string().min(1),
      toolName: z.string().min(1),
      arguments: z.record(z.string(), z.unknown()).optional(),
    }),
    appServerMethod: "mcpServer/tool/call",
    toParams: (p) => p as Record<string, unknown>,
  },
  "provider.feature.codex.skills.list": {
    schema: z.object({
      cwd: z.string().optional(),
      forceReload: z.boolean().optional(),
      extraUserRoots: z.array(z.string()).optional(),
    }),
    appServerMethod: "skills/list",
    // app-server expects cwds[] not cwd; forceReload passes through;
    // extraUserRoots ride perCwdExtraUserRoots (sidecar router parity).
    toParams: (p) => {
      const v = p as { cwd?: string; forceReload?: boolean; extraUserRoots?: string[] };
      return {
        ...(v.cwd ? { cwds: [v.cwd] } : {}),
        ...(v.forceReload ? { forceReload: true } : {}),
        ...(v.cwd && v.extraUserRoots?.length
          ? { perCwdExtraUserRoots: [{ cwd: v.cwd, extraUserRoots: v.extraUserRoots }] }
          : {}),
      };
    },
  },
};

export class CodexFeatureError extends Error {
  constructor(
    message: string,
    readonly code: "unknown_feature" | "invalid_payload",
  ) {
    super(message);
    this.name = "CodexFeatureError";
  }
}

/**
 * Invoke a capability-gated feature. Returns the app-server result.
 * Throws CodexFeatureError for unknown methods or schema violations —
 * never forwards unvalidated payloads.
 */
export async function invokeCodexFeature(
  client: CodexAppServerClient,
  method: string,
  payload: unknown,
): Promise<unknown> {
  const def = CODEX_FEATURES[method];
  if (!def) {
    throw new CodexFeatureError(`unknown codex feature: ${method}`, "unknown_feature");
  }
  const parsed = def.schema.safeParse(payload ?? {});
  if (!parsed.success) {
    throw new CodexFeatureError(
      `invalid payload for ${method}: ${parsed.error.issues[0]?.message ?? "schema violation"}`,
      "invalid_payload",
    );
  }
  return client.request(def.appServerMethod, def.toParams(parsed.data));
}
