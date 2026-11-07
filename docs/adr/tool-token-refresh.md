# ADR: Tool token refresh — adapter hot-update vs drain+restart

Status: DECIDED (implemented P1-09)
Bead: chromex-92l (plan §18.12)

## Decision

**Every current adapter hot-updates for free: the token never enters
provider config — it lives in a per-task scope file that the spawned
stdio MCP shim re-reads on every `tools/call`. Drain+restart is reserved
for future adapters that embed the token themselves; none do today.**

## Evidence

- `packages/bridge/src/browser/tool-refresh.ts` —
  `ToolTokenRefresher` issues a new generation 2min before expiry and
  notifies with `drainDeadlineAt` (old gen + 60s grace, §9.1).
- `packages/bridge/src/gateway/main.ts:285-322` — the notify handler
  does exactly one thing: `updateMcpScopeToken()` rewrites
  `<dataDir>/mcp/<taskId>.json` (0600) with the new token.
- `packages/bridge/src/browser/mcp-stdio.ts:9,33-46` + `mcp-scope.ts` —
  the shim re-reads the scope file per `tools/call`; next call picks up
  the new generation. No restart, no adapter involvement.
- `packages/bridge/src/agents/providers/{codex,claude,acp}/session.ts` —
  all three consume the same spawn descriptor
  (`chromex_browser` stdio + `CHROMEX_MCP_SCOPE_FILE` env). The token is
  NOT in `mcpServers` config for any of them, so no adapter caches it.
- `packages/bridge/test/browser/tool-refresh.test.ts` — pins refresh
  timing, grace window, and untrack/dispose.

## Rationale

- §9.1's open question was "which adapters can hot-update". The
  scope-file design made the answer uniform: hot-update is a property of
  OUR shim, not of Codex/Claude/ACP. The `tool.token.refreshed` notice
  on the session control channel exists for adapters that would cache
  config; today the file rewrite IS the hot-update path and no adapter
  needs the notice.
- Drain+restart remains implemented (`drainDeadlineAt`, 60s grace) as
  the fallback for any future transport where the token is baked into
  adapter config at spawn time (e.g. an HTTP MCP endpoint with auth
  headers — see `docs/adr/mcp-endpoint.md` rejection rationale).
- Never restart mid-tool-call (§9.1) is preserved: with the file-rewrite
  path there is no restart at all.

## Consequences

- Adapter matrix for §18.12: codex app-server — hot-update (stdio shim);
  claude Agent SDK — hot-update (stdio shim); acp — hot-update (stdio
  shim, `mcpServers` param); hypothetical HTTP/custom MCP — drain +
  restart via `drainDeadlineAt`.
- If a provider ever requires the token in config/env rather than the
  scope file, that adapter is classified drain+restart and must honor
  `tool.token.refreshed` or tolerate the 60s grace + reconnect.
- Token delivery rule unchanged: scope file (0600) or MCP config — never
  CLI args; env only carries the file PATH.
