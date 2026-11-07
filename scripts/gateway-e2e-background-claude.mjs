// E2E: claude agent keeps running while the client is disconnected.
// Variant of gateway-e2e-background.mjs with providerId "claude" and a
// 60s disconnect window + 180s overall deadline (claude startup can be slow).
import { randomUUID } from "node:crypto";
import { ensureGateway } from "/Users/tranquangdang21/Projects/chromex/packages/native-host/dist/gateway-client.js";

const dataDir = process.env.CHROMEX_GATEWAY_HOME || `${process.env.HOME}/.chromex/gateway`;
const hello = () => ({
  protocolVersion: 1, clientId: `e2e-bg-claude-${randomUUID().slice(0, 8)}`, clientVersion: "0.0.1",
  profileId: "default", hostInstanceId: randomUUID(), browserInstanceId: null,
});

const deadline = setTimeout(() => {
  console.error("TIMEOUT — overall 180s deadline exceeded");
  process.exit(2);
}, 180_000);

const conn1 = await ensureGateway(dataDir, { hello: hello(), log: (m) => console.log("[gw1]", m) });
console.log("connected #1");

const created = await conn1.request("task.create", {
  cwd: "/tmp", providerId: "claude", model: "haiku", title: "e2e background-survival-claude",
});
const taskId = created.taskId ?? created.task?.taskId ?? created.id;
console.log("task:", taskId);

await conn1.request("task.send", {
  taskId,
  clientMessageId: `e2e-bg-claude-${Date.now()}`,
  content: [{ type: "text", text: "Run `echo claude-bg-done` with your shell tool, then reply OK" }],
});
console.log("turn dispatched — disconnecting for 60s (agent should keep running)…");

conn1.close();
await new Promise((r) => setTimeout(r, 60_000));

const conn2 = await ensureGateway(dataDir, { hello: hello(), log: (m) => console.log("[gw2]", m) });
console.log("reconnected #2 — syncing task");

const seen = [];
conn2.onEvent((env) => {
  if (env.kind === "event") {
    const t = env.payload?.type ?? env.type;
    if (["turn.completed", "turn.failed", "turn.cancelled", "turn.unknown", "task.status_changed"].includes(t)) {
      seen.push(`${t} ${JSON.stringify(env.payload ?? {}).slice(0, 120)}`);
    }
  }
});

// pull durable history
const sync = await conn2.request("task.sync", { taskId, fromSeq: 0, maxEvents: 500 });
const events = sync.events ?? sync.replay?.events ?? [];
const types = events.map((e) => e.payload?.type ?? e.type ?? e.payload_json);
console.log("replayed event types tail:", types.slice(-8));
const completed = types.includes("turn.completed");
const failed = types.filter((t) => t === "turn.failed" || t === "turn.unknown" || t === "turn.cancelled");
console.log("\n=== RESULT ===");
console.log("turn.completed while disconnected:", completed);
console.log("terminal failures:", failed.length ? failed : "none");
const pass = completed && !failed.length;
console.log(pass ? "PASS — agent ran to completion with no client attached" : "CHECK — see events above");
clearTimeout(deadline);
process.exit(pass ? 0 : 1);
