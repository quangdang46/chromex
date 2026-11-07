/**
 * Turn deliverable evidence — S8.
 *
 * Derives a "what actually happened" summary for a completed turn from
 * data already in the conversation: the persisted turn-trace items
 * (tool calls translated from provider/gateway events) plus small
 * extras the sidepanel records itself (diff file lists, approval
 * answers it submitted). Nothing is synthesized — a section only
 * appears when the underlying events exist.
 *
 * Fidelity tiers (see report): gateway-mode trace items carry
 * `tool`/`input`/`output` (bounded JSON), so commands can show exit
 * codes and file edits can show real paths. Legacy codex-plane
 * `turn.activity` events carry only kind/title/detail, so paths come
 * from the `turn.diff.updated` diff text or the trace detail string.
 */

import type { ConversationMessageTraceItem } from "../types.js";

export interface DeliverableApproval {
  /** the question/summary the user was asked */
  question: string;
  /** the answer text the user submitted (option id/label or custom text) */
  answer: string;
}

export interface DeliverableExtras {
  /** file paths parsed from the full turn diff at event time */
  diffFiles?: string[];
  /** approval requests answered through the sidepanel this session */
  approvals?: DeliverableApproval[];
}

export interface DeliverableFile {
  path: string;
  status: "completed" | "failed";
}

export interface DeliverableCommand {
  command: string;
  status: "completed" | "failed";
  exitCode?: number;
}

export interface DeliverableBrowserAction {
  tool: string;
  detail: string;
  status: "completed" | "failed";
}

export interface TurnDeliverable {
  files: DeliverableFile[];
  commands: DeliverableCommand[];
  browserActions: DeliverableBrowserAction[];
  approvals: DeliverableApproval[];
  /** completed tool/web/image steps that fit no evidence bucket */
  otherStepCount: number;
  failedCount: number;
}

// ---- tool classification -------------------------------------------------
// Mirrors the coarse buckets in background/gateway/legacy-events.ts
// describeGatewayTool, refined with the provider tool name when the
// gateway path supplied one.

const EDIT_TOOL_RE = /edit|write|patch|filechange|multiedit|notebook|apply/i;
const READ_TOOL_RE = /read|grep|glob|list|ls|search|find|view|cat|open|explore/i;
const COMMAND_TOOL_RE = /command|bash|shell|exec|terminal|run/i;
const BROWSER_TOOL_RE = /browser/i;

const EDIT_TITLE_RE = /edit|writ|patch|diff|chang|work complete/i;
const READ_TITLE_RE = /explor|read|search|list/i;

type TraceStatus = ConversationMessageTraceItem["status"];

function traceStatus(item: ConversationMessageTraceItem): "completed" | "failed" {
  return item.status === "failed" ? "failed" : "completed";
}

function isEditLike(item: ConversationMessageTraceItem): boolean {
  if (item.id === "turn-diff") {
    // diff marker row — file list comes from extras.diffFiles instead
    return false;
  }
  const tool = (item.tool ?? "").trim();
  if (tool) {
    if (EDIT_TOOL_RE.test(tool)) return true;
    if (READ_TOOL_RE.test(tool) || COMMAND_TOOL_RE.test(tool) || BROWSER_TOOL_RE.test(tool)) {
      return false;
    }
  }
  if (item.kind !== "file") {
    return false;
  }
  const title = item.title.trim();
  if (EDIT_TITLE_RE.test(title)) return true;
  if (READ_TITLE_RE.test(title)) return false;
  // legacy file-kind rows without a tool name: only trust explicit
  // change/edit wording; bare "file work" titles stay out
  return false;
}

function isCommandLike(item: ConversationMessageTraceItem): boolean {
  if (item.kind === "command") return true;
  const tool = (item.tool ?? "").trim();
  return Boolean(tool && COMMAND_TOOL_RE.test(tool) && item.kind !== "browser");
}

function isBrowserLike(item: ConversationMessageTraceItem): boolean {
  if (item.kind === "browser") return true;
  const tool = (item.tool ?? "").trim();
  return Boolean(tool && BROWSER_TOOL_RE.test(tool));
}

// ---- bounded payload parsing --------------------------------------------
// Trace `input`/`output` are already-bounded display strings; when they
// happen to be JSON (gateway path stringifies the bounded event payload)
// we can read structured fields. Anything unparseable falls back to the
// human-readable detail — never invented.

