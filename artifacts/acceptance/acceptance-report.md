# Chromex Acceptance Report

Generated: 2026-11-08T07:19:33.453Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-08T07-13-02-723Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-08T07-13-17-743Z |
| agent-task-headless | PASS | scripted agent loop on the REAL extension: form submitted + verified server-side; stale-snapshot recovery in-loop; screenshot+pdf+evaluate deliverables (7.4s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-task-headless/2026-11-08T07-14-02-529Z-c06c56 |
| cdp-headless | PASS | CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get (15.2s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/cdp-headless/2026-11-08T07-13-46-596Z-d64aed |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-08T07-13-29-932Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/extension-headless/2026-11-08T07-13-32-259Z-0216ab |
| gateway-host-routing | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-host-routing/2026-11-08T07-13-25-728Z |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-08T07-13-20-331Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world); cross-frame snapshotId refused; bad frameId fails honestly (6.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/iframe-headless/2026-11-08T07-13-38-826Z-d52791 |
| native-host-relay | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/native-host-relay/2026-11-08T07-13-26-277Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (55.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-07T15-07-56-593Z-f2ec47 |
| s10-ui-queue-stop | PASS | UI queue held the second message; Stop cancelled the provider turn without flushing the queue (25.4s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s10-ui-queue-stop/2026-11-08T07-16-02-728Z-fd5687 |
| s11-ui-queue-flush | PASS | turn.completed auto-flushed the queued message exactly once as the next turn (41.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s11-ui-queue-flush/2026-11-08T07-16-28-916Z-10567a |
| s12-sw-turn-recovery | PASS | extension reload mid-turn → activeTurn restored via gateway hello → queue survived → flushed exactly once on turn.completed (90.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s12-sw-turn-recovery/2026-11-08T07-17-11-425Z-7ea28b |
| s13-risk-preflight | PASS | destructive ref-click → approval (denied→not fired, approved→danger-fired); benign ref-click → no approval, fired; trusted approve-then-mutate → browser.target_changed, handler never fired, restored-label control click fires (20.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s13-risk-preflight/2026-11-08T07-18-43-733Z-3ff8c1 |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (55.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-07T15-19-33-697Z-b3d61d |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused (7.7s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-08T07-14-21-060Z-a9c056 |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (29.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-08T07-14-29-643Z-938494 |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (7.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-08T07-14-59-641Z-15860f |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (7.2s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-08T07-15-09-358Z-9868b5 |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (9.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-08T07-15-46-024Z-309595 |
| s9-interrupt-queue | PASS | interrupt without turnId → turn.cancelled{interrupted}; queued turn auto-dispatched → turn.completed; no turn.unknown (5.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s9-interrupt-queue/2026-11-08T07-15-56-243Z-75c9bc |
| sw-restart | PASS | extension reload → new SW + NM host re-registered → calls + CDP tier recovered → post-reload click delivered exactly once (9.7s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/sw-restart/2026-11-08T07-14-10-636Z-7628f0 |
