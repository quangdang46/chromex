# ADR: Browser tool MCP endpoint — stdio per provider session

Status: DECIDED (P1-09, provisional pending Claude binding in P3-03)

## Decision

Browser tools reach providers through an MCP server spawned **per
provider session over stdio**. One MCP process per agent session; the
Gateway owns its lifecycle (spawn with the session, drain+restart on
token refresh when the adapter cannot hot-update, kill on session end).

## Alternatives considered

- **HTTP streamable endpoint on a pipe/port** — rejected for P1: needs
  port management, auth on a second channel, and lifecycle racing the
  provider process. Revisit only if a provider lacks stdio MCP support.
- **In-process tool calls (no MCP)** — rejected: providers (Codex
  app-server, Claude Agent SDK) already speak MCP; a private channel
  would duplicate the tool-schema/permission plumbing MCP gives us.

## Consequences

- Tool name map is one-directional and tested:
  `browser.page.click` → `browser_page_click` (dots → underscores).
  The map lives in `packages/bridge/src/browser/` next to the tool
  server; internal names keep dots, MCP names keep underscores.
- Token delivery: prefer MCP server config / headers; never CLI args
  (argv is world-readable in `ps`). If env is forced, redact in
  diagnostics and document the limitation (§9.1).
- Refresh: Gateway-initiated `tool.token.refreshed` on the session
  control channel 2min before expiry (see `tool-refresh.ts`). Adapter
  hot-updates → done; otherwise drain in-flight calls (60s grace) then
  restart the MCP connection — never mid-tool-call.
- Hard blocks (`evaluate`, `cookies`, `localStorage`, binary download)
  are enforced in `BrowserToolServer` before dispatch regardless of
  what the MCP schema advertises.

## Codex per-session registration (P1-09)

`thread/start` and `thread/resume` accept a `config` override object
(app-server protocol schema, codex-cli 0.165). `CodexAgentSession`
maps `config.options.mcpServers` → `config.mcp_servers.<name>` so each
gateway task gets its own `chromex_browser` stdio server with a
per-task `CHROMEX_MCP_SCOPE_FILE` (0600). `SessionManager` calls
`browserMcpSpawn` at session open; the spawn writes the scope file and
returns the descriptor — no shared config.toml entry needed.

Caveat: the nested `mcp_servers` override shape follows codex `-c`
dotted-key semantics; verify against a real app-server that nested
objects (not dotted string keys) are accepted — fallback is emitting
`"mcp_servers.chromex_browser.command"` style keys if needed.

Token refresh needs no MCP restart: `mcp-stdio.js` re-reads the scope
file per `tools/call`, and the refresher rewrites it — the hot-update
path. Drain+restart remains for adapters that cache config.
