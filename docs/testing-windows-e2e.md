# Windows e2e verification

Plan P3-06 / beads chromex-xki, chromex-2ml. These tests can only run on a
real Windows host; everything else (unit tests, POSIX spike results) already
runs in CI/dev on macOS/Linux. If you have no Windows machine, record each
item below as **env-blocked** in the bead and stop — do not fake results.

## Environment requirements

| Requirement | Detail |
|---|---|
| OS | Windows 10 1809+ or Windows 11, x64. PowerShell available (default on Win10+). |
| Node.js | 20 LTS or newer (`node --version`). Must be the npm-installed Node, not a Store shim that breaks native modules. |
| Chrome | Stable or Canary, real Chrome profile — not Chromium, not Playwright's bundled browser, for the extension/native-host items. |
| Claude Code | `npm install -g @anthropic-ai/claude-code`, then `claude --version` and one interactive `claude` login so the SDK path has valid auth. The bridge reuses Claude Code auth; no API key env var is needed. Optional: `providers.claude.command` in `gateway.json` if `claude` is not on PATH. |
| Codex CLI (optional) | `npm install -g @openai/codex` for the codex-provider variant of the e2e turn. |
| Build | From the repo root on Windows: `npm install`, `npm run build`. |
| Native host registration | `node scripts/install-native-host.mjs --browser=chrome`. If Chrome shows a different extension ID than the public release ID `menmlhahmendmkiicbjihgjhppkgaeom`, re-run `node scripts/install-native-host.mjs <extension-id> --browser=chrome`. |
| Extension load | `chrome://extensions` → Developer mode on → **Load unpacked** → `packages\extension\dist` → reload card after any rebuild. |

Isolate gateway state for every run so tests don't touch a real profile:

```powershell
$env:CHROMEX_GATEWAY_HOME = "$env:TEMP\chromex-e2e-gw"   # PowerShell
# or: set CHROMEX_GATEWAY_HOME=C:\Users\<you>\AppData\Local\Temp\chromex-e2e-gw  (cmd)
```

For the Claude turn, enable the provider in `<CHROMEX_GATEWAY_HOME>\gateway.json`
(create the dir first; `gateway.json` is written by the gateway on boot, so
run once, stop, edit, restart — or write the full file):

```json
{ "version": 1, "providers": { "claude": { "enabled": true } } }
```

Unknown keys are rejected (`resolveGatewayConfig`), so merge into the file
the gateway already wrote rather than inventing the schema.

## Test 1 — Claude e2e turn (chromex-xki)

Does not need Chrome. Exercises provider spawn → turn → durable events over
the Windows named-pipe transport.

```powershell
node scripts\gateway-e2e-background-claude.mjs
```

The script connects to the gateway, creates a task with
`providerId: "claude", model: "haiku"`, sends
`Run \`echo claude-bg-done\` with your shell tool, then reply OK`, disconnects
for 60 s, reconnects, and asserts `turn.completed` with no
`turn.failed`/`turn.unknown`/`turn.cancelled` after replay.

Pass criteria: script prints `PASS` (exit 0); `=== RESULT ===` shows
`turn.completed while disconnected: true` and `terminal failures: none`.
Deadline is 180 s — Claude startup is slow; do not shorten it.

Also run the provider unit suite on Windows:

```powershell
cd packages\bridge
npx vitest run test/claude-session.test.ts test/codex-session.test.ts --bail=1
```

## Test 2 — named-pipe ACL (plan §3.4.1 spike test 5)

`docs/adr/ipc-transport.md` keeps the Windows named-pipe ACL decision
PROVISIONAL until this runs. Node's `net.createServer("\\\\.\\pipe\\…")` does
not expose an ACL API — the pipe gets the process default DACL. The question
is whether that default already denies other local users.

1. Start the gateway on Windows (any e2e script above works; it stays up
   while the script runs — or run `ensureGateway` from a small node script
   that sleeps).
2. Confirm the pipe exists:

   ```powershell
   [System.IO.Directory]::GetFiles('\\.\pipe\') | Select-String chromex-gateway
   ```

   Expected name: `\\.\pipe\chromex-gateway-<sha256(dataDir)[:16]>`.
3. From a **different local user account** (create a throwaway account if
   none exists, or use `runas /user:<other> cmd`), attempt:

   ```powershell
   node -e "require('net').createConnection('\\\\.\\pipe\\chromex-gateway-<hash>').on('error',e=>{console.log('ERR',e.code);process.exit(1)}).on('connect',()=>{console.log('CONNECTED');process.exit(0)})"
   ```

   - **Denied** (`EPERM` / `EACCES`): default DACL is sufficient → record
     PASS in `docs/adr/ipc-transport.md` and flip the sub-decision to
     DECIDED.
   - **Connected**: another local user reached the gateway → the decision
     rule in plan §3.4.1 applies: fall back to `127.0.0.1` + random port +
     opaque token (`gateway.ipc.transport: "tcp"`) **for Windows only** and
     record the evidence in the ADR.
4. Same-user negative control: connect with a wrong/missing `hello.token` →
   expect `proto.auth_failed` and socket close (already covered by the POSIX
   spike; repeat once on Windows to confirm identical behavior).

If no second user account can be created on the test machine, run steps
1–2 and the wrong-token control, then mark test 5 **partial**: "pipe
created, cross-user denial unverified — needs second account".

## Test 3 — LockFileEx crash / fence (plan §3.3.2 tests 1, 2, 5 + stale fence)

