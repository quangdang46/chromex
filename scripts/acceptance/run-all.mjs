// Run every acceptance scenario and aggregate artifacts/acceptance/acceptance-report.{md,json}.
// Usage: node scripts/acceptance/run-all.mjs [s1-build-feature s3-multitab ...]
//        CHROMEX_ACCEPTANCE_ONLY="s3,s7" node scripts/acceptance/run-all.mjs
//        CHROMEX_ACCEPTANCE_SKIP_LIVE=1 → skip provider scenarios (s1,s2)
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { collectResults, writeReport, formatMarkdown } from "./lib/report.mjs";
import { realBrowserScenariosEnabled } from "./lib/harness.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// Scenarios that run fully in-process/headless — no user Chrome, no
// acceptance token required.
const TOKENLESS = new Set([
  "agent-loop-isolated",
  "agent-loop-mcp-isolated",
  "gateway-mcp-isolated",
  "gateway-host-routing",
  "native-host-relay",
  "content-script-isolated",
]);
const ALL = [
  "agent-loop-isolated",
  "agent-loop-mcp-isolated",
  "gateway-mcp-isolated",
  "gateway-host-routing",
  "native-host-relay",
  "content-script-isolated",
  "s1-build-feature",
  "s2-debug-live",
  "s3-multitab",
  "s5-interruption",
  "s6-failedplan",
  "s7-approval",
  "s8-deliverable",
];
const LIVE = new Set(["s1-build-feature", "s2-debug-live"]);

const args = process.argv.slice(2);
const onlyEnv = process.env.CHROMEX_ACCEPTANCE_ONLY?.split(",").map((s) => s.trim()).filter(Boolean);
let scenarios = args.length ? args : onlyEnv ?? ALL;
if (process.env.CHROMEX_ACCEPTANCE_SKIP_LIVE === "1") {
  scenarios = scenarios.filter((s) => !LIVE.has(s));
}
if (!realBrowserScenariosEnabled()) {
  const skipped = scenarios.filter((s) => !TOKENLESS.has(s));
  if (skipped.length) {
    console.log(`[acceptance] no token — skipping real-browser scenarios: ${skipped.join(", ")}`);
    console.log("[acceptance] arm with: echo \"$(uuidgen)\" > /tmp/chromex-acceptance-token && CHROMEX_ACCEPTANCE_TOKEN=$(cat /tmp/chromex-acceptance-token) node scripts/acceptance/run-all.mjs");
  }
  scenarios = scenarios.filter((s) => TOKENLESS.has(s));
}
// resolve scenario names → script files present
const files = await readdir(here);
const runnable = scenarios.filter((s) => files.includes(`${s}.mjs`));
const missing = scenarios.filter((s) => !files.includes(`${s}.mjs`));
for (const m of missing) console.log(`[skip] ${m}: no script`);

const results = [];
for (const s of runnable) {
  console.log(`\n########## ${s} ##########`);
  const SCENARIO_TIMEOUT_MS = Number(process.env.CHROMEX_ACCEPTANCE_SCENARIO_TIMEOUT_MS || 600_000);
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [join(here, `${s}.mjs`)], {
      cwd: join(here, "../.."),
      env: { ...process.env },
      stdio: "inherit",
    });
    const killer = setTimeout(() => {
      console.log(`[${s}] exceeded ${SCENARIO_TIMEOUT_MS}ms — killing`);
      child.kill("SIGKILL");
    }, SCENARIO_TIMEOUT_MS);
    child.on("exit", (c) => {
      clearTimeout(killer);
      resolve(c ?? 1);
    });
  });
  console.log(`[${s}] exit=${code}`);
}

const collected = await collectResults();
const { mdPath, jsonPath } = await writeReport(collected);
console.log("\n" + formatMarkdown(collected));
console.log("\nreport:", mdPath);
console.log("json:  ", jsonPath);
process.exit(0);
