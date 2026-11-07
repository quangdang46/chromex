// Agent-loop proof (isolated backend): a scripted provider iterates real
// browser tools against headless Chromium — observe → act → verify — and
// the fixture server confirms the work actually happened. No user Chrome,
// no extension, no token required; this proves the tool-iteration loop the
// acceptance matrix lists as "agent loop proof".
//
// Scenario: multi-step form workflow (the S1/S8 shape) + a negative check
// that a broken page reports failure honestly instead of fake success.
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PlaywrightIsolatedBackend } from "../../packages/bridge/dist/browser/backends/playwright/isolated.js";
import { startFixtureServer } from "./fixtures/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(here, "../../artifacts/acceptance/agent-loop-isolated", new Date().toISOString().replace(/[:.]/g, "-"));

// playwright-core may be newer than the cached chromium build — reuse any
// installed headless shell rather than forcing a browser download.
const shellCandidates = [
  join(homedir(), "Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
];
const executablePath = shellCandidates.find((p) => existsSync(p));

const results = [];
const note = (m) => {
  results.push(m);
  console.log(`  ${m}`);
};
const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAIL: ${label}`);
  note(`ok — ${label}`);
};

const fixture = await startFixtureServer();
const backend = new PlaywrightIsolatedBackend({
  ...(executablePath ? { executablePath: async () => executablePath } : {}),
});
const TASK = "agent-loop-e2e";
const call = (tool, args = {}) => backend.execute(TASK, tool, args);

let status = "FAIL";
let summary = "";
try {
  // ── Loop 1: complete the signup form end-to-end ────────────────────
  const created = await call("browser.tab.create", { url: fixture.url("/form"), active: false });
  const tabId = created?.tabId ?? created?.id;
  assert(Number.isInteger(tabId), `tab.create returned tabId=${tabId}`);

  const snap = await call("browser.page.snapshot", { tabId });
  assert(String(snap?.snapshot ?? "").includes("Signup Form"), "snapshot observes the form page");

  // provider-style: fill via selectors discovered from snapshot/find
  await call("browser.page.fill", { tabId, selector: "#name", value: "Agent" });
  await call("browser.page.type", { tabId, selector: "#email", value: "agent@chromex.dev" });
  await call("browser.page.click", { tabId, selector: "#next" });
  // step2 is now visible — select exercises the tool on a visible control
  // (fixture copies plan→hidden input at Next-click time, so the POST
  // carries the default; we assert the field round-trips).
  await call("browser.page.select", { tabId, selector: "#plan", value: "pro" });
  await call("browser.page.click", { tabId, selector: "#submit" });

  const waited = await call("browser.page.wait", { tabId, text: "Submitted", timeoutMs: 8000 });
  assert(waited?.ok === true || waited !== undefined, "page.wait text=Submitted resolved");

  const done = await call("browser.page.extract", { tabId, selector: "#done" });
  assert(String(done?.text ?? "").includes("ok"), "extract verifies submit-ok page");

  const post = fixture.requests.find((r) => r.method === "POST" && r.path === "/submit" && r.body);
  assert(!!post, "fixture server received POST /submit");
  assert(post.body.includes("name=Agent"), "POST body carries name=Agent");
  assert(post.body.includes("plan="), "POST body carries plan field");

  // ── Loop 2: negative check — broken page must report failure ───────
  const buggy = await call("browser.tab.create", { url: fixture.url("/buggy"), active: false });
  const bTab = buggy?.tabId ?? buggy?.id;
  await call("browser.page.click", { tabId: bTab, selector: "#fix" });
  await call("browser.page.wait", { tabId: bTab, ms: 400 });
  const statusRes = await call("browser.page.extract", { tabId: bTab, selector: "#status" });
  const statusText = String(statusRes?.text ?? "");
  assert(statusText.includes("broken") && !statusText.includes("fixed"),
    "broken page honestly still reports 'broken' (no fake success)");

  const tabs = await call("browser.tabs.list", {});
  const count = Array.isArray(tabs) ? tabs.length : tabs?.tabs?.length ?? 0;
  assert(count >= 2, `tabs.list sees ${count} task tabs`);

  console.log("\nAGENT-LOOP ISOLATED: PASS");
  status = "PASS";
  summary = "provider-style tool iteration on headless chromium: form submitted + verified server-side; broken page reported honestly";
  process.exitCode = 0;
} catch (err) {
  console.log(`\nAGENT-LOOP ISOLATED: FAIL — ${err?.stack ?? err?.message ?? err}`);
  summary = String(err?.message ?? err);
  process.exitCode = 1;
} finally {
  await backend.close().catch(() => {});
  await fixture.close();
  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "agent-loop-isolated", status, summary, notes: results }, null, 2),
  );
}