Run the lock suite inside `packages/bridge`:

```powershell
cd packages\bridge
npx vitest run test/gateway.test.ts --bail=1
```

Relevant cases and Windows notes:

| Case | Windows expectation |
|---|---|
| Second acquisition of same lock → `LockHeldError` with owner metadata | PASS — `fs-ext` maps to `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK\|FAIL_IMMEDIATELY)`. |
| Release → reacquire → **new fence** | PASS. |
| Child holds lock → `taskkill /F /PID <holder>` → OS releases handle → reacquire succeeds, fence bumps | PASS — this is the Windows equivalent of POSIX kill; `LockFileEx` is released on process termination including forced kill. |
| Lock file replaced → `checkFence()` false → `StaleFenceError`, no partial writes | PASS — pure logic, platform-independent. |
| SIGSTOPped holder still owns lock (no mtime reclaim) | **POSIX-only test.** On Windows `process.kill(pid,"SIGSTOP")` is unsupported and this case cannot run as written. See manual equivalent below; if unavailable, record as env-blocked — the kill/release case above still proves `LockFileEx` semantics. |

Manual suspend equivalent (optional, needs Sysinternals `pssuspend64.exe`):

```powershell
# holder: node -e script that fs-ext-flocks <dataDir>\gateway.lock and sleeps
pssuspend64 -nobanner <holder-pid>     # suspend — lock must remain held
node acquire-attempt                   # expect LockHeldError
pssuspend64 -r <holder-pid>            # resume — still held
Stop-Process -Id <holder-pid> -Force   # OS releases → reacquire OK, fence bumps
```

Also verify the crash table row manually once: start a gateway, hard-kill it
(`taskkill /F`), confirm a second gateway instance acquires
`gateway.lock`, publishes a fresh `gateway.json` endpoint atomically, and
the old named pipe does not accept stale connections (plan §3.3.2 rows
3–5, spike test 3).

## Test 4 — PID-reuse guard / browserInstanceId (docs/adr/browser-instance.md)

Needs real Chrome + loaded extension. `resolveBrowserInstanceId` is exported
from `@codex-sidepanel/native-host` and takes `{ dataDir, ppid }` overrides,
so most of this is scriptable without Chrome.

1. **Start-time capture on Windows.** After any gateway/native-host run,
   read `<CHROMEX_GATEWAY_HOME>\browser-instance.json`. `chromePpidStartedAt`
   must be a non-empty timestamp — the implementation uses
   `(Get-Process -Id <ppid>).StartTime.ToString('o')` via PowerShell. If it
   is `""`, the CIM call failed; record the actual value and stderr.
2. **Stability within a run.** Call twice with the same ppid:

   ```powershell
   node --input-type=module -e "import {resolveBrowserInstanceId} from '@codex-sidepanel/native-host'; const d=process.env.CHROMEX_GATEWAY_HOME; console.log(await resolveBrowserInstanceId({dataDir:d, ppid:process.ppid}))"
   ```

   Same ppid + same start time → identical `browserInstanceId` (record
   contains `chromePpid`, `chromePpidStartedAt`, `browserInstanceId`).
3. **New run → new ID.** Call with a different live ppid (e.g. spawn a
   sleeper `node -e "setInterval(()=>{},1e6)"`, use its PID) → different
   `browserInstanceId`; the record file is overwritten.
4. **PID-reuse guard.** Windows has no deterministic way to force the OS to
   reuse a specific PID in a test. Verify the guard's components instead:
   (a) `chromePpidStartedAt` is populated (step 1); (b) if it were empty,
   same-ppid calls still dedupe and different-ppid calls still differ —
   confirm by reading `browser-instance.ts` fallback path and noting the
   documented limitation: empty start time widens the PID-reuse window,
   accepted under the same-user threat model (§3.4.3). Record which branch
   was exercised.
5. **Real-Chrome lifecycle (manual).** With the extension loaded:
   - Extension reload / disable→enable → `browserInstanceId` unchanged
     (Chrome run continues).
   - Fully quit Chrome (all windows, check `Get-Process chrome` is empty)
     → relaunch → new `browserInstanceId`; task bindings must surface as
     `needs_confirmation`, never auto-`stale` (plan §4.4).
   - Native host crash → reconnect → ID stable, `hostInstanceId` updated.

## SKIP conditions — record, don't fake

- **No Windows host:** mark every item above env-blocked in chromex-xki /
  chromex-2ml with date and reason. Partial credit applies: POSIX-covered
  items (lock semantics, fence, claude-session unit tests, pipe protocol
  shape) already have evidence from `docs/adr/ipc-transport.md` and
  `packages/bridge/test/gateway.test.ts`.
- **No second local user account:** pipe ACL test → run creation +
  wrong-token control only, mark cross-user denial unverified.
- **Claude Code not installed / not authenticated:** Test 1 → run
  `gateway-e2e-background.mjs` (codex) instead and mark the claude variant
  env-blocked; do not count it as a claude pass.
- **No Sysinternals `pssuspend64`:** skip the manual suspend case; the
  kill-release case still covers `LockFileEx` release semantics.
- **No interactive Chrome session:** skip Test 4 step 5 (real-Chrome
  lifecycle); steps 1–4 are scriptable headlessly.
- **`fs-ext`/native module build failure on Windows:** that itself is a
  finding — record the exact error (`node-gyp`, missing VS Build Tools) and
  mark lock + e2e items blocked, since both depend on the built `dist`.
