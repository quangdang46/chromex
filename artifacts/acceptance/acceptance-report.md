# Chromex Acceptance Report

Generated: 2026-11-08T06:28:12.145Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-08T06-22-47-468Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-08T06-24-46-322Z |
| agent-task-headless | PASS | scripted agent loop on the REAL extension: form submitted + verified server-side; stale-snapshot recovery in-loop; screenshot+pdf+evaluate deliverables (7.2s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-task-headless/2026-11-08T06-23-38-150Z-3913c9 |
| cdp-headless | PASS | CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get (14.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/cdp-headless/2026-11-08T06-23-22-710Z-14f091 |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-08T06-23-08-267Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/extension-headless/2026-11-08T06-23-09-832Z-b61834 |
| gateway-host-routing | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-host-routing/2026-11-08T06-23-04-203Z |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-08T06-23-02-029Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world); cross-frame snapshotId refused; bad frameId fails honestly (6.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/iframe-headless/2026-11-08T06-23-15-381Z-95276c |
| native-host-relay | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/native-host-relay/2026-11-08T06-23-04-763Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (55.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-07T15-07-56-593Z-f2ec47 |
| s10-ui-queue-stop | PASS | UI queue held the second message; Stop cancelled the provider turn without flushing the queue (16.4s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s10-ui-queue-stop/2026-11-08T06-25-22-265Z-f0d95f |
| s12-sw-turn-recovery | PASS | extension reload mid-turn → activeTurn restored via gateway hello → queue survived → flushed exactly once on turn.completed (88.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s12-sw-turn-recovery/2026-11-08T06-26-05-467Z-0a5e07 |
| s13-risk-preflight | PASS | destructive ref-click → approval (denied→not fired, approved→danger-fired); benign ref-click → no approval, fired (8.7s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s13-risk-preflight/2026-11-08T06-27-35-110Z-93db69 |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (55.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-07T15-19-33-697Z-b3d61d |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused (5.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-08T06-23-53-707Z-269acc |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (25.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-08T06-24-00-231Z-3893c9 |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (5.7s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-08T06-24-26-483Z-1bcf6c |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (5.4s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-08T06-24-33-065Z-415a0d |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (8.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-08T06-25-07-730Z-d06e63 |
| s9-interrupt-queue | PASS | interrupt without turnId → turn.cancelled{interrupted}; queued turn auto-dispatched → turn.completed; no turn.unknown (5.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s9-interrupt-queue/2026-11-08T06-25-16-767Z-4791f1 |
| sw-restart | PASS | extension reload → new SW + NM host re-registered → calls + CDP tier recovered → post-reload click delivered exactly once (7.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/sw-restart/2026-11-08T06-23-46-004Z-0dada0 |
| s11-ui-queue-flush | FAIL | harness error: page.waitForSelector: Timeout 15000ms exceeded.
Call log:
[2m  - waiting for locator('.composer-queue') to be visible[22m
 (25.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s11-ui-queue-flush/2026-11-08T06-25-39-302Z-8e829c |

## Failures

### s11-ui-queue-flush

harness error: page.waitForSelector: Timeout 15000ms exceeded.
Call log:
[2m  - waiting for locator('.composer-queue') to be visible[22m


- [2026-11-08T06:25:43.131Z] authed gateway connections=2 (1=client, 2+=browser host)
- [2026-11-08T06:25:47.187Z] turn 1 active
- [2026-11-08T06:25:47.217Z] early after send2: {"queuePresent":true,"queueText":"\n    \n          auto-flush me after turn one\n          ×\n        \n  ","stored":"{\"chromex.sidepanel.queuedComposerMessages\":{\"1d3e42df-2ee8-4eea-b4fc-adc7252beb17\":[{\"fileAttachments\":[],\"id\":\"queued-1794119147205-z004xy\",\"profileId\":\"default\",\"text\":\"auto-flush me after turn one\"}]}}"}
- [2026-11-08T06:25:47.223Z] second message queued
- [2026-11-08T06:25:49.328Z] post-reload: {"stored":"{\"chromex.sidepanel.queuedComposerMessages\":{\"1d3e42df-2ee8-4eea-b4fc-adc7252beb17\":[{\"fileAttachments\":[],\"id\":\"queued-1794119147205-z004xy\",\"profileId\":\"default\",\"text\":\"auto-flush me after turn one\"}]}}","queuePresent":false,"composerValue":"","frameClass":"composer-frame   ","approvalPanel":false,"footerHtml":"\n        \n        \n        <div class=\"composer-frame   \">\n          <input id=\"file-attachment-input\" type=\"file\" multiple=\"\" hidden=\"\">\n          \n          \n          \n              <div class=\"composer-tray\">\n                        <div class=\"context-summary composer-context-summary\">\n                          \n      <div class=\"composer-context-group\" data-composer-context-group=\"references","bgCurrentConv":"{\"codex.sidepanel.currentConversationId\":\"1d3e42df-2ee8-4eea-b4fc-adc7252beb17\"}","dbgEvents":{},"chatIds":[],"uiInit":"{\"convId\":\"1d3e42df-2ee8-4eea-b4fc-adc7252beb17\",\"activeTurn\":{\"turnId\":\"01M6WXB976KCAPR5DE3652DJD5\",\"threadId\":\"01M6WXB96VWEEQFJQVX71VY9E6\"},\"recentCount\":1}","dbg":{"currentConversationId":"1d3e42df-2ee8-4eea-b4fc-adc7252beb17","activeTurn":{"turnId":"01M6WXB976KCAPR5DE3652DJD5","threadId":"01M6WXB96VWEEQFJQVX71VY9E6"},"promptActivity":true,"queued":{}}}
- [2026-11-08T06:25:49.328Z] queue console: []
