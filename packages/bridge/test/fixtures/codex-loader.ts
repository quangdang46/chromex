/**
 * Codex app-server fixture loader — GateB-B2.
 * P1-05's mapper replays `notifications` through the real mapper and
 * asserts `expectedDurableEvents`/`expectedEphemeralEvents` sequences.
 */

import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface CodexFixture {
  name: string;
  description: string;
  gatewayTurnId: string;
  notifications?: Array<{ method: string; params?: unknown }>;
  expectedDurableEvents?: Array<Record<string, unknown>>;
  expectedEphemeralEvents?: Array<Record<string, unknown>>;
  expectedBehavior?: string[];
  permissionFlow?: Record<string, unknown>;
  scenario?: string;
  notes?: string;
}

const FIXTURE_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "fixtures",
  "codex",
);

export function listCodexFixtures(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
}

export function loadCodexFixture(name: string): CodexFixture {
  const file = name.endsWith(".json") ? name : `${name}.json`;
  return JSON.parse(readFileSync(path.join(FIXTURE_DIR, file), "utf8")) as CodexFixture;
}

export function loadAllCodexFixtures(): CodexFixture[] {
  return listCodexFixtures().map((f) => loadCodexFixture(f));
}
