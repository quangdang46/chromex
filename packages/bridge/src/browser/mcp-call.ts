/**
 * chromex-call — MCP client CLI for browser tools.
 *
 * Some providers (observed: codex app-server with weak models) cannot
 * invoke MCP tools as first-class functions — tools/call names come
 * back "unsupported call" and the model improvises. This binary is the
 * reliable fallback: it speaks MCP to mcp-stdio.js over stdio, exactly
 * like a provider's MCP client would, so ANY model that can run a shell
 * command can drive the browser.
 *
 * Usage:
 *   node mcp-call.js <tool> ['<json-args>'] [--scope <scope-file>]
 *
 * Scope resolution: --scope flag, else CHROMEX_MCP_SCOPE_FILE, else the
 * newest file in <CHROMEX_GATEWAY_HOME|~/.chromex/gateway>/mcp/.
 * Prints the tool result's text content to stdout; exits non-zero on
 * MCP/tool errors.
 */

import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MCP_STDIO = fileURLToPath(new URL("./mcp-stdio.js", import.meta.url));

function usage(): never {
  process.stderr.write(
    "usage: node mcp-call.js <tool> ['<json-args>'] [--scope <scope-file>]\n",
  );
  process.exit(2);
}

async function resolveScopePath(argv: string[]): Promise<string> {
  const flagIdx = argv.indexOf("--scope");
  const flagValue = flagIdx >= 0 ? argv[flagIdx + 1] : undefined;
  if (flagValue) return flagValue;
  if (process.env.CHROMEX_MCP_SCOPE_FILE) return process.env.CHROMEX_MCP_SCOPE_FILE;
  const gatewayHome =
    process.env.CHROMEX_GATEWAY_HOME ?? path.join(homedir(), ".chromex", "gateway");
  const mcpDir = path.join(gatewayHome, "mcp");
  const files = (await readdir(mcpDir).catch(() => [] as string[]))
    .filter((f) => f.endsWith(".json"))
    .sort();
  const newest = files[files.length - 1];
  if (!newest) {
    throw new Error(
      `no MCP scope file found in ${mcpDir} — pass --scope or set CHROMEX_MCP_SCOPE_FILE`,
    );
  }
  return path.join(mcpDir, newest);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const positional = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--scope");
  const [tool, jsonArg] = positional;
  if (!tool && !argv.includes("--list")) usage();
  const args = jsonArg ? (JSON.parse(jsonArg) as Record<string, unknown>) : {};
  const scopePath = await resolveScopePath(argv);
  await readFile(scopePath, "utf8"); // fail fast if unreadable

  const child = spawn(process.execPath, [MCP_STDIO], {
    env: { ...process.env, CHROMEX_MCP_SCOPE_FILE: scopePath },
    stdio: ["pipe", "pipe", "inherit"],
  });

  let buf = "";
  const pending = new Map<number, (msg: Record<string, unknown>) => void>();
  let nextId = 1;
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line) as Record<string, unknown>;
        const id = msg.id as number | undefined;
        if (id !== undefined && pending.has(id)) {
          pending.get(id)!(msg);
          pending.delete(id);
        }
      } catch {
        /* non-JSON noise on stdout — ignore */
      }
    }
  });

  const request = (method: string, params?: unknown): Promise<Record<string, unknown>> =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 60_000).unref();
    });

  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "chromex-call", version: "0.1.0" },
  });
  if (init.error) throw new Error(`initialize failed: ${JSON.stringify(init.error)}`);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");

  const call = (name: string, callArgs: Record<string, unknown>) =>
    request("tools/call", { name, arguments: callArgs });

  // Discovery path: `mcp-call.js --list` prints every advertised tool
  // name + one-line description so a model that guessed wrong can
  // self-correct without reading source.
  if (argv.includes("--list") || tool === "list_tools") {
    const list = await request("tools/list", {});
    child.kill();
    const tools =
      ((list.result as {
        tools?: Array<{
          name: string;
          description?: string;
          inputSchema?: {
            required?: string[];
            properties?: Record<
              string,
              { description?: string; enum?: Array<string | number> }
            >;
          };
        }>;
      })?.tools) ?? [];
    for (const t of tools) {
      const desc = (t.description ?? "").split("\n")[0]?.slice(0, 100) ?? "";
      const schema = t.inputSchema;
      const args = schema?.properties
        ? Object.entries(schema.properties)
            .map(([k, prop]) => {
              const req = schema.required?.includes(k) ? "*" : "";
              // enum values inline — models kept guessing invalid args
              // (e.g. snapshot mode:"compact") because --list hid them.
              const variants =
                Array.isArray(prop?.enum) && prop.enum.length > 0
                  ? `(${prop.enum.join("|")})`
                  : "";
              return `${k}${req}${variants}`;
            })
            .join(",")
        : "";
      process.stdout.write(`${t.name} — ${desc}${args ? ` [args: ${args}]` : ""}\n`);
    }
    return;
  }
  if (!tool) usage();

  const res = await call(tool, args);
  const result = res.result as
    | { content?: Array<{ type: string; text?: string }>; isError?: boolean }
    | undefined;
  let text = (result?.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
  if (res.error) {
    text = `tool error: ${JSON.stringify(res.error)}`;
  }
  // Self-correcting error: an unknown tool name is the most common
  // failure — append the advertised names so the caller can retry
  // without a second discovery round-trip. Covers both the JSON-RPC
  // error shape and the isError-content shape the server emits.
  if (/unknown tool/i.test(text)) {
    const list = await request("tools/list", {});
    const names =
      ((list.result as { tools?: Array<{ name: string }> })?.tools ?? []).map(
        (t) => t.name,
      );
    text += `\navailable tools:\n  ${names.join("\n  ")}`;
  }
  child.kill();
  // Resolve artifact:<id> refs to their on-disk paths — models
  // receiving a screenshot/pdf otherwise burn commands hunting the
  // artifact store. Files live at <gatewayHome>/artifacts/<id>.<ext>.
  const artifactIds = [...text.matchAll(/artifact:([A-Za-z0-9-]+)/g)].map((m) => m[1]);
  if (artifactIds.length > 0) {
    const { readdir } = await import("node:fs/promises");
    const artDir = path.join(
      process.env.CHROMEX_GATEWAY_HOME ?? path.join(homedir(), ".chromex", "gateway"),
      "artifacts",
    );
    const files = await readdir(artDir).catch(() => [] as string[]);
    const paths = artifactIds
      .map((id) => files.find((f) => f.startsWith(`${id}.`)))
      .filter((f): f is string => typeof f === "string")
      .map((f) => path.join(artDir, f));
    if (paths.length > 0) {
      text += `\n[artifact files: ${paths.join(", ")}]`;
    }
  }
  process.stdout.write(text + "\n");
  if (res.error || result?.isError) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`chromex-call: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
