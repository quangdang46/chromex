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
 * workspace/runtime.config) return `proto.unsupported` from the
 * Gateway — in full dual-path a second legacy bridge channel would
 * serve them; until then gatewayMode is for agent flows only.
 */

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
]);

export function isGatewayServed(method: string): boolean {
  return (
    GATEWAY_SERVED_METHODS.has(method) ||
    method.startsWith("provider.feature.")
  );
}
