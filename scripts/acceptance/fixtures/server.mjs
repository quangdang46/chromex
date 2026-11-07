// Self-contained fixture server for acceptance scenarios (node http, no deps).
// Listens on all interfaces (dual-stack) so auth.localhost (::1) and
// 127.0.0.1 both reach it — auth.* hostnames trip the §4.8 financial
// classifier, which is what S7 needs.
import http from "node:http";

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
<script>setTimeout(() => { document.getElementById('status').textContent = 'ready'; }, 800);</script>
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

  // mouse-drag proof: records the mouseup position — deterministic
  // observable state for coordinate and element drags.
  "/drag": `<!doctype html><html><body>
<h1>Drag Page</h1>
<div id="src" style="width:80px;height:80px;background:#cde">src</div>
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

  // keyboard + file-input proof: echoes the last key pressed, shows
  // uploaded file names — deterministic observable state for focus/press/upload.
  "/keys": `<!doctype html><html><body>
<h1>Keys Page</h1>
<input id="k" onkeydown="document.getElementById('out').textContent='key:'+event.key" />
<p id="out">none</p>
<input id="f" type="file" onchange="document.getElementById('fname').textContent=(this.files[0]&&this.files[0].name)||'none'" />
<p id="fname">none</p>
</body></html>`,
};

export async function startFixtureServer() {
  const requests = [];
  const sockets = new Set();
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
    const html = PAGES[url.pathname];
    if (html) {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(html);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
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
    close: () =>
      new Promise((r) => {
        for (const sock of sockets) sock.destroy();
        server.close(() => r());
        server.closeAllConnections?.();
      }),
  };
}
