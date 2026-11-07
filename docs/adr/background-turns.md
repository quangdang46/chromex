# ADR: background turns / subagents (§18.9, Phase 4 decision)

Status: DECIDED — deferred, with explicit revisit triggers
Bead: chromex-436.4 (P4-03)

## Decision

**Do not implement gateway-owned background turns or a subagent
orchestration layer in Phase 4.** The task model stays
sequential-foreground: one running turn per task, queued follow-ups via
`tasks.queueWhileRunning`. Provider-internal subagents (Codex child
agents, Claude Task tool, ACP agent fan-out) already surface honestly as
`tool.started`/`tool.completed` events (`subagent:*` tool names in the
Claude mapper) — they are provider implementation details, not gateway
entities.

## Rationale

- §4.7 `TaskAttention` is derived, not stored; background turns would
  need new attention semantics ("running in background, needs nothing"
  vs "waiting_user") that the plan does not specify.
- Crash recovery (§5.x) currently marks non-terminal turns `unknown`;
  background turns multiply the ambiguous-outcome surface without new
  evidence it is needed.
- Paseo reference (`/tmp/paseo/docs/agent-lifecycle.md`) tracks
  subagents as observations of the parent's tool calls — same model we
  already have. No gateway-owned subagent entity there either.
- Every shipped provider (codex, claude, acp) runs turns serially per
  session; a background-turn abstraction would be speculative for all
  three.

## Revisit triggers (any one)

- A provider ships a first-class "spawn background agent" API that
  returns its own session/turn identity (not just tool calls).
- User-facing need for parallel turns inside one task (e.g. compare two
  models on the same prompt) — would likely be separate tasks, not
  background turns.
- §14 MVP acceptance or a later plan revision explicitly schedules it.

## What IS in scope instead (Phase 4)

- ACP/OpenCode providers via the shared ACP adapter (P4-01/02) — done.
- Provider-internal subagent visibility stays as tool events; if a
  provider exposes richer subagent state later, extend the tool-event
  mapping, not the task model.
