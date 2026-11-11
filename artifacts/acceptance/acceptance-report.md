# Chromex Acceptance Report

Generated: 2026-11-11T06:03:25.539Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\agent-loop-isolated\2026-11-09T06-23-56-926Z |
| agent-loop-mcp-isolated | PASS |  | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\agent-loop-mcp-isolated\2026-11-09T06-25-17-776Z |
| agent-task-headless | PASS | scripted agent loop on the REAL extension: form submitted + verified server-side; stale-snapshot recovery in-loop; screenshot+pdf+evaluate deliverables (9.6s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\agent-task-headless\2026-11-09T06-28-02-671Z-87047b |
| cdp-backend-loop | PASS |  | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\cdp-backend-loop\2026-11-09T06-28-33-159Z |
| cdp-headless | PASS | CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get, cookies + web storage + indexedDB + caches + serviceWorker + raw CDP + browsingData.clear boundary (104.7s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\cdp-headless\2026-11-09T06-26-17-208Z-dc08d1 |
| content-script-isolated | PASS |  | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\content-script-isolated\2026-11-09T05-37-21-444Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\extension-headless\2026-11-09T06-26-00-303Z-617d78 |
| gateway-host-routing | PASS |  | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\gateway-host-routing\2026-11-09T06-25-53-817Z |
| gateway-mcp-cdp | PASS |  | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\gateway-mcp-cdp\2026-11-09T06-25-22-226Z |
| gateway-mcp-isolated | PASS |  | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\gateway-mcp-isolated\2026-11-09T06-25-18-954Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world + open shadow DOM); cross-frame snapshotId refused; bad frameId fails honestly (10.4s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\iframe-headless\2026-11-09T06-26-06-072Z-1aef08 |
| native-host-relay | PASS |  | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\native-host-relay\2026-11-09T05-37-17-999Z |
| s1-cdp-live | PASS | live provider iterated playwright-cdp browser tools observe→act→observe; user tab never leaked (84.1s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s1-cdp-live\2026-11-09T12-15-41-362Z-1cae86 |
| s10-ui-queue-stop | PASS | UI queue held the second message; Stop cancelled the provider turn without flushing the queue (14.7s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s10-ui-queue-stop\2026-11-09T06-29-51-552Z-3656c9 |
| s13-risk-preflight | PASS | destructive ref-click → approval (denied→not fired, approved→danger-fired); benign ref-click → no approval, fired; trusted approve-then-mutate → browser.target_changed, handler never fired, restored-label control click fires (15.3s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s13-risk-preflight\2026-11-11T06-01-11-096Z-1a0058 |
| s14-windows | PASS | agent created a dedicated window, drove its tab in-scope, targeted tab.create at windowId, maximized+restored window state, bogus state refused, windows.remove closed it and the host stayed alive (9.2s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s14-windows\2026-11-09T04-07-43-661Z-ecee28 |
| s15-goal-mode | PASS | useGoal on unsupported provider → turn.failed proto.unsupported (no silent chat turn); plain turn unaffected; goal.clear → honest error; catalog goalMode flag absent; declared goalMode capability flows config→catalog→gate→turn.completed; diagnostics.turns records turn wall-time (9.0s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s15-goal-mode\2026-11-11T05-18-29-381Z-37cdc7 |
| s17-goal-ui | PASS | Goal Mode UX: menu toggle arms badge, send consumes once with useGoal ctx, disarm works, unsupported provider hides the item (29.5s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s17-goal-ui\2026-11-11T05-59-21-439Z-7cf7f9 |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (36.9s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s2-debug-live\2026-11-09T12-12-46-048Z-48f3c9 |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused; popup acquired into opener's scope (7.3s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s3-multitab\2026-11-09T06-28-22-363Z-8fe8d7 |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (25.8s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s5-interruption\2026-11-09T06-28-30-362Z-3e77c9 |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (5.8s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s6-failedplan\2026-11-09T06-28-56-374Z-a3ff7a |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (5.3s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s7-approval\2026-11-09T06-29-02-880Z-d5a1b0 |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (7.7s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s8-deliverable\2026-11-09T06-29-37-551Z-0103c5 |
| s9-interrupt-queue | PASS | interrupt without turnId → turn.cancelled{interrupted}; queued turn auto-dispatched → turn.completed; no turn.unknown (5.0s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s9-interrupt-queue\2026-11-09T06-29-45-948Z-c352c1 |
| sw-restart | PASS | extension reload → new SW + NM host re-registered → calls + CDP tier recovered → post-reload click delivered exactly once (8.7s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\sw-restart\2026-11-09T06-28-13-025Z-db796f |
| tab-close-last | PASS | refused=true alive=true workaround=true (7.7s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\tab-close-last\2026-11-09T05-44-17-894Z-c8e5a4 |
| tab-highlight-debug | PASS | debug (6.1s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\tab-highlight-debug\2026-11-08T19-13-11-394Z-64d00c |
| task-purge | PASS |  | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\task-purge\2026-11-09T06-32-51-720Z |
| tool-reconcile | PASS |  | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\tool-reconcile\2026-11-09T06-32-52-319Z |
| wheel-debug | PASS | wheel=count:1 trusted:true delta:300 y=300 (5.8s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\wheel-debug\2026-11-08T20-29-49-128Z-ad53dd |
| s1-build-feature | FAIL | terminal=turn.failed classified=0 browserDone=0/0 mcpDone=0 oao=false (39.7s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s1-build-feature\2026-11-11T05-15-14-689Z-ddeb9e |
| s11-ui-queue-flush | FAIL | harness error: page.waitForSelector: Timeout 10000ms exceeded.
Call log:
[2m  - waiting for locator('.composer-queue') to be visible[22m
 (39.2s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s11-ui-queue-flush\2026-11-11T06-00-31-560Z-ae9fe8 |
| s12-sw-turn-recovery | FAIL | turn 1 never became a gateway turn before reload — prompt.send did not reach task.create (89.9s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s12-sw-turn-recovery\2026-11-11T06-01-55-287Z-18a7bf |
| winremove-repro | FAIL | rec=false gone=false (50.4s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\winremove-repro\2026-11-08T18-24-27-989Z-f97adf |
| s16-goal-live | BLOCKED | provider codex catalog does not advertise goalMode — nothing to exercise (1.5s) | C:\Users\ADMIN\Documents\Projects\chromex\artifacts\acceptance\s16-goal-live\2026-11-11T05-14-43-521Z-68360c |

## Failures

### s1-build-feature

terminal=turn.failed classified=0 browserDone=0/0 mcpDone=0 oao=false

```json
{
  "taskId": "01M74GH1X6BK2PAAMN7Q5DHYGM",
  "turnId": "01M74GH1XK40K60E331YY5B48X",
  "terminal": "turn.failed",
  "actions": [],
  "classified": 0,
  "browserDone": 0,
  "browserSucceeded": 0,
  "mcpDone": 0,
  "latency": {
    "turnMs": {
      "count": 1,
      "total": 12118,
      "max": 12118,
      "last": 12118
    },
    "toolMs": {
      "count": 0,
      "total": 0,
      "max": 0,
      "last": null
    },
    "approvalWaitMs": {
      "count": 0,
      "total": 0,
      "max": 0,
      "last": null
    }
  }
}
```

- [2026-11-11T05:15:41.595Z] authed gateway connections=1 (1=client, 2+=browser host)
- [2026-11-11T05:15:41.595Z] WARNING: extension native host never registered with the isolated gateway
- [2026-11-11T05:15:41.870Z] task 01M74GH1X6BK2PAAMN7Q5DHYGM provider=codex model=xxx
- [2026-11-11T05:15:41.873Z] mcp descriptor scopeFile=C:\Users\ADMIN\AppData\Local\Temp\chromex-accept-gw-1dGpoa\mcp\01M74GH1X6BK2PAAMN7Q5DHYGM.json
- [2026-11-11T05:15:42.244Z] turn 01M74GH1XK40K60E331YY5B48X
- [2026-11-11T05:15:54.365Z] latency turn=12118ms tools=?ms approvalWait=?ms

### s11-ui-queue-flush

harness error: page.waitForSelector: Timeout 10000ms exceeded.
Call log:
[2m  - waiting for locator('.composer-queue') to be visible[22m


- [2026-11-11T06:00:57.017Z] authed gateway connections=1 (1=client, 2+=browser host)
- [2026-11-11T06:00:57.017Z] WARNING: extension native host never registered with the isolated gateway
- [2026-11-11T06:00:57.648Z] usage notice accept clicked=false
- [2026-11-11T06:01:00.729Z] turn 1 active
- [2026-11-11T06:01:00.753Z] early after send2: {"queuePresent":false,"queueText":"","stored":"{}"}
- [2026-11-11T06:01:10.765Z] diag: {"composerValue":"","queuePresent":false,"stopVisible":false,"msgLog":[{"type":"conversation.save","ok":true,"err":null},{"type":"prompt.send","ok":false,"err":"Error when communicating with the native messaging host."},{"type":"conversation.save","ok":true,"err":null},{"type":"gateway.tasks","ok":true,"err":null},{"type":"page.image-prompt-hover.install","ok":true,"err":null},{"type":"image.prompt.error.pending.take","ok":true,"err":null},{"type":"image.prompt.pending.take","ok":true,"err":null},{"type":"conversation.save","ok":true,"err":null},{"type":"prompt.send","ok":false,"err":"Error when communicating with the native messaging host."},{"type":"conversation.save","ok":true,"err":null}]}

### s12-sw-turn-recovery

turn 1 never became a gateway turn before reload — prompt.send did not reach task.create

```json
{
  "gwTaskId": null,
  "activeTurnId": null
}
```

- [2026-11-11T06:02:20.768Z] authed gateway connections=1 (1=client, 2+=browser host)
- [2026-11-11T06:02:20.769Z] WARNING: extension native host never registered with the isolated gateway
- [2026-11-11T06:02:21.375Z] usage notice accept clicked=false
- [2026-11-11T06:02:24.441Z] turn 1 active
- [2026-11-11T06:03:25.125Z] gateway turn 1 established: task=null activeTurn=null

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

## Blocked

- **s16-goal-live**: provider codex catalog does not advertise goalMode — nothing to exercise
