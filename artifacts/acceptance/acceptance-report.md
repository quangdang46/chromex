# Chromex Acceptance Report

Generated: 2026-11-08T07:34:17.961Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-08T07-27-05-665Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-08T07-27-20-384Z |
| agent-task-headless | PASS | scripted agent loop on the REAL extension: form submitted + verified server-side; stale-snapshot recovery in-loop; screenshot+pdf+evaluate deliverables (9.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-task-headless/2026-11-08T07-28-33-573Z-047c2d |
| cdp-headless | PASS | CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get (32.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/cdp-headless/2026-11-08T07-27-59-943Z-65e5f7 |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-08T07-27-30-048Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/extension-headless/2026-11-08T07-27-33-406Z-f57f57 |
| gateway-host-routing | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-host-routing/2026-11-08T07-27-25-653Z |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-08T07-27-22-182Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world); cross-frame snapshotId refused; bad frameId fails honestly (11.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/iframe-headless/2026-11-08T07-27-46-846Z-f11621 |
| native-host-relay | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/native-host-relay/2026-11-08T07-27-26-281Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (55.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-07T15-07-56-593Z-f2ec47 |
| s12-sw-turn-recovery | PASS | extension reload mid-turn → activeTurn restored via gateway hello → queue survived → flushed exactly once on turn.completed (92.4s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s12-sw-turn-recovery/2026-11-08T07-31-58-099Z-99ac2c |
| s13-risk-preflight | PASS | destructive ref-click → approval (denied→not fired, approved→danger-fired); benign ref-click → no approval, fired; trusted approve-then-mutate → browser.target_changed, handler never fired, restored-label control click fires (17.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s13-risk-preflight/2026-11-08T07-33-31-526Z-a3ea3b |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (55.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-07T15-19-33-697Z-b3d61d |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused (7.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-08T07-28-55-361Z-e7cece |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (30.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-08T07-29-03-503Z-a6e486 |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (8.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-08T07-29-35-083Z-22140b |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (6.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-08T07-29-44-461Z-10e1ad |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (10.2s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-08T07-30-20-747Z-5363a3 |
| s9-interrupt-queue | PASS | interrupt without turnId → turn.cancelled{interrupted}; queued turn auto-dispatched → turn.completed; no turn.unknown (5.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s9-interrupt-queue/2026-11-08T07-30-32-130Z-b3ac59 |
| sw-restart | PASS | extension reload → new SW + NM host re-registered → calls + CDP tier recovered → post-reload click delivered exactly once (9.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/sw-restart/2026-11-08T07-28-44-589Z-2b92f6 |
| s10-ui-queue-stop | FAIL | queueKept=false noFlush=true cancelled=1 completed=0 (44.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s10-ui-queue-stop/2026-11-08T07-30-38-363Z-f4abfd |
| s11-ui-queue-flush | FAIL | harness error: page.waitForSelector: Timeout 15000ms exceeded.
Call log:
[2m  - waiting for locator('.composer-queue') to be visible[22m
 (33.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s11-ui-queue-flush/2026-11-08T07-31-23-223Z-b9e53f |

## Failures

### s10-ui-queue-stop

queueKept=false noFlush=true cancelled=1 completed=0

```json
{
  "afterStop": {
    "queueStillThere": false,
    "queueText": "",
    "stopVisible": true,
    "errorText": "",
    "storedQueue": "{\"chromex.sidepanel.queuedComposerMessages\":{}}"
  },
  "cancelled": 1,
  "completed": 0,
  "started": 2
}
```

- [2026-11-08T07:30:43.115Z] authed gateway connections=2 (1=client, 2+=browser host)
- [2026-11-08T07:30:45.321Z] settings.update → {"uiLanguage":"auto","uiTheme":"system","usageNoticeAccepted":true,"shareCurrentTabByDefault":false,"rememberChats":false,"liveCaptions":true,"allowVoiceNavigat
- [2026-11-08T07:30:45.330Z] settings.agentProviderId now: fakeacp
- [2026-11-08T07:30:45.331Z] provider options: []
- [2026-11-08T07:30:58.269Z] gateway task after send: 01M6X12HZ7ZS27AQA5HNR5WYTT
- [2026-11-08T07:30:58.272Z] task.get → providerId=fakeacp {"task":{"taskId":"01M6X12HZ7ZS27AQA5HNR5WYTT","createdAt":1794123057127,"updatedAt":1794123058264,"status":"active","pauseReason":null,"title":null,"profileId":"fakeacp","originBrowserInstanceId":null,"binding":{"browserInstanceId":null,"state":"none"},"providerId":"fakeacp","conversationKey":"conv
- [2026-11-08T07:31:18.065Z] stop button visible — turn 1 active
- [2026-11-08T07:31:18.128Z] queue strip: queued second message
          ×
- [2026-11-08T07:31:22.168Z] after stop: {"queueStillThere":false,"queueText":"","stopVisible":true,"errorText":"","storedQueue":"{\"chromex.sidepanel.queuedComposerMessages\":{}}"}
- [2026-11-08T07:31:22.244Z] task 01M6X12HZ7ZS27AQA5HNR5WYTT events=8 cancelled=1 completed=0 failed=0 userMsgs=2 seq=1:task.created>2:task.status_changed>3:user.message.created>4:turn.started>5:turn.cancelled>6:task.status_changed>7:task.attention_changed>8:task.completed
- [2026-11-08T07:31:22.244Z] failPayloads=[]

### s11-ui-queue-flush

harness error: page.waitForSelector: Timeout 15000ms exceeded.
Call log:
[2m  - waiting for locator('.composer-queue') to be visible[22m


- [2026-11-08T07:31:30.191Z] authed gateway connections=2 (1=client, 2+=browser host)
- [2026-11-08T07:31:39.859Z] turn 1 active
- [2026-11-08T07:31:39.877Z] early after send2: {"queuePresent":false,"queueText":"","stored":"{\"chromex.sidepanel.queuedComposerMessages\":{\"c8e9ddb0-4ac7-4955-8cfa-074c6b2af976\":[{\"fileAttachments\":[],\"id\":\"queued-1794123099871-s3v9a1\",\"profileId\":\"default\",\"text\":\"auto-flush me after turn one\"}]}}"}
- [2026-11-08T07:31:39.891Z] second message queued
- [2026-11-08T07:31:42.021Z] post-reload: {"stored":"{\"chromex.sidepanel.queuedComposerMessages\":{\"c8e9ddb0-4ac7-4955-8cfa-074c6b2af976\":[{\"fileAttachments\":[],\"id\":\"queued-1794123099871-s3v9a1\",\"profileId\":\"default\",\"text\":\"auto-flush me after turn one\"}]}}","queuePresent":false,"composerValue":"","frameClass":"composer-frame   ","approvalPanel":false,"footerHtml":"\n        \n        \n        <div class=\"composer-frame   \">\n          <input id=\"file-attachment-input\" type=\"file\" multiple=\"\" hidden=\"\">\n          \n          \n          \n              <div class=\"composer-tray\">\n                        <div class=\"context-summary composer-context-summary\">\n                          \n      <div class=\"composer-context-group\" data-composer-context-group=\"references","bgCurrentConv":"{\"codex.sidepanel.currentConversationId\":\"c8e9ddb0-4ac7-4955-8cfa-074c6b2af976\"}","dbgEvents":{},"chatIds":[],"uiInit":"{\"convId\":\"c8e9ddb0-4ac7-4955-8cfa-074c6b2af976\",\"activeTurn\":{\"turnId\":\"01M6X13XAGX6TVG6GMP9DJH60P\",\"threadId\":\"01M6X13X9KES0H3NZGMV2CTS8X\"},\"recentCount\":1}","dbg":{"currentConversationId":"c8e9ddb0-4ac7-4955-8cfa-074c6b2af976","activeTurn":{"turnId":"01M6X13XAGX6TVG6GMP9DJH60P","threadId":"01M6X13X9KES0H3NZGMV2CTS8X"},"promptActivity":true,"queued":{}}}
- [2026-11-08T07:31:42.028Z] queue console: []
