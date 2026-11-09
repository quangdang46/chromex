# Chromex Acceptance Report

Generated: 2026-11-09T04:04:54.900Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-09T03-45-19-122Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-09T03-46-40-343Z |
| agent-task-headless | PASS | scripted agent loop on the REAL extension: form submitted + verified server-side; stale-snapshot recovery in-loop; screenshot+pdf+evaluate deliverables (9.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-task-headless/2026-11-09T03-48-53-527Z-d4ff87 |
| cdp-headless | PASS | CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get, cookies + web storage + indexedDB + caches + serviceWorker + raw CDP + browsingData.clear boundary (106.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/cdp-headless/2026-11-09T03-47-06-584Z-dc30ec |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-09T03-46-48-739Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/extension-headless/2026-11-09T03-46-50-198Z-c81e86 |
| gateway-host-routing | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-host-routing/2026-11-09T03-46-44-706Z |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-09T03-46-41-840Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world + open shadow DOM); cross-frame snapshotId refused; bad frameId fails honestly (10.2s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/iframe-headless/2026-11-09T03-46-55-682Z-581432 |
| native-host-relay | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/native-host-relay/2026-11-09T03-46-45-317Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (26.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-09T03-49-13-247Z-b8ff9d |
| s10-ui-queue-stop | PASS | UI queue held the second message; Stop cancelled the provider turn without flushing the queue (14.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s10-ui-queue-stop/2026-11-09T03-51-52-553Z-fb4a1c |
| s11-ui-queue-flush | PASS | turn.completed auto-flushed the queued message exactly once as the next turn (37.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s11-ui-queue-flush/2026-11-09T03-52-08-189Z-096f3d |
| s12-sw-turn-recovery | PASS | extension reload mid-turn → activeTurn restored via gateway hello → queue survived → flushed exactly once on turn.completed (78.2s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s12-sw-turn-recovery/2026-11-09T03-52-46-564Z-419500 |
| s13-risk-preflight | PASS | destructive ref-click → approval (denied→not fired, approved→danger-fired); benign ref-click → no approval, fired; trusted approve-then-mutate → browser.target_changed, handler never fired, restored-label control click fires (13.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s13-risk-preflight/2026-11-09T03-54-05-499Z-be5a09 |
| s14-windows | PASS | agent created a dedicated window, drove its tab in-scope, targeted tab.create at windowId, maximized+restored window state, bogus state refused, windows.remove closed it and the host stayed alive (10.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s14-windows/2026-11-09T03-54-47-660Z-9242bc |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (40.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-09T03-49-40-074Z-ecec9a |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused; popup acquired into opener's scope (7.7s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-09T03-50-20-892Z-1f4e74 |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (25.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-09T03-50-29-300Z-a12a51 |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (6.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-09T03-50-55-496Z-e3e59b |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (6.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-09T03-51-02-363Z-905326 |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (7.7s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-09T03-51-37-909Z-5c79bf |
| s9-interrupt-queue | PASS | interrupt without turnId → turn.cancelled{interrupted}; queued turn auto-dispatched → turn.completed; no turn.unknown (5.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s9-interrupt-queue/2026-11-09T03-51-46-356Z-08142f |
| sw-restart | PASS | extension reload → new SW + NM host re-registered → calls + CDP tier recovered → post-reload click delivered exactly once (8.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/sw-restart/2026-11-09T03-49-03-762Z-7e7d71 |
| tab-close-last | PASS | refused=true alive=true workaround=true (6.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/tab-close-last/2026-11-09T04-04-47-666Z-349739 |
| tab-highlight-debug | PASS | debug (6.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/tab-highlight-debug/2026-11-08T19-13-11-394Z-64d00c |
| wheel-debug | PASS | wheel=count:1 trusted:true delta:300 y=300 (5.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/wheel-debug/2026-11-08T20-29-49-128Z-ad53dd |
| tmp-ax-probe | FAIL | harness error: Cannot read properties of undefined (reading 'status') (6.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/tmp-ax-probe/2026-11-08T22-58-44-317Z-467610 |
| tmp-metrics-probe | FAIL | harness error: Cannot read properties of undefined (reading 'status') (5.7s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/tmp-metrics-probe/2026-11-08T23-02-42-476Z-726fae |
| tmp-pierce-probe | FAIL | harness error: Cannot read properties of undefined (reading 'status') (6.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/tmp-pierce-probe/2026-11-08T21-54-19-667Z-bb64d7 |
| winremove-repro | FAIL | rec=false gone=false (50.4s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/winremove-repro/2026-11-08T18-24-27-989Z-f97adf |

## Failures

### tmp-ax-probe

harness error: Cannot read properties of undefined (reading 'status')

- [2026-11-08T22:58:48.522Z] authed gateway connections=2 (1=client, 2+=browser host)

### tmp-metrics-probe

harness error: Cannot read properties of undefined (reading 'status')

- [2026-11-08T23:02:47.058Z] authed gateway connections=2 (1=client, 2+=browser host)

### tmp-pierce-probe

harness error: Cannot read properties of undefined (reading 'status')

- [2026-11-08T21:54:24.235Z] authed gateway connections=2 (1=client, 2+=browser host)

### winremove-repro

rec=false gone=false

```json
{}
```

- [2026-11-08T18:24:32.425Z] authed gateway connections=2 (1=client, 2+=browser host)
- [2026-11-08T18:24:32.439Z] baseline → completed/- wins=1
- [2026-11-08T18:24:32.502Z] windowId=1999223356
- [2026-11-08T18:24:33.006Z] after-create → completed/- wins=2
- [2026-11-08T18:24:33.262Z] remove → {"toolCallId":"rpc-mw85w5wu-iepcln","tool":"browser.windows.remove","status":"completed","result":{"removed":1999223356}}
- [2026-11-08T18:24:33.263Z] browser DEAD → TypeError: browser.version is not a function
- [2026-11-08T18:24:34.266Z] t+1s → failed/browser.no_host wins=0
- [2026-11-08T18:24:35.270Z] t+2s → failed/browser.no_host wins=0
- [2026-11-08T18:24:36.273Z] t+3s → failed/browser.no_host wins=0
- [2026-11-08T18:24:37.275Z] t+4s → failed/browser.no_host wins=0
- [2026-11-08T18:24:38.278Z] t+5s → failed/browser.no_host wins=0
- [2026-11-08T18:24:39.282Z] t+6s → failed/browser.no_host wins=0
- [2026-11-08T18:24:40.284Z] t+7s → failed/browser.no_host wins=0
- [2026-11-08T18:24:41.287Z] t+8s → failed/browser.no_host wins=0
- [2026-11-08T18:24:42.291Z] t+9s → failed/browser.no_host wins=0
- [2026-11-08T18:24:43.295Z] t+10s → failed/browser.no_host wins=0
- [2026-11-08T18:24:44.298Z] t+11s → failed/browser.no_host wins=0
- [2026-11-08T18:24:45.301Z] t+12s → failed/browser.no_host wins=0
- [2026-11-08T18:24:46.303Z] t+13s → failed/browser.no_host wins=0
- [2026-11-08T18:24:47.307Z] t+14s → failed/browser.no_host wins=0
- [2026-11-08T18:24:48.311Z] t+15s → failed/browser.no_host wins=0
- [2026-11-08T18:24:49.314Z] t+16s → failed/browser.no_host wins=0
- [2026-11-08T18:24:50.318Z] t+17s → failed/browser.no_host wins=0
- [2026-11-08T18:24:51.322Z] t+18s → failed/browser.no_host wins=0
- [2026-11-08T18:24:52.326Z] t+19s → failed/browser.no_host wins=0
- [2026-11-08T18:24:53.332Z] t+20s → failed/browser.no_host wins=0
- [2026-11-08T18:24:54.335Z] t+21s → failed/browser.no_host wins=0
- [2026-11-08T18:24:55.338Z] t+22s → failed/browser.no_host wins=0
- [2026-11-08T18:24:56.341Z] t+23s → failed/browser.no_host wins=0
- [2026-11-08T18:24:57.343Z] t+24s → failed/browser.no_host wins=0
- [2026-11-08T18:24:58.347Z] t+25s → failed/browser.no_host wins=0
- [2026-11-08T18:24:59.348Z] t+26s → failed/browser.no_host wins=0
- [2026-11-08T18:25:00.362Z] t+27s → failed/browser.no_host wins=0
- [2026-11-08T18:25:01.364Z] t+28s → failed/browser.no_host wins=0
- [2026-11-08T18:25:02.368Z] t+29s → failed/browser.no_host wins=0
- [2026-11-08T18:25:03.371Z] t+30s → failed/browser.no_host wins=0
- [2026-11-08T18:25:04.372Z] t+31s → failed/browser.no_host wins=0
- [2026-11-08T18:25:05.374Z] t+32s → failed/browser.no_host wins=0
- [2026-11-08T18:25:06.377Z] t+33s → failed/browser.no_host wins=0
- [2026-11-08T18:25:07.379Z] t+34s → failed/browser.no_host wins=0
- [2026-11-08T18:25:08.382Z] t+35s → failed/browser.no_host wins=0
- [2026-11-08T18:25:09.385Z] t+36s → failed/browser.no_host wins=0
- [2026-11-08T18:25:10.389Z] t+37s → failed/browser.no_host wins=0
- [2026-11-08T18:25:11.391Z] t+38s → failed/browser.no_host wins=0
- [2026-11-08T18:25:12.393Z] t+39s → failed/browser.no_host wins=0
- [2026-11-08T18:25:13.395Z] t+40s → failed/browser.no_host wins=0
- [2026-11-08T18:25:14.398Z] t+41s → failed/browser.no_host wins=0
- [2026-11-08T18:25:15.401Z] t+42s → failed/browser.no_host wins=0
- [2026-11-08T18:25:16.403Z] t+43s → failed/browser.no_host wins=0
- [2026-11-08T18:25:17.406Z] t+44s → failed/browser.no_host wins=0
- [2026-11-08T18:25:18.409Z] t+45s → failed/browser.no_host wins=0
- [2026-11-08T18:25:18.409Z] recovered=false gone=false
