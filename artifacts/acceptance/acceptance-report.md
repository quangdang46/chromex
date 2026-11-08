# Chromex Acceptance Report

Generated: 2026-11-08T07:50:22.567Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-08T07-44-43-733Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-08T07-44-57-867Z |
| agent-task-headless | PASS | scripted agent loop on the REAL extension: form submitted + verified server-side; stale-snapshot recovery in-loop; screenshot+pdf+evaluate deliverables (8.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-task-headless/2026-11-08T07-45-39-669Z-44f064 |
| cdp-headless | PASS | CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get (16.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/cdp-headless/2026-11-08T07-45-22-958Z-9ed921 |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-08T07-45-57-646Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/extension-headless/2026-11-08T07-45-08-941Z-9e9b0a |
| gateway-host-routing | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-host-routing/2026-11-08T07-45-03-019Z |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-08T07-44-58-852Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world); cross-frame snapshotId refused; bad frameId fails honestly (6.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/iframe-headless/2026-11-08T07-45-15-372Z-7b6248 |
| native-host-relay | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/native-host-relay/2026-11-08T07-45-03-598Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (55.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-07T15-07-56-593Z-f2ec47 |
| s10-ui-queue-stop | PASS | UI queue held the second message; Stop cancelled the provider turn without flushing the queue (18.2s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s10-ui-queue-stop/2026-11-08T07-47-17-418Z-28b267 |
| s11-ui-queue-flush | PASS | turn.completed auto-flushed the queued message exactly once as the next turn (38.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s11-ui-queue-flush/2026-11-08T07-47-36-274Z-dd6c5c |
| s12-sw-turn-recovery | PASS | extension reload mid-turn → activeTurn restored via gateway hello → queue survived → flushed exactly once on turn.completed (83.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s12-sw-turn-recovery/2026-11-08T07-48-15-235Z-22bc19 |
| s13-risk-preflight | PASS | destructive ref-click → approval (denied→not fired, approved→danger-fired); benign ref-click → no approval, fired; trusted approve-then-mutate → browser.target_changed, handler never fired, restored-label control click fires (13.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s13-risk-preflight/2026-11-08T07-49-39-970Z-b55666 |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (55.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-07T15-19-33-697Z-b3d61d |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused (5.7s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-08T07-45-50-247Z-bfe704 |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (25.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-08T07-45-56-637Z-fa9064 |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (5.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-08T07-46-22-762Z-cd5f65 |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (5.2s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-08T07-46-29-274Z-d010db |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (7.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-08T07-47-03-885Z-683209 |
| s9-interrupt-queue | PASS | interrupt without turnId → turn.cancelled{interrupted}; queued turn auto-dispatched → turn.completed; no turn.unknown (4.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s9-interrupt-queue/2026-11-08T07-47-11-854Z-3f43d7 |
| sw-restart | FAIL | harness error: ENOENT: no such file or directory, open '/Users/tranquangdang21/Projects/chromex/packages/extension/dist/manifest.json' (0.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/sw-restart/2026-11-08T07-45-48-655Z-95c0af |

## Failures

### sw-restart

harness error: ENOENT: no such file or directory, open '/Users/tranquangdang21/Projects/chromex/packages/extension/dist/manifest.json'
