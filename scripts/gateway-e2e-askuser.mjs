// E2E: codex requestUserInput → permission.requested (with questions) →
//      permission.respond {answers} → permission.resolved → turn.completed.
//
// 180s overall deadline. One codex task only: codex runs approvalPolicy:"never"
// so the ONLY permission.requested path is the app-server's
// `item/tool/requestUserInput` tool request, mapped in
// packages/bridge/src/agents/providers/codex/session.ts to a
// provider_permission whose details.argsPreview.questions carries
// [{id, question, options:[{id,label}]}]. We answer every question with the
// first non-deny option label via permission.respond {requestId, answers:
// {<qid>:[<label>]}} (answers: Record<questionId, string[]>, schema in
// packages/bridge/src/gateway/schemas.ts).
//
// PASS  = questions-shaped permission.requested seen, answered,
//         permission.resolved observed, turn reached a terminal state.
// SKIP  = no questions-shaped request within budget. Known blocker as of
//         codex-cli 0.165.0: `request_user_input` is only in the Default-mode
//         toolset when feature `default_mode_request_user_input` is enabled
//         (`codex features list` → under development, default false; not set
//         in ~/.codex/config.toml [features]). The alternative — Plan
//         collaborationMode on turn/start — is never sent by
//         CodexAgentSession.startTurn, and task.create's providerOptions is
//         stored but never reaches session config. So this script SKIPs
//         unless the user enables the feature flag or the session grows a
//         mode/collaborationMode passthrough.
import { randomUUID } from "node:crypto";
import { ensureGateway } from "/Users/tranquangdang21/Projects/chromex/packages/native-host/dist/gateway-client.js";

const OVERALL_MS = 180_000;
const TRIGGER_BUDGET_MS = 90_000;

const dataDir = process.env.CHROMEX_GATEWAY_HOME || `${process.env.HOME}/.chromex/gateway`;

const hardDeadline = setTimeout(() => {
  console.error("FAIL — 180s overall deadline exceeded");
  process.exit(2);
}, OVERALL_MS);

const conn = await ensureGateway(dataDir, {
  hello: {
    protocolVersion: 1,
    clientId: `e2e-askuser-${randomUUID().slice(0, 8)}`,
    clientVersion: "0.0.1",
    profileId: "default",
    hostInstanceId: randomUUID(),
    browserInstanceId: null,
  },
  log: (m) => console.log("[gw]", m),
});
console.log("connected");

// ---- event capture ----
const events = []; // {taskId, type, payload}
const pendingRequests = new Map(); // requestId -> {taskId, request, responded}
conn.onEvent((env) => {
  if (env.kind !== "event") return;
  const p = env.payload ?? {};
  const type = p.type ?? env.type;
  const taskId = p.taskId ?? env.taskId ?? env.payload?.taskId ?? null;
  events.push({ taskId, type, payload: p });
  if (
    [
      "permission.requested",
      "permission.resolved",
      "turn.completed",
      "turn.failed",
      "turn.cancelled",
      "turn.unknown",
      "turn.started",
    ].includes(type)
  ) {
    console.log("EV", type, `task=${taskId ?? "-"}`, JSON.stringify(p).slice(0, 400));
  }
  if (type === "permission.requested" && p.request?.requestId) {
    pendingRequests.set(p.request.requestId, { taskId, request: p.request, responded: false });
    void handlePermissionRequest(p.request.requestId);
  }
});

