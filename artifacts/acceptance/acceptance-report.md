# Chromex Acceptance Report

Generated: 2026-11-07T21:30:13.178Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-07T21-28-24-869Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-07T21-28-28-347Z |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-07T21-28-34-713Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/extension-headless/2026-11-07T21-28-35-778Z-52a8e9 |
| gateway-host-routing | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-host-routing/2026-11-07T21-28-30-655Z |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-07T21-28-28-895Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click inside same- AND cross-origin iframes; cross-frame snapshotId refused; bad frameId fails honestly (6.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/iframe-headless/2026-11-07T21-28-40-853Z-3a44f0 |
| native-host-relay | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/native-host-relay/2026-11-07T21-28-31-203Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (55.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-07T15-07-56-593Z-f2ec47 |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (55.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-07T15-19-33-697Z-b3d61d |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused (5.2s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-07T21-28-54-768Z-d12ce6 |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (25.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-07T21-29-00-644Z-a78074 |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (4.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-07T21-29-26-621Z-b3c66f |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (5.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-07T21-29-32-155Z-0d812c |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (6.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-07T21-30-06-536Z-d1691d |
| sw-restart | PASS | extension reload → new SW + NM host re-registered → calls recovered → post-reload click delivered exactly once (6.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/sw-restart/2026-11-07T21-28-47-542Z-9fa198 |
