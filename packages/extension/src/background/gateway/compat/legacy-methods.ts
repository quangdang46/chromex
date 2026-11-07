/**
 * Legacy method classification for dual-path routing — plan §10/§11.
 *
 * In gatewayMode the extension sends EVERY request as an Envelope to
 * the native host → Gateway. The Gateway's own compat layer (bridge
 * `gateway/compat.ts`) rewrites legacy agent methods to the new
 * contract and returns legacy-shaped results, so the extension does
 * NOT translate payloads — it only decides which transport understands
 * the method.
 *
 * Agent-domain methods are served by the Gateway. Sidecar domains
 * (image/voice/dictation/translation/diagnostics/local.file/profile/
 * workspace/runtime.config) are NOT served by the Gateway — they are
 * routed to the legacy bridge sidecar channel on the same native host
 * (chromex-rzf). SIDECAR_METHODS below picks the transport; the
 * extension never translates payloads.
 */

import { LEGACY_SIDECAR_METHODS } from "@codex-sidepanel/shared";

export const GATEWAY_SERVED_METHODS = new Set([
  // new contract
  "hello",
  "task.create",
  "task.get",
  "task.list",
  "task.send",
  "task.cancel",
  "task.pause",
  "task.resume",
  "task.reopen",
  "task.setBackend",
  "task.steer",
  "task.sync",
  "task.snapshot",
  "task.snapshot.chunk",
  "task.interrupt",
  "turn.interrupt",
  "turn.steer",
  "gateway.sync",
  "permission.respond",
  "provider.catalog",
  "provider.feature.codex.compact",
  "provider.feature.codex.goal.set",
  "provider.feature.codex.goal.get",
  "provider.feature.codex.goal.clear",
  "provider.feature.codex.account.status",
  "provider.feature.codex.mcp.list",
  "provider.feature.codex.mcp.oauth.login",
  "provider.feature.codex.mcp.tool.call",
  "provider.feature.codex.skills.list",
  "config.read",
  "config.update",
  "browser.backend.status",
  "browser.backend.install",
  // legacy agent methods (Gateway compat rewrites these)
  "session.open",
  "session.resume",
  "prompt.send",
  "thread.list",
  "thread.read",
  "thread.turns.list",
  "thread.compact.start",
  "model.list",
  "account.status",
  "account.rate_limits.read",
  "account.login.start",
  "account.login.cancel",
  "account.logout",
  "goal.set",
  "goal.get",
  "goal.clear",
  "plan.user_input.respond",
  "skills.list",
  "mcp.servers.list",
  "mcp.tool.call",
  "mcp.oauth.login.start",
  "runtime.playwright.status",
  "runtime.playwright.install",
  // planning RPCs run natively on the codex provider (chromex-pwu)
  "route.plan",
  "browser.action.plan",
  // account login/logout via provider.feature.codex.account.* (chromex-pnk)
  "account.login.start",
  "account.login.cancel",
  "account.logout",
]);

export function isGatewayServed(method: string): boolean {
  return (
    GATEWAY_SERVED_METHODS.has(method) ||
    method.startsWith("provider.feature.")
  );
}

/**
 * Methods routed to the legacy bridge sidecar while gatewayMode is on.
 * Exactly the shared LEGACY_SIDECAR_METHODS set — the Gateway's own
 * reject-path (bridge gateway/main.ts) keys off the same list, so the
 * two transports can never disagree about who owns a method.
 * route.plan/browser.action.plan are NOT here: the Gateway serves
 * them natively on the codex provider (chromex-pwu).
 */
export const SIDECAR_METHODS: ReadonlySet<string> = LEGACY_SIDECAR_METHODS;

export function isSidecarMethod(method: string): boolean {
  return SIDECAR_METHODS.has(method);
}
