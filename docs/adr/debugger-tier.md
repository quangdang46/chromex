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
input, response bodies + WebSocket frames, real a11y) funnels through one mechanism:
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
- `Network.webSocketCreated` / `webSocketFrameSent` /
  `webSocketFrameReceived` / `webSocketClosed` — WebSocket
  connections + frame payloads (`payloadData`) retrievable.
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
  (`browser.page.responseBody`), `webSocketFrames: true`
  (`browser.page.webSocket` — connections + sent/recv frame payloads,
  captured only after the tap attaches, per-frame 8KiB truncation),
  `requestInterception: true` (`browser.page.route`/`unroute` — CDP
  Fetch.enable request-stage interception fulfilled with agent-supplied
  responses; rules tab-scoped, ≤50/tab, held session like emulation,
  do not survive SW restart). `trustedGesture` is `true` — every
  gesture-bearing tool has a verified `args.trusted` path:
  `browser.page.click` (Input.dispatchMouseEvent), `press`/`type`/`fill`
  (Input.dispatchKeyEvent, shared US-layout key table; fill = focus →
  select-all → Backspace → per-char keys), `hover` and `drag` (mouse
  move / press→moves→release). Element targets are focused/located
  through the content script first. All six trusted ops accept
  `args.frameId`. Keyboard ops (press/type/fill) focus the element
  through that frame's content script and CDP key events follow the
  focused frame. Pointer ops (click/hover/drag) resolve element
  targets to absolute viewport coordinates through a content-script
  postMessage geometry chain (`content/frame-geometry.ts`) — every
  frame answers "where is the iframe hosting you?" with its rect plus
  its own cumulative offset, so nested, cross-origin and
  out-of-process iframes all resolve in one hop; `page.geom.absolute`
  fails `browser.timeout` honestly when the chain cannot be reached.
  Verified by `cdp-headless`: `key:x,trusted:true` and
  `down:true up:true` (isTrusted mousedown/mouseup) inside both the
  same-origin and cross-origin iframe fixtures. Coordinate-form
  pointer args are already viewport pixels and ignore frameId.
  select/submit/scroll/focus/
  navigate/wait/find and in-memory `browser.page.upload` stay
  programmatic — not gestures.
  `filePicker` stays `false` —
  `browser.page.setInputFiles` writes `input.files` by path; the native
  picker UI remains unreachable. `setInputFiles` also accepts
  `args.frameId`: the content script marks the resolved element
  (`page.dom.mark`) and a pierced `DOM.getDocument` finds the node —
  verified inside a same-origin iframe (`cdp-headless`). Out-of-process
  iframes are invisible to the tab's DOM agent, so the handler falls
  back to the frame's own debugger target: `chrome.debugger.getTargets`
  is matched to the frame's webNavigation URL (OOPIF targets report
  type `iframe` or `other` depending on build), the target is attached
  as `{targetId}`, and its DOM domain — scoped to that frame's document
  — runs the same querySelector + setFileInputFiles. Verified
  end-to-end against a cross-origin (localhost vs 127.0.0.1) iframe
  fixture (`cdp-headless` `oopifSetInputFiles`).
  `browser.page.screenshot` also accepts an element target
  (ref/selector/label, optional `args.frameId`): the element is
  scrolled into view, located through the same geometry path, and
  clipped via `Page.captureScreenshot` — verified inside an iframe in
  `cdp-headless`. Whole-tab capture stays on `captureVisibleTab`;
  `playwright-isolated` rejects element clips `proto.unsupported`.
- `browser.page.pdf` prints the tab via `Page.printToPDF` — bytes go to
  the artifact store only (no inline payload); scale retries 1→0.45
  until ≤512KiB decoded, then `proto.payload_too_large`. playwright-
  isolated implements via `page.pdf` with the same bound.
- `browser.page.emulate` applies CDP `Emulation.*`/`Network.emulateNetworkConditions`
  overrides (viewport, UA, timezone, geolocation, media, CPU throttle,
  network conditions). Overrides are session-scoped, so emulate HOLDS the
  debugger attach until `args.reset:true` or tab close — the infobar
  stays while emulation is active. Verified headless: 390px viewport +
  dark `prefers-color-scheme` observed via evaluate, reset restores.
  playwright-isolated supports only viewport + media keys and refuses
  the rest `proto.unsupported`.
- CDP-only tools (`browser.page.dialog`, `browser.page.setInputFiles`,
  `browser.page.responseBody`, `browser.page.webSocket`,
  `browser.page.route`, `browser.page.unroute`) exist only on
  the chrome-extension backend; `playwright-isolated` rejects them `proto.unsupported` —
  honest negative, no silent downgrade.
- No `chrome.debugger` use for page scraping — CDP is for operations
  DOM-tier cannot do; observation stays on the cheaper paths.
- Playwright backend unchanged (it already has CDP-level power).
