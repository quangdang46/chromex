// E2E: permission.requested → permission.respond → permission.resolved live flow.
//
// Trigger paths tried in order (120s overall deadline):
//  A. browser.tool.call — deterministic when a browser host (extension) is
//     connected: an unclassified/financial tool call goes through §4.8
//     classify → requestApproval → durable permission.requested. NOTE: the
//     browser path persists permission.requested but does NOT broadcast it
//     live (main.ts requestApproval discards the appendTaskEvent envelope),
//     so we discover the requestId via task.sync replay. We answer "deny" —
//     exercises the full lifecycle without mutating the user's real browser.
//  B. claude task — canUseTool → permission.requested, but only fires when
//     Claude Code's own permission system would prompt; this host's
//     settings.json has permissions.defaultMode:"auto" so it likely won't.
//     (codex was tried and dropped: approvalPolicy:"never" and the model
//     never calls requestUserInput for a cheap prompt.)
// PASS = permission.requested observed, permission.respond accepted,
//        permission.resolved observed, and the gated operation reaches a
//        terminal state (tool outcome / turn.completed|failed|cancelled).
// SKIP = no trigger path was available cheaply (e.g. no browser host and
//        no provider emitted a request). Never faked.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { ensureGateway } from "/Users/tranquangdang21/Projects/chromex/packages/native-host/dist/gateway-client.js";

const OVERALL_MS = 120_000;
const dataDir = process.env.CHROMEX_GATEWAY_HOME || `${process.env.HOME}/.chromex/gateway`;

const hardDeadline = setTimeout(() => {
  console.error("FAIL — 120s overall deadline exceeded");
  process.exit(2);
}, OVERALL_MS);

