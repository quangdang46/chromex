# ADR: chrome.debugger (CDP) tier for the extension backend

Status: IMPLEMENTED (spike evidence 2026-11-08, headless implementation
verified same day via `cdp-headless` acceptance — all five CDP
capabilities end-to-end on the real built extension)

## Why

The DOM-tier backend honestly reports `isTrusted=false` everywhere:
content-script events cannot satisfy trusted-gesture checks, JS dialogs
are unreachable, `input[type=file]` picks need the DataTransfer
workaround, `webRequest` yields metadata only (no bodies), and there is
no accessibility tree. Every remaining capability gap in
`docs/product-acceptance-matrix.md` (dialogs, file picker, trusted
input, response bodies, real a11y) funnels through one mechanism:
`chrome.debugger` → CDP.

## Spike evidence (`scripts/spike/cdp-tier.mjs` — 11/11)

Driven from a real extension page (`chrome.debugger` API surface is
identical in the SW) against the built extension in headless Chrome
for Testing:

- `chrome.debugger.attach({tabId}, "1.3")` / `detach` — works.
- `Accessibility.getFullAXTree` — real AX tree returned (nodes with
  `role.value`, names) — the true a11y snapshot, not a DOM approximation.
- `Network.enable` + `Network.responseReceived` +
  `Network.getResponseBody` — full response bodies retrievable.
- `DOM.setFileInputFiles` — `input.files` populated with real File
  objects (verified via `onchange` → filename in DOM).
- `Page.javascriptDialogOpening` + `Page.handleJavaScriptDialog` —
  alert handled (`accept:true`). Caveat found: Playwright's own CDP
  session auto-dismisses dialogs when no `page.on('dialog')` listener
  exists — a test-harness artifact only; production has no competing
  session. Dialogs must be handled inside the `onEvent` callback
  (headless dismisses fast).
- `Input.dispatchMouseEvent` — **`event.isTrusted === true`** proven by
  a fixture button writing `isTrusted` into the DOM; control synthetic
  `.click()` reports `false`. This is the trusted-gesture unlock.

## Decision

- Add `"debugger"` to manifest permissions (done).
- CDP access is a **capability tier**, not a parallel backend: the
  chrome-extension backend keeps DOM-tier tools as default; new
  `args`/tools opt into CDP per call, behind the existing §4.8
  classifier + approval + task/tab scope gates. Debugger-tier actions
  classify at least as strictly as their DOM equivalents (trusted
  input and dialog/file mutation are never `allow_task`-eligible
  beyond the existing sensitive rules).
- Attach policy: lazy per-tab attach on first CDP call, refcounted;
  detach when the last scoped task releases the tab or the tab closes
  (Chrome auto-detaches on close). Re-attach is idempotent
  (`already attached` → reuse).
- SW restart: `chrome.debugger` sessions belong to the extension, not
  the SW — verify in `sw-restart`-style scenario; if Chrome drops them,
  the client re-attaches lazily on next call (self-healing, same
  pattern as content-script injection). VERIFIED: `sw-restart`
  passes with the debugger permission present; the tool host's CDP
  dep injection makes re-attach lazy per call regardless.
- Page-domain deadlock (found in implementation, worth the note):
  `Page.handleJavaScriptDialog` only acts on dialogs Chrome's Page
  agent is already tracking, and `Page.enable` itself hangs behind an
  already-open modal dialog. The session therefore issues `Page.enable`
  eagerly once per attach (fire-and-forget, before any tool call can
  open a dialog) and records `pageEnabled` per tab — see
  `packages/extension/src/background/cdp.ts` and the dialog path in
  `gateway/tool-host.ts`.
- Infobar: Chrome shows "Chromex is debugging this browser" on attached
  tabs. Accepted: it is honest signaling while the agent owns the tab,
  and attach is scoped to task-bound tabs only.

## Consequences / non-goals

- Capability claims (updated after `cdp-headless` PASS, not before):
  `accessibility: true` (snapshot `mode:"aria"`), `nativeDialogs: true`
  (`browser.page.dialog`), `networkBodies: true`
  (`browser.page.responseBody`). `trustedGesture` is `true` — every
  gesture-bearing tool has a verified `args.trusted` path:
  `browser.page.click` (Input.dispatchMouseEvent), `press`/`type`/`fill`
  (Input.dispatchKeyEvent, shared US-layout key table; fill = focus →
  select-all → Backspace → per-char keys), `hover` and `drag` (mouse
  move / press→moves→release). Element targets are focused/located
  through the content script first. select/submit/scroll/focus/
  navigate/wait/find and in-memory `browser.page.upload` stay
  programmatic — not gestures.
  `filePicker` stays `false` —
  `browser.page.setInputFiles` writes `input.files` by path; the native
  picker UI remains unreachable.
- CDP-only tools (`browser.page.dialog`, `browser.page.setInputFiles`,
  `browser.page.responseBody`) exist only on the chrome-extension
  backend; `playwright-isolated` rejects them `proto.unsupported` —
  honest negative, no silent downgrade.
- No `chrome.debugger` use for page scraping — CDP is for operations
  DOM-tier cannot do; observation stays on the cheaper paths.
- Playwright backend unchanged (it already has CDP-level power).
