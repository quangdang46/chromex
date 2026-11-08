# Chromex Acceptance Report

Generated: 2026-11-08T01:53:16.526Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-08T01-50-28-119Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-08T01-50-42-534Z |
| cdp-headless | PASS | CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get (12.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/cdp-headless/2026-11-08T01-51-35-752Z-27dc01 |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-08T01-51-20-327Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/extension-headless/2026-11-08T01-51-21-891Z-b9c067 |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-08T01-50-43-553Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world); cross-frame snapshotId refused; bad frameId fails honestly (6.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/iframe-headless/2026-11-08T01-51-28-511Z-d190bc |
| native-host-relay | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/native-host-relay/2026-11-08T01-51-16-647Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (55.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-07T15-07-56-593Z-f2ec47 |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (55.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-07T15-19-33-697Z-b3d61d |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused (5.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-08T01-51-56-313Z-3fb6d1 |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (25.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-08T01-52-02-327Z-736de7 |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (5.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-08T01-52-28-358Z-fea532 |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (5.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-08T01-52-34-314Z-96f5eb |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (6.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-08T01-53-08-854Z-18697b |
| sw-restart | PASS | extension reload → new SW + NM host re-registered → calls + CDP tier recovered → post-reload click delivered exactly once (6.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/sw-restart/2026-11-08T01-51-48-733Z-c35dfb |
| gateway-host-routing | FAIL |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-host-routing/2026-11-08T01-50-46-311Z |

## Failures

### gateway-host-routing


