// Minimal MCP stdio JSON-RPC client for acceptance scripts — spawns a
// server (e.g. mcp-stdio.js) and speaks newline-delimited JSON-RPC:
// initialize / tools/list / tools/call. Results come back fenced as
// untrusted browser data; callTool parses the embedded JSON payload.
import { spawn } from "node:child_process";

export function spawnMcpClient({ command, args, env }) {
  const child = spawn(command, args, {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buf = "";
  let stderrText = "";
  const pending = new Map();
  child.stderr.on("data", (d) => { stderrText += d; });
  child.stdout.on("data", (d) => {
    buf += d.toString("utf8");
    let idx;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* non-JSON noise */ }
    }
  });
  let nextId = 0;
  const rpc = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`mcp rpc ${method} timeout; stderr=${stderrText.slice(-300)}`)), 30000);
    });
  const callTool = async (name, args = {}) => {
    const res = await rpc("tools/call", { name, arguments: args });
    const result = res.result;
    if (!result || result.isError) {
      const msg = result?.content?.[0]?.text ?? JSON.stringify(res.error ?? res);
      const e = new Error(msg);
      e.rpcMessage = msg;
      throw e;
    }
    const text = result.content?.find((c) => c.type === "text")?.text ?? "";
    const jsonLine = text.split("\n").find((l) => l.startsWith("{") || l.startsWith("["));
    return { raw: text, data: jsonLine ? JSON.parse(jsonLine) : null };
  };
  return {
    child,
    rpc,
    callTool,
    get stderr() { return stderrText; },
    close() { try { child.kill("SIGKILL"); } catch {} },
  };
}
