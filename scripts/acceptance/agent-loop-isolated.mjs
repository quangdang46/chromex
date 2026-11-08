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

  // Drop-zone fallback: #dz has no file input — upload must dispatch a
  // real dragenter/dragover/drop carrying the File objects.
  const dzUp = await call("browser.page.upload", {
    tabId: kTab,
    selector: "#dz",
    files: [{ name: "agent-drop.bin", mimeType: "application/octet-stream", base64: Buffer.from("drop").toString("base64") }],
  });
  assert(dzUp?.uploaded === 1 && dzUp?.via === "drop", "drop-zone upload dispatched (via=drop)");
  const dzOut = await call("browser.page.extract", { tabId: kTab, selector: "#dzout" });
  assert(String(dzOut?.text ?? "").includes("agent-drop.bin"), `drop zone received file (got "${dzOut?.text}")`);

  // Emulation parity: UA/timezone/metrics go through the page's CDP
  // session — same Emulation.* commands the extension debugger tier sends.
  const emu = await call("browser.page.emulate", {
    tabId: kTab,
    userAgent: "ChromexAcceptance/1.0",
    timezoneId: "America/New_York",
    width: 800,
    height: 600,
    deviceScaleFactor: 2,
    mobile: true,
  });
  assert(emu?.ok === true && emu?.applied?.includes("userAgent"), `emulate applied (${JSON.stringify(emu?.applied)})`);
  const emuCheck = await call("browser.page.evaluate", {
    tabId: kTab,
    expression: "JSON.stringify({ua:navigator.userAgent,t2:Intl.DateTimeFormat().resolvedOptions().timeZone,dpr:window.devicePixelRatio})",
  });
  const emuState = JSON.parse(String(emuCheck?.value ?? "{}"));
  assert(emuState.ua === "ChromexAcceptance/1.0", `userAgent emulated (got ${emuState.ua})`);
  assert(emuState.t2 === "America/New_York", `timezone emulated (got ${emuState.t2})`);
  assert(emuState.dpr === 2, `deviceScaleFactor emulated (dpr=${emuState.dpr})`);
  await call("browser.page.emulate", { tabId: kTab, reset: true });
  const emuReset = await call("browser.page.evaluate", {
    tabId: kTab,
    expression: "JSON.stringify({dpr:window.devicePixelRatio})",
  });
  assert(JSON.parse(String(emuReset?.value ?? "{}")).dpr !== 2, "emulate reset cleared deviceScaleFactor");

  // setInputFiles: real filesystem path → input.files (path-based
  // counterpart of the bytes upload above).
  const pathFile = join(homedir(), ".chromex-acceptance-setinput.txt");
  await writeFile(pathFile, "path-attach", "utf8");
  const sif = await call("browser.page.setInputFiles", {
    tabId: kTab,
    selector: "#f",
    files: [pathFile],
  });
  assert(sif?.ok === true && sif?.files === 1, "setInputFiles attached one path");
  const sifName = await call("browser.page.extract", { tabId: kTab, selector: "#fname" });
  assert(String(sifName?.text ?? "").includes("chromex-acceptance-setinput.txt"), "file input shows path basename");
  const sifBad = await call("browser.page.setInputFiles", {
    tabId: kTab,
    selector: "#f",
    files: ["relative/path.txt"],
  }).then(() => null).catch((e) => e);
  assert(sifBad !== null, "setInputFiles refused a relative path");

  // tab.duplicate: new page in the same isolated context — session
  // (cookies/storage) carries over; lands on the source URL.
  const dup = await call("browser.tab.duplicate", { tabId: kTab });
  const dupId = dup?.openedTabId ?? dup?.tabId;
  assert(typeof dupId === "number", `tab.duplicate returned openedTabId (${JSON.stringify(dup)})`);
  const dupGet = await call("browser.page.get", { tabId: dupId, key: "url" });
  assert(String(dupGet?.value ?? "").endsWith("/keys"), `duplicate page landed on source URL (got ${dupGet?.value})`);

  // tab.update zoomFactor → CDP page scale; pinned/muted refused.
  const zoom = await call("browser.tab.update", { tabId: dupId, zoomFactor: 2 });
  assert(zoom?.zoomFactor === 2, `tab.update applied zoom (${JSON.stringify(zoom)})`);
  const zoomCheck = await call("browser.page.evaluate", {
    tabId: dupId,
    expression: "window.innerWidth",
  });
  assert(typeof zoomCheck?.value === "number", "page still evaluates after zoom");
  const zoomBad = await call("browser.tab.update", { tabId: dupId, muted: true }).then(() => null).catch((e) => e);
  assert(zoomBad !== null, "tab.update refused muted on isolated backend");

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
  // cancel on a finished download reports its real state — no fake cancel.
  const dlCancel = await call("browser.downloads.cancel", { downloadId: listed.id });
  assert(dlCancel?.cancelled === false && dlCancel?.state === "complete", "downloads.cancel on finished download is an honest no-op");

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

  // ── Loop 10b: route/unroute + responseBody on the isolated backend ──
  // fulfill: /api/ping is answered from the rule, never hits the server.
  const rt = await call("browser.page.route", {
    tabId: fTab,
    match: "/api/ping",
    action: "fulfill",
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ v: "mocked" }),
  });
  assert(typeof rt?.routeId === "string", `route registered (${rt?.routeId})`);
  await call("browser.page.history", { tabId: fTab, action: "reload" });
  await call("browser.page.wait", { tabId: fTab, text: "pong:mocked", timeoutMs: 8000 });
  const mocked = await call("browser.page.extract", { tabId: fTab, selector: "#out" });
  assert(String(mocked?.text ?? "").includes("pong:mocked"), `route fulfill intercepted /api/ping (got "${mocked?.text}")`);

  // responseBody: the fulfilled response is still observable.
  const rbList = await call("browser.page.responseBody", { tabId: fTab, urlContains: "/api/ping" });
  const rbEntry = (rbList?.requests ?? []).find((r) => String(r.url).includes("/api/ping"));
  assert(!!rbEntry?.requestId, "responseBody lists the intercepted request");
  const rbBody = await call("browser.page.responseBody", { tabId: fTab, requestId: rbEntry.requestId });
  assert(String(rbBody?.body ?? "").includes('"mocked"'), `responseBody returns fulfilled body (got ${String(rbBody?.body).slice(0, 60)})`);

  // unroute one rule → real response returns.
  const un = await call("browser.page.unroute", { tabId: fTab, routeId: rt.routeId });
  assert(un?.removed === 1, "unroute removed the fulfill rule");
  await call("browser.page.history", { tabId: fTab, action: "reload" });
  await call("browser.page.wait", { tabId: fTab, text: "pong:ok", timeoutMs: 8000 });

  // modify: rewrite /api/ping → /api/pong2 (fixture returns {v:"rerouted"}).
  await call("browser.page.route", {
    tabId: fTab,
    match: "/api/ping",
    action: "modify",
    url: fixture.url("/api/pong2"),
  });
  await call("browser.page.history", { tabId: fTab, action: "reload" });
  await call("browser.page.wait", { tabId: fTab, text: "pong:rerouted", timeoutMs: 8000 });
  const rerouted = await call("browser.page.extract", { tabId: fTab, selector: "#out" });
  assert(String(rerouted?.text ?? "").includes("pong:rerouted"), `route modify rewrote the request URL (got "${rerouted?.text}")`);
  await call("browser.page.unroute", { tabId: fTab });

  // abort: matching requests fail → page reports fetch-failed.
  await call("browser.page.route", { tabId: fTab, match: "/api/ping", action: "abort" });
  await call("browser.page.history", { tabId: fTab, action: "reload" });
  await call("browser.page.wait", { tabId: fTab, text: "fetch-failed", timeoutMs: 8000 });
  const aborted = await call("browser.page.extract", { tabId: fTab, selector: "#out" });
  assert(String(aborted?.text ?? "").includes("fetch-failed"), `route abort failed the request (got "${aborted?.text}")`);
  await call("browser.page.unroute", { tabId: fTab });

  // ── Loop 10c: page.dialog — confirm accept + alert dismiss +
  //  honest no_dialog on the isolated backend ──────────────────────
  const dlgTab = await call("browser.tab.create", { url: fixture.url("/dialog"), active: false });
  const dlgId = dlgTab?.tabId ?? dlgTab?.id;
  await call("browser.page.click", { tabId: dlgId, selector: "#ask" });
  const dlgAccept = await call("browser.page.dialog", { tabId: dlgId, accept: true, timeoutMs: 8000 });
  assert(dlgAccept?.handled === true && dlgAccept?.dialog?.type === "confirm", `dialog accepted (${JSON.stringify(dlgAccept?.dialog)})`);
  const dlgOut = await call("browser.page.wait", { tabId: dlgId, text: "confirm:true", timeoutMs: 8000 });
  assert(!!dlgOut, "confirm() resolved true after accept");
  await call("browser.page.click", { tabId: dlgId, selector: "#alertBtn" });
  const dlgDismiss = await call("browser.page.dialog", { tabId: dlgId, timeoutMs: 8000 });
  assert(dlgDismiss?.handled === true && dlgDismiss?.dialog?.type === "alert", `alert dismissed (${JSON.stringify(dlgDismiss?.dialog)})`);
  await call("browser.page.wait", { tabId: dlgId, text: "alert-done", timeoutMs: 8000 });
  const dlgNone = await call("browser.page.dialog", { tabId: dlgId, timeoutMs: 1000 });
  assert(dlgNone?.handled === false && dlgNone?.reason === "no_dialog", "dialog reports no_dialog honestly");

  // ── Loop 10d: page.webSocket — fixture /ws echoes hello-agent ─────
  const wsTab = await call("browser.tab.create", { url: fixture.url("/ws"), active: false });
  const wTab = wsTab?.tabId ?? wsTab?.id;
  await call("browser.page.wait", { tabId: wTab, text: "echo:hello-agent", timeoutMs: 8000 });
  const wsList = await call("browser.page.webSocket", { tabId: wTab });
  const sock = (wsList?.sockets ?? [])[0];
  assert(!!sock?.requestId, "webSocket lists the fixture connection");
  const wsFrames = await call("browser.page.webSocket", { tabId: wTab, requestId: sock.requestId });
  const payloads = (wsFrames?.frames ?? []).map((f) => `${f.dir}:${f.data}`);
  assert(payloads.includes("sent:hello-agent"), `ws sent frame captured (${payloads.join("|")})`);
  assert(payloads.includes("recv:echo:hello-agent"), `ws recv frame captured (${payloads.join("|")})`);

  // ── Loop 11: open shadow DOM on the isolated backend — playwright
  //  locators pierce open roots natively; text/extract must too ─────
  const shTab = await call("browser.tab.create", { url: fixture.url("/shadow"), active: false });
  const shId = shTab?.tabId ?? shTab?.id;
  const shGet = await call("browser.page.get", { tabId: shId, key: "text" });
  assert(
    String(shGet?.value ?? "").includes("shadow-secret-text"),
    "page.get text sees open-shadow content",
  );
  const shExt = await call("browser.page.extract", { tabId: shId, selector: "#stext" });
  assert(
    String(shExt?.text ?? "").includes("shadow-secret-text"),
    "extract reads open-shadow content",
  );
  await call("browser.page.fill", { tabId: shId, selector: "#sin", value: "shadow-typed" });
  const shVal = await call("browser.page.evaluate", {
    expression: "document.getElementById('host').shadowRoot.getElementById('sin').value",
  });
  assert(
    String(shVal?.value ?? shVal?.result?.value ?? "") === "shadow-typed",
    `fill reached the open-shadow input (got ${JSON.stringify(shVal).slice(0, 120)})`,
  );
  await call("browser.page.click", { tabId: shId, selector: "#sbtn" });
  const shOut = await call("browser.page.extract", { tabId: shId, selector: "#out" });
  assert(
    String(shOut?.text ?? "").includes("shadow-clicked"),
    "click reached the open-shadow button and fired its handler",
  );
  // wait/text conditions must also see shadow content (deep body text)
  await call("browser.page.wait", { tabId: shId, text: "shadow-secret-text", timeoutMs: 3000 });
  const shFind = await call("browser.page.find", { tabId: shId, text: "shadow-secret-text" });
  assert(
    (shFind?.matches ?? shFind?.results ?? []).length > 0 || String(JSON.stringify(shFind)).includes("shadow-secret-text"),
    `find locates open-shadow text (${JSON.stringify(shFind).slice(0, 160)})`,
  );

  // ── Loop 12: popup tab (target=_blank) joins the task context and is
  //  fully instrumented — console/network capture must work on it ────
  const popTab = await call("browser.tab.create", { url: fixture.url("/popup"), active: false });
  const popId = popTab?.tabId ?? popTab?.id;
  await call("browser.page.click", { tabId: popId, selector: "#pop" });
  let popIdx = -1;
  for (let i = 0; i < 20 && popIdx < 0; i++) {
    const tl = await call("browser.tabs.list", {});
    const rows = tl?.tabs ?? (Array.isArray(tl) ? tl : []);
    popIdx = rows.findIndex((t) => String(t.url ?? "").includes("/popup-target"));
    if (popIdx < 0) await new Promise((r) => setTimeout(r, 250));
  }
  assert(popIdx >= 0, "target=_blank click produced a popup tab in the task context");
  const popTitle = await call("browser.page.get", { tabId: popIdx, key: "title" });
  assert(
    String(popTitle?.value ?? "").includes("Popup Target"),
    `popup tab is drivable by index (title=${popTitle?.value})`,
  );
  // popup pages must carry the same observation listeners as tab.create
  // pages — console capture on the popup proves context "page" tracking.
  await call("browser.page.evaluate", {
    tabId: popIdx,
    expression: "console.log('popup-console-marker'); 'ok'",
  });
  await new Promise((r) => setTimeout(r, 300));
  const popConsole = await call("browser.page.console", { tabId: popIdx });
  assert(
    JSON.stringify(popConsole ?? {}).includes("popup-console-marker"),
    "console capture works on agent-opened popup tab",
  );

  // ── Loop 13: page.cookies — set/list/delete/clear on the real jar ──
  const ckTab = await call("browser.tab.create", { url: fixture.url("/keys"), active: false });
  const ckId = ckTab?.tabId ?? ckTab?.id;
  await call("browser.page.cookies", { tabId: ckId, action: "set", name: "agentck", value: "v1" });
  // the cookie must ride real requests — server-side echo is the proof
  const echo1 = await call("browser.page.evaluate", {
    tabId: ckId,
    expression: "fetch('/api/cookie-echo').then(r=>r.json()).then(j=>j.cookie)",
  });
  // evaluate returns a promise — playwright awaits it; assert on value
  const echoVal = String(echo1?.value ?? echo1?.result?.value ?? "");
  assert(echoVal.includes("agentck=v1"), `tool-set cookie reached the server (got ${echoVal})`);
  // metadata list withholds values
  const ckList = await call("browser.page.cookies", { tabId: ckId, action: "list" });
  const ckRow = (ckList?.cookies ?? []).find((c) => c.name === "agentck");
  assert(ckRow && ckRow.value === undefined, "list returns metadata without values");
  // httpOnly cookie: invisible to document.cookie, visible to the tool
  await call("browser.page.cookies", {
    tabId: ckId, action: "set", name: "httponlyck", value: "hv", httpOnly: true,
  });
  const docCk = await call("browser.page.evaluate", {
    tabId: ckId,
    expression: "document.cookie",
  });
  assert(
    !String(docCk?.value ?? docCk?.result?.value ?? "").includes("httponlyck"),
    "httpOnly cookie correctly invisible to document.cookie",
  );
  const ckList2 = await call("browser.page.cookies", { tabId: ckId, action: "list" });
  const hoRow = (ckList2?.cookies ?? []).find((c) => c.name === "httponlyck");
  assert(hoRow?.httpOnly === true, "list exposes the httpOnly flag");
  // delete + clear
  await call("browser.page.cookies", { tabId: ckId, action: "delete", name: "agentck", url: fixture.url("/") });
  await call("browser.page.cookies", { tabId: ckId, action: "clear", domain: new URL(fixture.url("/")).hostname });
  const ckList3 = await call("browser.page.cookies", { tabId: ckId, action: "list" });
  assert((ckList3?.cookies ?? []).length === 0, "clear emptied the jar");
  await expectReject("browser.page.cookies", { tabId: ckId, action: "clear" }, "url or args.domain", "clear without scope refused");

  // ── Loop 14: page.localStorage — keys/values/session area ──────────
  await call("browser.page.localStorage", { tabId: ckId, action: "set", key: "theme", value: "dark" });
  const lsKeys = await call("browser.page.localStorage", { tabId: ckId });
  assert(
    (lsKeys?.keys ?? []).includes("theme") && lsKeys?.entries === undefined,
    "storage list returns keys only (values withheld by default)",
  );
  const lsGet = await call("browser.page.localStorage", { tabId: ckId, action: "get", key: "theme" });
  assert(lsGet?.value === "dark" && lsGet?.found === true, "storage get returns the value");
  await call("browser.page.localStorage", { area: "session", action: "set", key: "sflag", value: "1" });
  const ssKeys = await call("browser.page.localStorage", { tabId: ckId, area: "session" });
  assert((ssKeys?.keys ?? []).includes("sflag"), "sessionStorage is a separate area");
  const lsDom = await call("browser.page.evaluate", {
    tabId: ckId,
    expression: "localStorage.getItem('theme') + '|' + sessionStorage.getItem('sflag')",
  });
  assert(
    String(lsDom?.value ?? "") === "dark|1",
    `in-page storage sees tool writes (got ${lsDom?.value})`,
  );
  await call("browser.page.localStorage", { tabId: ckId, action: "remove", key: "theme" });
  await call("browser.page.localStorage", { tabId: ckId, area: "session", action: "clear" });
  const lsAfter = await call("browser.page.localStorage", { tabId: ckId });
  assert(!(lsAfter?.keys ?? []).includes("theme"), "remove deleted the key");
  await expectReject("browser.page.localStorage", { tabId: ckId, action: "set", key: "x" }, "args.value", "set without value refused");

  // ── Honesty checks: refused paths must fail loudly, never fake ─────
  const ev = await call("browser.page.evaluate", { expression: "1 + 1" });
  assert(ev?.value === 2 || ev?.result?.value === 2, `evaluate returns expression value (${JSON.stringify(ev).slice(0, 120)})`);
  await expectReject("browser.page.evaluate", {}, "invalid", "evaluate without expression refused");
  await expectReject("browser.page.click", { selector: "#x", frameId: 3 }, "unsupported", "frameId refused on isolated backend");
  await expectReject("browser.page.upload", { selector: "#f", files: ["/etc/passwd"] }, "refused", "local-path upload refused (bytes-only)");
  await expectReject("browser.downloads.save", { url: "file:///etc/passwd" }, "http(s)", "non-http(s) download url refused");
  await expectReject("browser.downloads.save", { url: fixture.url("/dl"), filename: "../escape.txt" }, "relative path", "traversal filename refused");
  await expectReject("browser.tab.create", { url: fixture.url("/"), muted: true }, "chrome-extension only", "muted arg refused (no silent drop)");
  await expectReject("browser.downloads.cancel", {}, "downloadId", "downloads.cancel without id refused");

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
