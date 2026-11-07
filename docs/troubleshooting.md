# Gateway troubleshooting

Runbook for gateway-mode failures. State lives under `CHROMEX_GATEWAY_HOME`
(default `~/.chromex/gateway`); set `G` to that dir in the commands below.

```sh
export G="${CHROMEX_GATEWAY_HOME:-$HOME/.chromex/gateway}"
```

Ground truth, in order of usefulness:

- `$G/gateway.log` — gateway stdout/stderr; the only diagnostic surface for
  a detached crash. `--- spawn <ts> pid=N ---` lines separate respawn
  attempts by the native host.
- `$G/gateway.db` — SQLite store (tasks, turns, events, approvals).
  Only exists when `store: "sqlite"` in `gateway.json`.
- `$G/run/gateway.json` — atomically published IPC endpoint (socket path,
  pid). Read only after checking the pid is alive.
- `$G/gateway.lock` / `gateway.startup.lock` — OS flock ownership. Never
  deleted by hand; the lock dies with the process.

Process checks:

```sh
pgrep -fl "gateway/bin.js"          # gateway process(es); expect exactly one
pgrep -fl "native-host"             # native host relaying for the extension
sqlite3 "$G/gateway.db" ".tables"   # quick sanity that the DB opens
```

## hello timed out / `gateway.unresponsive`

Symptom: extension stuck on "connecting", or requests fail with
`gateway connect timed out` / `request hello timed out` (client code
`unresponsive`).

Likely causes:

- Gateway is alive but still booting — recovery scan and SQLite migration
  run before `markReady`. Clients get `gateway.starting` /
  `gateway.not_ready` until then; a very slow recovery (large `events`
  table) can push past the 15 s connect/hello deadline.
- Endpoint is stale — `run/gateway.json` points at a dead pid or a
  socket that no longer accepts. The client should respawn; check
  `gateway.log` for the spawn marker.
- Socket path mismatch — endpoint path is `run/gw-<sha256(dataDir)>.sock`;
  a `CHROMEX_GATEWAY_HOME` change orphans the old endpoint.

Diagnose:

```sh
cat "$G/run/gateway.json"                 # endpoint + gatewayPid
tail -50 "$G/gateway.log"                 # last boot/recovery lines
sqlite3 "$G/gateway.db" \
  "SELECT COUNT(*) FROM events;"          # large table → slow recovery
lsof -U | grep chromex                     # is the socket actually listening
```

Fix: if `gateway.log` shows a crash loop, fix the crash first. If the
gateway is wedged mid-recovery, kill it (`kill <gatewayPid>`) and let the
native host respawn — recovery is idempotent. If `run/gateway.json` is
corrupt JSON, delete `run/` and let the next `ensureGateway` respawn.

## `proto.unsupported` on a legacy method

Symptom: a request fails with `proto.unsupported: legacy method <m> is
served by the bridge sidecar, not the gateway`.

Likely cause: the client sent a method the gateway does not own.
Methods in `LEGACY_SIDECAR_METHODS` (`apps.list`,
`plugins.list`, `image.*`, `workspace.harness.read`, `runtime.config.*`,
… — see `packages/shared/src/protocol/sidecar.ts`) are routed by the
extension to the legacy bridge sidecar automatically while gatewayMode
is on; hitting this error means the request bypassed that routing (e.g.
a non-extension client) or the native host is older than the extension.
`route.plan` / `browser.action.plan` are served natively by the gateway
on the codex provider.

Diagnose: the error message names the method; check `isSidecarMethod`
in `packages/extension/src/background/gateway/compat/legacy-methods.ts`
for which transport should have carried it.

Fix: update the client and the native host (`npm run build
--workspace @codex-sidepanel/native-host` then reinstall). If the
feature genuinely only exists on the legacy bridge, reinstall the
native host in legacy mode (`install-native-host.mjs --legacy-mode`).

## `model.list` failed or model picker empty

Symptom: model dropdown empty, console shows `model.list failed`, or
`provider.catalog` returns `{ catalogs: [] }`.

Likely causes:

- Provider catalog fetch failed — `provider.catalog` swallows per-provider
  errors and returns `null`, which is filtered out. Empty list ≠ empty
  catalog; it often means the provider errored.
- Catalog cache is stale or poisoned — `CatalogCache` TTL is 10 min,
  single-flight, 120 s deadline (`CatalogFetchTimeoutError`). In-memory
  only: a gateway restart clears it.
- Provider disabled or misconfigured in `gateway.json`
  (`providers.<id>.enabled`, `models` allowlist with no overlap).
- `model.list` itself is a compat rewrite to `provider.catalog` with
  `providerId` defaulting to `codex`; an unregistered provider id yields
  an empty catalog.

Diagnose:

```sh
tail -100 "$G/gateway.log" | grep -i "catalog\|provider"
sqlite3 "$G/gateway.db" "SELECT key, substr(value,1,200) FROM gateway_state;"
# force a fresh fetch (bypasses the 10-min TTL):
#   request provider.catalog { providerId, forceRefresh: true }
```

Fix: send `provider.catalog` with `forceRefresh: true`; if that fails,
check provider auth/CLI in `gateway.json` and `gateway.log`, or restart
the gateway to drop the in-memory cache.

## Turn stuck, then `unknown` after gateway restart

Symptom: a turn shows running forever, or after a gateway restart the
task is `paused` and the turn is `unknown`.

