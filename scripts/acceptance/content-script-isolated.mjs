// Content-script proof (isolated): injects the REAL bundled
// packages/extension/dist/content.js into headless Chromium behind a
// minimal chrome.* stub, then drives it through the same
// chrome.runtime.onMessage API the background service worker uses —
// page.dom.snapshot / page.dom.perform / page.dom.wait / page.extract.
//
// This exercises the extension's actual DOM event dispatch (pointer
// sequences, per-char type, DataTransfer upload/drag, wait conditions)
// without needing the user's Chrome or the acceptance token. It does
// NOT cover chrome.* APIs (tabs/downloads/windows) — those stay
// real-Chrome gated.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startFixtureServer } from "./fixtures/server.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(here, "../..");
const CONTENT_JS = join(REPO, "packages/extension/dist/content.js");
const ARTIFACT_DIR = join(here, "../../artifacts/acceptance/content-script-isolated", new Date().toISOString().replace(/[:.]/g, "-"));

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

if (!existsSync(CONTENT_JS)) {
  console.log("CONTENT-SCRIPT ISOLATED: SKIP — packages/extension/dist/content.js missing (run npm run build)");
  process.exit(0);
}

const fixture = await startFixtureServer();
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  headless: true,
});

const contentSource = await readFile(CONTENT_JS, "utf8");

/** Install the chrome.* stub + __chromexSend helper + content.js on the
 *  CURRENT document. Re-run after every navigation — content scripts are
 *  per-document, exactly like real Chrome re-injection. */
async function injectContent(page) {
  await page.evaluate(() => {
    // Minimal chrome.* surface the content bundle touches at init.
    window.chrome = {
      runtime: {
        id: "chromex-content-e2e",
        onMessage: {
          addListener(fn) { window.__chromexMsgListener = fn; },
          removeListener() {},
        },
        sendMessage: () => Promise.resolve({}),
      },
      storage: {
        local: {
          get: (_k, cb) => { const r = {}; if (cb) cb(r); return Promise.resolve(r); },
          set: (_o, cb) => { if (cb) cb(); return Promise.resolve(); },
        },
        onChanged: { addListener() {}, removeListener() {} },
      },
    };
    window.__chromexSend = (msg) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("content script did not respond")), 15000);
        try {
          window.__chromexMsgListener(msg, { id: "e2e" }, (res) => {
            clearTimeout(timer);
            resolve(res);
          });
        } catch (e) {
          clearTimeout(timer);
          reject(e);
        }
      });
  });
  await page.addScriptTag({ content: contentSource });
}

/** Open a fixture page with the real content.js injected behind a
 *  chrome.* stub; returns a send(msg) → response helper. */
async function openWithContent(path) {
  const page = await browser.newPage();
  await page.goto(fixture.url(path), { waitUntil: "domcontentloaded" });
  await injectContent(page);
  const ping = await page.evaluate(() => window.__chromexSend({ type: "page.ping" }));
  assert(ping?.ok === true, `${path}: content script listener active`);
  return {
    page,
    send: async (msg) => {
      // content scripts die on navigation — re-inject lazily so callers
      // don't have to track document boundaries (the background SW
      // does this via tabs.sendMessage to whichever document is live).
      const alive = await page.evaluate(() => typeof window.__chromexSend === "function").catch(() => false);
      if (!alive) await injectContent(page);
      return page.evaluate((m) => window.__chromexSend(m), msg);
    },
  };
}

const perform = (steps) => ({ type: "page.dom.perform", steps });

