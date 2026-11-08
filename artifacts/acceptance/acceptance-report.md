# Chromex Acceptance Report

Generated: 2026-11-08T02:25:05.627Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-08T02-21-54-327Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-08T02-22-08-287Z |
| agent-task-headless | PASS | scripted agent loop on the REAL extension: form submitted + verified server-side; stale-snapshot recovery in-loop; screenshot+pdf+evaluate deliverables (14.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-task-headless/2026-11-08T02-23-03-619Z-636090 |
| cdp-headless | PASS | CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get (23.7s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/cdp-headless/2026-11-08T02-22-38-209Z-b782eb |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-08T02-22-18-345Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/extension-headless/2026-11-08T02-22-21-142Z-701e55 |
| gateway-host-routing | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-host-routing/2026-11-08T02-22-12-860Z |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-08T02-22-09-207Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world); cross-frame snapshotId refused; bad frameId fails honestly (8.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/iframe-headless/2026-11-08T02-22-28-669Z-5f34d4 |
| native-host-relay | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/native-host-relay/2026-11-08T02-22-14-071Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (55.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-07T15-07-56-593Z-f2ec47 |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (55.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-07T15-19-33-697Z-b3d61d |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused (7.2s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-08T02-23-27-853Z-ce651b |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (30.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-08T02-23-35-968Z-b7448f |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (6.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-08T02-24-06-541Z-f3c9a4 |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (10.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-08T02-24-14-339Z-42274e |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (10.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-08T02-24-54-481Z-a8a8a2 |
| sw-restart | PASS | extension reload → new SW + NM host re-registered → calls + CDP tier recovered → post-reload click delivered exactly once (8.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/sw-restart/2026-11-08T02-23-18-547Z-4d25eb |
