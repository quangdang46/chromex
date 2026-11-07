# ADR: MCP tool naming — snake_case external, dotted internal

Status: DECIDED (implemented P1-09; transport decision in
`docs/adr/mcp-endpoint.md`)
Bead: chromex-ado (plan §18.4)

## Decision

- **Transport: stdio MCP server per provider session** — already decided
  in `docs/adr/mcp-endpoint.md`; HTTP streamable stays rejected unless a
  provider lacks stdio MCP support.
- **Naming: one-directional map.** Internal tool names keep dots
  (`browser.page.click`); the MCP surface exposes snake_case
  (`browser_page_click`). Internal names are the contract of record —
  `allowedTools` in the tool token, `browser.tool.call` RPC, and policy
  checks all use the dotted form.

## Evidence

- `packages/bridge/src/browser/mcp-server.ts:27-33` — `mcpToolName()` /
  `internalToolName()` implement dots→underscores both ways for lookup,
  but only the mapped (underscore) name is advertised in `tools/list`.
- `packages/bridge/test/browser/mcp-server.test.ts:56-101` — tests pin
  the map (`browser.page.click` → `browser_page_click`) and reject
  unmapped names (`browser_evaluate` → null).
- `packages/shared/src/browser/tool.ts` `BROWSER_TOOL_NAMES` — dotted
  internal enum is what token scope and the tool server validate against.

## Rationale

- MCP clients and provider tool-call UIs render tool names as identifiers;
  snake_case survives JSON-schema/tool-name constraints uniformly across
  Codex, Claude, and ACP agents. Dotted names risk being split on `.` by
  client-side routers.
- The map is one-directional and total: every internal name has exactly
  one MCP name; unknown MCP names are rejected before dispatch, so there
  is no ambiguity surface.
- Keeping dots internally preserves the §4.x namespacing convention used
  by the rest of the protocol (`browser.tool.call`, `task.send`, …).

## Consequences

- Never advertise a dotted name over MCP; never accept an internal name
  that did not come through `internalToolName`.
- Adding a tool = add to `BROWSER_TOOL_NAMES` (dotted) + map entry is
  automatic; the test file is the place to pin any exception.
- If a future provider requires dotted MCP names, that is a per-adapter
  presentation concern — the internal contract does not change.