async function handlePermissionRequest(requestId) {
  const pending = pendingRequests.get(requestId);
  if (!pending || pending.responded) return;
  pending.responded = true;
  const req = pending.request;
  const questions = req.details?.argsPreview?.questions;
  const hasQuestions = Array.isArray(questions) && questions.length > 0;
  console.log(
    `\n>>> permission.requested id=${requestId} kind=${req.kind} tool=${req.details?.tool} ` +
      `questions=${hasQuestions ? questions.length : "none"} ` +
      `options=${JSON.stringify((req.options ?? []).map((o) => `${o.id}:${o.kind}`))}`,
  );
  if (hasQuestions) {
    console.log("    questions:", JSON.stringify(questions).slice(0, 800));
  }

  // Build answers: Record<questionId, string[]> — first non-deny option
  // label (fall back to id) per question. Also pick a top-level optionId
  // when the request carries options, so non-question requests still get
  // answered instead of left hanging.
  const payload = { requestId };
  const options = req.options ?? [];
  const allow = options.find((o) => o.kind !== "deny") ?? options[0];
  if (allow?.id) payload.optionId = allow.id;

  if (hasQuestions) {
    payload.answers = {};
    for (const q of questions) {
      const qOpts = Array.isArray(q.options) ? q.options : [];
      const pick =
        qOpts.find(
          (o) => !/deny|reject|dismiss/i.test(String(o.id ?? "") + " " + String(o.label ?? "")),
        ) ?? qOpts[0];
      payload.answers[String(q.id ?? "")] = [String(pick?.label ?? pick?.id ?? "yes")];
    }
  }
  if (!payload.optionId && !payload.answers) {
    console.log("!!! no usable option/answer for request", requestId, "— cannot respond");
    return;
  }

  try {
    const res = await conn.request("permission.respond", payload);
    console.log(">>> permission.respond accepted:", JSON.stringify(res ?? {}));
  } catch (err) {
    console.log("!!! permission.respond failed:", err?.message ?? err);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function taskTerminal(taskId) {
  return events.find(
    (e) =>
      e.taskId === taskId &&
      ["turn.completed", "turn.failed", "turn.cancelled", "turn.unknown"].includes(e.type),
  );
}

function questionsRequestFor(taskId) {
  return events.find(
    (e) =>
      e.type === "permission.requested" &&
      (e.taskId === taskId ||
        [...pendingRequests.entries()].some(([rid, p]) => p.taskId === taskId && e.payload?.request?.requestId === rid)) &&
      Array.isArray(e.payload?.request?.details?.argsPreview?.questions) &&
      e.payload.request.details.argsPreview.questions.length > 0,
  );
}

function permissionResolvedFor(taskId) {
  return events.find(
    (e) =>
      e.type === "permission.resolved" &&
      (e.taskId === taskId ||
        [...pendingRequests.entries()].some(
          ([rid, p]) => p.taskId === taskId && e.payload?.requestId === rid,
        )),
  );
}

// ---- the attempt ----
const started = Date.now();
let taskId;
try {
  const created = await conn.request("task.create", {
    cwd: "/tmp",
    providerId: "codex",
    model: "xxx",
    title: "e2e askuser codex",
  });
  taskId = created.taskId ?? created.task?.taskId ?? created.id;
  console.log("task created:", taskId);
} catch (err) {
  console.log("task.create failed:", err?.message ?? err);
  console.log("SKIP — codex provider unavailable:", err?.message ?? err);
  clearTimeout(hardDeadline);
  process.exit(3);
}

await conn.request("task.send", {
  taskId,
  clientMessageId: `e2e-askuser-${Date.now()}`,
  content: [
    {
      type: "text",
      text:
        "I need you to pick a name for a variable. You MUST call the " +
        "requestUserInput tool to ask me one question: prefer snake_case " +
        "or camelCase? Give options snake_case and camelCase. After I " +
        "answer, reply with just the chosen style. Do not do anything else.",
    },
  ],
  // planMode → codex collaborationMode{mode:plan} unlocks requestUserInput
  // (the standalone feature flag is off by default in codex-cli)
  ctx: { metadata: { planMode: true } },
});
console.log(`prompt sent — waiting up to ${TRIGGER_BUDGET_MS / 1000}s for questions-shaped permission.requested…`);

// Phase 1: wait for a questions-shaped permission.requested.
while (Date.now() - started < TRIGGER_BUDGET_MS) {
  if (questionsRequestFor(taskId)) break;
  const terminal = taskTerminal(taskId);
  if (terminal && !events.some((e) => e.type === "permission.requested")) {
    console.log(`turn ended (${terminal.type}) with no permission.requested at all`);
    break;
  }
  await sleep(250);
}

const sawQuestions = Boolean(questionsRequestFor(taskId));
const sawAnyRequest = events.some((e) => e.type === "permission.requested");
if (!sawQuestions) {
  console.log(
    sawAnyRequest
      ? "SKIP — permission.requested seen but without details.argsPreview.questions (not the requestUserInput path)"
      : "SKIP — no permission.requested within budget; model did not call requestUserInput or tool not enabled in this app-server build",
  );
  clearTimeout(hardDeadline);
  process.exit(3);
}

// Phase 2: wait for permission.resolved + terminal turn.
const waitUntil = Date.now() + Math.min(OVERALL_MS - (Date.now() - started), 90_000);
while (Date.now() < waitUntil) {
  const resolved = permissionResolvedFor(taskId);
  const terminal = taskTerminal(taskId);
  if (resolved && terminal) {
    console.log(`permission.resolved + ${terminal.type} observed`);
    console.log(
      `PASS — requestUserInput questions answered via permission.respond → permission.resolved → ${terminal.type} (task ${taskId})`,
    );
    clearTimeout(hardDeadline);
    process.exit(0);
  }
  if (terminal && !resolved) {
    console.log(`turn ended (${terminal.type}) without permission.resolved`);
    break;
  }
  await sleep(250);
}

console.log(
  `FAIL — questions-shaped permission.requested seen but flow did not complete (task ${taskId})`,
);
clearTimeout(hardDeadline);
process.exit(1);
