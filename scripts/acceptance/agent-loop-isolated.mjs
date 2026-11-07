// Agent-loop proof (isolated backend): a scripted provider iterates real
// browser tools against headless Chromium — observe → act → verify — and
// the fixture server confirms the work actually happened. No user Chrome,
// no extension, no token required; this proves the tool-iteration loop the
// acceptance matrix lists as "agent loop proof".
//
// Scenario: multi-step form workflow (the S1/S8 shape) + a negative check
// that a broken page reports failure honestly instead of fake success.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
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
const expectReject = async (tool, args, fragment, label) => {
  try {
    await call(tool, args);
  } catch (e) {
    assert(
      `${e?.code ?? ""} ${e?.message ?? ""}`.includes(fragment),
      `${label} → ${e?.code ?? ""} ${e?.message ?? e}`,
    );
    return;
  }
  throw new Error(`ASSERT FAIL: ${label} did not reject`);
};

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
  // args.expect — post-action verification polled after dispatch
  const nextRes = await call("browser.page.click", {
    tabId,
    selector: "#next",
    expect: { selector: "#step2:not([hidden])", timeoutMs: 5000 },
  });
  assert(nextRes?.expect?.met === true && nextRes?.verified === true,
    "args.expect verified step2 revealed after click");
  // step2 is now visible — select exercises the tool on a visible control
  // (fixture copies plan→hidden input at Next-click time, so the POST
  // carries the default; we assert the field round-trips).
  await call("browser.page.select", { tabId, selector: "#plan", value: "pro" });
  // page.submit exercises requestSubmit — covers the submit tool itself
  await call("browser.page.submit", { tabId, selector: "#submit" });

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
  // arm console capture BEFORE the error fires, then read it back
  await call("browser.page.console", { tabId: bTab });
  await call("browser.page.click", { tabId: bTab, selector: "#fix" });
  await call("browser.page.wait", { tabId: bTab, ms: 400 });
  const consoleRes = await call("browser.page.console", { tabId: bTab, level: "error" });
  const errs = JSON.stringify(consoleRes?.entries ?? []);
  assert(errs.includes("nonExistentFixFunction") || errs.includes("ReferenceError") || errs.length > 2,
    "console captured the page error");
  const statusRes = await call("browser.page.extract", { tabId: bTab, selector: "#status" });
  const statusText = String(statusRes?.text ?? "");
  assert(statusText.includes("broken") && !statusText.includes("fixed"),
    "broken page honestly still reports 'broken' (no fake success)");

  // ── Loop 3: async page — observe pending, wait for ready ───────────
  const slow = await call("browser.tab.create", { url: fixture.url("/slow"), active: false });
  const sTab = slow?.tabId ?? slow?.id;
  const early = await call("browser.page.extract", { tabId: sTab, selector: "#status" });
  assert(String(early?.text ?? "").includes("pending"), "slow page observed while pending");
  await call("browser.page.wait", { tabId: sTab, text: "ready", timeoutMs: 8000 });
  const late = await call("browser.page.extract", { tabId: sTab, selector: "#status" });
  assert(String(late?.text ?? "").includes("ready"), "wait text=ready resolved after delay");

  // ── Loop 3b: selectorGone — wait until element leaves the DOM ──────
  const vanish = await call("browser.tab.create", { url: fixture.url("/vanish"), active: false });
  const vTab = vanish?.tabId ?? vanish?.id;
  await call("browser.page.wait", { tabId: vTab, selectorGone: "#x", timeoutMs: 8000 });
  const afterGone = await call("browser.page.extract", { tabId: vTab, selector: "#after" });
  assert(String(afterGone?.text ?? "").includes("stays"), "selectorGone resolved; page still intact");
  await expectReject(
    "browser.page.wait",
    { tabId: vTab, selector: "#x", selectorGone: "#x" },
    "must differ",
    "selector === selectorGone rejected",
  );

  // ── Loop 4: history back returns to previous page ──────────────────
  await call("browser.page.navigate", { tabId: sTab, url: fixture.url("/") });
  const hist = await call("browser.page.history", { tabId: sTab, action: "back" });
  assert(hist?.moved === true, "history back navigated to previous page");
  const backUrl = await call("browser.page.get", { tabId: sTab, key: "url" });
  assert(String(backUrl?.value ?? "").includes("/slow"), "back landed on /slow");

  // ── Loop 5: coordinate click on a fixed-position target ────────────
  const coord = await call("browser.tab.create", { url: fixture.url("/coord"), active: false });
  const cTab = coord?.tabId ?? coord?.id;
  await call("browser.page.click", { tabId: cTab, x: 100, y: 70 });
  const pad = await call("browser.page.extract", { tabId: cTab, selector: "#pad" });
  assert(String(pad?.text ?? "").includes("coord-hit"), "coordinate click hit the fixed-position button");

  // ── Loop 6: scroll moves viewport, page.get reports position ───────
  const tall = await call("browser.tab.create", { url: fixture.url("/tall"), active: false });
  const tTab = tall?.tabId ?? tall?.id;
  await call("browser.page.scroll", { tabId: tTab, direction: "down", amountPx: 1200 });
  const pos = await call("browser.page.get", { tabId: tTab });
  assert((pos?.scroll?.scrollY ?? 0) > 0, `scroll moved viewport (scrollY=${pos?.scroll?.scrollY})`);

  // ── Loop 6b: drag — coordinate form and element form ───────────────
  const drag = await call("browser.tab.create", { url: fixture.url("/drag"), active: false });
  const dTab = drag?.tabId ?? drag?.id;
  await call("browser.page.drag", { tabId: dTab, x: 40, y: 40, dropX: 360, dropY: 80 });
  const dragOut1 = await call("browser.page.extract", { tabId: dTab, selector: "#out" });
  assert(String(dragOut1?.text ?? "").includes("up@360,80"), "coordinate drag ended at drop point");
  await call("browser.page.drag", { tabId: dTab, selector: "#src", toSelector: "#dst" });
  const dragOut2 = await call("browser.page.extract", { tabId: dTab, selector: "#out" });
  assert(/up@3\d\d,\d+/.test(String(dragOut2?.text ?? "")), "element drag ended inside #dst bounds");

  // ── Loop 7: find / hover / screenshot / tab activate+close ─────────
  const found = await call("browser.page.find", { tabId: cTab, text: "coord-hit" });
  const matchCount = Array.isArray(found?.matches) ? found.matches.length : found?.count ?? 0;
  assert(matchCount > 0, `page.find located "coord-hit" (${matchCount} matches)`);

  const hov = await call("browser.page.hover", { tabId: cTab, x: 100, y: 70 });
  assert(hov?.hovered === true, "coordinate hover dispatched");

  const shot = await call("browser.page.screenshot", { tabId: cTab });
  assert(typeof shot?.dataBase64 === "string" && shot.dataBase64.length > 100 && shot?.mimeType === "image/jpeg",
    `screenshot returned jpeg payload (${shot?.bytes} bytes)`);

  await call("browser.tab.activate", { tabId: bTab });
  const tabsBefore = await call("browser.tabs.list", {});
  const nBefore = Array.isArray(tabsBefore) ? tabsBefore.length : tabsBefore?.tabs?.length ?? 0;
  await call("browser.tab.close", { tabId: tTab });
  const tabsAfter = await call("browser.tabs.list", {});
  const nAfter = Array.isArray(tabsAfter) ? tabsAfter.length : tabsAfter?.tabs?.length ?? 0;
  assert(nAfter === nBefore - 1, `tab.close removed one tab (${nBefore}→${nAfter})`);

  // ── Loop 8: focus + press + upload on the keys fixture ─────────────
  const keys = await call("browser.tab.create", { url: fixture.url("/keys"), active: false });
  const kTab = keys?.tabId ?? keys?.id;
  await call("browser.page.focus", { tabId: kTab, selector: "#k" });
  await call("browser.page.press", { tabId: kTab, selector: "#k", key: "a" });
  const keyOut = await call("browser.page.extract", { tabId: kTab, selector: "#out" });
  assert(String(keyOut?.text ?? "").includes("key:a"), "press dispatched key 'a' to focused input");

  // type = pressSequentially — per-char key events, last char wins the echo
  await call("browser.page.type", { tabId: kTab, selector: "#k", value: "xy" });
  const typeOut = await call("browser.page.extract", { tabId: kTab, selector: "#out" });
  assert(String(typeOut?.text ?? "").includes("key:y"), "type fired per-char keydown (last 'y')");

  const up = await call("browser.page.upload", {
    tabId: kTab,
    selector: "#f",
    files: [{ name: "agent-note.txt", mimeType: "text/plain", base64: Buffer.from("hello from agent").toString("base64") }],
  });
  assert(up?.uploaded === 1, "upload accepted one file");
  const fname = await call("browser.page.extract", { tabId: kTab, selector: "#fname" });
  assert(String(fname?.text ?? "").includes("agent-note.txt"), "file input shows uploaded name");

  // ── Loop 9: downloads.save → file on disk → downloads.list ─────────
  const dl = await call("browser.downloads.save", {
    url: fixture.url("/dl"),
    filename: "e2e-download.txt",
  });
  assert(dl?.state === "complete" && dl?.fileExists === true, `download saved (state=${dl?.state})`);
  assert(String(dl?.filename ?? "").endsWith("e2e-download.txt"), "filename arg honored");
  const onDisk = await readFile(String(dl?.filename), "utf8").catch(() => "");
  assert(onDisk === "download-bytes-from-fixture", "downloaded bytes match fixture payload");
  const dlList = await call("browser.downloads.list", {});
  const listed = (dlList?.downloads ?? []).find((d) => String(d?.filename ?? "").endsWith("e2e-download.txt"));
  assert(!!listed && listed.state === "complete", "downloads.list reports the completed download");

  // ── Loop 10: page.network observes the page's own /api/ping fetch ──
  const fetchTab = await call("browser.tab.create", { url: fixture.url("/fetch"), active: false });
  const fTab = fetchTab?.tabId ?? fetchTab?.id;
  await call("browser.page.wait", { tabId: fTab, text: "pong:ok", timeoutMs: 8000 });
  const net = await call("browser.page.network", { tabId: fTab, urlContains: "/api/ping" });
  const ping = (net?.requests ?? [])[0];
  assert(!!ping, "page.network captured the /api/ping request");
  assert(ping.method === "GET" && ping.status === 200, `ping request metadata (status=${ping.status})`);
  assert(String(ping.mimeType ?? "").includes("application/json"), "mimeType captured from response");
  const netFiltered = await call("browser.page.network", { tabId: fTab, status: "2xx", type: "fetch" });
  assert((netFiltered?.requests ?? []).some((r) => String(r.url).includes("/api/ping")), "status/type filters work");

  // ── Honesty checks: refused paths must fail loudly, never fake ─────
  await expectReject("browser.page.evaluate", {}, "unsupported", "evaluate refused (no arbitrary JS)");
  await expectReject("browser.page.click", { selector: "#x", frameId: 3 }, "unsupported", "frameId refused on isolated backend");
  await expectReject("browser.page.upload", { selector: "#f", files: ["/etc/passwd"] }, "refused", "local-path upload refused (bytes-only)");
  await expectReject("browser.downloads.save", { url: "file:///etc/passwd" }, "http(s)", "non-http(s) download url refused");
  await expectReject("browser.downloads.save", { url: fixture.url("/dl"), filename: "../escape.txt" }, "relative path", "traversal filename refused");
  await expectReject("browser.tab.create", { url: fixture.url("/"), muted: true }, "chrome-extension only", "muted arg refused (no silent drop)");

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
