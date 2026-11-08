# Chromex Acceptance Report

Generated: 2026-11-08T08:42:04.707Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-08T08-36-57-589Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-08T08-36-24-550Z |
| agent-task-headless | PASS | scripted agent loop on the REAL extension: form submitted + verified server-side; stale-snapshot recovery in-loop; screenshot+pdf+evaluate deliverables (9.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-task-headless/2026-11-08T08-37-16-057Z-05711a |
| cdp-headless | PASS | CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get (21.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/cdp-headless/2026-11-08T08-36-53-372Z-98b65c |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-08T08-36-34-065Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/extension-headless/2026-11-08T08-36-35-952Z-0011f0 |
| gateway-host-routing | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-host-routing/2026-11-08T08-36-29-972Z |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-08T08-36-25-906Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world + open shadow DOM); cross-frame snapshotId refused; bad frameId fails honestly (10.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/iframe-headless/2026-11-08T08-36-42-121Z-5d671a |
| native-host-relay | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/native-host-relay/2026-11-08T08-36-30-537Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (55.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-07T15-07-56-593Z-f2ec47 |
| s10-ui-queue-stop | PASS | UI queue held the second message; Stop cancelled the provider turn without flushing the queue (15.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s10-ui-queue-stop/2026-11-08T08-39-03-483Z-97f191 |
| s11-ui-queue-flush | PASS | turn.completed auto-flushed the queued message exactly once as the next turn (38.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s11-ui-queue-flush/2026-11-08T08-39-19-291Z-e2d43d |
| s12-sw-turn-recovery | PASS | extension reload mid-turn → activeTurn restored via gateway hello → queue survived → flushed exactly once on turn.completed (83.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s12-sw-turn-recovery/2026-11-08T08-39-58-640Z-808d66 |
| s13-risk-preflight | PASS | destructive ref-click → approval (denied→not fired, approved→danger-fired); benign ref-click → no approval, fired; trusted approve-then-mutate → browser.target_changed, handler never fired, restored-label control click fires (13.4s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s13-risk-preflight/2026-11-08T08-41-22-478Z-ea7b6c |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (55.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-07T15-19-33-697Z-b3d61d |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused; popup acquired into opener's scope (7.2s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-08T08-37-35-124Z-1bcf2c |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (25.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-08T08-37-42-983Z-ab4177 |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (5.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-08T08-38-09-043Z-1cc423 |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (5.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-08T08-38-15-566Z-3a834b |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (7.2s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-08T08-38-50-080Z-922216 |
| s9-interrupt-queue | PASS | interrupt without turnId → turn.cancelled{interrupted}; queued turn auto-dispatched → turn.completed; no turn.unknown (5.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s9-interrupt-queue/2026-11-08T08-38-57-973Z-445470 |
| sw-restart | PASS | extension reload → new SW + NM host re-registered → calls + CDP tier recovered → post-reload click delivered exactly once (8.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/sw-restart/2026-11-08T08-37-25-816Z-4fa3e3 |
