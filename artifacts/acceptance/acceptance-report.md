# Chromex Acceptance Report

Generated: 2026-11-07T20:15:59.669Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-07T20-05-53-651Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-07T20-05-57-305Z |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-07T20-15-57-998Z |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-07T20-05-57-903Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (55.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-07T15-07-56-593Z-f2ec47 |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (55.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-07T15-19-33-697Z-b3d61d |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused (11.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-07T15-13-00-811Z-bfe7d6 |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (10.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-07T15-13-12-430Z-734f0b |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (27.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-07T15-17-16-437Z-c39140 |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (6.4s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-07T15-18-22-228Z-3c4c30 |
| s5-interruption | FAIL | call2=failed completed=29 started=29 dup=false (122.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-07T15-20-32-695Z-e6e341 |

## Failures

### s5-interruption

call2=failed completed=29 started=29 dup=false

```json
{
  "call1Status": "completed",
  "call2": {
    "toolCallId": "rpc-mw6jyb1d-tgj9tk",
    "tool": "browser.page.get",
    "status": "failed",
    "error": {
      "code": "browser.no_host",
      "message": "no browser host for task scope (no_host)"
    }
  },
  "completed": 29,
  "started": 29,
  "duplicateCompletions": false
}
```

- [2026-11-07T15:20:39.908Z] authed gateway connections=2 (1=client, 2+=browser host)
- [2026-11-07T15:20:41.160Z] task 01M6V9HX842NRSC2Z2ZJXT1FCM
- [2026-11-07T15:20:47.900Z] pre-kill page.get → {"toolCallId":"rpc-mw6jvx2p-1x6ym5","tool":"browser.page.get","status":"completed","result":{"id":1891140391,"url":"http://127.0.0.1:62250/","title":"Fixture Home","active":true,"resolvedTabId":189114
- [2026-11-07T15:20:47.902Z] gateway pid=4202 — sending SIGKILL
- [2026-11-07T15:20:48.408Z] spawn_in_flight window: waiting 6s before respawn
- [2026-11-07T15:20:55.554Z] gateway respawned
- [2026-11-07T15:21:00.622Z] sidepanel opened to wake NM host → gateway reconnect
- [2026-11-07T15:21:05.152Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:09.379Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:14.292Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:17.509Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:20.539Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:23.577Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:26.709Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:29.731Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:32.816Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:35.873Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:38.883Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:41.892Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:44.922Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:47.935Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:50.991Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:54.150Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:21:57.182Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:22:00.221Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:22:04.827Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:22:07.875Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:22:10.927Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:22:15.433Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:22:18.442Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:22:21.507Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:22:24.736Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:22:29.184Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:22:32.210Z] browser.no_host — waiting for extension host re-register, retrying
- [2026-11-07T15:22:35.248Z] post-respawn page.get → {"toolCallId":"rpc-mw6jyb1d-tgj9tk","tool":"browser.page.get","status":"failed","error":{"code":"browser.no_host","message":"no browser host for task scope (no_host)"}}
- [2026-11-07T15:22:35.291Z] durable: tool.started=29 tool.completed=29
