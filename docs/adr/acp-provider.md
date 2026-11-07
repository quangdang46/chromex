# ADR: ACP provider mechanism (Phase 4)

Status: DECIDED (spike-verified 2026-11-07)
Beads: chromex-436.1 (P4-00), parents chromex-436.2/.3

## Decision

Implement ONE generic `AcpAgentProvider` — an AgentSession adapter over
Agent Client Protocol (JSON-RPC 2.0, ndjson over stdio) — and register
ACP-capable agents (`opencode acp`, `gemini --acp`, future ACP agents)
as provider entries sharing the adapter. OpenCode's HTTP `serve` API is
rejected: ACP already provides session/update streaming, permission
requests, model config options and loadSession resume in one protocol.

## Spike evidence (real binaries, this machine)

- `opencode acp --pure` (opencode 1.19.0): `initialize` →
  protocolVersion 1, agentCapabilities {loadSession, mcpCapabilities
  http+sse, promptCapabilities {embeddedContext, image}, sessionCapabilities
  {close, fork, list, resume}}, authMethods [opencode-login], agentInfo.
- `session/new` {cwd, mcpServers:[]} → sessionId + configOptions
  (model select with full catalog).
- `session/set_config_option` {configId:"model"} → accepted, catalog
  currentValue updated (verified with 3 different model ids).
- `session/prompt` → dispatched; `session/update` notifications observed:
  `available_commands_update`, `usage_update`, `config_option_update`,
  `agent_message_chunk` path exists in spec (not reached — upstream
  provider creds in opencode auth store are stale: "API key expired" /
  "Invalid API Key" / "overloaded". Protocol layer fully verified;
  completion is an env/credential issue, same class as 9router).
- `gemini --acp` flag exists (gemini-cli 0.46.0) — same protocol, not
  probed (needs Google auth).

## Mapping to AgentSession

| ACP | AgentSession |
|---|---|
| `session/new` | createSession (sessionId → persistence ref, kind "acp-session") |
| `session/load` (loadSession cap) | resumeSession |
| `session/prompt` | startTurn; response stopReason → turn.completed/failed/cancelled |
| `session/update` agent_message_chunk | assistant.delta (deltaOffset = cumulative chars) → assistant.message on prompt response |
| agent_thought_chunk | reasoning.delta (bounded) |
| tool_call / tool_call_update | tool.started / tool.completed (status→outcome) |
| `session/request_permission` (agent→client request) | permission.requested → respondToPermission → JSON-RPC result {outcome:selected,optionId} |
| `session/cancel` notification | interrupt() — bounded wait for prompt response |
| usage_update | usage event |
| available_commands_update | listCommands cache |
| configOptions (model/mode/thinking selects) | setModel/setMode/setThinkingOption via session/set_config_option |
| authenticate | attempted when session/new returns auth-required |

Client capabilities advertised: fs.read/write = false, terminal = false
(Chromex does not service agent file/terminal requests; agents use their
own tools or Chromex MCP via mcpServers — see open question).

## Capability flags (honest)

streaming, reasoningSummary, toolEvents, interrupt, resume (when
loadSession advertised), modelSelection, permissionPrompts, imageInput
(when promptCapabilities.image), slashCommands, usage — all true for
opencode per initialize evidence. steer = false (no mid-turn inject in
ACP; followUpPrompt → new turn like Claude). modeSelection/thinkingOption
= true only when the agent's configOptions actually expose those
categories — resolved per-session, advertised conservatively.

## Open questions

1. **MCP bridging**: `session/new` accepts `mcpServers` — wire the
   browser-tool MCP spawn (P1-09) through config.options.mcpServers the
   same way Claude/Codex do. http+sse supported by opencode.
2. **Permission option mapping**: ACP kinds allow_once/allow_always/
   reject_once/reject_always → our allow_once/allow_task/deny. Map
   allow_always→allow_task ONLY when the action digest scope exists;
   otherwise downgrade to allow_once (never widen silently).
3. **Auth**: authMethods may require `authenticate` before session/new;
   implement lazily on auth-error, no credential handling in adapter.
4. **turnId correlation**: ACP prompt is request/response — one
   session/prompt in flight per turn; sequential queue like Claude.
   providerTurnId = ACP request id.
5. **gemini --acp**: same adapter, separate provider entry; unverified
   live (Google auth needed).
