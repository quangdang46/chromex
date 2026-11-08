// Self-contained fixture server for acceptance scenarios (node http, no deps).
// Listens on all interfaces (dual-stack) so auth.localhost (::1) and
// 127.0.0.1 both reach it — auth.* hostnames trip the §4.8 financial
// classifier, which is what S7 needs.
import http from "node:http";
import crypto from "node:crypto";

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

const PAGES = {
  // S1/S3/S8: simple observable page
  "/": `<!doctype html><html><head><title>Fixture Home</title></head><body>
<h1 id="title">Fixture Home</h1>
<p id="status">ready</p>
<button id="go" onclick="document.getElementById('status').textContent='clicked'">Go</button>
<a id="form-link" href="/form">open form</a>
</body></html>`,

  // multi-step-ish form: step 1 → step 2 → submit records the POST
  "/form": `<!doctype html><html><head><title>Fixture Form</title></head><body>
<h1>Signup Form</h1>
<div id="step1">
  <label>Name <input id="name" name="name" /></label>
  <label>Email <input id="email" name="email" type="email" /></label>
  <button id="next" onclick="document.getElementById('step1').hidden=true;document.getElementById('step2').hidden=false">Next</button>
</div>
<div id="step2" hidden>
  <label>Plan <select id="plan" name="plan"><option>free</option><option>pro</option></select></label>
  <form method="post" action="/submit">
    <input type="hidden" name="name" id="h-name" />
    <input type="hidden" name="email" id="h-email" />
    <input type="hidden" name="plan" id="h-plan" />
    <button id="submit" type="submit">Submit</button>
  </form>
</div>
<script>
  document.getElementById('next').addEventListener('click', () => {
    document.getElementById('h-name').value = document.getElementById('name').value;
    document.getElementById('h-email').value = document.getElementById('email').value;
    document.getElementById('h-plan').value = document.getElementById('plan').value;
  });
</script>
</body></html>`,

  "/submit-ok": `<!doctype html><html><body><h1>Submitted</h1><p id="done">ok</p></body></html>`,

  // S13: §4.8 ground-truth preflight — a destructive-labeled button must
  // demand approval even when targeted by bare snapshot ref (args carry
  // no label), while a benign button stays approval-free.
  "/risky": `<!doctype html><html><body>
<h1>Risky Page</h1>
<button id="benign" onclick="document.getElementById('out').textContent='benign-ok'">Search</button>
<button id="danger" onclick="document.getElementById('out').textContent='danger-fired'">Delete account permanently</button>
<p id="out">idle</p>
</body></html>`,

  // occlusion gate: #covered is painted under #veil — a real pointer
  // hits the veil, synthetic dispatch must refuse honestly.
  "/occluded": `<!doctype html><html><body>
<button id="covered" style="position:absolute;left:100px;top:100px;width:140px;height:40px" onclick="document.getElementById('out').textContent='covered-clicked'">Covered</button>
<div id="veil" style="position:absolute;left:100px;top:100px;width:140px;height:40px;background:rgba(200,0,0,.4);z-index:5"></div>
<button id="free" style="position:absolute;left:100px;top:200px;width:140px;height:40px" onclick="document.getElementById('out').textContent='free-clicked'">Free</button>
<div id="out"></div>
</body></html>`,

  // framework-tracker fidelity: the select's own 'value' property is a
  // React-style tracker — assignments through it update the tracked
  // value, prototype-setter bypass leaves tracked stale. A change
  // listener reports real vs tracked so the scenario can prove the
  // action used the bypass (tracked stays old → framework sees change).
  "/tracked-select": `<!doctype html><html><body>
<select id="ts">
  <option value="a">A</option><option value="b">B</option>
</select>
<div id="tout">none</div>
<script>
(function(){
  var sel = document.getElementById('ts');
  var d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  var tracked = d.get.call(sel);
  Object.defineProperty(sel, 'value', {
    configurable: true,
    get: function(){ return tracked; },
    set: function(v){ tracked = v; d.set.call(sel, v); }
  });
  sel.addEventListener('change', function(){
    var real = d.get.call(sel);
    document.getElementById('tout').textContent =
      'real=' + real + ' tracked=' + tracked + ' mismatch=' + (real !== tracked);
  });
})();
</script>
</body></html>`,

  // submitter fidelity: two submit buttons in one form branch on
  // event.submitter — submit targeted at #save must report save,
  // targeted at #purge must report purge (not null/first button).
  "/submitter": `<!doctype html><html><body>
<form id="f" onsubmit="event.preventDefault(); document.getElementById('out').textContent='submitter:'+(event.submitter?event.submitter.id:'none')">
  <input name="q" value="x">
  <button id="save" type="submit">Save</button>
  <button id="purge" type="submit">Purge</button>
</form>
<p id="out">idle</p>
</body></html>`,

  // popup acquisition: target=_blank implies noopener in modern Chrome —
  // the opened tab has no openerTabId, so detection must be time-based.
  "/popup": `<!doctype html><html><body>
<h1>Popup Source</h1>
<a id="pop" href="/popup-target" target="_blank">open popup</a>
</body></html>`,
  "/popup-target": `<!doctype html><html><head><title>Popup Target Page</title></head><body>
<h1>Popup Target</h1>
</body></html>`,

  // open shadow DOM: an open root with a button/input/text plus a nested
  // open root, and a closed root whose control must stay unreachable —
  // honest element_not_found, never a silent light-DOM fallback.
  "/shadow": `<!doctype html><html><body>
<h1>Shadow Host Page</h1>
<div id="host"></div>
<div id="closed-host"></div>
<p id="out">idle</p>
<script>
(function(){
  var out = function(v){ document.getElementById('out').textContent = v; };
  var host = document.getElementById('host');
  var root = host.attachShadow({mode:'open'});
  root.innerHTML =
    '<button id="sbtn">Shadow Button</button>' +
    '<input id="sin" placeholder="shadow-input">' +
    '<p id="stext">shadow-secret-text</p>' +
    '<div id="inner-host"></div>';
  root.getElementById('sbtn').addEventListener('click', function(){ out('shadow-clicked'); });
  var inner = root.getElementById('inner-host');
  var innerRoot = inner.attachShadow({mode:'open'});
  innerRoot.innerHTML = '<button id="nested-btn">Nested Shadow Button</button>';
  innerRoot.getElementById('nested-btn').addEventListener('click', function(){ out('nested-clicked'); });
  var closed = document.getElementById('closed-host');
  var croot = closed.attachShadow({mode:'closed'});
  croot.innerHTML = '<button id="cbtn">Closed Shadow Button</button>';
  croot.getElementById('cbtn').addEventListener('click', function(){ out('closed-fired'); });
  // Real user events are composed — they cross the shadow boundary and
  // reach document-level delegated listeners. Synthetic events must
  // match or delegation-based apps never see agent clicks.
  window.__docClicks = 0;
  document.addEventListener('click', function(e){
    window.__docClicks += 1;
    window.__lastClickComposed = e.composed === true;
  });
})();
</script>
</body></html>`,

  // S2/S6: deliberate bug — the "Fix" button throws and never updates status;
  // a broken inline handler references a missing function.
  "/buggy": `<!doctype html><html><head><title>Buggy Page</title></head><body>
<h1>Buggy Page</h1>
<p id="status">broken</p>
<p id="expected">should say fixed</p>
<button id="fix" onclick="applyFix()">Fix</button>
<script>
  function applyFix() {
    // BUG: calls a function that does not exist → ReferenceError, status never updates
    window.nonExistentFixFunction();
    document.getElementById('status').textContent = 'fixed';
  }
</script>
</body></html>`,

  // page that sets text after a delay (for wait/observe scenarios)
  "/slow": `<!doctype html><html><body>
<h1>Slow Page</h1><p id="status">pending</p>
<script>
window.__slowReady = () => { document.getElementById('status').textContent = 'ready'; };
setTimeout(window.__slowReady, 60000);
</script>
</body></html>`,

  // fixed-position target for coordinate (x,y) click proof — non-DOM
  // surface path; center of the button is viewport (100, 70).
  "/coord": `<!doctype html><html><body>
<h1>Coord Page</h1>
<button id="pad" style="position:fixed;left:40px;top:40px;width:120px;height:60px" onclick="this.textContent='coord-hit'">pad</button>
</body></html>`,

  // tall page for scroll proof
  "/tall": `<!doctype html><html><body>
<h1>Tall Page</h1><div style="height:5000px">spacer</div><p id="bottom">bottom</p>
</body></html>`,

  // wheel probe: records trusted/untrusted wheel events — proof that
  // trusted scroll dispatches real input (synthetic scrollBy fires no
  // wheel event at all).
  "/wheel-probe": `<!doctype html><html><body>
<h1>Wheel Probe</h1><div style="height:3000px">spacer</div>
<script>
let n = 0, lastTrusted = "none", lastDelta = 0;
addEventListener("wheel", (e) => {
  n++; lastTrusted = String(e.isTrusted); lastDelta = e.deltaY;
  document.getElementById("r").textContent = "count:" + n + " trusted:" + lastTrusted + " delta:" + lastDelta;
}, { passive: true });
</script>
<p id="r">count:0 trusted:none delta:0</p>
</body></html>`,

  // console probe: buttons emit marker console messages at distinct
  // levels — proof for page.wait consoleText/consoleLevel.
  "/console-probe": `<!doctype html><html><body>
<h1>Console Probe</h1>
<button id="err" onclick="console.error('probe-error-marker')">err</button>
<button id="warn" onclick="console.warn('probe-warn-marker')">warn</button>
<button id="ok" onclick="console.log('probe-log-marker')">log</button>
</body></html>`,

  // popup launcher: target=_blank link — a trusted click opens a real
  // new tab asynchronously, the scenario for browser.tabs.wait.
  "/popup-link": `<!doctype html><html><body>
<h1>Popup Launcher</h1>
<a id="go" href="/popup-done" target="_blank">open popup</a>
</body></html>`,
  "/popup-done": `<!doctype html><html><body><h1>Popup Done</h1><p>popup landed</p></body></html>`,
  // Same popup flow but the document arrives ~1.2s late — keeps the
  // new tab in status "loading" long enough for waitForLoad proof.
  "/popup-link-slow": `<!doctype html><html><body>
<h1>Popup Launcher Slow</h1>
<a id="go" href="/popup-slow" target="_blank">open slow popup</a>
</body></html>`,
  // Self-closing popup: window.open (script-opened → window.close is
  // permitted) then the popup closes itself ~600ms later — the OAuth
  // popup pattern browser.tabs.wait disappear:true observes.
  "/popup-link-close": `<!doctype html><html><body>
<h1>Popup Launcher Close</h1>
<button id="go" onclick="window.open('/popup-closing','_blank')">open self-closing popup</button>
</body></html>`,
  "/popup-closing": `<!doctype html><html><body><h1>Popup Closing</h1><p>will self-close</p>
<script>setTimeout(() => window.close(), 600);</script>
</body></html>`,

  // closed shadow root: content scripts cannot see inside (shadowRoot
  // is null); only the CDP pierce path (browser.page.pierce) reaches it.
  // Click proof writes to window.__pierceClicks — readable via
  // page.evaluate in the MAIN world.
  "/closed-shadow": `<!doctype html><html><body>
<h1>Closed Shadow Page</h1>
<div id="host"></div>
<script>
const h = document.getElementById('host');
const sr = h.attachShadow({ mode: 'closed' });
sr.innerHTML = \`
  <button id="inner" style="width:140px;height:44px">closed action</button>
  <input id="field" placeholder="closed-input" style="width:200px;height:30px">
\`;
sr.getElementById('inner').addEventListener('click', () => {
  window.__pierceClicks = (window.__pierceClicks || 0) + 1;
});
</script>
</body></html>`,

  // mouse-drag proof: records the mouseup position — deterministic
  // observable state for coordinate and element drags.
  "/drag": `<!doctype html><html><body>
<h1>Drag Page</h1>
<div id="src" style="width:80px;height:80px;background:#cde" onmousedown="document.getElementById('r-down').textContent='isTrusted:'+event.isTrusted">src</div>
<p id="r-down">none</p>
<div id="dst" style="position:fixed;left:300px;top:40px;width:120px;height:80px;background:#ecd">dst</div>
<pre id="out">idle</pre>
<script>
window.addEventListener('mouseup', (e) => {
  document.getElementById('out').textContent = 'up@' + Math.round(e.clientX) + ',' + Math.round(e.clientY);
});
</script>
</body></html>`,

  // element removed from DOM after a delay — selectorGone wait proof
  "/vanish": `<!doctype html><html><body>
<h1>Vanish Page</h1><div id="x">temporary</div><p id="after">stays</p>
<script>setTimeout(() => document.getElementById('x').remove(), 500);</script>
</body></html>`,

  // fetch proof: fires an XHR on load, writes the response into the DOM
  // — deterministic observable state for page.network inspection.
  "/fetch": `<!doctype html><html><body>
<h1>Fetch Page</h1><p id="out">pending</p>
<script>
fetch('/api/ping').then((r) => r.json()).then((j) => {
  document.getElementById('out').textContent = 'pong:' + j.v;
}).catch(() => { document.getElementById('out').textContent = 'fetch-failed'; });
</script>
</body></html>`,

  // click counter — exact-count proof that an action is delivered once
  // (duplicate content-script listeners would double-increment)
  "/counter": `<!doctype html><html><body>
<h1>Counter Page</h1>
<button id="inc" onclick="document.getElementById('count').textContent=String((parseInt(document.getElementById('count').textContent,10)||0)+1)">inc</button>
<p id="count">0</p>
</body></html>`,

  // iframe proof: child frame with an observable button + text field.
  // ?mark=<src> is echoed into the fetch so same- and cross-origin hits
  // are distinguishable in the requests log.
  "/iframe-child": `<!doctype html><html><head><title>Frame Child</title></head><body>
<h1>Frame Child</h1>
<button id="fb" onclick="fetch('/api/frame-hit?src='+encodeURIComponent(location.origin)).then(()=>{document.getElementById('fout').textContent='frame-hit'})">frame-btn</button>
<p id="fout">idle</p>
<input id="fin" onkeydown="document.getElementById('kout').textContent='key:'+event.key+',trusted:'+event.isTrusted" />
<p id="kout">none</p>
<button id="pb" style="position:absolute;left:20px;top:120px;width:80px;height:30px" onmousedown="document.getElementById('pout').textContent='down:'+event.isTrusted" onmouseup="document.getElementById('pout').textContent+=' up:'+event.isTrusted">ptr-btn</button>
<p id="pout">none</p>
<input id="ffile" type="file" onchange="document.getElementById('fout2').textContent='files:'+Array.from(event.target.files).map(f=>f.name).join(',')" />
<p id="fout2">none</p>
<div id="sh-host" style="position:absolute;top:8px;right:8px"></div>
<script>
(function(){
  var r = document.getElementById('sh-host').attachShadow({mode:'open'});
  r.innerHTML = '<button id="sfb">shadow-child-btn</button><input id="sfin">';
  r.getElementById('sfb').addEventListener('click', function(){
    document.getElementById('fout').textContent = 'shadow-child-hit';
  });
})();
</script>
</body></html>`,

  // keyboard + file-input proof: echoes the last key pressed, shows
  // uploaded file names — deterministic observable state for focus/press/upload.
  "/keys": `<!doctype html><html><body>
<h1>Keys Page</h1>
<input id="k" onkeydown="document.getElementById('out').textContent='key:'+event.key+',trusted:'+event.isTrusted" />
<p id="out">none</p>
<input id="f" type="file" onchange="document.getElementById('fname').textContent=(this.files[0]&&this.files[0].name)||'none'" />
<p id="fname">none</p>
<div id="dz" style="width:200px;height:60px;border:2px dashed #888">drop here</div>
<p id="dzout">none</p>
<script>
document.getElementById('dz').addEventListener('drop', function(e){
  e.preventDefault();
  var names = Array.from(e.dataTransfer.files).map(function(f){return f.name;}).join(',');
  document.getElementById('dzout').textContent = 'dropped:' + names;
});
document.getElementById('dz').addEventListener('dragover', function(e){ e.preventDefault(); });
</script>
</body></html>`,

  // trusted-input proof (CDP tier): two buttons record event.isTrusted —
  // a synthetic DOM .click() must report false, CDP Input must report true.
  "/trusted": `<!doctype html><html><body>
<h1>Trusted Page</h1>
<button id="t-untrusted" onclick="document.getElementById('r-untrusted').textContent='isTrusted:'+event.isTrusted">untrusted</button>
<p id="r-untrusted">none</p>
<button id="t-trusted" onclick="document.getElementById('r-trusted').textContent='isTrusted:'+event.isTrusted">trusted</button>
<p id="r-trusted">none</p>
<div id="hov" style="width:60px;height:60px;background:#eee" onmouseover="document.getElementById('r-hover').textContent='isTrusted:'+event.isTrusted">hover</div>
<p id="r-hover">none</p>
<style>#hov-css:hover{outline:3px solid rgb(255,0,0)}</style>
<div id="hov-css" style="width:60px;height:60px;background:#def">css-hover</div>
</body></html>`,

  // approve-then-mutate TOCTOU: the destructive label is what the risk
  // classifier approves; __mutate swaps it before dispatch so the
  // expectedTarget re-check must refuse the trusted click.
  "/toctou": `<!doctype html><html><body>
<h1>TOCTOU Page</h1>
<button id="btn" onclick="document.getElementById('out').textContent='clicked:'+this.textContent">Delete account permanently</button>
<p id="out">idle</p>
<script>
window.__mutate = function(){ document.getElementById('btn').textContent = 'Search'; };
window.__restore = function(){ document.getElementById('btn').textContent = 'Delete account permanently'; };
</script>
</body></html>`,

  // dialog proof (CDP tier): the confirm opens on a macrotask so the
  // triggering click returns before the dialog blocks the page thread.
  "/dialog": `<!doctype html><html><body>
<h1>Dialog Page</h1>
<button id="ask" onclick="setTimeout(()=>{document.getElementById('r').textContent='confirm:'+confirm('proceed?')},50)">ask</button>
<button id="alertBtn" onclick="setTimeout(()=>{alert('heads-up');document.getElementById('a').textContent='alert-done'},50)">alert</button>
<p id="r">none</p>
<p id="a">none</p>
</body></html>`,

  // service worker proof: registers /sw.js on load, reports state into
  // the DOM — the browser.page.serviceWorker acceptance leg observes
  // registration via the tool and control via this page.
  "/sw": `<!doctype html><html><body>
<h1>SW Page</h1><p id="swstate">pending</p>
<script>
navigator.serviceWorker.register('/sw.js', { scope: '/' }).then((r) => {
  document.getElementById('swstate').textContent = 'registered:' + r.scope;
}).catch((e) => {
  document.getElementById('swstate').textContent = 'failed:' + e.message;
});
</script>
</body></html>`,
};

