# Chromex Acceptance Report

Generated: 2026-11-09T03:07:06.865Z

| Scenario | Status | Summary | Evidence |
|----------|--------|---------|----------|
| agent-loop-isolated | PASS | provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-isolated/2026-11-09T03-05-40-579Z |
| agent-loop-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-loop-mcp-isolated/2026-11-09T03-07-01-752Z |
| agent-task-headless | PASS | scripted agent loop on the REAL extension: form submitted + verified server-side; stale-snapshot recovery in-loop; screenshot+pdf+evaluate deliverables (9.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/agent-task-headless/2026-11-09T03-00-43-739Z-1db747 |
| cdp-headless | PASS | CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get, cookies + web storage + indexedDB + caches + serviceWorker + raw CDP + browsingData.clear boundary (100.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/cdp-headless/2026-11-09T02-59-02-123Z-ef9ce2 |
| content-script-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/content-script-isolated/2026-11-09T03-07-04-961Z |
| extension-headless | PASS | real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/extension-headless/2026-11-09T02-58-45-039Z-dc4970 |
| gateway-host-routing | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-host-routing/2026-11-09T02-58-40-625Z |
| gateway-mcp-isolated | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/gateway-mcp-isolated/2026-11-09T02-58-37-638Z |
| iframe-headless | PASS | frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world + open shadow DOM); cross-frame snapshotId refused; bad frameId fails honestly (10.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/iframe-headless/2026-11-09T02-58-50-712Z-312740 |
| native-host-relay | PASS |  | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/native-host-relay/2026-11-09T02-58-41-415Z |
| s1-build-feature | PASS | provider iterated real-extension browser tools observe→act→observe (110.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s1-build-feature/2026-11-08T09-52-55-894Z-cbf654 |
| s10-ui-queue-stop | PASS | UI queue held the second message; Stop cancelled the provider turn without flushing the queue (13.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s10-ui-queue-stop/2026-11-09T03-02-30-156Z-a84a43 |
| s11-ui-queue-flush | PASS | turn.completed auto-flushed the queued message exactly once as the next turn (36.7s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s11-ui-queue-flush/2026-11-09T03-02-44-628Z-1f6c54 |
| s12-sw-turn-recovery | PASS | extension reload mid-turn → activeTurn restored via gateway hello → queue survived → flushed exactly once on turn.completed (79.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s12-sw-turn-recovery/2026-11-09T03-03-22-019Z-6de434 |
| s13-risk-preflight | PASS | destructive ref-click → approval (denied→not fired, approved→danger-fired); benign ref-click → no approval, fired; trusted approve-then-mutate → browser.target_changed, handler never fired, restored-label control click fires (13.3s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s13-risk-preflight/2026-11-09T03-04-42-844Z-ea3552 |
| s2-debug-live | PASS | agent edited code, re-drove real browser, verified token end-to-end (37.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s2-debug-live/2026-11-08T09-54-46-960Z-5d0ba3 |
| s3-multitab | PASS | two tasks held isolated tab scopes; cross-task tab access refused; popup acquired into opener's scope (7.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s3-multitab/2026-11-09T03-01-02-652Z-70a05b |
| s5-interruption | PASS | gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped (25.7s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s5-interruption/2026-11-09T03-01-10-344Z-2f08db |
| s6-failedplan | PASS | stale snapshotId rejected loudly; re-observe + retry succeeded (5.6s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s6-failedplan/2026-11-09T03-01-36-208Z-8905b3 |
| s7-approval | PASS | deny→approval_denied, allow→navigated, permission.resolved×2 (5.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s7-approval/2026-11-09T03-01-42-419Z-091b53 |
| s8-deliverable | PASS | task.sync carries full tool evidence; sidepanel renders in real Chrome (7.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s8-deliverable/2026-11-09T03-02-16-862Z-f74ab1 |
| s9-interrupt-queue | PASS | interrupt without turnId → turn.cancelled{interrupted}; queued turn auto-dispatched → turn.completed; no turn.unknown (5.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s9-interrupt-queue/2026-11-09T03-02-24-616Z-37baeb |
| sw-restart | PASS | extension reload → new SW + NM host re-registered → calls + CDP tier recovered → post-reload click delivered exactly once (8.5s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/sw-restart/2026-11-09T03-00-53-475Z-62b864 |
| tab-close-last | PASS | refused=true alive=true workaround=true (5.9s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/tab-close-last/2026-11-09T03-05-25-073Z-edb4b0 |
| tab-highlight-debug | PASS | debug (6.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/tab-highlight-debug/2026-11-08T19-13-11-394Z-64d00c |
| wheel-debug | PASS | wheel=count:1 trusted:true delta:300 y=300 (5.8s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/wheel-debug/2026-11-08T20-29-49-128Z-ad53dd |
| s14-windows | FAIL | harness error: browserType.launchPersistentContext: Timeout 300000ms exceeded.
Call log:
[2m  - <launching> /Users/tranquangdang21/Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,AvoidCorsURLLoaderRestartOnRedirect,TcpPortRandomizationWin,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,PreconnectToSearch,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface,SkipListAccountsWithoutGaiaCookies --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --disable-updater-scheduler --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --enable-unsafe-swiftshader --edge-skip-compat-layer-relaunch --disable-stack-profiler --disable-infobars --disable-sync --do-not-de-elevate --no-sandbox --disable-extensions-except=/var/folders/dd/qv4ltr9158116jk2739rp61c0000gn/T/chromex-accept-ext-kACBHv/extension --load-extension=/var/folders/dd/qv4ltr9158116jk2739rp61c0000gn/T/chromex-accept-ext-kACBHv/extension --no-first-run --no-default-browser-check --user-data-dir=/var/folders/dd/qv4ltr9158116jk2739rp61c0000gn/T/chromex-accept-profile-bRvFkV --remote-debugging-pipe about:blank[22m
[2m  - <launched> pid=7986[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.264 Google Chrome for Testing[7986:43714595] NSNotificationCenter connection invalid[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.264 Google Chrome for Testing[7986:43714595] Connection to notification center invalid. ServerConnectionFailure: 1 invalidated: 0[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.349 Google Chrome for Testing Helper (Aperitif Alerts)[7997:43714687] NSNotificationCenter connection invalid[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.349 Google Chrome for Testing Helper (Aperitif Alerts)[7997:43714687] Connection to notification center invalid. ServerConnectionFailure: 1 invalidated: 0[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.467 Google Chrome for Testing[7986:43714566] +[NSXPCSharedListener endpointForReply:withListenerName:replyErrorCode:]: an error occurred while attempting to obtain endpoint for listener 'ClientCallsAuxiliary': Connection interrupted[22m
[2m  - [pid=7986][err] [7994:43714645:1109/015741.479336:ERROR:ui/display/mac/cv_display_link_mac.mm:191] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670[22m
[2m  - [pid=7986][err] [7994:43714711:1109/015741.479563:ERROR:ui/display/mac/cv_display_link_mac.mm:191] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670[22m
[2m  - [pid=7986][err] [7994:43714645:1109/015741.479726:ERROR:ui/display/mac/cv_display_link_mac.mm:191] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670[22m
[2m  - [pid=7986][err] [7994:43714711:1109/015741.479765:ERROR:ui/display/mac/cv_display_link_mac.mm:191] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670[22m
[2m  - [pid=7986][err] [7994:43714645:1109/015741.479916:ERROR:ui/display/mac/cv_display_link_mac.mm:191] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670[22m
[2m  - [pid=7986][err] [7994:43714711:1109/015741.479933:ERROR:ui/display/mac/cv_display_link_mac.mm:191] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.484 Google Chrome for Testing[7986:43714595] Connection to notification center invalid. ServerConnectionFailure: 1 invalidated: 0[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.485 Google Chrome for Testing Helper (Aperitif Alerts)[7997:43714715] Connection to notification center invalid. ServerConnectionFailure: 1 invalidated: 0[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.487 Google Chrome for Testing[7986:43714595] Connection to notification center invalid. ServerConnectionFailure: 1 invalidated: 0[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.487 Google Chrome for Testing Helper (Aperitif Alerts)[7997:43714715] Connection to notification center invalid. ServerConnectionFailure: 1 invalidated: 0[22m
[2m  - [pid=7986] <process did exit: exitCode=null, signal=SIGTRAP>[22m
[2m  - [pid=7986] starting temporary directories cleanup[22m
[2m  - [pid=7986] finished temporary directories cleanup[22m
 (300.4s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/s14-windows/2026-11-08T18-57-40-655Z-df937f |
| tmp-ax-probe | FAIL | harness error: Cannot read properties of undefined (reading 'status') (6.1s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/tmp-ax-probe/2026-11-08T22-58-44-317Z-467610 |
| tmp-metrics-probe | FAIL | harness error: Cannot read properties of undefined (reading 'status') (5.7s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/tmp-metrics-probe/2026-11-08T23-02-42-476Z-726fae |
| tmp-pierce-probe | FAIL | harness error: Cannot read properties of undefined (reading 'status') (6.0s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/tmp-pierce-probe/2026-11-08T21-54-19-667Z-bb64d7 |
| winremove-repro | FAIL | rec=false gone=false (50.4s) | /Users/tranquangdang21/Projects/chromex/artifacts/acceptance/winremove-repro/2026-11-08T18-24-27-989Z-f97adf |

## Failures

### s14-windows

harness error: browserType.launchPersistentContext: Timeout 300000ms exceeded.
Call log:
[2m  - <launching> /Users/tranquangdang21/Library/Caches/ms-playwright/chromium-1254/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --disable-field-trial-config --disable-background-networking --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-back-forward-cache --disable-breakpad --disable-component-extensions-with-background-pages --disable-component-update --no-default-browser-check --disable-default-apps --disable-dev-shm-usage --disable-edgeupdater --disable-extensions --disable-features=AvoidUnnecessaryBeforeUnloadCheckSync,DestroyProfileOnBrowserClose,HttpsUpgrades,HttpsFirstBalancedModeAutoEnable,LensOverlay,MediaRouter,PaintHolding,ThirdPartyStoragePartitioning,AvoidCorsURLLoaderRestartOnRedirect,TcpPortRandomizationWin,OptimizationHints,NetworkTimeServiceQuerying,AimEnabled,PreconnectToSearch,msForceBrowserSignIn,msEdgeUpdateLaunchServicesPreferredVersion --enable-features=CDPScreenshotNewSurface,SkipListAccountsWithoutGaiaCookies --allow-pre-commit-input --disable-hang-monitor --disable-ipc-flooding-protection --disable-popup-blocking --disable-prompt-on-repost --disable-renderer-backgrounding --disable-updater-scheduler --force-color-profile=srgb --metrics-recording-only --no-first-run --password-store=basic --use-mock-keychain --no-service-autorun --disable-search-engine-choice-screen --unsafely-disable-devtools-self-xss-warnings --enable-unsafe-swiftshader --edge-skip-compat-layer-relaunch --disable-stack-profiler --disable-infobars --disable-sync --do-not-de-elevate --no-sandbox --disable-extensions-except=/var/folders/dd/qv4ltr9158116jk2739rp61c0000gn/T/chromex-accept-ext-kACBHv/extension --load-extension=/var/folders/dd/qv4ltr9158116jk2739rp61c0000gn/T/chromex-accept-ext-kACBHv/extension --no-first-run --no-default-browser-check --user-data-dir=/var/folders/dd/qv4ltr9158116jk2739rp61c0000gn/T/chromex-accept-profile-bRvFkV --remote-debugging-pipe about:blank[22m
[2m  - <launched> pid=7986[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.264 Google Chrome for Testing[7986:43714595] NSNotificationCenter connection invalid[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.264 Google Chrome for Testing[7986:43714595] Connection to notification center invalid. ServerConnectionFailure: 1 invalidated: 0[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.349 Google Chrome for Testing Helper (Aperitif Alerts)[7997:43714687] NSNotificationCenter connection invalid[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.349 Google Chrome for Testing Helper (Aperitif Alerts)[7997:43714687] Connection to notification center invalid. ServerConnectionFailure: 1 invalidated: 0[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.467 Google Chrome for Testing[7986:43714566] +[NSXPCSharedListener endpointForReply:withListenerName:replyErrorCode:]: an error occurred while attempting to obtain endpoint for listener 'ClientCallsAuxiliary': Connection interrupted[22m
[2m  - [pid=7986][err] [7994:43714645:1109/015741.479336:ERROR:ui/display/mac/cv_display_link_mac.mm:191] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670[22m
[2m  - [pid=7986][err] [7994:43714711:1109/015741.479563:ERROR:ui/display/mac/cv_display_link_mac.mm:191] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670[22m
[2m  - [pid=7986][err] [7994:43714645:1109/015741.479726:ERROR:ui/display/mac/cv_display_link_mac.mm:191] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670[22m
[2m  - [pid=7986][err] [7994:43714711:1109/015741.479765:ERROR:ui/display/mac/cv_display_link_mac.mm:191] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670[22m
[2m  - [pid=7986][err] [7994:43714645:1109/015741.479916:ERROR:ui/display/mac/cv_display_link_mac.mm:191] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670[22m
[2m  - [pid=7986][err] [7994:43714711:1109/015741.479933:ERROR:ui/display/mac/cv_display_link_mac.mm:191] CVDisplayLinkCreateWithCGDisplay failed. CVReturn: -6670[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.484 Google Chrome for Testing[7986:43714595] Connection to notification center invalid. ServerConnectionFailure: 1 invalidated: 0[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.485 Google Chrome for Testing Helper (Aperitif Alerts)[7997:43714715] Connection to notification center invalid. ServerConnectionFailure: 1 invalidated: 0[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.487 Google Chrome for Testing[7986:43714595] Connection to notification center invalid. ServerConnectionFailure: 1 invalidated: 0[22m
[2m  - [pid=7986][err] 2026-11-09 01:57:41.487 Google Chrome for Testing Helper (Aperitif Alerts)[7997:43714715] Connection to notification center invalid. ServerConnectionFailure: 1 invalidated: 0[22m
[2m  - [pid=7986] <process did exit: exitCode=null, signal=SIGTRAP>[22m
[2m  - [pid=7986] starting temporary directories cleanup[22m
[2m  - [pid=7986] finished temporary directories cleanup[22m


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
