# ADR: SQLite durability mode

Status: DECIDED (spike-B7 / chromex-3nk, darwin arm64, node v26.3.0,
3000 iters of the §7.2 BEGIN IMMEDIATE task-stream pattern).

## Benchmark results (scripts/spike/durability-bench.mjs)

| mode    | commits/s | p50 ms | p95 ms | p99 ms | max ms |
|---------|-----------|--------|--------|--------|--------|
| FULL    | ~9,730    | 0.039  | 0.226  | 0.425  | 59.5*  |
| NORMAL  | ~24,783   | 0.028  | 0.106  | 0.300  | 1.66   |

*max is a one-off fsync stall (spotlight/backupd), not steady state.

## Decision

**Keep synchronous=FULL.** Even the p99 FULL commit (~0.4 ms) is ~25x under
the interactive-turn latency budget; NORMAL's ~2.5x throughput gain is
irrelevant at event-log write rates (tens of commits/sec, not thousands).
The §5.6 "0 loss on process crash AND power loss" commitment stays
unconditional — no wording change needed. NORMAL remains documented only
as a future bulk-write optimization (retention prune) via a separate
connection, per plan §7.2.

## Context

Plan §5.x: durable event store in SQLite. `synchronous=FULL` gives zero
durability loss claims but costs fsync per commit; `NORMAL` risks losing
recent commits on OS crash (not process crash). The plan forbids claiming
"zero durability loss" unless FULL is chosen and verified.

## Candidates

1. `synchronous=FULL` + `journal_mode=WAL` + `wal_autocheckpoint` tuned.
2. `synchronous=NORMAL` + WAL, accepting bounded loss window.
3. Hybrid: NORMAL for high-frequency ephemeral-adjacent writes, FULL for
   durable event commits only.

## Decision rule

Benchmark on the spike's target disk (APFS + typical NVMe): measure commit
latency p50/p99 at expected event rates. Choose FULL unless p99 commit
latency breaks interactive turn latency budgets (>~10 ms sustained); if
hybrid, ONLY durable event/sequence allocation may use FULL — snapshots
and caches may use NORMAL. Never claim zero-loss under NORMAL.

## Consequences (pending)

- `PRAGMA synchronous` is per-connection; store must set it explicitly and
  expose it in diagnostics.
- Recovery path must handle torn WAL tails regardless of mode.