const conn = await ensureGateway(dataDir, {
  hello: {
    protocolVersion: 1,
    clientId: `e2e-perm-${randomUUID().slice(0, 8)}`,
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
const respondedRequestIds = new Set();
conn.onEvent((env) => {
  if (env.kind !== "event") return;
  const p = env.payload ?? {};
  const type = p.type ?? env.type;
  const taskId = env.taskId ?? p.taskId ?? null;
  events.push({ taskId, type, payload: p });
  if (
    [
      "permission.requested",
      "permission.resolved",
      "permission.expired",
      "turn.completed",
      "turn.failed",
      "turn.cancelled",
      "turn.unknown",
      "turn.started",
    ].includes(type)
  ) {
    console.log("EV", type, `task=${taskId ?? "-"}`, JSON.stringify(p).slice(0, 300));
  }
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const elapsed = () => Date.now() - globalThis.__t0;

/** Build + send permission.respond for a PermissionRequest. */
async function respondToRequest(requestId, request) {
  if (respondedRequestIds.has(requestId)) return;
  respondedRequestIds.add(requestId);
  const options = request?.options ?? [];
  // prefer an explicit deny option when present (no side effects); else first option
  const deny = options.find((o) => o.kind === "deny" || /deny|dismiss|reject/i.test(String(o.id)));
  const pick = deny ?? options.find((o) => o.kind !== "deny") ?? options[0];
  const payload = { requestId };
  if (pick?.id) payload.optionId = pick.id;
  const questions = request?.details?.argsPreview?.questions;
  if (Array.isArray(questions) && questions.length > 0) {
    payload.answers = {};
    for (const q of questions) {
      const qOpts = Array.isArray(q.options) ? q.options : [];
      const qPick =
        qOpts.find((o) => !/deny|reject|dismiss/i.test(String(o.id ?? "") + " " + String(o.label ?? ""))) ??
        qOpts[0];
      payload.answers[String(q.id ?? "")] = [String(qPick?.label ?? qPick?.id ?? "yes")];
    }
  }
  console.log(`>>> permission.respond ${requestId} optionId=${payload.optionId ?? "-"} answers=${payload.answers ? "y" : "n"}`);
  try {
    const res = await conn.request("permission.respond", payload);
    console.log(">>> permission.respond accepted:", JSON.stringify(res ?? {}));
    return true;
  } catch (err) {
    console.log("!!! permission.respond failed:", err?.message ?? err);
    return false;
  }
}

/** Discover permission.requested for a task — live events first, then
 *  task.sync replay (browser approvals are durable-only, not broadcast). */
async function findPermissionRequest(taskId, deadlineMs) {
  while (Date.now() < deadlineMs) {
    const live = events.find((e) => e.type === "permission.requested" && e.taskId === taskId);
    if (live?.payload?.request?.requestId) return live.payload.request;
    try {
      const sync = await conn.request("task.sync", { taskId, fromSeq: 0, maxEvents: 500 });
      const evs = sync.events ?? sync.replay?.events ?? [];
      for (const e of evs) {
        const t = e.type ?? e.payload?.type;
        const pay = e.payload ?? e;
        if (t === "permission.requested" && pay.request?.requestId) {
          console.log("(request found via task.sync replay)");
          return pay.request;
        }
      }
    } catch {
      /* task.sync may lag; keep polling */
    }
    await sleep(400);
  }
  return null;
}

function resolvedFor(taskId) {
  return events.find((e) => e.type === "permission.resolved" && e.taskId === taskId);
}

function terminalFor(taskId) {
  return events.find(
    (e) => e.taskId === taskId && ["turn.completed", "turn.failed", "turn.cancelled", "turn.unknown"].includes(e.type),
  );
}

async function createTask(providerId, model, title) {
  const created = await conn.request("task.create", { cwd: "/tmp", providerId, model, title });
  return created.taskId ?? created.task?.taskId ?? created.id;
}

// ================= Attempt A: browser.tool.call approval =================
async function attemptBrowserToolCall() {
  console.log("\n=== attempt A: browser.tool.call approval (financial navigate → approve flow) ===");
  let taskId;
  try {
    taskId = await createTask("codex", "xxx", "e2e permission browser-tool");
  } catch (err) {
    console.log("[browser] task.create failed:", err?.message ?? err);
    return { status: "unavailable", reason: String(err?.message ?? err) };
  }
  console.log("[browser] task:", taskId);

  let token;
  try {
    const spawn = await conn.request("browser.mcp.spawn", { taskId });
    const scope = JSON.parse(fs.readFileSync(spawn.scopeFile, "utf8"));
    token = scope.token;
    console.log("[browser] mcp scope token acquired");
  } catch (err) {
    console.log("[browser] mcp spawn/token failed:", err?.message ?? err);
    return { status: "unavailable", reason: String(err?.message ?? err) };
  }

  // Fire the gated call WITHOUT awaiting the RPC response — it blocks in
  // the 60s approval poll server-side; we resolve it via permission.respond.
  let callOutcome = null;
  let callError = null;
  const callPromise = conn
    .request(
      "browser.tool.call",
      {
        taskId,
        tool: "browser.page.navigate",
        args: { url: "https://stripe.com/" }, // financial origin → needsApproval, allow_once only
        token,
      },
      90_000,
    )
    .then((o) => (callOutcome = o))
    .catch((e) => (callError = e));

  const request = await findPermissionRequest(taskId, Date.now() + 20_000);
  if (!request) {
    console.log("[browser] no permission.requested within 20s");
    await Promise.race([callPromise, sleep(5_000)]);
    return { status: callError ? "call-error" : "no-trigger", detail: callError?.message ?? callOutcome, taskId };
  }
  console.log(
    `[browser] permission.requested id=${request.requestId} kind=${request.kind} tool=${request.details?.tool} summary=${request.summary}`,
  );
  const responded = await respondToRequest(request.requestId, request);
  if (!responded) return { status: "respond-failed", taskId };

  // wait for permission.resolved + tool.call terminal (approval poll returns
  // verdict → dispatch or approval_denied)
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    await Promise.race([callPromise, sleep(300)]);
    if (callOutcome || callError) break;
  }
  const resolved = resolvedFor(taskId);
  const outcome = callOutcome ?? callError;
  console.log(
    `[browser] resolved=${!!resolved} callOutcome=${JSON.stringify(outcome)?.slice(0, 300)}`,
  );
  if (resolved && outcome) {
    const denied =
      callOutcome?.status === "failed" && callOutcome?.error?.code === "browser.approval_denied";
    // denied is a graceful terminal — proves respond→resolved→verdict path.
    // (allow_once would navigate the user's real browser; we chose deny.)
    return {
      status: "ok",
      taskId,
      terminal: denied ? "browser.approval_denied" : `tool.${callOutcome?.status ?? "error"}`,
      note: "denied by e2e (no real-browser mutation)",
    };
  }
  return { status: resolved ? "no-terminal" : "resolved-missing", taskId };
}

// ================= Attempt B: claude provider permission =================
async function attemptProvider({ providerId, model, prompt, title, budgetMs }) {
  console.log(`\n=== attempt: ${providerId} provider permission ===`);
  let taskId;
  try {
    taskId = await createTask(providerId, model, title);
  } catch (err) {
    console.log(`[${providerId}] task.create failed:`, err?.message ?? err);
    return { status: "unavailable", reason: String(err?.message ?? err) };
  }
  console.log(`[${providerId}] task:`, taskId);
  await conn.request("task.send", {
    taskId,
    clientMessageId: `e2e-perm-${providerId}-${Date.now()}`,
    content: [{ type: "text", text: prompt }],
  });

  const started = Date.now();
  let request = null;
  while (Date.now() - started < budgetMs) {
    const live = events.find((e) => e.type === "permission.requested" && e.taskId === taskId);
    if (live?.payload?.request?.requestId) {
      request = live.payload.request;
      break;
    }
    const term = terminalFor(taskId);
    if (term) break; // turn ended without asking — stop early
    await sleep(300);
  }
  if (!request) {
    const term = terminalFor(taskId);
    console.log(`[${providerId}] no permission.requested (terminal=${term?.type ?? "none"})`);
    return { status: "no-trigger", taskId };
  }
  console.log(
    `[${providerId}] permission.requested id=${request.requestId} kind=${request.kind} tool=${request.details?.tool}`,
  );
  const responded = await respondToRequest(request.requestId, request);
  if (!responded) return { status: "respond-failed", taskId };

  const deadline = Date.now() + Math.min(30_000, Math.max(5_000, OVERALL_MS - elapsed()));
  while (Date.now() < deadline) {
    const resolved = resolvedFor(taskId);
    const term = terminalFor(taskId);
    if (resolved && term) {
      console.log(`[${providerId}] permission.resolved + ${term.type}`);
      return { status: "ok", taskId, terminal: term.type };
    }
    await sleep(300);
  }
  return { status: "timeout-after-request", taskId };
}

globalThis.__t0 = Date.now();

// ---- run attempts within budget ----
let result = await attemptBrowserToolCall();
console.log("[browser] result:", JSON.stringify(result));

if (result.status !== "ok") {
  const remaining = OVERALL_MS - elapsed() - 8_000;
  if (remaining > 25_000) {
    const claude = await attemptProvider({
      providerId: "claude",
      model: "haiku",
      title: "e2e permission claude",
      budgetMs: Math.min(remaining, 60_000),
      prompt:
        "Use the AskUserQuestion tool to ask me whether I prefer red or blue. " +
        "After I answer, run `curl -s https://example.com -o /tmp/chromex-perm-e2e.html` " +
        "with your shell tool, then reply with just OK",
    });
    console.log("[claude] result:", JSON.stringify(claude));
    if (claude.status !== "unavailable" && claude.status !== "no-trigger") result = claude;
    else if (result.status === "unavailable") result = claude;
  }
}

console.log("\n=== RESULT ===");
if (result.status === "ok") {
  console.log(`PASS — permission.requested → permission.respond → permission.resolved → ${result.terminal} (task ${result.taskId})${result.note ? ` [${result.note}]` : ""}`);
  clearTimeout(hardDeadline);
  process.exit(0);
}
if (result.status === "unavailable") {
  console.log(`SKIP — no permission trigger path available (${result.reason ?? "unknown"})`);
  clearTimeout(hardDeadline);
  process.exit(3);
}
console.log(`FAIL — permission flow did not complete (status=${result.status}, task=${result.taskId ?? "-"})`);
clearTimeout(hardDeadline);
process.exit(1);
