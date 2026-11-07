# ADR: Claude provider mechanism — DECIDED (spike-B3 / chromex-sff)

Status: DECIDED — Option A: **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`).

## Options evaluated (real install: claude CLI 2.1.319, SDK 0.3.246)

| Option | Verdict |
|---|---|
| A. Agent SDK `query()` | **CHOSEN** — token streaming, permission hooks, session resume, MCP tools, existing auth reused |
| B. CLI `claude -p` structured output | Viable fallback; weaker streaming/permission control; kept as escape hatch |
| C. ACP mode | Rejected — Codex already covers ACP path later; Claude SDK is richer |

## Evidence (scripts/spike/b3-claude-sdk.mjs — 9/9 checks, real API)

- `system/init` + `assistant` + `result` messages, `result.subtype==="success"`, `session_id` + `usage` present
- Token-level deltas require **`includePartialMessages: true`** — `stream_event`/`content_block_delta` otherwise absent (spike caught this)
- `resume: session_id` continues the same session; result success
- Interrupt: `abortController.abort()` → "Claude Code process aborted by user", terminal result propagates
- `canUseTool` hook fires for tool calls; `tool_use`/`tool_result` blocks observed (2 tool_use in tool test)
- **Steer: NOT native.** Mid-turn steer = interrupt → new turn on same `session_id` (same model as Codex followUpPrompt → new Gateway turn)

## Capability matrix (§8.1, evidence-backed)

| Capability | Verdict | Evidence |
|---|---|---|
| Token streaming | YES | stream_event deltas w/ includePartialMessages |
| Reasoning/thinking | PARTIAL | thinking blocks appear in assistant content; verify per-model |
| Tool events | YES | tool_use/tool_result blocks |
| Interrupt ownership | YES | abort → terminal result, process killed |
| Steer | NO (interrupt+resume) | no mid-turn input channel |
| Resume | YES | `resume: session_id` |
| Model/mode/thinking opts | YES | Options.model, permissionMode, effort |
| Permission prompts | YES | canUseTool callback → map to PermissionRequest |
| MCP tools | YES | options.mcpServers |
| Images | YES | SDK supports image blocks (Paseo image-rendering tests) |
| Slash commands | PARTIAL | via prompt text; dedicated API limited |
| Usage | YES | result.usage + stream usage |

## Version floor

- SDK `@anthropic-ai/claude-agent-sdk` ≥ 0.3.x (tested 0.3.246)
- Requires `claude` CLI on PATH (SDK spawns it); auth = user's existing Claude Code login — no new credential handling

## Tool binding approach (P3-01 input)

- Wrap `query()` as `ClaudeAgentSession implements AgentSession`
- `canUseTool` → `PermissionRequest` (provider-side permission) mapped through shared contract
- Provider turn ID = SDK `session_id`+turn boundary; Gateway `gatewayTurnId` stays authoritative
- `describePersistence()` → resumable via `resume: session_id` once rollout files verified (same honesty rule as Codex)
- Paseo reference: `providers/claude/{agent,query,tool-call-mapper,subagents/}` — borrow mapper structure, not code
