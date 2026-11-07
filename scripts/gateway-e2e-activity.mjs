// E2E: gateway turn → assert turn.activity events carry tool detail
import { randomUUID } from "node:crypto";
import { ensureGateway } from "/Users/tranquangdang21/Projects/chromex/packages/native-host/dist/gateway-client.js";

const dataDir = process.env.CHROMEX_GATEWAY_HOME || `${process.env.HOME}/.chromex/gateway`;
const conn = await ensureGateway(dataDir, {
  hello: { protocolVersion: 1, clientId: "e2e-activity", clientVersion: "0.0.1", profileId: "default", hostInstanceId: randomUUID(), browserInstanceId: null },
  log: (m) => console.log("[gw]", m),
});
console.log("connected, hello providers:", JSON.stringify(conn.hello?.providers ?? conn.hello));

const events = [];
conn.onEvent((env) => {
  if (env.kind === "event") events.push(env);
  const t = env.payload?.type ?? env.type;
  if (["turn.activity","tool.started","tool.completed","assistant.delta","assistant.message","turn.started","turn.completed","turn.failed"].includes(t)) {
    console.log("EV", t, JSON.stringify(env.payload ?? env).slice(0, 300));
  }
});

const created = await conn.request("task.create", {
  cwd: "/tmp", providerId: "codex", model: "xxx",
  title: "e2e activity",
});
const taskId = created.taskId ?? created.task?.taskId ?? created.id;
console.log("task:", taskId);

await conn.request("task.send", {
  taskId,
  clientMessageId: `e2e-${Date.now()}`,
  content: [{ type: "text", text: "Run `echo hello-from-e2e` then reply with just OK" }],
});

// wait for turn.completed/failed or timeout 120s
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const done = events.some((e) => {
    const t = e.payload?.type ?? e.type;
    return t === "turn.completed" || t === "turn.failed" || t === "turn.cancelled";
  });
  if (done) break;
  await new Promise((r) => setTimeout(r, 500));
}

const activities = events.filter((e) => (e.payload?.type ?? e.type) === "turn.activity" || (e.payload?.type ?? e.type) === "tool.started" || (e.payload?.type ?? e.type) === "tool.completed");
console.log("\n=== SUMMARY ===");
console.log("total events:", events.length, "| tool-ish events:", activities.length);
for (const e of activities.slice(0, 20)) {
  const p = e.payload ?? {};
  console.log(` ${p.type} tool=${p.tool} outcome=${p.outcome ?? "-"} in=${p.input ? "y" : "n"} out=${p.output ? "y" : "n"}`);
}
process.exit(0);
