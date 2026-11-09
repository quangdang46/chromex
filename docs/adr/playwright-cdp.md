# ADR: playwright-cdp backend (attach to running Chrome via CDP)

Status: SPIKE PROVEN (`scripts/spike/cdp-attach.mjs`, 10/10 checks,
darwin arm64, playwright-core 1.59.1, headless Chromium). Executor NOT
implemented — research backlog per plan §backend matrix.

## What the spike proved

Launching Chromium with `--remote-debugging-port` then
`chromium.connectOverCDP("http://127.0.0.1:PORT")` gives a working
agent surface on the SAME browser the launcher sees:

- existing user tabs are visible in `browserContext.pages()`
- observe (DOM read), act (DOM mutation), verify (read-back) all work
  on a user tab through the attached connection
- the attached connection can open its own tabs
- trusted input (`page.click`, `keyboard.press`) dispatches normally

So the mechanics a `playwright-cdp` executor needs are real — this is
not blocked on Playwright capability.

## Constraints discovered (design inputs, not yet solved)

1. **Split-brain connections.** Two playwright connections to the same
   browser have SEPARATE context/page views: pages created via the CDP
   attach are invisible to the launching connection (verified). The
   backend must therefore be the ONLY playwright client of that browser
   — which is naturally true (one gateway, one backend handle), but
   rules out "attach while something else playwright-drives it".

2. **Chrome requires the flag at launch.** `connectOverCDP` cannot
   attach to a Chrome that wasn't started with
   `--remote-debugging-port`. Since Chrome 136, remote debugging is
   additionally ignored on the *default* user-data dir — attaching to a
   user's everyday profile requires a dedicated `--user-data-dir`,
   which means it is NOT the user's real session. Honest capability
   claim: `existingUserSession` is only true for Chrome instances the
   user explicitly launched with debugging enabled on a non-default
   profile. The extension backend remains the only path to the real
   default-profile session.

3. **No task isolation primitive.** `playwright-isolated` gets isolation
   from `browser.newContext()`; a CDP-attached browser exposes the
   user's real contexts/pages. Tab scope must be enforced purely by
   `TaskTabScope` bookkeeping — and "which tabs are the agent's" is
   ambiguous when the user also drives the browser. Needs an ownership
   convention (e.g. agent-created pages tagged/named, or per-task
   target filter) before `execute()` can honestly claim scope.

4. **Overlap with chrome-extension backend.** Both can drive a real
   browser. playwright-cdp's unique value is *no extension required* —
   useful for Chrome variants where extensions are unavailable
   (e.g. managed/enterprise, or driving a separate automation profile).
   It is not a replacement for the extension path.

## Executor sketch (when scheduled)

- `PlaywrightCdpBackend implements BrowserBackend` in
  `packages/bridge/src/browser/backends/playwright/cdp.ts`
- Lifecycle: resolve CDP endpoint (config `cdpEndpoint` or
  `chromium.launch({args:[--remote-debugging-port]})` for a dedicated
  automation profile) → `connectOverCDP` → hold single connection
- Reuse `isolated.ts` page-level op implementations where the API
  surface matches (locator/evaluate/input are identical); fork only
  context/page lifecycle + scope enforcement
- Capabilities must be declared conservatively: no per-task isolated
  profile, `existingUserSession` only per constraint 2, dialogs/
  fileChooser per-page like isolated (Playwright auto-handles on the
  attached session)
- `attachToRunningChrome: true` stays gated until an acceptance leg
  proves observe→act→verify→recover on a real attached Chrome
