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
