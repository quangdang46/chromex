/**
 * Legacy RPC compat layer — plan §10 / P1-07.
 *
 * Every entry rewrites a legacy method+payload into the new Gateway
 * contract, dispatches, then adapts the result back to the legacy
 * response shape. Entries carry `// COMPAT(legacy-rpc)` markers with a
 * removal date; the whole table is deleted when the extension drops
 * dual-path mode.
 *
 * Methods NOT in this table are non-agent domains (image/voice/
 * dictation/translation/diagnostics/local.file/profile/workspace/
 * runtime.config) — they stay on the legacy bridge sidecar during
 * dual-path migration and are NOT served by the Gateway.
 */

import os from "node:os";

import { protocolError as perr } from "@codex-sidepanel/shared";

import { mapMcpServerStatusResponse, mapRateLimits, mapSkills } from "../app-server-mappers.js";

// Canonical list lives in @codex-sidepanel/shared so the extension's
// sidecar router and this reject-path share one source (chromex-rzf).
export { LEGACY_SIDECAR_METHODS } from "@codex-sidepanel/shared";

export interface CompatRewrite {
  method: string;
  payload: unknown;
}

export interface CompatEntry {
  /** legacy method → new method + payload translation */
  toRequest(payload: unknown): CompatRewrite;
  /** new result → legacy response shape (identity when shapes match) */
  fromResult(result: unknown, payload: unknown): unknown;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** deterministic fallback clientMessageId for legacy prompt.send */
function legacyClientMessageId(p: Record<string, unknown>): string {
  if (typeof p.clientRequestId === "string" && p.clientRequestId) return p.clientRequestId;
  const msg = typeof p.message === "string" ? p.message : "";
  let h = 0;
  for (let i = 0; i < msg.length; i++) h = (h * 31 + msg.charCodeAt(i)) | 0;
  return `legacy-${(p.threadId as string) ?? "new"}-${(h >>> 0).toString(36)}`;
}

// COMPAT(legacy-rpc): v3 → remove after 2026-12-31 (gatewayMode default-on)
export const LEGACY_COMPAT: Record<string, CompatEntry> = {
  // ---- agent core ----
  "session.open": {
    toRequest: (payload) => {
      const p = asRecord(payload);
      return {
        method: "task.create",
        payload: {
          // legacy clients omit cwd when no workspace is configured;
          // task.create requires a real path — home dir is the honest default
          cwd: typeof p.cwd === "string" && p.cwd ? p.cwd : os.homedir(),
          ...(p.model ? { model: p.model } : {}),
          ...(p.profileId ? { profileId: p.profileId } : {}),
          ...(p.providerId ? { providerId: p.providerId } : {}),
        },
      };
    },
    fromResult: (r) => ({ threadId: (r as { taskId: string }).taskId }),
  },
  "session.resume": {
    toRequest: (payload) => ({
      method: "task.reopen",
      payload: { taskId: asRecord(payload).threadId },
    }),
    fromResult: (_r, payload) => ({ threadId: asRecord(payload).threadId }),
  },
  "prompt.send": {
    toRequest: (payload) => {
      const p = asRecord(payload);
      const threadId = p.threadId as string | undefined;
      if (!threadId) {
        // no thread → create task first is a two-step the legacy client
        // never needed; reject rather than silently split.
        throw perr("proto.invalid", "prompt.send compat requires threadId (open a task first)");
      }
      const message = typeof p.message === "string" ? p.message : "";
      const goalMetadata =
        p.useGoal === true
          ? {
              useGoal: true,
              ...(typeof p.goalObjective === "string" && p.goalObjective.trim()
                ? { goalObjective: p.goalObjective.trim() }
                : {}),
            }
          : {};
      return {
        method: "task.send",
        payload: {
          taskId: threadId,
          clientMessageId: legacyClientMessageId(p),
          content: [{ type: "text", text: message }],
          ...(p.planMode === true || p.useGoal === true
            ? {
                ctx: {
                  metadata: {
                    ...(p.planMode === true ? { planMode: true } : {}),
                    ...goalMetadata,
                  },
                },
              }
            : {}),
        },
      };
    },
    fromResult: (r, payload) => ({
      threadId: asRecord(payload).threadId,
      turnId: (r as { turnId: string }).turnId,
    }),
  },
  "turn.interrupt": {
    toRequest: (payload) => {
      const p = asRecord(payload);
      return {
        method: "turn.interrupt",
        payload: { taskId: p.threadId, turnId: p.turnId },
      };
    },
    fromResult: (_r, payload) => {
      const p = asRecord(payload);
      return { threadId: p.threadId, turnId: p.turnId };
    },
  },
  "turn.steer": {
    toRequest: (payload) => {
      const p = asRecord(payload);
      const message = typeof p.message === "string" ? p.message : "";
      return {
        method: "task.steer",
        payload: {
          taskId: p.threadId,
          clientMessageId: legacyClientMessageId(p),
          content: [{ type: "text", text: message }],
        },
      };
    },
    fromResult: (r, payload) => {
      const p = asRecord(payload);
      return {
        threadId: p.threadId,
        turnId: (p.expectedTurnId as string) ?? "",
        status: (r as { status?: string }).status ?? "unavailable",
      };
    },
  },
  "plan.user_input.respond": {
    // legacy answers map {qid:{answers:[...]}} → PermissionResponse.answers
    // {qid:[...]}; an empty map is a dismiss → optionId "deny".
    toRequest: (payload) => {
      const p = asRecord(payload);
      const requestId = typeof p.requestId === "string" ? p.requestId : "";
      if (!requestId) {
        throw perr("proto.invalid", "plan.user_input.respond compat requires requestId");
      }
      const answers = asRecord(p.answers);
      const flat: Record<string, string[]> = {};
      for (const [qid, v] of Object.entries(answers)) {
        const list = (v as { answers?: unknown } | null)?.answers;
        if (Array.isArray(list)) {
          flat[qid] = list.filter((x): x is string => typeof x === "string");
        }
      }
      const hasAnswers = Object.values(flat).some((list) => list.length > 0);
      const directOption =
        typeof p.optionId === "string" && p.optionId ? p.optionId : undefined;
      if (!hasAnswers && !directOption) {
        return {
          method: "permission.respond",
          payload: { requestId, optionId: "deny" },
        };
      }
      const firstAnswer = Object.values(flat)
        .flat()
        .find((a) => a.trim().length > 0);
      return {
        method: "permission.respond",
        payload: {
          requestId,
          optionId: directOption ?? firstAnswer ?? "answered",
          ...(hasAnswers ? { answers: flat } : {}),
        },
      };
    },
    fromResult: () => ({ ok: true }),
  },
  "thread.list": {
    toRequest: (payload) => ({
      method: "task.list",
      payload: {
        ...(asRecord(payload).cwd ? {} : {}),
        ...(typeof asRecord(payload).limit === "number" ? { limit: asRecord(payload).limit } : {}),
      },
    }),
    fromResult: (r) => ({
      threads: (r as { tasks: Array<Record<string, unknown>> }).tasks.map((t) => ({
        id: t.taskId,
        title: (t.title as string) ?? "",
        preview: "",
        updatedAt: (t.updatedAt as number) ?? 0,
        status: (t.status as string) ?? "",
        cwd: "",
        source: "gateway",
      })),
    }),
  },
  "thread.read": {
    toRequest: (payload) => ({
      method: "task.snapshot",
      payload: { taskId: asRecord(payload).threadId },
    }),
    fromResult: (r, payload) => {
      const snap = r as {
        task?: { title?: string | null; cwd?: string; updatedAt?: number; status?: string };
        userMessages?: Array<{ text?: string }>;
        assistantMessages?: Array<{ text?: string }>;
      };
      const messages = [
        ...(snap.userMessages ?? []).map((m) => ({ id: "", role: "user" as const, text: m.text ?? "" })),
        ...(snap.assistantMessages ?? []).map((m) => ({ id: "", role: "assistant" as const, text: m.text ?? "" })),
      ];
      return {
        id: asRecord(payload).threadId,
        title: snap.task?.title ?? "",
        preview: messages.at(-1)?.text ?? "",
        updatedAt: snap.task?.updatedAt ?? 0,
        status: snap.task?.status ?? "",
        cwd: snap.task?.cwd ?? "",
        messages,
      };
    },
  },
  "thread.turns.list": {
    toRequest: (payload) => ({
      method: "task.snapshot",
      payload: { taskId: asRecord(payload).threadId },
    }),
    fromResult: (r) => ({
      turns: (r as { turns?: Array<Record<string, unknown>> }).turns?.map((t) => ({
        id: t.turnId,
        status: t.status,
        startedAt: t.startedAt ?? null,
        completedAt: t.endedAt ?? null,
        durationMs: null,
      })) ?? [],
    }),
  },
  "thread.compact.start": {
    toRequest: (payload) => ({
      method: "provider.feature.codex.compact",
      payload: asRecord(payload),
    }),
    fromResult: (r) => r,
  },
  "model.list": {
    toRequest: (payload) => ({
      method: "provider.catalog",
      payload: { providerId: asRecord(payload).providerId ?? "codex" },
    }),
    fromResult: (r) => {
      const catalogs = (r as { catalogs?: Array<{ models?: Array<Record<string, unknown>> }> }).catalogs ?? [];
      const models = catalogs[0]?.models ?? [];
      return models.map((m) => {
        const meta = (m.metadata ?? {}) as Record<string, unknown>;
        const efforts = Array.isArray(meta.reasoningEfforts)
          ? meta.reasoningEfforts.filter((e): e is string => typeof e === "string")
          : [];
        return {
          id: String(m.id),
          label: (m.label as string) ?? String(m.id),
          description: (m.description as string) ?? "",
          isDefault: meta.isDefault === true,
          supportsImages: meta.supportsImages === true,
          reasoningEfforts: efforts,
          ...(typeof meta.defaultReasoningEffort === "string"
            ? { defaultReasoningEffort: meta.defaultReasoningEffort }
            : {}),
        };
      });
    },
  },
  // ---- provider features (passthrough to schema-validated feature RPCs) ----
  // account/read returns {account, requiresOpenaiAuth}; the sidecar
  // contract is AccountStatus — derive authMode/codexAuthenticated here
  // (mirrors AppServerCodexPlane.accountStatus; openAiApiKeyConfigured
  // arrives pre-enriched by the provider's secret store).
  "account.status": {
    toRequest: (p) => ({ method: "provider.feature.codex.account.status", payload: p }),
    fromResult: (r) => {
      const rec = asRecord(r);
      const raw = rec.account;
      const account = raw && typeof raw === "object" ? asRecord(raw) : null;
      const type = account?.type;
      const authenticated = Boolean(account) || rec.requiresOpenaiAuth === false;
      const planType =
        type === "chatgpt" && typeof account?.planType === "string" && account.planType.trim()
          ? account.planType.trim().toLowerCase()
          : null;
      return {
        authMode: type === "chatgpt" ? "chatgpt" : type === "apiKey" ? "apikey" : null,
        codexAuthenticated: authenticated,
        multimodalAvailable: authenticated,
        openAiApiKeyConfigured: rec.openAiApiKeyConfigured === true,
        email:
          typeof account?.email === "string" && account.email.trim() ? account.email.trim() : null,
        planType,
      };
    },
  },
  // login.start returns the app-server result verbatim ({authUrl,...} for
  // OAuth, {stored:true} for apiKey — the provider intercepts apiKey).
  "account.login.start": {
    toRequest: (p) => ({ method: "provider.feature.codex.account.login.start", payload: p }),
    fromResult: (r) => r,
  },
  // legacy contract returns {} for both cancel and logout.
  "account.login.cancel": {
    toRequest: (p) => ({ method: "provider.feature.codex.account.login.cancel", payload: p }),
    fromResult: () => ({}),
  },
  "account.logout": {
    toRequest: () => ({ method: "provider.feature.codex.account.logout", payload: {} }),
    fromResult: () => ({}),
  },
  // account/rateLimits/read returns {rateLimits, rateLimitsByLimitId};
  // the sidecar contract is the mapped CodexRateLimits shape.
  "account.rate_limits.read": {
    toRequest: (p) => ({ method: "provider.feature.codex.account.rate_limits", payload: p }),
    fromResult: (r) => mapRateLimits(r as never),
  },
  "goal.set": { toRequest: (p) => ({ method: "provider.feature.codex.goal.set", payload: p }), fromResult: (r) => r },
  "goal.get": { toRequest: (p) => ({ method: "provider.feature.codex.goal.get", payload: p }), fromResult: (r) => r },
  "goal.clear": { toRequest: (p) => ({ method: "provider.feature.codex.goal.clear", payload: p }), fromResult: (r) => r },
  // skills/list returns {data:[...]}; sidecar contract is a flat array.
  "skills.list": {
    toRequest: (p) => ({ method: "provider.feature.codex.skills.list", payload: p }),
    fromResult: (r) => mapSkills(((r as { data?: unknown[] }).data ?? []) as never),
  },
  // mcpServerStatus/list returns {data,nextCursor}; the sidecar contract is a
  // flat CodexMcpServerOption[] — map the first page here.
  "mcp.servers.list": {
    toRequest: (p) => ({ method: "provider.feature.codex.mcp.list", payload: p }),
    fromResult: (r) => mapMcpServerStatusResponse(r as never).servers,
  },
  "mcp.tool.call": { toRequest: (p) => ({ method: "provider.feature.codex.mcp.tool.call", payload: p }), fromResult: (r) => r },
  "mcp.oauth.login.start": { toRequest: (p) => ({ method: "provider.feature.codex.mcp.oauth.login", payload: p }), fromResult: (r) => r },
  // ---- runtime surfaces ----
  "runtime.playwright.status": {
    toRequest: () => ({ method: "browser.backend.status", payload: {} }),
    fromResult: (r) => (r as { playwrightIsolated?: unknown }).playwrightIsolated ?? r,
  },
  "runtime.playwright.install": {
    toRequest: () => ({ method: "browser.backend.install", payload: { backend: "playwright-isolated" } }),
    fromResult: (r) => (r as { playwrightIsolated?: unknown }).playwrightIsolated ?? r,
  },
};


