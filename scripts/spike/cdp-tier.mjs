// Spike: chrome.debugger (CDP) tier through the REAL extension service
// worker in headless Chrome for Testing. Drives chrome.debugger.* via
// Playwright's worker.evaluate on the MV3 SW — the same API surface the
// background would use in production.
//
// Proves or honestly reports, per capability:
//   attach/detach, Page domain (dialog handling), DOM.setFileInputFiles,
//   Network.getResponseBody, Accessibility.getFullAXTree,
//   Input.dispatchMouseEvent trusted-ness (isTrusted=true proof).
import http from "node:http";
import { writeFileSync } from "node:fs";
import { launchChromiumWithExtension } from "../acceptance/lib/harness.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const evidenceUrl = async (page, tag) => {
  try {
    console.log(`[probe] ${tag}: url=${page.url()} title=${await page.title()}`);
  } catch (e) {
    console.log(`[probe] ${tag}: page gone — ${e?.message ?? e}`);
  }
};

const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const PAGES = {
  "/": `<!doctype html><html><body><h1>Spike</h1><button id="b" onclick="document.getElementById('o').textContent='dom-click'">go</button><p id="o">idle</p></body></html>`,
  "/dialog": `<!doctype html><html><body><button id="alert" onclick="alert('spike-dialog')">alert</button><button id="confirm" onclick="document.getElementById('o').textContent=confirm('ok?')?'yes':'no'">confirm</button><p id="o">idle</p></body></html>`,
  "/trust": `<!doctype html><html><body><button id="t" style="position:fixed;left:100px;top:100px;width:100px;height:50px" onclick="document.getElementById('o').textContent='isTrusted='+event.isTrusted">t</button><p id="o">idle</p></body></html>`,
  "/keys": `<!doctype html><html><body><input id="f" type="file" onchange="document.getElementById('o').textContent=(this.files[0]&&this.files[0].name)||'none'"><p id="o">none</p></body></html>`,
  "/fetch": `<!doctype html><html><body><p id="o">pending</p><script>fetch('/api/ping').then(r=>r.text()).then(t=>{document.getElementById('o').textContent='body:'+t})</script></body></html>`,
};

const server = http.createServer((req, res) => {
  const p = new URL(req.url, "http://x").pathname;
  if (p === "/api/ping") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ secret: "response-body-visible" }));
    return;
  }
  const html = PAGES[p];
  res.writeHead(html ? 200 : 404, { "content-type": html ? "text/html" : "text/plain" });
  res.end(html ?? "nf");
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = (p) => `http://127.0.0.1:${port}${p}`;

