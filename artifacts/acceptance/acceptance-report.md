# Chromex Acceptance Report

Generated: 2026-11-08T01:59:13.557Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-08T01-56-50-788Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-08T01-57-04-377Z |
| agent-task-headless | PASS | scripted agent loop on the REAL extension: form submitted + verified server-side; stale-snapshot recovery in-loop; screenshot+pdf+evaluate deliverables (5.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-task-headless/2026-11-08T01-57-40-807Z-89e1e6 |
| cdp-headless | PASS | CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get (12.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/cdp-headless/2026-11-08T01-57-27-684Z-67617d |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-08T01-57-12-554Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/extension-headless/2026-11-08T01-57-14-277Z-b76b00 |
| gateway-host-routing | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-host-routing/2026-11-08T01-57-08-502Z |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-08T01-57-05-513Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world); cross-frame snapshotId refused; bad frameId fails honestly (6.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/iframe-headless/2026-11-08T01-57-20-456Z-bbab86 |
| native-host-relay | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/native-host-relay/2026-11-08T01-57-09-052Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (55.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-07T15-07-56-593Z-f2ec47 |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (55.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-07T15-19-33-697Z-b3d61d |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused (5.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-08T01-57-54-647Z-e70b72 |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (26.4s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-08T01-58-00-542Z-6fcf77 |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (4.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-08T01-58-27-179Z-d1c24c |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (5.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-08T01-58-32-703Z-edecec |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (5.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-08T01-59-07-050Z-182d2a |
| sw-restart | PASS | extension reload → new SW + NM host re-registered → calls + CDP tier recovered → post-reload click delivered exactly once (6.7s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/sw-restart/2026-11-08T01-57-47-310Z-e0bbd6 |
