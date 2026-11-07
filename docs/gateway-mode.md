# Gateway mode

Gateway mode replaces the legacy bridge-per-Native-Messaging-port path
with a single durable **Chromex Gateway** process that owns sessions,
tasks, turns, and events. See plan §11 and `docs/adr/gateway-distribution.md`.

## What changes

- Legacy: each extension connection spawns its own bridge process; state
  lives and dies with the port.
- Gateway: one detached Gateway process holds all agent sessions. Tasks
  and turns are durable records with a sequenced event log; the extension
  is a client that replays events after reconnect.

## Enabling

Gateway mode is the default transport in this checkout. Two layers:

- **Native host**: `scripts/install-native-host.mjs` writes
  `CHROMEX_GATEWAY_MODE=1` and `GATEWAY_ENTRY` into the host launcher.
  Reinstall with `--legacy-mode` to go back to per-port bridging.
- **Extension**: `settings.gatewayMode` selects the runtime path. The
  stored flag is normalized to `true` — a stored `false` is treated as a
  stale auto-write, not a user choice.

Optional env overrides:

- `CHROMEX_GATEWAY_HOME` — gateway data dir (default
  `~/.chromex/gateway`).
- `GATEWAY_ENTRY` — path to `gateway/bin.js` when the sibling-package
  layout cannot resolve it.

## Providers

Registered per `gateway.json` → `providers`:

- `codex` — enabled by default; uses the Codex app-server.
- `claude` — disabled by default; set `providers.claude.enabled: true`.
- `providers.acp.<id>` — generic ACP agents (e.g. `opencode`,
  `gemini`), each with `command`, `args`, `env`, and `enabled`.
  See `docs/adr/acp-provider.md`.

The composer shows a provider picker only when gateway mode is on and
the gateway reports more than one enabled provider
(`settings.agentProviderId` picks the provider for new tasks).

## Models

The model list comes from each provider's catalog. Three config knobs
per provider in `gateway.json`:

- `models` — allowlist over the fetched catalog.
- `additionalModels` — always appended (routers/custom providers serve
  ids the agent CLI never reports).
- `defaultModel` — overrides the catalog default.

`settings.customModels` (extension side, max 32 ids) merges extra model
ids into the Codex/Claude picker for deployments fronted by a custom
`model_provider`.

## State

All under `CHROMEX_GATEWAY_HOME` (default `~/.chromex/gateway`):

- `gateway.db` — SQLite store (tasks, turns, events, approvals).
  Only when `store: "sqlite"` in `gateway.json`; `memory` is the
  default until the sqlite flag flips.
- `gateway.json` — resolved config (see `config.ts` for the schema;
  unknown keys are rejected).
- `gateway.log` — gateway stdout/stderr; the only diagnostic surface
  for a detached crash.
- `auth/token` — IPC auth token (0600), injected into `hello` by the
  native host; never exposed to the extension.
- `run/gateway.json` — atomically published IPC endpoint
  (UDS/named pipe path + pid).
- `gateway.lock`, `gateway.startup.lock` — ownership locks. A second
  gateway instance cannot start; the loser exits during boot.

## Behavior guarantees

- **Survives extension reload and service-worker sleep.** The gateway
  keeps running; on reconnect the extension sends `hello` with its
  `lastSeqByTask` cursors and pulls `task.sync` per task (snapshot
  fallback when events were pruned). SW sleep does not change task or
  turn state.
- **Panel closed ≠ agent stopped.** Turns continue while the side panel
  is closed; reopening replays missed events.
- **Gateway crash → honest unknown.** On restart the recovery scan marks
  non-terminal turns `unknown` and their tasks `paused` (reason
  `restart`); pending approvals expire. Nothing is replayed as if it
  had completed. Resume is explicit, never automatic side effects.

## Troubleshooting

- **Nothing works / `gateway.starting`, `gateway.not_ready`,
  `gateway.unresponsive`** — the native host auto-spawns the gateway
  detached (`ensureGateway`, backoff 250 ms → 5 s, deadline
  `startupTimeoutMs` default 15 s). If it keeps failing, read
  `~/.chromex/gateway/gateway.log`; the spawn marker lines
  (`--- spawn <ts> pid=N ---`) separate attempts.
- **Stale endpoint** — `run/gateway.json` is ignored when its pid is
  dead; the host respawns. Delete `run/` only if the log shows a
  corrupt endpoint file.
- **Second instance won't start** — expected: the lifetime flock admits
  one gateway. Check for a stray process before deleting
  `gateway.lock`.
- **Provider missing from picker** — check `providers.<id>.enabled` in
  `gateway.json` and `gateway.log` for provider init errors; the hello
  response's provider list is the source of truth.
- **Model id rejected** — add it via `additionalModels` in
  `gateway.json` or `customModels` in extension settings.
