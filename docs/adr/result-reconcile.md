# ADR: browser.tool result reconciliation

Status: IMPLEMENTED (acceptance `tool-reconcile`, 23 asserts — live
disconnect, host reconnect, and gateway-restart legs all green).

## Problem

A browser tool call dispatched to the chrome-extension host can lose its
result two ways:

1. The IPC channel drops **after** the host executed the call but before
   the `browser.tool.result` envelope arrived → gateway must not guess
   `failed` (the action may have committed — a retry could double-submit).
2. The gateway restarts while calls are in flight → seeded outcomes
   previously collapsed everything to `failed`/`browser.interrupted`,
   which was a lie for calls that actually completed.

The honest floor was `outcome: "unknown"`. This ADR covers how `unknown`
gets resolved when evidence exists.

## Decision

### Host side (extension service worker)

- Every `browser.tool.call` outcome is recorded in a bounded LRU buffer
  (`recentToolOutcomes`, cap 512, payload ≤ 64 KB) **before** the result
  envelope is written — a result lost to a channel drop is still
  retrievable.
- `browser.tool.reconcile` is a server→host request: `{ toolCallIds: string[]
  (1..512) }` → `{ results: Record<toolCallId, {status, output?, error?}> }`.
  Only outcomes still in the buffer are returned; absent ids stay unknown.
- The buffer dies with the service worker — post-SW-restart calls cannot
  be reconciled and stay `unknown` forever. That is correct: the host no
  longer has evidence.

### Gateway side (`BrowserToolServer`)

- `outcome === "unknown"` results are tracked in `unreconciled`
  (bounded 512, keyed taskId+toolCallId).
- On host (re)register → `browser.tool.reconcile` per task → for each
  reported call still `unknown`/`browser.interrupted`, emit durable
  `tool.reconciled` (`source: "browser"`) carrying the true outcome. The
  original `tool.completed` (unknown) is preserved — reconcile is an
  amendment event, never a rewrite.
- `tool.reconciled` is in `PROTECTED_TASK_EVENT_TYPES` so retention can
  never prune the amendment while keeping the unknown original.
- Snapshot builder merges reconciled outcome/output/verified **only**
  when the existing call is still `unknown` — a real outcome always wins.
- Tracking is scoped to `backendId === "chrome-extension"`: isolated
  Playwright is in-process and has no remote outcome buffer to query.

### Restart seeding

`durableBrowserToolCalls` scans `tool.started`/`tool.completed`/
`tool.reconciled` and reseeds `BrowserToolServer.outcomes` so dedup
survives restarts. Event vocabulary maps `succeeded`→`completed`;
`tool.reconciled` supersedes a preceding unknown completion by seq order.
Interrupted seeds (`started`/`unknown` last, chrome-extension backend
only) re-enter `unreconciled` so a host reconnect after gateway restart
still reconciles them.

Dedup coherence: a replayed `toolCallId` returns `{ status: "failed",
error: browser.duplicate_tool_call }` regardless of the prior outcome —
a rejection is a failure, never inherits `completed`.

## Consumers

- UI legacy path: `tool.reconciled` shares the `tool.completed` block and
  `itemId = toolCallId` → `upsertTurnActivityTrace` overwrites the item
  (no duplicate). Unknown completions render "result unconfirmed".
- `tool.reconciled` carries non-`unknown` outcomes only; the event union
  enforces this at the type level.

## Consequences

- An agent that sees `unknown` may later see the snapshot amend to a real
  outcome — the audit trail keeps both events, so the story is honest.
- Worst case (host gone for good) is unchanged: `unknown` forever.
- Reconcile adds one bounded request per host hello per task — negligible.