function parseJsonRecord(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function firstString(rec: Record<string, unknown> | null, keys: string[]): string {
  if (!rec) return "";
  for (const key of keys) {
    const v = rec[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

function extractCommand(item: ConversationMessageTraceItem): string {
  const rec = parseJsonRecord(item.input);
  const fromInput = firstString(rec, ["command", "commandLine", "cmd", "commandLineString"]);
  if (fromInput) return fromInput;
  return item.detail.trim();
}

function extractExitCode(item: ConversationMessageTraceItem): number | undefined {
  const rec = parseJsonRecord(item.output);
  const code = rec?.exitCode ?? rec?.exit_code;
  return typeof code === "number" && Number.isFinite(code) ? code : undefined;
}

function extractFilePaths(item: ConversationMessageTraceItem): string[] {
  const paths = new Set<string>();
  const rec = parseJsonRecord(item.input);
  if (rec) {
    for (const key of ["path", "file_path", "filePath", "notebook_path", "target_file"]) {
      const v = rec[key];
      if (typeof v === "string" && v.trim()) paths.add(v.trim());
    }
    const changes = rec.changes;
    if (Array.isArray(changes)) {
      for (const change of changes) {
        if (!change || typeof change !== "object") continue;
        const c = change as Record<string, unknown>;
        for (const key of ["path", "file_path", "filePath"]) {
          const v = c[key];
          if (typeof v === "string" && v.trim()) paths.add(v.trim());
        }
      }
    }
  }
  if (paths.size === 0 && item.detail.trim()) {
    // legacy path: detail is the path-ish summary already shown in trace
    for (const part of item.detail.split(",")) {
      const p = part.trim();
      if (p) paths.add(p);
    }
  }
  return [...paths];
}

// ---- diff parsing ---------------------------------------------------------

/** File paths touched by a unified diff (`diff --git` / `+++ b/` headers). */
export function parseUnifiedDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  const patterns = [
    /^diff --git a\/(.+?) b\/(.+)$/gm,
    /^\+\+\+ b\/(.+)$/gm,
    /^\+\+\+ "b\/(.+)"$/gm,
  ];
  for (const pattern of patterns) {
    for (const match of diff.matchAll(pattern)) {
      const captured = match[2] ?? match[1];
      if (captured && captured !== "/dev/null") {
        paths.add(captured.trim().replace(/^"|"$/g, ""));
      }
    }
  }
  // `+++ /dev/null` marks deletions; the `--- a/` side still names the file
  for (const match of diff.matchAll(/^--- a\/(.+)$/gm)) {
    if (match[1]) paths.add(match[1].trim().replace(/^"|"$/g, ""));
  }
  return [...paths];
}

// ---- summary ---------------------------------------------------------------

/**
 * Summarize one turn's trace into deliverable evidence. Returns null
 * when there is nothing worth surfacing (no tool/file/command/browser/
 * approval activity) so plain chat turns stay clean.
 */
export function summarizeTurnDeliverable(
  trace: ConversationMessageTraceItem[] | undefined,
  extras?: DeliverableExtras,
): TurnDeliverable | null {
  const items = trace ?? [];
  const files: DeliverableFile[] = [];
  const commands: DeliverableCommand[] = [];
  const browserActions: DeliverableBrowserAction[] = [];
  const approvals = (extras?.approvals ?? []).filter((a) => a.question.trim());
  let otherStepCount = 0;
  let failedCount = 0;

  const seenFilePaths = new Set<string>();
  const pushFile = (path: string, status: TraceStatus) => {
    if (!path || seenFilePaths.has(path)) return;
    seenFilePaths.add(path);
    files.push({ path, status: status === "failed" ? "failed" : "completed" });
  };

  for (const path of extras?.diffFiles ?? []) {
    pushFile(path, "completed");
  }

  for (const item of items) {
    if (item.kind === "reasoning" || item.kind === "response") continue;
    if (item.status === "failed") failedCount += 1;

    if (isEditLike(item)) {
      const paths = extractFilePaths(item);
      if (paths.length) {
        for (const p of paths) pushFile(p, item.status);
      } else {
        // edit happened but path not parseable — count as an other step
        // rather than fabricating a filename
        otherStepCount += 1;
      }
      continue;
    }
    if (isCommandLike(item)) {
      const exitCode = extractExitCode(item);
      commands.push({
        command: extractCommand(item),
        status: traceStatus(item),
        ...(exitCode !== undefined ? { exitCode } : {}),
      });
      continue;
    }
    if (isBrowserLike(item)) {
      browserActions.push({
        tool: (item.tool ?? "").trim() || "browser",
        detail: item.detail.trim(),
        status: traceStatus(item),
      });
      continue;
    }
    if (item.status !== "running") {
      otherStepCount += 1;
    }
  }

  const hasEvidence =
    files.length > 0 ||
    commands.length > 0 ||
    browserActions.length > 0 ||
    approvals.length > 0 ||
    otherStepCount > 0 ||
    failedCount > 0;
  if (!hasEvidence) return null;

  return { files, commands, browserActions, approvals, otherStepCount, failedCount };
}
