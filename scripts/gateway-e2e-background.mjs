// E2E: agent keeps running while the client is disconnected (extension off).
// 1. connect → task.send a turn that sleeps ~25s
// 2. close the connection mid-turn (simulates extension disable / SW death)
// 3. reconnect → task.sync → assert the turn completed while we were gone
import { randomUUID } from "node:crypto";
import { ensureGateway } from "/Users/tranquangdang21/Projects/chromex/packages/native-host/dist/gateway-client.js";

const dataDir = process.env.CHROMEX_GATEWAY_HOME || `${process.env.HOME}/.chromex/gateway`;
const hello = () => ({
  protocolVersion: 1, clientId: `e2e-bg-${randomUUID().slice(0, 8)}`, clientVersion: "0.0.1",
  profileId: "default", hostInstanceId: randomUUID(), browserInstanceId: null,
});

const conn1 = await ensureGateway(dataDir, { hello: hello(), log: (m) => console.log("[gw1]", m) });
console.log("connected #1");

const created = await conn1.request("task.create", {
  cwd: "/tmp", providerId: "codex", model: "xxx", title: "e2e background-survival",
});
const taskId = created.taskId ?? created.task?.taskId ?? created.id;
console.log("task:", taskId);

await conn1.request("task.send", {
  taskId,
  clientMessageId: `e2e-bg-${Date.now()}`,
  content: [{ type: "text", text: "Run `sleep 20 && echo bg-done` with your shell tool, then reply OK" }],
});
console.log("turn dispatched — disconnecting for 30s (agent should keep running)…");

conn1.close();
await new Promise((r) => setTimeout(r, 30_000));

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
console.log(completed && !failed.length ? "PASS — agent ran to completion with no client attached" : "CHECK — see events above");
process.exit(0);