export async function startFixtureServer() {
  const requests = [];
  const sockets = new Set();
  const wsMessages = [];
  // /cache-probe hit counter — body carries the hit number
  let cacheProbeHits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    requests.push({ method: req.method, path: url.pathname, at: Date.now() });
    if (req.method === "POST" && url.pathname === "/submit") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        requests.push({ method: "POST", path: "/submit", body, at: Date.now() });
        res.writeHead(200, { "content-type": "text/html" });
        res.end(PAGES["/submit-ok"]);
      });
      return;
    }
    // cache-bypass probe: CONSTANT ETag + hit-counter body + long
    // max-age. A conditional reload gets 304 → browser keeps the OLD
    // body; bypassCache gets a fresh 200 → new counter. Deterministic
    // proof that the cache was actually bypassed.
    if (url.pathname === "/cache-probe") {
      cacheProbeHits += 1;
      const etag = '"cache-probe"';
      if (req.headers["if-none-match"] === etag) {
        res.writeHead(304, { etag, "cache-control": "public, max-age=3600" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "text/html",
        etag,
        "cache-control": "public, max-age=3600",
      });
      res.end(`<!doctype html><html><body><p id="cv">cache-v${cacheProbeHits}</p></body></html>`);
      return;
    }
    // JSON API hit by the /fetch page — page.network proof
    if (url.pathname === "/api/ping") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ v: "ok" }));
      return;
    }
    // cookie echo — proves tool-set cookies actually ride requests
    if (url.pathname === "/api/cookie-echo") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ cookie: req.headers.cookie ?? "" }));
      return;
    }
    // route-modify target — a rewrite of /api/ping lands here
    if (url.pathname === "/api/pong2") {
      requests.push({ method: "GET", path: "/api/pong2", at: Date.now() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ v: "rerouted" }));
      return;
    }
    // iframe parent: one same-origin child (127.0.0.1) and one
    // cross-origin child (localhost — different origin, same server).
    if (url.pathname === "/iframe-parent") {
      const same = `http://127.0.0.1:${port}/iframe-child`;
      const cross = `http://localhost:${port}/iframe-child`;
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><head><title>Iframe Parent</title></head><body>
<h1>Iframe Parent</h1><p id="pout">parent-idle</p>
<iframe id="f-same" src="${same}"></iframe>
<iframe id="f-cross" src="${cross}"></iframe>
</body></html>`);
      return;
    }
    // child-frame click beacon — records which origin fired it
    if (url.pathname === "/api/frame-hit") {
      requests.push({ method: "GET", path: "/api/frame-hit", src: url.searchParams.get("src"), at: Date.now() });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    // attachment download — Content-Disposition triggers a real
    // browser download event (downloads.save proof)
    if (url.pathname === "/dl") {
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="agent-file.txt"',
      });
      res.end("download-bytes-from-fixture");
      return;
    }
    // WebSocket fixture page — connects to /ws, sends a hello, shows the echo
    if (url.pathname === "/ws") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<!doctype html><html><head><title>WS Fixture</title></head><body>
<h1>WS Fixture</h1><p id="wstate">connecting</p><p id="wout">none</p>
<script>
  const ws = new WebSocket("ws://127.0.0.1:${port}/ws");
  ws.onopen = () => { document.getElementById("wstate").textContent = "open"; ws.send("hello-agent"); };
  ws.onmessage = (e) => { document.getElementById("wout").textContent = e.data; };
  ws.onclose = () => { document.getElementById("wstate").textContent = "closed"; };
  ws.onerror = () => { document.getElementById("wstate").textContent = "error"; };
</script>
</body></html>`);
      return;
    }
    if (url.pathname === "/popup-slow") {
      setTimeout(() => {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html><body><h1>Popup Slow</h1><p>slow landed</p></body></html>`);
      }, 1200);
      return;
    }
    if (url.pathname === "/sw.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(`self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});`);
      return;
    }
    const html = PAGES[url.pathname];
    if (html) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  });
  // Minimal RFC6455 endpoint at /ws: handshake + masked-frame parse +
  // text echo. Just enough for the browser.page.webSocket acceptance leg.
  const wsSend = (sock, opcode, payload) => {
    const len = payload.length;
    let header;
    if (len < 126) header = Buffer.from([0x80 | opcode, len]);
    else if (len < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode; header[1] = 126; header.writeUInt16BE(len, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
    }
    sock.write(Buffer.concat([header, payload]));
  };
  server.on("upgrade", (req, sock) => {
    if (req.url !== "/ws") { sock.destroy(); return; }
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string") { sock.destroy(); return; }
    const accept = crypto
      .createHash("sha1")
      .update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
      .digest("base64");
    sock.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let buf = Buffer.alloc(0);
    sock.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const fin = (buf[0] & 0x80) !== 0;
        const opcode = buf[0] & 0x0f;
        const masked = (buf[1] & 0x80) !== 0;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        const maskOff = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        let payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) {
          const mask = buf.subarray(maskOff, maskOff + 4);
          for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
        }
        buf = buf.subarray(off + len);
        if (!fin) continue; // fixture only handles unfragmented frames
        if (opcode === 8) { sock.end(); return; }
        if (opcode === 9) { wsSend(sock, 0xA, payload); continue; }
        if (opcode === 1 || opcode === 2) {
          wsMessages.push(payload.toString("utf8"));
          if (opcode === 1) wsSend(sock, 1, Buffer.from(`echo:${payload.toString("utf8")}`));
        }
      }
    });
    sock.on("error", () => {});
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });
  server.on("connection", (sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
  });
  // no host → binds :: (dual-stack) so both 127.0.0.1 and *.localhost work
  await new Promise((r, j) => {
    server.once("error", j);
    server.listen(0, r);
  });
  const port = server.address().port;
  return {
    port,
    url: (p = "/") => `http://127.0.0.1:${port}${p}`,
    // hostname that trips the financial classifier (auth.* → approval)
    gatedUrl: (p = "/") => `http://auth.localhost:${port}${p}`,
    requests,
    wsMessages,
    close: () =>
      new Promise((r) => {
        for (const sock of sockets) sock.destroy();
        server.close(() => r());
        server.closeAllConnections?.();
      }),
  };
}
