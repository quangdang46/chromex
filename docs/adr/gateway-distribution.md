# ADR: Gateway distribution and update mechanism

Status: PROPOSED
Bead: chromex-d9x (plan §18.2)

## Decision (recommended)

**Bundle the Gateway inside the existing local-bridge installer package;
updates ship by reinstalling that package.** No standalone installer, no
CLI self-update, no auto-updater for MVP.

## Current state (evidence)

- `scripts/package-local-bridge.mjs` already produces one zip containing
  `packages/native-host/dist` + `bridge/cli.bundle.cjs`; the Gateway entry
  (`packages/bridge/src/gateway/bin.ts`) rides in the same `dist` tree.
- `scripts/install-native-host.mjs` copies the bundle into the per-OS
  app-support dir and registers the Chrome native host manifest.
- The native host spawns the Gateway from the sibling layout
  (`packages/native-host/src/gateway-client.ts` resolves
  `bridge/dist/gateway/bin.js` next to its own `dist/`).
- Version drift is already handled by the hello handshake
  (`gateway/hello.ts` reports `gatewayVersion`; ADR-005 versioning).

## Rationale

- One artifact, one install path, one update path. A second distribution
  channel (standalone gateway installer or `npm i -g chromex-gateway`)
  doubles the support matrix for zero MVP benefit — the Gateway is
  useless without the native host and the extension anyway.
- Reinstall-based update matches how Chrome Web Store users already
  receive bridge updates; the version handshake surfaces mismatches
  instead of silently running a stale Gateway.
- The Gateway is spawned, not daemon-installed: it has no launchd/systemd
  footprint of its own, so "updating" it is just replacing files while
  the next spawn picks them up (locks + fencing already handle a live
  instance).

## Alternatives considered

- **Standalone installer / separate Gateway package** — rejected for MVP:
  second artifact to version, sign, and support; revisit only if the
  Gateway ever needs a release cadence independent of the bridge.
- **CLI install (`chromex gateway install`)** — rejected: the CLI is a
  dev/diagnostic surface today; making it an install path adds a third
  trust boundary (npm supply chain) for end users who never touch it.
- **Auto-update / self-update** — rejected: the Gateway runs detached and
  holds SQLite state; silent self-replacement risks version skew with the
  native host that spawned it. The hello handshake is the drift detector;
  the reinstall is the fix.

## Consequences

- Update UX = "download the new local-bridge zip, run the installer" —
  same as today; document it in the install README when gatewayMode
  flips on by default.
- Gateway and bridge versions must stay lockstep within one package;
  `gatewayVersion` in hello should equal the package version.
- Revisit triggers: independent Gateway release need, non-technical
  users hitting reinstall friction, or a platform (e.g. F-droid/Play
  build) that cannot ship the zip flow.
