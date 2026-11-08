# Chromex Product Master Acceptance Matrix

North Star: **A coding agent that owns the browser** — the user hands
over a goal; the agent plans, operates browser + coding tools, verifies
results, recovers from failure, and delivers evidence. "Own" means the
agent is the coordinating subject; authority stays behind policy,
permissions, and user approval.

Rule: no capability counts as done until an end-to-end user scenario
passes on a real browser. APIs, classes, and unit tests are necessary,
not sufficient.

## Acceptance scenarios (MVP gate)

| # | Scenario | Pass evidence | Latest real-browser result |
|---|----------|---------------|----------------------------|
| S1 | Build a web feature: understand → edit files → run app → drive UI → iterate → report | Real run: diff + test output + browser verification of the feature | **PASS** (2026-11-07, codex): navigate→snapshot→click→get→extract×3, 7/7 classified, `artifacts/acceptance/s1-build-feature/` |
| S2 | Debug a live website: observe page → locate cause in code → fix → reproduce → verify | Real run on a logged-in tab with an actual bug | **PASS**: agent edited code, re-drove real browser, verified token end-to-end |
| S3 | Multi-tab/multi-app work without scope bleed | Task A and B concurrently on different tabs; no cross-talk | **PASS** (headless Chromium, real ext): two tasks held isolated tab scopes; cross-task tab access refused (`browser.not_in_scope`); **popup acquisition**: task A's `target=_blank` click reported `openedTabs[]` and the new tab entered A's scope (`page.get` → "Popup Target Page") while staying `not_in_scope` for B |
| S4 | Real web workflow: logged-in session, multi-step form, file use, auth handoff (CAPTCHA/MFA → user) | Real run on a real web app | BLOCKED-by-design — requires real credentials/site; manual runbook: `docs/s4-manual-runbook.md` |
| S5 | Interruption recovery: close panel / kill SW / restart gateway mid-turn → resume without duplicate actions | kill -9 style test + live run | **PASS** (headless Chromium, real ext, 2026-11-08): gateway SIGKILL → respawn → extension host re-registered → calls completed; replayed toolCallId deduped (`browser.duplicate_tool_call`), no double dispatch. Fixes: `040b328`/`e5c8702` conn routing, `371fe7a` durable dedup, native-host self-heal + per-socket hello + stable token (`a953e3c`) |
| S6 | Failed plan: stale selector / UI change / tool failure → re-observe, re-plan, continue; never fake success | Injected failure run | **PASS** (headless Chromium, real ext): stale `snapshotId` rejected loudly (`browser.stale_snapshot`), re-observe + retry succeeded |
| S7 | Protection: sensitive actions (send/post/delete/pay) → contextual approval; denial is honored, never bypassed | Approval-flow run incl. deny path | **PASS** (headless Chromium, real ext): deny→`browser.approval_denied`, allow→navigated, permission.resolved×2 |
| S8 | Verifiable deliverable: diff, changed files, test results, browser evidence, known limits | Deliverable rendered in sidepanel | **PASS** (headless Chromium, real ext): task.sync carries full tool evidence (started/completed/classified per call); sidepanel renders composer UI |
| S9 | Stop + message queue: interrupt a running turn (no turnId), queued follow-up auto-dispatches, never fakes success | Deterministic provider-path run | **PASS** (2026-11-08, fake ACP agent + real gateway): `task.send` during running turn → `queued:true`; `turn.interrupt` without turnId → `turn.cancelled{interrupted}`; queued turn → `turn.completed`; zero `turn.unknown`. Codex adapter fix `97cdead` (keep turn bound until terminal notification) |
| S10 | Stop + composer queue through the real sidepanel UI | Headless Chrome for Testing + built extension + fake ACP provider | **PASS** (2026-11-08): sidepanel-as-tab composer send → running turn → `#stop-turn` visible → second send lands in `.composer-queue` (not steer) → Stop click → `turn.cancelled` gateway-side, queue strip + `chrome.storage.local` entry retained, zero `turn.failed`/`turn.unknown`. Required fixes: `message-guard` extension-page-with-tab classification, gateway `turn.interrupt` legacy `threadId` payload, `task.create` profileId defaulting to bare providerId (non-codex providers were silently rerouted to codex) |
| S11 | Composer queue auto-flush on normal turn completion | Headless Chrome for Testing + built extension + fake ACP provider | **PASS** (2026-11-08): second composer send during turn 1 → `.composer-queue` + `chrome.storage.local` → `turn.completed` → queued message auto-sent as turn 2 → second `turn.completed`; queue storage emptied, zero `turn.cancelled`/`turn.failed`/`turn.unknown`. Fixed silent-drop gap: Enter-key guard and send guard only allowed steer when `state.activeTurn` was set, so sends during the promptActivity/pending-request window (before `turn.started` lands) were discarded — queue eligibility now uses `isPromptTurnInFlight()`. Reload leg: sidepanel reloaded mid-turn → queue rehydrated from `chrome.storage.local` (moved off `storage.session` — `chrome.runtime.reload()` wipes session storage), `activeTurn` restored via ui.init (gateway `turn.started` is now broadcast live + `activeTurnId` hello fallback), reconcile held the queue until `turn.completed` → flushed exactly once |
| S12 | Full extension reload (`chrome.runtime.reload` → MV3 SW death) mid-turn with queued message | Headless Chrome for Testing + built extension + fake ACP provider | **PASS** (2026-11-08): gateway turn established (task + activeTurnId polled gateway-side before reload — #stop-turn alone only proves pending UI) → `chrome.runtime.reload()` → new SW → task still `active` on gateway, queue entry survived in `chrome.storage.local`, `ui.init` restored `threadId` + `activeTurn` from hello `activeTurnId`, queue strip held (no early flush) → `turn.completed` → queued message flushed exactly once → second `turn.completed`; zero `turn.cancelled`/`turn.failed`/`turn.unknown`. Cold-SW fixes: `GatewayRuntime.ready()` awaited before `gateway.tasks`/active-turn reads so hello+syncAll seed task views first; all gateway-synthesized durable events (`task.created`/`status_changed`/`completed`/`cancelled`, `turn.*` terminals, `user.message.created`) now persist AND live-publish via `#publishLive`; flush requeues the entry unless `sendPrompt` definitively accepts it (`onPromptAccepted`) |

| S13 | §4.8 ground-truth target preflight on real extension | Headless Chrome for Testing + built extension + fixture `/risky` | **PASS** (2026-11-08): snapshot mints refs → `browser.page.click` with bare `{ref, snapshotId}` (no label in args) on the "Delete account permanently" button → `permission.requested` kind=`browser_action` carrying `targetLabel` resolved from the real DOM → deny → `browser.approval_denied`, `#out` stays `idle` (handler never fired) → re-click + approve once → `completed`, `#out`=`danger-fired` (real DOM mutation verified) → benign "Search" ref click → `completed` with zero new approvals, `#out`=`benign-ok`. Proves the describeTarget preflight feeds real element facts (label/origin/input type/form method) into `classifyActionRisk` — agent args can no longer hide a destructive target |

Evidence root: `artifacts/acceptance/<scenario>/<runId>/{result.json,events.jsonl,task.sync.*.json,screenshots/}`. Harness: `scripts/acceptance/`.

## Capability → component → gap map

| Capability | Owner | Status | Gap / bead |
|---|---|---|---|
| Durable tasks/turns/events/recovery | bridge gateway | ✅ built + tested | S5 PASS headless real-ext: SIGKILL → respawn → host re-register → dedup verified; `sw-restart` PASS: chrome.runtime.reload → new SW + NM host re-registered → calls recovered, click delivered exactly once |
| Provider abstraction codex/claude/acp | bridge agents | ✅ built | live ACP creds blocked (436) |
| Browser tool server + scope + approvals | bridge browser + ext tool-host | ✅ built | egress UX (b1h) |
| Tab lifecycle: list/create/activate/close/duplicate/update(pinned/muted/zoom)/discard + popup acquisition (click/submit/trusted click+press/evaluate → `openedTabs[]` → scope harvest) | ext tool-host | ✅ 7 tools (07cf2e4, c42040d, cd8b05e, f04d70a) + popup report | lifecycle completeness edge cases |
| Window management: windows.list/create/update | ext tool-host + chrome.windows | ✅ 3 tools (16045c8) | agent can spawn dedicated window; first tab enters scope |
| Page observation: snapshot/get/extract/screenshot/console/network | ext tool-host + content | ✅ console, screenshot→image, webRequest metadata log (+frameId filter), extract selector+html, scroll pos, snapshot truncated flag, URL query/hash stripped everywhere; **iframes verified headless** (`iframe-headless`: frameId snapshot+click inside same- AND cross-origin frames, per-frame snapshotIds, cross-frame snapshot refused, bad frameId fails honestly) → capability now `iframe:"all"`; **CDP tier verified headless** (`cdp-headless`): `snapshot mode:"aria"` real AX tree, element-targeted screenshot clips (incl. inside iframes), `browser.page.responseBody` tap+get; **open Shadow DOM verified** (`content-script-isolated` /shadow leg): snapshot/find/extract/wait/describe/actions all traverse open roots incl. nested; closed roots fail `browser.element_not_found` honestly; `setInputFiles` marker+pierce path crosses shadow boundaries | no a11y tree option on DOM mode; closed shadow roots unreachable by design |
| Page interaction: click(+button/clickCount/modifiers/**x,y coords**/**trusted**)/focus/type(real append)/fill/select(+values multi)/submit/scroll/navigate/wait(+readyState+networkIdle+visibleSelector)/upload/hover(+coords/+**trusted**)/press(+**trusted**)/type(+**trusted**)/drag(+coords/+**trusted**)/find/history + downloads.list/save(+waitForCompletion)/cancel + dialog/setInputFiles/responseBody (CDP tier) + evaluate (MAIN-world JS, always approval) + emulate (CDP viewport/UA/timezone/geo/media/CPU/network overrides, session-held until reset; **playwright-isolated parity** — same Emulation.* commands via per-page CDP session, verified UA/timezone/deviceScaleFactor in-page + reset in `agent-loop-isolated`) + pdf (Page.printToPDF → artifact, scale-retry under 512KiB cap) | ext tool-host + content + cdp.ts | ✅ 27 tools; **CDP tier verified headless** (`cdp-headless`): trusted click+press+type+fill+hover+drag `isTrusted:true` (incl. inside same- AND cross-origin iframes), real :hover CSS, JS dialog accept, file input by path | untrusted-event paths on non-click/press/type/fill/hover/drag tools; pointer gate now covers visibility AND center-point occlusion (`elementFromPoint` pierced through open shadow roots, `content-script-isolated` /occluded + /shadow legs); `element_not_visible` is retryable pre-dispatch; cancel is profile-wide → always approval |
| Browser↔MCP tool surface for providers | bridge mcp-server + session-manager + mcp-call | ✅ wired per task; agent steering verified | `initialize.instructions` (own-the-browser + snapshot-first) reaches native-MCP providers automatically; `mcp-call.js --list` now prints the same instructions + enum values so the CLI-fallback path self-corrects; unknown-tool errors append the tool list; `page.get` documents origin+path URL stripping + `evaluate 'location.href'` escape hatch |
| Coding tools (fs/shell/git) | provider-native (codex/claude) | ✅ via provider | verify in gatewayMode tasks |
| Browser↔code feedback loop | composition | ✅ E2E proven | S1 + S2 PASS real-browser; loop proof cbbda36/6e690ab |
| Prompt-injection defense | page content → agent boundary | ✅ fenced (af60f2b, cd3cf46, e5b9531, 3c5c4f9) + dispatch binding | envelope on results AND tool-error text; label-defuse + planner marking; §4.8 classifier sees ground-truth element facts (423c0b1) AND those facts are re-verified at dispatch on ALL paths (`expectedTarget` → `browser.target_changed` on drift — closes the approve-then-mutate TOCTOU): DOM steps + trusted/CDP locate/describe/geom (incl. post-scroll and post-frame-offset rechecks, targetless activeElement verify) on chrome-extension; in-page re-derivation on playwright-isolated |
| Permission/audit/revoke | approvals + tool tokens | ✅ built | S7 PASS real-browser; egress consent landed (d4e5429); §4.8 classifier now sees ground-truth element context via describeTarget preflight (423c0b1) — ref-targeted clicks can't hide destructive labels/payment origins/password fields |
| UX: timeline/approvals/questions/elapsed/deliverable | sidepanel | ✅ deliverable card (9cbdcb7) | approval-card-for-all-kinds + verified badge + rebuild notice in flight |
| Backend capability honesty | shared backend.ts | ✅ truthful | update as capabilities land |

## Workstream beads (this matrix)

- Browser runtime depth: LANDED — debugger/CDP tier implemented and
  verified headless (`cdp-headless`: aria AX snapshot, trusted click,
  JS dialog accept, setInputFiles by path, responseBody tap+get, webSocket frame capture, route/unroute fulfill+abort+modify+restore; see
  docs/adr/debugger-tier.md). Trusted paths now cover click, press,
  type, fill, hover and drag — including inside same-origin and
  cross-origin iframes via the content-script geometry chain.
  `setInputFiles` reaches out-of-process iframes through their own
  debugger targets (`cdp-headless` `oopifSetInputFiles` PASS).
  `browser.page.evaluate` runs arbitrary JS in the page MAIN world —
  unblocked from the day-one hard-block once the scripting tier landed;
  every call requires approval (expression previewed in argsPreview),
  frameId reaches OOPIFs (`iframe-headless` evaluate leg PASS), and the
  result is page-text egress class. Residual: an approved expression
  can trigger in-page side effects no tool gate observes.
  Native file picker still unreachable; headful re-verify pending
  (real Chrome S1–S8 gated on acceptance token)
- Agent loop proofs: `agent-loop-isolated`/`agent-loop-mcp-isolated`
  (playwright backend) AND `agent-task-headless` PASS — a scripted
  observe→act→verify→recover→deliver loop on the REAL extension:
  form submitted + verified server-side, in-loop stale-snapshot
  recovery, screenshot+pdf+evaluate deliverables.
  `agent-loop-isolated` scenario PASS — scripted
  provider-style iteration on headless chromium (form submit verified
  server-side + honest-failure check); runs in `run-all` without a token.
  `agent-loop-mcp-isolated` PASS — same loop through the real MCP path:
  JSON-RPC tools/call → scope allowlist + untrusted fencing → tool
  server (token verify, §4.8 classify + approval) → backend → Chromium.
  `content-script-isolated` PASS — the real bundled content.js injected
  into headless Chromium behind a chrome.* stub, driven via the actual
  runtime.onMessage API: snapshot refs, pointer-sequence actions,
  per-char type, DataTransfer upload/drag, wait conditions, honest
  failure on hidden targets; **upload drop-zone fallback**: target
  without a file input gets a real dragenter/dragover/drop carrying
  File objects, reported `via:"drop"` (acceptance page-defined) on
  both extension and playwright-isolated backends (62 asserts);
  **tool parity additions**: playwright-isolated now also serves
  tab.duplicate (shared context = session carry-over, fresh DOM),
  page.setInputFiles (absolute paths, input-only), downloads.cancel
  (honest no-op on finished) — verified in `agent-loop-isolated`
  `gateway-mcp-isolated` PASS — the full provider path without user
  Chrome: real in-process Gateway + spawned mcp-stdio.js child +
  JSON-RPC over stdio → IPC browser.tool.call → tool server (HMAC
  token, §4.8 classify, permission.respond approval) →
  playwright-isolated → Chrome for Testing (15 asserts)
  `gateway-host-routing` PASS — the chrome-extension dispatch path
  without user Chrome: fake host registers via the real hello protocol
  (hostInstanceId/browserInstanceId), MCP tool calls route through
  host registry → browser.tool.request → typed result; proves tabScope
  payload, browserInstanceId scope isolation (browser.no_host),
  host-loss → stranded → re-registration recovery (21 asserts)
  `native-host-relay` PASS — the REAL native-host process in gateway
  mode, driven over actual Native Messaging stdio framing: extension
  hello without token → host injects token + hostInstanceId +
  browserInstanceId → MCP tool call round-trips browser.tool.request
  down to the "extension" and back; kill → browser.no_host → respawn
  → recovery; **gateway kill → native-host self-heals with zero
  extension traffic** (conn close → proactive reconnect → ensureGateway
  respawns gateway → cached hello re-registers host → calls recover,
  sqlite store keeps task + durable events) (11 asserts)
  `extension-headless` PASS — the BUILT extension loaded in headless
  Chrome for Testing (new headless runs MV3 SWs): real service worker
  registers as browser host over the acceptance NM manifest → MCP
  browser.page.get / page.snapshot / tabs.list all complete through
  MCP → gateway → native host → SW → content script (no windows, no
  token). s3/s5/s6/s7/s8 now run the same headless path by default
  (`CHROMEX_ACCEPTANCE_HEADFUL=1` + token restores headful); only
  s1/s2 (live provider) stay token-gated
  `iframe-headless` PASS — frameId end-to-end on the real extension:
  page.get frames[] discovery, per-frame snapshot mints refs,
  click lands inside BOTH a same-origin and a cross-origin
  (localhost vs 127.0.0.1) iframe — both fetch beacons observed;
  top-frame snapshotId aimed at a child frame refused with
  browser.stale_snapshot; frameId=99999 fails honestly (capability
  promoted to iframe:"all" for http(s) frames)
  `sw-restart` PASS — chrome.runtime.reload() kills the MV3 service
  worker and orphans every content script: new SW appears, NM host
  re-registers as browser host (authed conns back to 2), page.get →
  snapshot → click all complete with zero user action, and the
  post-reload click lands exactly once on a counter fixture (no
  duplicate listeners)
- Browser↔code loop: S1/S2 scripted scenarios
- Injection defense audit + content fencing
- Deliverable/evidence rendering (S8)
