# Chromex Product Master Acceptance Matrix

North Star: **A coding agent that owns the browser** — the user hands
over a goal; the agent plans, operates browser + coding tools, verifies
results, recovers from failure, and delivers evidence. "Own" means the
agent is the coordinating subject; authority stays behind policy,
permissions, and user approval.

Rule: no capability counts as done until an end-to-end user scenario
passes on a real browser. APIs, classes, and unit tests are necessary,
not sufficient.

## Acceptance scenarios (MVP gate)

| # | Scenario | Pass evidence | Latest real-browser result |
|---|----------|---------------|----------------------------|
| S1 | Build a web feature: understand → edit files → run app → drive UI → iterate → report | Real run: diff + test output + browser verification of the feature | **PASS** (2026-11-07, codex): navigate→snapshot→click→get→extract×3, 7/7 classified, `artifacts/acceptance/s1-build-feature/` |
| S2 | Debug a live website: observe page → locate cause in code → fix → reproduce → verify | Real run on a logged-in tab with an actual bug | **PASS**: agent edited code, re-drove real browser, verified token end-to-end |
| S3 | Multi-tab/multi-app work without scope bleed | Task A and B concurrently on different tabs; no cross-talk | **PASS**: two tasks held isolated tab scopes; cross-task tab access refused |
| S4 | Real web workflow: logged-in session, multi-step form, file use, auth handoff (CAPTCHA/MFA → user) | Real run on a real web app | BLOCKED-by-design — requires real credentials/site; manual runbook: `docs/s4-manual-runbook.md` |
| S5 | Interruption recovery: close panel / kill SW / restart gateway mid-turn → resume without duplicate actions | kill -9 style test + live run | **FAIL**→fixes landed + IPC proofs: `8409af2` ext auto-reconnect; `040b328`/`e5c8702` conn-level host routing (zombie conn); `371fe7a` durable toolCallId dedup. `gateway-kill9.test.ts` C: restart → host re-register → live routing; D: mid-call kill → same id deduped, no duplicate dispatch. Awaiting real-browser re-run on new dist |
| S6 | Failed plan: stale selector / UI change / tool failure → re-observe, re-plan, continue; never fake success | Injected failure run | **PASS**: stale `snapshotId` rejected loudly (`element_not_found`), re-observe + retry succeeded |
| S7 | Protection: sensitive actions (send/post/delete/pay) → contextual approval; denial is honored, never bypassed | Approval-flow run incl. deny path | **PASS**: deny→`browser.approval_denied`, allow→navigated, `hostAliveAfterApproval=true` |
| S8 | Verifiable deliverable: diff, changed files, test results, browser evidence, known limits | Deliverable rendered in sidepanel | **PASS**: task.sync carries full tool evidence; sidepanel renders in real Chrome |

Evidence root: `artifacts/acceptance/<scenario>/<runId>/{result.json,events.jsonl,task.sync.*.json,screenshots/}`. Harness: `scripts/acceptance/`.

## Capability → component → gap map

| Capability | Owner | Status | Gap / bead |
|---|---|---|---|
| Durable tasks/turns/events/recovery | bridge gateway | ✅ built + tested | S5 fixes landed (reconnect, conn routing, durable dedup); real-browser re-verify pending; sidepanel close path unverified |
| Provider abstraction codex/claude/acp | bridge agents | ✅ built | live ACP creds blocked (436) |
| Browser tool server + scope + approvals | bridge browser + ext tool-host | ✅ built | egress UX (b1h) |
| Tab lifecycle: list/create/activate/close | ext tool-host | ✅ 4 tools (07cf2e4) | lifecycle completeness edge cases |
| Page observation: snapshot/get/extract/screenshot/console/network | ext tool-host + content | ✅ console, screenshot→image, webRequest metadata log, extract selector+html, scroll pos | no a11y tree option; iframe impl landed, real-Chrome verify pending |
| Page interaction: click(+button)/focus/type/fill/select/submit/scroll/navigate/wait(+readyState)/upload/hover/press/drag/find/history + downloads.list/save | ext tool-host + content | ✅ 20 tools | dialogs need debugger decision (d7v deferred); click/drag are untrusted-event paths |
| Browser↔MCP tool surface for providers | bridge mcp-server + session-manager | ✅ wired per task | verify providers actually iterate tool calls E2E |
| Coding tools (fs/shell/git) | provider-native (codex/claude) | ✅ via provider | verify in gatewayMode tasks |
| Browser↔code feedback loop | composition | ✅ E2E proven | S1 + S2 PASS real-browser; loop proof cbbda36/6e690ab |
| Prompt-injection defense | page content → agent boundary | ✅ fenced (af60f2b, cd3cf46) | envelope + label-defuse + planner marking; action-side cross-check deferred |
| Permission/audit/revoke | approvals + tool tokens | ✅ built | S7 PASS real-browser; egress consent landed (d4e5429) |
| UX: timeline/approvals/questions/elapsed/deliverable | sidepanel | ✅ deliverable card (9cbdcb7) | approval-card-for-all-kinds + verified badge + rebuild notice in flight |
| Backend capability honesty | shared backend.ts | ✅ truthful | update as capabilities land |

## Workstream beads (this matrix)

- Browser runtime depth: a11y snapshot mode, iframe real-Chrome
  verification (code landed: all_frames + frameId end-to-end),
  dialogs/file-picker/trusted-input (debugger-tier, deferred),
  response-body inspection (needs debugger/CDP tier)
- Agent loop proof: scripted E2E where provider iterates browser tools
- Browser↔code loop: S1/S2 scripted scenarios
- Injection defense audit + content fencing
- Deliverable/evidence rendering (S8)
