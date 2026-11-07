# ADR: profileId binding and multi-Chrome-profile UX (§18.8)

Status: PROPOSED
Bead: chromex-4rx (plan §18.8)

## Decision (recommended)

**MVP: bind `task.profileId` to the authenticated connection's
`profileId` server-side (from `hello`, never client-supplied); show
tasks from other profiles read-only; defer the "adopt task" UX.** Split
the name collision between the Chrome-profile id and the provider
derived-profile id before multi-profile ships.

## Current state (evidence)

- `packages/extension/src/background/gateway/identity.ts` —
  `profileId`/`clientId` generated per extension installation,
  persisted in `chrome.storage.local`; stable per install, lost on
  uninstall/reset (matches §3.2 wording).
- `packages/bridge/src/gateway/hello.ts:58-74` — `hello` requires
  `profileId` + `hostInstanceId`; identity is per-connection.
- `packages/bridge/src/gateway/main.ts:745-749` +
  `session-manager.ts:215-238` — `task.create.profileId` is accepted
  from the payload (default `"codex"`) and passed to
  `registry.resolve(task.profileId, …)`, i.e. it currently means the
  **provider derived-profile** id (`agents/registry.ts` `DerivedProfile`),
  NOT the §3.2 Chrome-profile identity. The two concepts share one field
  name today.
- `packages/shared/src/protocol/errors.ts:51` — `browser.wrong_profile`
  exists in the error registry; no code path emits it yet.
- No adopt/cross-profile UI exists in the sidepanel.

## Rationale

- §3.2 already fixes the semantics: task bound to profile, cross-profile
  browser tools → `browser.wrong_profile`, "adopt" creates a new task.
  What is undecided is only the UX surface and where the binding comes
  from.
- Binding server-side from the hello identity is both simpler and safer:
  the client cannot spoof its profile, the schema needs no new required
  field, and single-profile installs (the common case) need zero UI.
- The field-name collision is a real defect-in-waiting: `task.create`'s
  `profileId` feeds provider-profile resolution. Before any multi-profile
  work, rename the provider-profile input (e.g. `providerProfileId`) and
  let `profileId` mean the §3.2 identity — small contract change now,
  expensive after `task.created` events and `tasks.profile_id` rows
  accumulate.
- Adopt UX is deferred because its only honest MVP form is "start a new
  task in this profile with the same prompt" — which users can already do
  manually; a dedicated affordance earns its keep only when multi-profile
  usage is proven.

## Alternatives considered

- **Client-supplied `profileId` on `task.create`** — rejected: spoofable,
  and redundant — the connection already proved its identity at `hello`.
- **Adopt = migrate/rebind the existing task to the new profile** —
  rejected by §3.2 itself (task profile is immutable; adopt creates a
  new task). Rebinding would break token `profileId` validation and
  tab-binding scope.
- **Full multi-profile UI now** (profile picker per task, wrong_profile
  surfacing, adopt flow) — deferred: no user demand signal; the identity
  plumbing must land first regardless.

## Consequences

- Required before multi-profile: rename/split the `profileId` collision
  in `taskCreateSchema`, `TaskRecord`, and `task.created` payloads
  (COMPAT-tagged, optional-then-required per §16 rules).
- `browser.wrong_profile` enforcement lands with the binding, even before
  any adopt UI — read-only cross-profile visibility is the MVP surface.
- Revisit triggers: users running Chrome profiles side-by-side asking to
  continue a task across profiles; second connected-host scenario.
