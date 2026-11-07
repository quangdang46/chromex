# ADR: Tool loop vs legacy planner (§18.5)

Status: PROPOSED
Bead: chromex-7du (plan §18.5)

## Decision (recommended)

**The gateway tool loop fully replaces `route.plan` /
`browser.action.plan`; the legacy sidecar planner is retained only as a
flag-gated compat path with a dated removal — no permanent deterministic
exceptions.**

## Current state (evidence)

- `packages/bridge/src/gateway/config.ts:76-79,136-137,308-309` —
  `features.legacySidecarPlanning` defaults **true**,
  `features.toolLoop` defaults **false**.
- `packages/bridge/src/gateway/main.ts:1155-1164` — when `toolLoop` is
  on, both methods throw `proto.unsupported` ("gateway toolLoop not
  implemented (P1-09)"); when both flags are off they are retired; only
  the legacy sidecar serves them today.
- `packages/extension/src/background/index.ts:2163,2613,2731` — the
  extension still calls `route.plan`/`browser.action.plan` for real
  features (agentic routing, DOM action plans), so the legacy path is
  load-bearing until the tool loop covers those flows.
- Plan §10 already marks both methods **retired (tool loop)**; §15 gives
  the flag rollout (`toolLoop` off→on end of P1, legacy off after).

## Rationale

- The planner exists because the pre-gateway architecture needed a
  deterministic middleman to pick engines and DOM actions. The tool loop
  moves that decision to the model with gateway-enforced policy
  (token scope, risk classification, approvals) — keeping a second,
  deterministic planner alongside it means two sources of truth for the
  same decision.
- "Keep deterministic for some flows" was considered and rejected for
  MVP: every current caller of `route.plan`/`browser.action.plan` is an
  agent-facing convenience, not a safety boundary. Safety lives in the
  permission/risk engine (§4.8), which is planner-independent.
- The compat window is already designed: `legacySidecarPlanning` is a
  flag, not a fork. Flipping `toolLoop` on and the legacy flag off is the
  migration; LEGACY_COMPAT entries get removal dates per §16.

## Alternatives considered

- **Permanent deterministic planner for "simple" flows** (e.g. single
  click) — rejected: splits behavior by flow type, doubles test surface,
  and the model already handles trivial tool calls well inside the loop.
- **Keep both indefinitely** — rejected: `route.plan` output feeds the
  same browser actions the tool loop would issue; maintaining both
  planners guarantees drift.

## Consequences

- Before `toolLoop` can default on, the tool loop must cover everything
  the sidecar planner currently serves (routing decision + DOM action
  planning) or those callers must be ported — that gap is the real P1-09
  work, not the flag flip.
- `legacySidecarPlanning` and the two RPC methods get `COMPAT` removal
  dates when `toolLoop` ships; regression tests for the legacy workflows
  (§15) run before the flip.
- Revisit only if a flow emerges where deterministic planning is a hard
  requirement (e.g. offline/no-model operation) — none exists today.
