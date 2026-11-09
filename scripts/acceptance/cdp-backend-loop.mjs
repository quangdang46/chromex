// Agent-loop proof (playwright-cdp backend): a scripted observe → act →
// verify → recover loop against a LIVE Chromium attached over CDP —
// the same executor as playwright-isolated but acquired via
// connectOverCDP. The attached browser's own tab must never leak into
// tool results; killing + relaunching the browser on the same endpoint
// must recover with fresh task contexts (stale-handle fix 1f5c160).
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { PlaywrightCdpBackend } from "../../packages/bridge/dist/browser/backends/playwright/cdp.js";
import { startFixtureServer } from "./fixtures/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ARTIFACT_DIR = join(here, "../../artifacts/acceptance/cdp-backend-loop", new Date().toISOString().replace(/[:.]/g, "-"));
const CDP_PORT = 19300 + Math.floor(Math.random() * 200);
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

const results = [];
const note = (m) => { results.push(m); console.log(`  ${m}`); };
const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAIL: ${label}`);
  note(`ok — ${label}`);
};

const fixture = await startFixtureServer();
let userBrowser = null;
const backend = new PlaywrightCdpBackend({ endpoint: async () => CDP_ENDPOINT });
const TASK = "cdp-loop-e2e";
const call = (tool, args = {}) => backend.execute(TASK, tool, args);

try {
  // ---- attach target: plain chromium + debug port ("user browser") --
  userBrowser = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1"],
  });
  const userCtx = await userBrowser.newContext();
  const userPage = await userCtx.newPage();
  await userPage.goto("data:text/html,<title>USER-OWNED-TAB</title><h1>do not touch</h1>");

  // ---- observe → act → verify on the fixture form -------------------
  await call("browser.page.navigate", { url: fixture.url("/form") });
  const snap = await call("browser.page.snapshot", {});
  assert(String(snap.snapshot ?? snap.raw ?? "").length > 20, "snapshot observes the form page over CDP");

  await call("browser.page.fill", { selector: "#name", value: "CDP Loop" });
  await call("browser.page.click", { selector: "#next" });
  await call("browser.page.select", { selector: "#plan", value: "pro" });
  await call("browser.page.submit", { selector: "#submit" });
  await call("browser.page.wait", { text: "Submitted", timeoutMs: 8000 });
  const done = await call("browser.page.extract", { selector: "#done" });
  assert(String(done.text ?? "").includes("ok"), "form submitted end-to-end on attached browser");
  const post = fixture.requests.find((r) => r.method === "POST" && r.path === "/submit" && r.body);
  assert(!!post && post.body.includes("name=CDP"), "fixture server saw POST /submit");

  // ---- user tab never leaks ------------------------------------------
  const tabs = await call("browser.tabs.list", {});
  const tabsJson = JSON.stringify(tabs);
  assert(!tabsJson.includes("USER-OWNED-TAB"), "attached browser's own tab NOT in tabs.list");

  // ---- per-task isolation --------------------------------------------
  const tabsOther = await backend.execute("cdp-loop-other", "browser.tabs.list", {});
  assert(JSON.stringify(tabsOther).includes('"tabs":[]') || JSON.stringify(tabsOther).includes('"tabs": []'),
    "second task context sees zero tabs from first task");

  // ---- recover: kill the whole browser, relaunch same endpoint -------
  await userBrowser.close();
  await new Promise((r) => setTimeout(r, 400));
  userBrowser = await chromium.launch({
    headless: true,
    args: [`--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1"],
  });
  const userPage2 = await userBrowser.newContext().then((c) => c.newPage());
  await userPage2.goto("data:text/html,<title>USER-OWNED-TAB-2</title>");

  // stale context must be dropped → fresh context on the new browser
  await call("browser.page.navigate", { url: fixture.url("/form") });
  const ev = await call("browser.page.evaluate", { expression: "location.pathname" });
  assert(JSON.stringify(ev).includes("/form"), "post-restart navigate + evaluate recovered on fresh context");
  const tabsAfter = await call("browser.tabs.list", {});
  assert(!JSON.stringify(tabsAfter).includes("USER-OWNED-TAB-2"), "new user tab still not leaked after restart");

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "cdp-backend-loop", status: "PASS", asserts: results.length, cdpEndpoint: CDP_ENDPOINT }, null, 2),
  );
  console.log(`\nCDP BACKEND LOOP: PASS (${results.length} asserts)`);
} catch (err) {
  console.log(`\nCDP BACKEND LOOP: FAIL — ${err.message}`);
  process.exitCode = 1;
} finally {
  await backend.close().catch(() => {});
  await userBrowser?.close().catch(() => {});
  await fixture.close().catch(() => {});
}
