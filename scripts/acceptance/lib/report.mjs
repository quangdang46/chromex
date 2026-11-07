// Acceptance report formatter — PASS/FAIL/BLOCKED/SKIP.
// BLOCKED = harness/provider unavailable, never counted as product failure.
// SKIP   = scenario not applicable in this environment.
import { readdir, readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { ARTIFACTS_ROOT } from "./harness.mjs";

const ORDER = { PASS: 0, FAIL: 1, BLOCKED: 2, SKIP: 3 };

export function formatScenarioLine(r) {
  const icon = { PASS: "PASS", FAIL: "FAIL", BLOCKED: "BLOCKED", SKIP: "SKIP" }[r.status] ?? r.status;
  const dur = r.durationMs != null ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : "";
  return `| ${r.scenario} | ${icon} | ${r.summary ?? ""}${dur} | ${r.evidenceDir ?? ""} |`;
}

export function formatMarkdown(results) {
  const lines = [
    "# Chromex Acceptance Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "| Scenario | Status | Summary | Evidence |",
    "|----------|--------|---------|----------|",
  ];
  for (const r of [...results].sort((a, b) => (ORDER[a.status] ?? 9) - (ORDER[b.status] ?? 9) || a.scenario.localeCompare(b.scenario))) {
    lines.push(formatScenarioLine(r));
  }
  lines.push("");
  const fails = results.filter((r) => r.status === "FAIL");
  const blocked = results.filter((r) => r.status === "BLOCKED");
  if (fails.length) {
    lines.push("## Failures", "");
    for (const f of fails) {
      lines.push(`### ${f.scenario}`, "", f.summary ?? "", "");
      if (f.details) lines.push("```json", JSON.stringify(f.details, null, 2).slice(0, 4000), "```", "");
      if (f.notes?.length) lines.push(...f.notes.map((n) => `- ${n}`), "");
    }
  }
  if (blocked.length) {
    lines.push("## Blocked", "");
    for (const b of blocked) lines.push(`- **${b.scenario}**: ${b.summary ?? ""}`);
    lines.push("");
  }
  return lines.join("\n");
}

/** Scan artifacts/acceptance/<scenario>/<run>/ for the newest result.json per scenario. */
export async function collectResults(root = ARTIFACTS_ROOT) {
  const out = [];
  let scenarios;
  try {
    scenarios = await readdir(root, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const s of scenarios) {
    if (!s.isDirectory()) continue;
    const sdir = join(root, s.name);
    let runs;
    try {
      runs = await readdir(sdir, { withFileTypes: true });
    } catch {
      continue;
    }
    let newest = null;
    for (const r of runs) {
      if (!r.isDirectory()) continue;
      const rp = join(sdir, r.name, "result.json");
      try {
        const st = await stat(rp);
        if (!newest || st.mtimeMs > newest.mtimeMs) newest = { path: rp, mtimeMs: st.mtimeMs, dir: join(sdir, r.name) };
      } catch {}
    }
    if (!newest) continue;
    try {
      const data = JSON.parse(await readFile(newest.path, "utf8"));
      out.push({ scenario: s.name, ...data, evidenceDir: newest.dir });
    } catch {}
  }
  return out;
}

export async function writeReport(results, outDir = ARTIFACTS_ROOT) {
  const md = formatMarkdown(results);
  const json = JSON.stringify({ generatedAt: new Date().toISOString(), results }, null, 2);
  const { mkdir } = await import("node:fs/promises");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, "acceptance-report.md"), md);
  await writeFile(join(outDir, "acceptance-report.json"), json);
  return { mdPath: join(outDir, "acceptance-report.md"), jsonPath: join(outDir, "acceptance-report.json") };
}
