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

import {
  BROWSER_TOOL_NAMES,
  type BrowserBackendId,
  type BrowserToolName,
} from "@codex-sidepanel/shared";

import { PLAYWRIGHT_ISOLATED_SUPPORTED_TOOLS } from "./backends/playwright/isolated.js";

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

/**
 * Honest per-backend tool advertisement (chromex-51ua). The scope
 * file's `allowedTools` — mirrored into the signed token — must list
 * exactly what the pinned backend can execute, so tools/list never
 * advertises a tool that fails proto.unsupported at call time:
 *  - chrome-extension: tool-host implements every BrowserToolName.
 *  - playwright-isolated: PLAYWRIGHT_ISOLATED_SUPPORTED_TOOLS — the
 *    same set execute() enforces.
 *  - playwright-cdp: same executor as playwright-isolated over a
 *    CDP-attached browser — identical honest tool surface.
 */
export function supportedToolsForBackend(backendId: BrowserBackendId): BrowserToolName[] {
  switch (backendId) {
    case "chrome-extension":
      return [...BROWSER_TOOL_NAMES];
    case "playwright-isolated":
    case "playwright-cdp":
      return [...PLAYWRIGHT_ISOLATED_SUPPORTED_TOOLS];
  }
}

export function mcpScopeDir(dataDir: string): string {
  return path.join(dataDir, "mcp");
}

export function mcpScopePath(dataDir: string, taskId: string): string {
  // taskId is a ULID — safe filename; sanitize anyway
  const safe = taskId.replace(/[^A-Za-z0-9_-]/g, "_");
  return path.join(mcpScopeDir(dataDir), `${safe}.json`);
}

/** task.purge: the scope file is inert once the task is gone (the RPC
 *  layer rejects dead taskIds before token verify matters), but leaving
 *  one 0600 credential file per purged task accumulates forever. */
export async function removeMcpScopeFile(dataDir: string, taskId: string): Promise<void> {
  await fs.unlink(mcpScopePath(dataDir, taskId)).catch(() => {});
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
