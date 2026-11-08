/**
 * CDP Profiler.takePreciseCoverage result → compact per-script summary.
 * Shared by both browser backends so browser.page.coverage reports the
 * same shape on chrome-extension and playwright-isolated.
 *
 * Totals always count every script; only the detail list truncates at
 * COVERAGE_MAX_SCRIPTS, reported honestly via omittedScripts.
 */

export const COVERAGE_MAX_SCRIPTS = 500;

export interface CoverageScriptEntry {
  scriptId?: string;
  url?: string;
  functions?: Array<{ functionName?: string; ranges?: Array<{ count?: number }> }>;
}

export interface CoverageScriptSummary {
  url: string;
  scriptId: string;
  functions: number;
  invokedFunctions: number;
}

export interface CoverageSummary {
  scripts: CoverageScriptSummary[];
  totals: { scripts: number; functions: number; invokedFunctions: number };
  omittedScripts?: number;
}

export function summarizeCoverage(raw: unknown): CoverageSummary {
  const entries = Array.isArray(raw) ? (raw as CoverageScriptEntry[]) : [];
  const scripts: CoverageScriptSummary[] = [];
  let functions = 0;
  let invokedFunctions = 0;
  let omittedScripts = 0;
  for (const s of entries) {
    const fns = Array.isArray(s?.functions) ? s.functions : [];
    const invoked = fns.filter((f) =>
      (f?.ranges ?? []).some((r) => (r?.count ?? 0) > 0),
    ).length;
    functions += fns.length;
    invokedFunctions += invoked;
    if (scripts.length < COVERAGE_MAX_SCRIPTS) {
      scripts.push({
        url: typeof s?.url === "string" ? s.url : "",
        scriptId: typeof s?.scriptId === "string" ? s.scriptId : "",
        functions: fns.length,
        invokedFunctions: invoked,
      });
    } else {
      omittedScripts += 1;
    }
  }
  return {
    scripts,
    totals: { scripts: entries.length, functions, invokedFunctions },
    ...(omittedScripts > 0 ? { omittedScripts } : {}),
  };
}
