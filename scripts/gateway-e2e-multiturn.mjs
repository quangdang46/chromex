// E2E: multi-turn memory within one task.
// 1. connect → task.create (codex)
// 2. turn1: "Remember the code word PINEAPPLE…" → wait turn.completed (180s)
// 3. turn2 same taskId: "What was the code word?" → wait turn.completed
// 4. assert turn2 assistant.message events mention PINEAPPLE (live capture
//    + durable task.sync replay as evidence)
import { randomUUID } from "node:crypto";
import { ensureGateway } from "/Users/tranquangdang21/Projects/chromex/packages/native-host/dist/gateway-client.js";

const TURN_DEADLINE_MS = 180_000;
const dataDir = process.env.CHROMEX_GATEWAY_HOME || `${process.env.HOME}/.chromex/gateway`;

const conn = await ensureGateway(dataDir, {
  hello: {
    protocolVersion: 1,
    clientId: `e2e-mt-${randomUUID().slice(0, 8)}`,
    clientVersion: "0.0.1",
    profileId: "default",
    hostInstanceId: randomUUID(),
    browserInstanceId: null,
  },
  log: (m) => console.log("[gw]", m),
});
console.log("connected");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- live event capture, filtered to our task ----
let taskId = null;
const live = []; // envelopes for this task: {seq, type, payload, turnId}
conn.onEvent((env) => {
  if (env.kind !== "event") return;
  if (taskId && env.taskId !== taskId) return;
  const p = env.payload ?? {};
  const type = p.type ?? env.type;
  const entry = { seq: env.seq, type, turnId: p.turnId ?? null, payload: p };
  live.push(entry);
  if (["turn.started", "turn.completed", "turn.failed", "turn.cancelled", "turn.unknown", "assistant.message"].includes(type)) {
    console.log(
      "EV", type,
      `turn=${entry.turnId ?? "-"}`,
      type === "assistant.message" ? JSON.stringify(p.text ?? "").slice(0, 200) : "",
    );
  }
});

const created = await conn.request("task.create", {
  cwd: "/tmp",
  providerId: "codex",
  model: "xxx",
  title: "e2e multiturn memory",
});
taskId = created.taskId ?? created.task?.taskId ?? created.id;
console.log("task:", taskId);

async function sendTurn(clientMessageId, text) {
  const res = await conn.request("task.send", {
    taskId,
    clientMessageId,
    content: [{ type: "text", text }],
  });
  const turnId = res.turnId ?? res.turn?.turnId;
  console.log(`sent ${clientMessageId} → turnId=${turnId} queued=${res.queued ?? "?"}`);
  return turnId;
}

const TERMINAL = ["turn.completed", "turn.failed", "turn.cancelled", "turn.unknown"];

async function waitTerminal(turnId, label) {
  const deadline = Date.now() + TURN_DEADLINE_MS;
  while (Date.now() < deadline) {
    const hit = live.find((e) => e.turnId === turnId && TERMINAL.includes(e.type));
    if (hit) {
      console.log(`${label}: terminal event ${hit.type} (turn ${turnId})`);
      return hit;
    }
    await sleep(300);
  }
  console.log(`${label}: TIMEOUT after ${TURN_DEADLINE_MS / 1000}s waiting for turn ${turnId}`);
  return null;
}

// ---- turn 1 ----
const cm1 = `e2e-mt1-${Date.now()}`;
const turn1 = await sendTurn(cm1, "Remember the code word PINEAPPLE. Reply OK.");
const t1 = await waitTerminal(turn1, "turn1");
if (!t1 || t1.type !== "turn.completed") {
  console.log("\n=== RESULT ===");
  console.log(`FAIL — turn1 did not complete (got ${t1?.type ?? "timeout"})`);
  process.exit(1);
}

// ---- turn 2 ----
const cm2 = `e2e-mt2-${Date.now()}`;
const turn2 = await sendTurn(cm2, "What was the code word? Reply with just the word.");
const t2 = await waitTerminal(turn2, "turn2");
if (!t2 || t2.type !== "turn.completed") {
  console.log("\n=== RESULT ===");
  console.log(`FAIL — turn2 did not complete (got ${t2?.type ?? "timeout"})`);
  process.exit(1);
}

// ---- evidence: live capture + durable replay ----
const liveMsgs = live.filter((e) => e.type === "assistant.message" && e.turnId === turn2);
console.log(`\nlive assistant.message events for turn2: ${liveMsgs.length}`);
for (const m of liveMsgs) console.log("  live:", JSON.stringify(m.payload.text ?? "").slice(0, 300));

const sync = await conn.request("task.sync", { taskId, fromSeq: 0, maxEvents: 1000 });
const events = sync.events ?? sync.replay?.events ?? [];
const durableMsgs = events.filter((e) => {
  const p = e.payload ?? e;
  const type = e.type ?? p.type;
  return type === "assistant.message" && (p.turnId === turn2 || e.turnId === turn2);
});
console.log(`durable assistant.message events for turn2 (task.sync): ${durableMsgs.length}`);
for (const m of durableMsgs) {
  const p = m.payload ?? m;
  console.log("  durable:", JSON.stringify(p.text ?? "").slice(0, 300));
}

const allTurn2Text = [...liveMsgs, ...durableMsgs]
  .map((m) => String(m.payload?.text ?? m.text ?? ""))
  .join("\n");
const mentions = /pineapple/i.test(allTurn2Text);

console.log("\n=== RESULT ===");
if (mentions) {
  console.log(`PASS — turn2 assistant output recalls the code word (task ${taskId}, turn1 ${turn1}, turn2 ${turn2})`);
  console.log("evidence:", JSON.stringify(allTurn2Text.slice(0, 300)));
  process.exit(0);
}
console.log("FAIL — turn2 completed but no assistant.message mentions PINEAPPLE");
console.log("turn2 live events:", live.filter((e) => e.turnId === turn2).map((e) => e.type));
process.exit(1);
