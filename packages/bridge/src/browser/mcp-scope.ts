/**
 * MCP scope files — plan §9.1/§9.3 / P1-09.
 *
 * One 0600 JSON file per task at <dataDir>/mcp/<taskId>.json. Contains
 * the tool token + gateway IPC pointers — NEVER argv/env (ps is
 * world-readable). The spawned MCP stdio process re-reads the file on
 * every tools/call, which is also the hot-update path for
 * `tool.token.refreshed`: the refresher rewrites the file and the next
 * call picks up the new generation (old gen valid 60s grace).
 */

import fs from "node:fs/promises";
import path from "node:path";

import type { BrowserBackendId } from "@codex-sidepanel/shared";

export interface McpScopeFile {
  taskId: string;
  token: string;
  tokenExpiresAt: number;
  profileId: string;
  backendId: BrowserBackendId;
  allowedTools: string[];
  /** gateway IPC endpoint (unix socket / pipe path) */
  gatewayEndpoint: string;
  /** path to <dataDir>/auth/token (0600) for the IPC hello */
  gatewayTokenFile: string;
  writtenAt: number;
}

export function mcpScopeDir(dataDir: string): string {
  return path.join(dataDir, "mcp");
}

export function mcpScopePath(dataDir: string, taskId: string): string {
  // taskId is a ULID — safe filename; sanitize anyway
  const safe = taskId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(mcpScopeDir(dataDir), `${safe}.json`);
}

export async function writeMcpScopeFile(
  dataDir: string,
  scope: Omit<McpScopeFile, "writtenAt">,
): Promise<string> {
  const dir = mcpScopeDir(dataDir);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const file = mcpScopePath(dataDir, scope.taskId);
  const payload: McpScopeFile = { ...scope, writtenAt: Date.now() };
  await fs.writeFile(file, JSON.stringify(payload), { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => {});
  return file;
}

export async function readMcpScopeFile(file: string): Promise<McpScopeFile | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as McpScopeFile;
    if (typeof parsed.taskId !== "string" || typeof parsed.token !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Hot-update path: rewrite only the token fields, keep the rest. */
export async function updateMcpScopeToken(
  dataDir: string,
  taskId: string,
  token: string,
  tokenExpiresAt: number,
): Promise<boolean> {
  const file = mcpScopePath(dataDir, taskId);
  const existing = await readMcpScopeFile(file);
  if (!existing) return false;
  await writeMcpScopeFile(dataDir, { ...existing, token, tokenExpiresAt });
  return true;
}