Likely cause: this is the designed recovery path (`store/recovery.ts`).
On boot, before `markReady`, the recovery scan marks every `running` turn
`unknown` (`turn.unknown` event, `stop_reason = gateway_restart`) and
pauses its task (`pause_reason = gateway_restart`). Queued turns stay
queued; the task is still paused so nothing auto-runs. `gateway.log`
prints `recovery: N turns unknown, M tasks paused`.

Diagnose:

```sql
SELECT turn_id, task_id, status, stop_reason, started_at, ended_at
FROM turns WHERE status IN ('running','queued','unknown')
ORDER BY created_at DESC;
SELECT task_id, status, pause_reason, updated_at FROM tasks
WHERE status = 'paused' ORDER BY updated_at DESC;
SELECT seq, type, turn_id FROM events
WHERE task_id = '<taskId>' ORDER BY seq DESC LIMIT 20;
```

Fix: this is expected after a crash/restart — side effects are never
replayed. Resume the task explicitly from the UI. If turns flip to
`unknown` *without* a restart, see "Agent stopped mid-turn" below.

## Agent stopped mid-turn (`turn.unknown`, task paused)

Symptom: turn ends `unknown` while the gateway stayed up; task paused
with `provider_unavailable`.

Likely causes — `turn.unknown` `stop_reason` tells you which:

- `gateway_restart` — recovery scan (see above).
- `turn.interrupt_timeout` — `turn.interrupt` did not confirm a stop
  within `interruptTimeoutMs` (default 30 s). The adapter may still be
  running; the gateway refuses to guess.
- `turn.timeout` — `tasks.turnTimeoutMs` budget expired and interrupt
  was unconfirmed (default `0` = disabled; set in `gateway.json`).
- `interrupt_no_terminal` — interrupt resolved but no terminal event
  arrived.

Diagnose:

```sql
SELECT turn_id, stop_reason, ended_at FROM turns WHERE status='unknown';
SELECT seq, type, payload_json FROM events
WHERE turn_id = '<turnId>' ORDER BY seq DESC LIMIT 15;
```

```sh
tail -100 "$G/gateway.log"   # provider/adapter errors near the stop
pgrep -fl "claude\|codex\|opencode"   # is the agent process still alive?
```

Fix: if the agent process is still running, kill it before resuming —
the turn's side effects are unconfirmed. Then resume the task; queued
follow-ups do not auto-run while the task is paused.

## Duplicate or missing events / deltas

Symptom: timeline gaps, duplicated messages, or text that arrives in
chunks after reconnect.

Likely causes:

- Ephemeral deltas (`assistant.delta`, `reasoning.delta`) are RAM-only
  and coalesced (50 ms silence window, 750 ms cap). They never enter the
  durable `events` table — durable `assistant.message` is the truth.
- Backpressure: a turn buffering > `deltaBufferMaxPerTurn` chars (default
  65 536) emits one `gateway.notice` with `backpressure:
  "deltas_dropped"` and drops further deltas until the next durable
  event. Client sees a `deltaOffset` gap — expected, not corruption.
- Reconnect replay: `hello` carries `lastSeqByTask` / `lastSeqByGateway`
  cursors; the client pulls `task.sync`. Events pruned by the retention
  sweep are covered by a snapshot checkpoint, so a `task.sync` for a
  pruned range returns snapshot mode instead of a gap.
- True duplicates cannot happen: `events` PK is
  `(stream, task_id, seq)`.

Diagnose:

```sql
-- seq continuity per task (look for gaps):
SELECT seq, type, turn_id FROM events
WHERE task_id = '<taskId>' ORDER BY seq;
-- find the drop notice:
SELECT seq, payload_json FROM events
WHERE task_id = '<taskId>' AND type = 'gateway.notice';
```

```sh
grep -n "deltas_dropped" "$G/gateway.log"
```

Fix: `deltas_dropped` → raise `gateway.deltaBufferMaxPerTurn` in
`gateway.json` or accept the gap (final message is durable). Missing
*durable* events with no notice → check `gateway.log` for a crash between
persist and broadcast; the seq in `events` is authoritative.

## Extension shows "disconnected"

Symptom: side panel / status shows disconnected or unresponsive; native
host port drops.

Likely causes:

- Gateway dead or restarting — the extension's `GatewayClient` tears down
  to `disconnected` on port loss and lazily reconnects + re-hellos on the
  next request. `starting`/`not_ready` map to the retryable `starting`
  state; timeouts map to `unresponsive`.
- Native host not running or crashed — `connectNative` fails before any
  gateway contact. Check the host manifest install
  (`install-native-host.mjs`) and `CHROMEX_GATEWAY_MODE=1`.
- `proto.auth_failed` — token mismatch: `auth/token` regenerated while a
  stale native host held the old one. Restart the native host.
- Oversized envelope — gateway drops outbound envelopes over
  `maxEnvelopeBytes` (`proto.payload_too_large`); a huge snapshot can
  kill the stream.

Diagnose:

```sh
pgrep -fl "native-host\|gateway/bin.js"
tail -50 "$G/gateway.log"
cat "$G/run/gateway.json" | python3 -c "import json,sys; print(json.load(sys.stdin)['gatewayPid'])" \
  | xargs -I{} ps -p {} -o pid,etime,command
```

Extension side: open the service-worker console; `GatewayClient` state
transitions and the hello error are logged there.

Fix: restart the native host (it respawns the gateway via `ensureGateway`
if needed). If auth fails persistently, stop everything, delete
`$G/auth/token` and `run/`, and let the gateway regenerate both on next
boot — tasks and events in `gateway.db` are untouched.