let browser = null;
try {
  browser = await launchChromiumWithExtension({ headless: true });
  // Playwright's worker.evaluate lands in a clean V8 context without
  // chrome.* — extension PAGES (sidepanel.html) have the real API
  // surface, same as the SW for chrome.debugger purposes.
  const extPage = await browser.context.newPage();
  await extPage.goto(`chrome-extension://${browser.extensionId}/sidepanel.html?mode=popup&test=1`);
  await sleep(1500);
  const apiCheck = await extPage.evaluate(() => ({
    rt: typeof chrome !== "undefined" ? chrome.runtime?.id ?? null : null,
    dbg: typeof chrome !== "undefined" ? typeof chrome.debugger?.attach : null,
    tabs: typeof chrome !== "undefined" ? typeof chrome.tabs?.query : null,
  }));
  check("extension page has chrome.debugger", apiCheck.dbg === "function" && !!apiCheck.rt, JSON.stringify(apiCheck));

  const page = await browser.context.newPage();
  await page.goto(url("/"), { waitUntil: "domcontentloaded" });
  // tabId comes from chrome.tabs.query inside the extension page
  const target = await extPage.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const t = tabs.find((x) => x.url?.includes("127.0.0.1")) ?? tabs[0];
    return { tabId: t.id, url: t.url };
  });
  check("extension sees tab", typeof target?.tabId === "number", JSON.stringify(target));

  // ---- attach ----
  const attach = await extPage.evaluate(async (tabId) => {
    try {
      await chrome.debugger.attach({ tabId }, "1.3");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }, target.tabId);
  check("debugger.attach", attach.ok === true, attach.error ?? "");

  const send = (method, params = {}) =>
    extPage.evaluate(
      async ([tabId, m, p]) => {
        try {
          const r = await chrome.debugger.sendCommand({ tabId }, m, p);
          return { ok: true, result: r };
        } catch (e) {
          return { ok: false, error: String(e?.message ?? e) };
        }
      },
      [target.tabId, method, params],
    );

  // ---- Accessibility.getFullAXTree ----
  const ax = await send("Accessibility.getFullAXTree");
  const nodeCount = ax?.result?.nodes?.length ?? 0;
  const hasButton = (ax?.result?.nodes ?? []).some((n) => n.role?.value === "button");
  check("Accessibility.getFullAXTree", ax.ok && nodeCount > 0, `nodes=${nodeCount} button=${hasButton}`);

  // ---- Network.getResponseBody ----
  await send("Network.enable");
  await page.goto(url("/fetch"), { waitUntil: "domcontentloaded" });
  evidenceUrl(page, "after /fetch");
  await page.waitForFunction(() => document.getElementById("o")?.textContent?.startsWith("body:"), null, { timeout: 5000 }).catch(() => {});
  // find the requestId for /api/ping via SW-side Network domain — need events;
  // simpler: enable Network then use performance entries is not CDP. Use
  // Network.getResponseBody requires requestId from events — collect via
  // chrome.debugger.onEvent inside the SW.
  const bodyProbe = await extPage.evaluate(async (tabId) => {
    const reqs = [];
    const listener = (src, method, params) => {
      if (method === "Network.responseReceived") reqs.push(params);
    };
    chrome.debugger.onEvent.addListener(listener);
    await chrome.debugger.sendCommand({ tabId }, "Network.enable");
    // trigger a fresh fetch in the page
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => fetch("/api/ping").then((r) => r.text()),
    });
    await new Promise((r) => setTimeout(r, 1500));
    chrome.debugger.onEvent.removeListener(listener);
    const hit = reqs.find((r) => r.response?.url?.includes("/api/ping"));
    if (!hit) return { ok: false, error: "no responseReceived for /api/ping", seen: reqs.length };
    try {
      const body = await chrome.debugger.sendCommand(
        { tabId },
        "Network.getResponseBody",
        { requestId: hit.requestId },
      );
      return { ok: true, body: body.body, seen: reqs.length };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e), seen: reqs.length };
    }
  }, target.tabId);
  check(
    "Network.getResponseBody",
    bodyProbe.ok === true && String(bodyProbe.body ?? "").includes("response-body-visible"),
    bodyProbe.ok ? `body=${String(bodyProbe.body).slice(0, 60)}` : bodyProbe.error,
  );

  // ---- DOM.setFileInputFiles ----
  writeFileSync("/tmp/chromex-spike-upload.txt", "spike-upload");
  await page.goto(url("/keys"), { waitUntil: "domcontentloaded" });
  evidenceUrl(page, "after /keys");
  const fileProbe = await extPage.evaluate(async (tabId) => {
    try {
      await chrome.debugger.sendCommand({ tabId }, "DOM.enable");
      const doc = await chrome.debugger.sendCommand({ tabId }, "DOM.getDocument", { depth: 1 });
      const q = await chrome.debugger.sendCommand(
        { tabId },
        "DOM.querySelector",
        { nodeId: doc.root.nodeId, selector: "#f" },
      );
      if (!q.nodeId) return { ok: false, error: "node not found" };
      await chrome.debugger.sendCommand(
        { tabId },
        "DOM.setFileInputFiles",
        { files: ["/tmp/chromex-spike-upload.txt"], nodeId: q.nodeId },
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }, target.tabId);
  check("DOM.setFileInputFiles", fileProbe.ok === true, fileProbe.error ?? "");
  await sleep(300);
  const fname = await page.evaluate(() => document.getElementById("o")?.textContent);
  check("file input received file", /chromex-spike-upload\.txt/.test(fname ?? ""), `dom=${fname}`);

  // ---- Page dialog handling ----
  // Playwright auto-dismisses dialogs with no listener — keep one so the
  // dialog stays open for chrome.debugger to handle.
  page.on("dialog", () => {});
  await page.goto(url("/dialog"), { waitUntil: "domcontentloaded" });
  evidenceUrl(page, "after /dialog");
  const dialogProbe = await extPage.evaluate(async (tabId) => {
    const out = { events: [], handled: null };
    // handle INSIDE the event callback — headless auto-dismisses fast,
    // any polling delay loses the dialog
    const listener = (src, method, params) => {
      if (method !== "Page.javascriptDialogOpening") return;
      out.events.push(params);
      chrome.debugger
        .sendCommand({ tabId }, "Page.handleJavaScriptDialog", { accept: true })
        .then(() => { out.handled = true; })
        .catch((e) => { out.handleError = String(e?.message ?? e); });
    };
    chrome.debugger.onEvent.addListener(listener);
    await chrome.debugger.sendCommand({ tabId }, "Page.enable");
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.getElementById("alert").click(),
    });
    const evDeadline = Date.now() + 5000;
    while (out.handled !== true && out.handleError == null && Date.now() < evDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    chrome.debugger.onEvent.removeListener(listener);
    return out;
  }, target.tabId);
  check(
    "Page.javascriptDialogOpening + handleJavaScriptDialog",
    dialogProbe.events?.length > 0 && dialogProbe.handled === true,
    JSON.stringify(dialogProbe),
  );

  // ---- Input.dispatchMouseEvent trusted-ness ----
  await page.goto(url("/trust"), { waitUntil: "domcontentloaded" });
  evidenceUrl(page, "after /trust");
  const trustProbe = await extPage.evaluate(async (tabId) => {
    await chrome.debugger.sendCommand({ tabId }, "Input.enable").catch(() => {});
    // center of #t at fixed left:100 top:100 w:100 h:50 → (150,125)
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: 150, y: 125, button: "left", clickCount: 1,
    });
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: 150, y: 125, button: "left", clickCount: 1,
    });
    return { ok: true };
  }, target.tabId);
  await sleep(400);
  const trustText = await page.evaluate(() => document.getElementById("o")?.textContent);
  check(
    "Input.dispatchMouseEvent → isTrusted=true",
    trustProbe.ok && trustText === "isTrusted=true",
    `dom=${trustText}`,
  );

  // control: content-script-style synthetic click → isTrusted=false
  await page.evaluate(() => document.getElementById("t").click());
  await sleep(200);
  const synthText = await page.evaluate(() => document.getElementById("o")?.textContent);
  check("synthetic .click() → isTrusted=false (control)", synthText === "isTrusted=false", `dom=${synthText}`);

  // ---- detach ----
  const detach = await extPage.evaluate(async (tabId) => {
    try {
      await chrome.debugger.detach({ tabId });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String(e?.message ?? e) };
    }
  }, target.tabId);
  check("debugger.detach", detach.ok === true, detach.error ?? "");
} catch (e) {
  check("spike crashed", false, String(e?.stack ?? e));
} finally {
  if (browser) await browser.cleanup().catch(() => {});
  server.close();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} spike checks passed`);
process.exit(failed.length ? 1 : 0);
