# ADR: browserInstanceId mechanism

Status: DECIDED (spike-B6 / chromex-ov8, 2026-11-07) — mechanism
implemented in `native-host/src/browser-instance.ts`; real-Chrome
lifecycle validation tracked as follow-up (unit-tested decision logic).

## Context

Plan §4.4/§6.x: browser identity must distinguish `profileId`,
`browserInstanceId`, `hostInstanceId`, `connectionId`, `clientId`.
`browserInstanceId` is `string | null` everywhere; loss of identity maps to
`needs_confirmation`, never auto-`stale`. `tabId` and `hostInstanceId` are
never durable affinity keys.

## Candidates

1. **Extension-generated UUID per browser profile**, persisted in
   `chrome.storage.local`, rotated on explicit "reset browser identity".
   - Pros: simple, survives SW restarts, no OS coupling.
   - Cons: user can copy profile dir → duplicate IDs; needs storage-event
     reconciliation.
2. **Native-host attested ID**: bridge mints ID at first host.register and
   signs it into handshake.
   - Pros: bound to host instance, tamper-evident.
   - Cons: conflates hostInstanceId with browserInstanceId — plan forbids
     using hostInstanceId as affinity key.
3. **Hybrid**: extension UUID + host countersign in `host.register` scope.

## Decision rule

Pick the candidate that (a) survives extension reload + browser restart,
(b) cannot be forged by a content script, (c) does not leak across Chrome
profiles. Default lean: candidate 1 with storage-write validation, unless
spike shows profile-dir cloning is a real threat → candidate 3.

## Decision (implemented)

**Native-host-derived, Chrome-run-scoped ID** — candidate 3 hybrid,
simplified: the NM host's parent PID *is* the Chrome process for its
whole run, so `browserInstanceId` is minted once per (chromePpid,
chromePpidStartedAt) and persisted at `<dataDir>/browser-instance.json`
(0600, atomic tmp+rename).

Lifecycle mapping (the 4 required events):

| Event | chromePpid/start | browserInstanceId | Binding |
|---|---|---|---|
| SW restart | unchanged | **stable** | `ok` kept |
| Extension reload/update/disable→enable | unchanged (host unaffected or respawned under same Chrome) | **stable** | `ok` kept — same Chrome run, identity preserved |
| Native host reconnect (new hostInstanceId) | unchanged | **stable** | `ok`, host field updated |
| Chrome quit/restart | new ppid and/or start time | **new ID** | `needs_confirmation`/`stale` per §3.2 |

Rejected: `chrome.storage.session` (lost on extension reload — Chrome
run continues but ID dies → false `needs_confirmation`); storage.local
UUID (survives Chrome quit → cannot express per-run identity);
`profileId + chromePid` string concat (PID reuse without start-time
guard → implemented with `ps lstart`/CIM StartTime instead).

`null` remains valid everywhere (degraded mode → `needs_confirmation`,
never auto-`stale`). `browserInstanceId` is Chrome-RUN identity, not a
security principal.

## Consequences

- `resolveBrowserInstanceId()` in native-host feeds `hello.browserInstanceId`
  and `host.register` once P1-03 wires the relay.
- PID-reuse guard uses parent start time; Windows falls back to empty
  start time (documented limitation — reuse window accepted, same
  user-only threat model as §3.4.3).
- Real-Chrome lifecycle e2e (actual reload/disable/quit) remains a
  manual/CI validation item; decision logic is unit-tested.
