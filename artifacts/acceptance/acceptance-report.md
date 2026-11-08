# Chromex Acceptance Report

Generated: 2026-11-08T08:10:39.732Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-08T08-04-36-541Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-08T08-04-50-526Z |
| agent-task-headless | PASS | scripted agent loop on the REAL extension: form submitted + verified server-side; stale-snapshot recovery in-loop; screenshot+pdf+evaluate deliverables (9.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-task-headless/2026-11-08T08-05-51-058Z-36ffc3 |
| cdp-headless | PASS | CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get (23.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/cdp-headless/2026-11-08T08-05-26-267Z-9a7abd |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-08T08-05-00-754Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/extension-headless/2026-11-08T08-05-04-476Z-4b4bf5 |
| gateway-host-routing | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-host-routing/2026-11-08T08-04-56-391Z |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-08T08-04-51-837Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world); cross-frame snapshotId refused; bad frameId fails honestly (11.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/iframe-headless/2026-11-08T08-05-14-417Z-32003d |
| native-host-relay | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/native-host-relay/2026-11-08T08-04-56-980Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (55.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-07T15-07-56-593Z-f2ec47 |
| s10-ui-queue-stop | PASS | UI queue held the second message; Stop cancelled the provider turn without flushing the queue (16.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s10-ui-queue-stop/2026-11-08T08-07-42-635Z-d83e50 |
| s11-ui-queue-flush | PASS | turn.completed auto-flushed the queued message exactly once as the next turn (37.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s11-ui-queue-flush/2026-11-08T08-07-59-921Z-4c9247 |
| s12-sw-turn-recovery | PASS | extension reload mid-turn → activeTurn restored via gateway hello → queue survived → flushed exactly once on turn.completed (77.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s12-sw-turn-recovery/2026-11-08T08-08-38-269Z-1008f1 |
| s13-risk-preflight | PASS | destructive ref-click → approval (denied→not fired, approved→danger-fired); benign ref-click → no approval, fired; trusted approve-then-mutate → browser.target_changed, handler never fired, restored-label control click fires (14.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s13-risk-preflight/2026-11-08T08-09-56-596Z-55c94e |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (55.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-07T15-19-33-697Z-b3d61d |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused; popup acquired into opener's scope (8.4s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-08T08-06-12-108Z-b69a81 |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (26.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-08T08-06-21-148Z-6719df |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (5.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-08T08-06-47-504Z-bb882f |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (5.2s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-08T08-06-53-987Z-e0b807 |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (7.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-08T08-07-28-561Z-9a3f77 |
| s9-interrupt-queue | PASS | interrupt without turnId → turn.cancelled{interrupted}; queued turn auto-dispatched → turn.completed; no turn.unknown (5.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s9-interrupt-queue/2026-11-08T08-07-36-503Z-c17a92 |
| sw-restart | PASS | extension reload → new SW + NM host re-registered → calls + CDP tier recovered → post-reload click delivered exactly once (9.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/sw-restart/2026-11-08T08-06-01-648Z-06ddc9 |
