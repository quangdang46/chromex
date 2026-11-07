# ADR: Gateway IPC transport

Status: DECIDED for POSIX (spike-B5 / chromex-vy2, 2026-11-07);
Windows named-pipe ACL sub-decision remains PROVISIONAL pending Windows run.

## Evidence (scripts/spike/b5-ipc-transport.mjs — real dist gateway, 5/5)

- Endpoint published atomically (`run/gateway.json` tmp+rename). PASS
- Token file mode `0600`. PASS
- Wrong token → `proto.auth_failed` + socket closed. PASS
- Two connections, same user, different `profileId` → both authed;
  identity separation is per-hello, not per-socket. PASS
- Gateway restart with stale `.sock` file → clean rm+rebind, new token
  (rotation per boot; `HelloResponse.tokenRotated` covers clients).
  PASS

## Decision

- **POSIX: Unix domain socket** in `<dataDir>/run/` (dir 0700) +
  32-byte token file 0600, first-frame `hello{token}` auth, uint32-LE
  length-prefixed JSON envelopes capped at `maxEnvelopeBytes`.
- **Windows: named pipe** `\\.\pipe\chromex-gateway-<sha256(dataDir)[:16]>`
  — implemented in `ipc-server.ts`; ACL restriction to user SID is
  PROVISIONAL until verified on Windows (test 5 not executable on
  macOS). If ACL control proves unavailable with plain Node APIs, the
  decision rule falls back to TCP+token for Windows only.
- **TCP+token remains the documented fallback** everywhere; `gateway.ipc.
  transport: auto|pipe|tcp|unix` config already exists.

## Threat model (§3.4.3 sign-off)

Pipe/UDS+token defends against **OTHER USERS** (file perms + socket dir
perms). It does NOT defend against same-user malware, which can read the
token file — accepted for MVP; token rotation per gateway boot bounds
the window. The transport cannot distinguish "real Chrome Native Host"
from any same-user process holding the token — no such claim is made.

## Platform-limited items

- Test 1 (cross-user rejection): POSIX mechanism is 0600/0700 — standard;
  multi-user matrix deferred to Linux CI.
- Test 5 (Windows pipe ACL): pending Windows environment.
