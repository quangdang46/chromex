# Chromex Acceptance Report

Generated: 2026-11-08T03:41:27.249Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-08T03-38-52-432Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-08T03-39-06-717Z |
| agent-task-headless | PASS | scripted agent loop on the REAL extension: form submitted + verified server-side; stale-snapshot recovery in-loop; screenshot+pdf+evaluate deliverables (7.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-task-headless/2026-11-08T03-39-44-768Z-950d7f |
| cdp-headless | PASS | CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get (14.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/cdp-headless/2026-11-08T03-39-29-257Z-5c15cb |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-08T03-39-15-130Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/extension-headless/2026-11-08T03-39-16-554Z-4c2673 |
| gateway-host-routing | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-host-routing/2026-11-08T03-39-10-872Z |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-08T03-39-07-736Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world); cross-frame snapshotId refused; bad frameId fails honestly (6.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/iframe-headless/2026-11-08T03-39-21-968Z-68e125 |
| native-host-relay | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/native-host-relay/2026-11-08T03-39-11-504Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (55.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-07T15-07-56-593Z-f2ec47 |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (55.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-07T15-19-33-697Z-b3d61d |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused (5.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-08T03-39-59-958Z-f38b93 |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (27.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-08T03-40-05-906Z-76ccac |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (6.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-08T03-40-33-319Z-e6adf6 |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (6.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-08T03-40-40-384Z-f903d7 |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (10.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-08T03-41-15-827Z-7e77a6 |
| sw-restart | PASS | extension reload → new SW + NM host re-registered → calls + CDP tier recovered → post-reload click delivered exactly once (6.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/sw-restart/2026-11-08T03-39-52-394Z-fc2ec2 |
