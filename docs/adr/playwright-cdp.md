# ADR: playwright-cdp backend (attach to running Chrome via CDP)

Status: IMPLEMENTED (executor shares the full playwright-isolated
page-ops over connectOverCDP — acquisition is the only difference;
per-task browser.newContext() over CDP gives fresh storage partitions,
verified end-to-end on real Chromium: navigate/evaluate/click/tabs.list,
per-task isolation, user tab not surfaced, attached browser survives
backend.close()). Spike evidence: scripts/spike/cdp-attach.mjs 10/10.
Unit tests: packages/bridge/test/browser/playwright-cdp.test.ts.
Gated: backend.playwright.enabledByUser + cdpEndpoint (config
browser.playwright.cdpEndpoint or CHROMEX_CDP_ENDPOINT env) +
allowedBackends must include it. Acceptance: gateway-mcp-cdp scenario
(15 asserts — real gateway + mcp-stdio + connectOverCDP browser:
opt-in gate, form submit e2e, per-task context isolation, user-tab
non-leak, purge survival).

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

3. **Isolation RESOLVED at implementation time.** The spike-era
   assumption that CDP attach has no isolation primitive was wrong:
   `connectOverCDP` supports `browser.newContext()` (Playwright creates
   a real browser context target — fresh storage partition, verified
   end-to-end: taskB sees zero of taskA's tabs). The executor therefore
   reuses the isolated backend's per-task `#contextFor` unchanged —
   one isolated context per task. The attached browser's own default
   context is never surfaced to tools.

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