try {
  // ── Loop 1: form flow through the real content pipeline ─────────────
  const form = await openWithContent("/form");
  const snap = await form.send({ type: "page.dom.snapshot" });
  assert(typeof snap?.snapshotId === "string" && Array.isArray(snap?.elements) && snap.elements.length > 0,
    `dom.snapshot returns structured snapshot (${snap?.elements?.length} elements)`);
  const refFor = (sel) => snap.elements.find((e) => e.selector === sel)?.ref;

  const fillRes = await form.send(
    perform([
      // mix: ref-resolved (snapshot path) + selector-resolved (direct path)
      { action: "fill", targetRef: refFor("#name"), value: "Content Agent", reason: "e2e" },
      { action: "type", selector: "#email", value: "cs@chromex.dev", reason: "e2e" },
      { action: "click", targetRef: refFor("#next"), reason: "e2e" },
    ]),
  );
  assert(fillRes?.ok === true, `dom.perform fill/type/click ok (summary=${fillRes?.summary})`);

  const step2 = await form.send({ type: "page.dom.wait", selector: "#step2:not([hidden])", timeoutMs: 5000 });
  assert(step2?.ok === true, "dom.wait selector revealed step2");

  const submitRes = await form.send(
    perform([
      { action: "select", selector: "#plan", value: "pro", reason: "e2e" },
      { action: "submit", selector: "#submit", reason: "e2e" },
    ]),
  );
  assert(submitRes?.ok === true, `dom.perform select/submit ok (${submitRes?.summary})`);

  const done = await form.send({ type: "page.dom.wait", text: "Submitted", timeoutMs: 8000 });
  assert(done?.ok === true, "dom.wait text=Submitted after real form submit");
  const post = fixture.requests.find((r) => r.method === "POST" && r.path === "/submit" && r.body);
  assert(!!post && post.body.includes("name=Content%20Agent") || (post && post.body.includes("name=Content+Agent")), "POST body carries filled name");
  await form.page.close();

  // ── Loop 2: drag — element and coordinate forms, real DragEvent ─────
  const drag = await openWithContent("/drag");
  const dRes = await drag.send(
    perform([
      { action: "drag", selector: "#src", dropSelector: "#dst", reason: "e2e" },
    ]),
  );
  assert(dRes?.ok === true, `element drag ok (${dRes?.summary})`);
  const dOut = await drag.send({ type: "page.extract", selector: "#out" });
  assert(String(dOut?.text ?? "").startsWith("up@"), `drag produced mouseup coords (got "${dOut?.text}")`);
  await drag.page.close();

  // ── Loop 3: wait conditions — selectorGone on /vanish ────────────────
  const vanish = await openWithContent("/vanish");
  const gone = await vanish.send({ type: "page.dom.wait", selectorGone: "#x", timeoutMs: 5000 });
  assert(gone?.ok === true, "selectorGone wait resolved when #x removed");
  await vanish.page.close();

  // ── Loop 4: press/type/upload on /keys ──────────────────────────────
  const keys = await openWithContent("/keys");
  const kRes = await keys.send(
    perform([
      { action: "press", selector: "#k", key: "y", reason: "e2e" },
      {
        action: "upload",
        selector: "#f",
        files: [{ name: "cs-note.txt", mimeType: "text/plain", base64: Buffer.from("hi").toString("base64") }],
        reason: "e2e",
      },
    ]),
  );
  assert(kRes?.ok === true, `press+upload ok (${kRes?.summary})`);
  const keyOut = await keys.send({ type: "page.extract", selector: "#out" });
  assert(String(keyOut?.text ?? "").includes("key:y"), `press dispatched real key (got "${keyOut?.text}")`);
  const fname = await keys.send({ type: "page.extract", selector: "#fname" });
  assert(String(fname?.text ?? "").includes("cs-note.txt"), "upload attached file via DataTransfer");
  await keys.page.close();

  // ── Loop 5: honesty — invisible element click must fail, not fake ───
  const form2 = await openWithContent("/form");
  const bad = await form2.send(
    perform([{ action: "click", selector: "#step2 #submit", reason: "e2e" }]),
  );
  assert(bad?.ok === false, "click on hidden element reports failure");
  const badStep = (bad?.results ?? []).find((r) => r?.ok === false);
  assert(!!badStep, "failed step carries an honest result entry");
  await form2.page.close();

  // ── Loop 6: occlusion gate — covered button must fail honestly ──────
  const occ = await openWithContent("/occluded");
  const covered = await occ.send(
    perform([{ action: "click", selector: "#covered", reason: "e2e" }]),
  );
  const coveredStep = (covered?.results ?? []).find((r) => r?.ok === false);
  assert(covered?.ok === false && !!coveredStep, "click on overlay-covered element reports failure");
  assert(
    String(coveredStep?.code ?? coveredStep?.message ?? "").includes("element_not_visible") ||
      String(coveredStep?.message ?? "").includes("covered by another element"),
    `occluded click reports element_not_visible (got ${JSON.stringify(coveredStep)})`,
  );
  const outAfterCovered = await occ.send({ type: "page.extract", selector: "#out" });
  assert(
    !String(outAfterCovered?.text ?? "").includes("covered-clicked"),
    "occluded click did not fire the page handler",
  );
  const free = await occ.send(
    perform([{ action: "click", selector: "#free", reason: "e2e" }]),
  );
  assert(free?.ok === true, `uncovered click still succeeds (${free?.summary})`);
  const outAfterFree = await occ.send({ type: "page.extract", selector: "#out" });
  assert(String(outAfterFree?.text ?? "").includes("free-clicked"), "uncovered click reached the page");
  await occ.page.close();

  // ── Loop 7: select must bypass framework value trackers ─────────────
  const ts = await openWithContent("/tracked-select");
  const selRes = await ts.send(
    perform([{ action: "select", selector: "#ts", value: "b", reason: "e2e" }]),
  );
  assert(selRes?.ok === true, `select action ok (${selRes?.summary})`);
  const tout = await ts.send({ type: "page.extract", selector: "#tout" });
  assert(
    String(tout?.text ?? "").includes("mismatch=true") && String(tout?.text ?? "").includes("real=b"),
    `select bypassed the value tracker so frameworks see the change (got "${tout?.text}")`,
  );
  await ts.page.close();

  // ── Loop 8: §4.8 dispatch binding — a target mutated after the
  //  risk check must abort with browser.target_changed, never fire on
  //  semantics the classifier never saw. ─────────────────────────────
  const risk = await openWithContent("/risky");
  const desc = await risk.send({ type: "page.dom.describe", selector: "#danger" });
  assert(desc?.found === true && desc?.label === "Delete account permanently",
    `page.dom.describe resolves ground-truth label (got "${desc?.label}")`);
  const { found: _found, ...expectedFacts } = desc;
  // Page mutates the target during the (simulated) approval
  // round-trip: same node, new semantics.
  await risk.page.evaluate(() => {
    document.getElementById("danger").textContent = "Search";
  });
  const stale = await risk.send(
    perform([{ action: "click", selector: "#danger", expectedTarget: expectedFacts, reason: "e2e" }]),
  );
  const staleStep = (stale?.results ?? [])[0];
  assert(stale?.ok === false && staleStep?.code === "browser.target_changed",
    `mutated target aborts with browser.target_changed (got ${JSON.stringify(staleStep)})`);
  const outStale = await risk.send({ type: "page.extract", selector: "#out" });
  assert(!String(outStale?.text ?? "").includes("danger-fired"),
    "mutated-target click did not fire the page handler");
  // Fresh facts → matching expectedTarget → the action fires.
  const desc2 = await risk.send({ type: "page.dom.describe", selector: "#danger" });
  const { found: _found2, ...freshFacts } = desc2;
  const fresh = await risk.send(
    perform([{ action: "click", selector: "#danger", expectedTarget: freshFacts, reason: "e2e" }]),
  );
  assert(fresh?.ok === true, `unchanged target with matching facts still clicks (${fresh?.summary})`);
  const outFresh = await risk.send({ type: "page.extract", selector: "#out" });
  assert(String(outFresh?.text ?? "").includes("danger-fired"),
    "verified click reached the page handler");
  await risk.page.close();

  await mkdir(ARTIFACT_DIR, { recursive: true });
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "content-script-isolated", status: "PASS", asserts: results.length }, null, 2),
  );
  console.log(`\nCONTENT-SCRIPT ISOLATED: PASS (${results.length} asserts)`);
} catch (err) {
  await mkdir(ARTIFACT_DIR, { recursive: true }).catch(() => {});
  await writeFile(
    join(ARTIFACT_DIR, "result.json"),
    JSON.stringify({ scenario: "content-script-isolated", status: "FAIL", error: String(err?.stack ?? err), asserts: results }, null, 2),
  ).catch(() => {});
  console.log(`\nCONTENT-SCRIPT ISOLATED: FAIL — ${err?.stack ?? err?.message ?? err}`);
  process.exitCode = 1;
} finally {
  await browser.close().catch(() => {});
  await fixture.close();
}
