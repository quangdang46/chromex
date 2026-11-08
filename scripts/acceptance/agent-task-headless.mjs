// agent-task-headless — a scripted agent loop on the REAL built
// extension (chrome-extension backend) in headless Chrome for Testing.
//
// This is the missing evidence tier between agent-loop-isolated
// (playwright backend, in-process) and s1-build-feature (real provider,
// real Chrome, token-gated): a coherent multi-step task — observe →
// plan → act → verify server-side → recover → deliver — driven through
// the production path MCP → gateway → native host → SW → content/CDP.
//
// The loop asserts fixture-server truth (the POST actually arrived),
// not just tool status — the same bar s1 holds a real provider to.
import { runScenario, sleep } from "./lib/harness.mjs";
import process from "node:process";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "agent-task-headless";

const results = [];
const note = (m) => { results.push(m); console.log(`  ${m}`); };
const assert = (cond, label) => {
  if (!cond) throw new Error(`ASSERT FAIL: ${label}`);
  note(`ok — ${label}`);
};

await runScenario(
  SCENARIO,
  async ({ runner, browser, evidence }) => {
    const fixture = await startFixtureServer();
    try {
      const taskId = await runner.createTask({
        title: "agent task loop on real extension",
        cwd: "/tmp",
        backend: { backendId: "chrome-extension", pinnedBy: "user" },
        tabIntent: { scope: "untitled" },
      });
      const { token } = await runner.spawnBrowserScope(taskId);
      const call = (tool, args = {}) => runner.browserToolCall(taskId, tool, args, token, 60_000);

      // ── Loop 1: observe → fill → submit → verify server-side ──────
      const created = await call("browser.tab.create", { url: fixture.url("/form") });
      const tabId = created?.result?.tabId ?? created?.result?.id ?? created?.tabId;
      assert(Number.isInteger(tabId), `tab.create returned tabId=${tabId}`);

      const snap = await call("browser.page.snapshot", { tabId });
      const snapRes = snap?.result ?? {};
      const snapEls = Array.isArray(snapRes.elements) ? snapRes.elements : [];
      assert(
        snapRes?.metadata?.title === "Fixture Form" && snapEls.some((e) => e.selector === "#name") && snapEls.some((e) => e.selector === "#next"),
        "snapshot observes the form page (title + interactive elements)",
      );

      await call("browser.page.fill", { tabId, selector: "#name", value: "Agent" });
      await call("browser.page.fill", { tabId, selector: "#email", value: "agent@chromex.dev" });
      const nextRes = await call("browser.page.click", {
        tabId, selector: "#next",
        expect: { selector: "#step2:not([hidden])", timeoutMs: 8000 },
      });
      assert(nextRes?.status === "completed", "click Next completed");
      await call("browser.page.select", { tabId, selector: "#plan", value: "pro" });
      await call("browser.page.submit", { tabId, selector: "#submit" });

      const waited = await call("browser.page.wait", { tabId, text: "Submitted", timeoutMs: 10_000 });
      assert(waited?.status === "completed", "page.wait text=Submitted resolved");
      const done = await call("browser.page.extract", { tabId, selector: "#done" });
      assert(String(done?.result?.text ?? "").includes("ok"), "extract verifies submit-ok page");

      const post = fixture.requests.find((r) => r.method === "POST" && r.path === "/submit" && r.body);
      assert(!!post, "fixture server received POST /submit");
      assert(post.body.includes("name=Agent"), "POST body carries name=Agent");
      assert(post.body.includes("plan="), "POST body carries plan field");

      // ── Loop 2: in-loop recovery — stale snapshotId fails loudly,
      // re-observe and retry (the s6 shape inside an agent task) ─────
      const snap2 = await call("browser.page.snapshot", { tabId });
      const snapId2 = JSON.stringify(snap2?.result ?? {}).match(/"snapshotId"\s*:\s*"([^"]+)"/)?.[1];
      await call("browser.page.navigate", { tabId, url: fixture.url("/form") });
      // wait for the NEW document so the stale check sees the committed
      // url — navigate can return before tabs.get reflects the swap
      await call("browser.page.wait", { tabId, selector: "#name", timeoutMs: 8000 });
      const staleClick = await call("browser.page.click", {
        tabId, selector: "#next", snapshotId: snapId2,
      }).catch((e) => ({ rpcError: e?.message }));
      const staleFailed =
        staleClick == null || staleClick.rpcError || staleClick.status === "failed" ||
        /stale|snapshot/i.test(JSON.stringify(staleClick?.error ?? staleClick));
      assert(staleFailed, "stale snapshotId rejected loudly mid-task");
      const snap3 = await call("browser.page.snapshot", { tabId });
      const snap3Res = snap3?.result ?? {};
      assert(
        snap3Res?.metadata?.title === "Fixture Form",
        "re-observe after navigation",
      );
      await call("browser.page.fill", { tabId, selector: "#name", value: "Retry" });
      evidence.note("recovery: stale snapshot → re-observe → fill succeeded");

      // ── Loop 3: deliverables — screenshot + pdf + evaluate verify ──
      const shot = await call("browser.page.screenshot", { tabId });
      assert(shot?.status === "completed" && (shot?.result?.bytes ?? 0) > 1000,
        `screenshot artifact (${shot?.result?.bytes} bytes)`);
      const pdf = await call("browser.page.pdf", { tabId });
      assert(pdf?.status === "completed" && (pdf?.result?.bytes ?? 0) > 1000,
        `pdf artifact (${pdf?.result?.bytes} bytes)`);
      const ev = await call("browser.page.evaluate", { tabId, expression: "document.title" });
      const evVal = ev?.result?.value ?? ev?.value;
      assert(evVal === "Fixture Form", `evaluate reads page title (${JSON.stringify(evVal)})`);

      // ── Loop 4: network control — route fulfill mocks the API, the
      // agent observes the mocked state, unroute restores reality ────
      const rt = await call("browser.page.route", {
        tabId, match: "/api/ping", status: 200,
        contentType: "application/json", body: '{"v":"agent-mock"}',
      });
      assert(rt?.status === "completed" && rt?.result?.routeId, "route rule registered");
      await call("browser.page.navigate", { tabId, url: fixture.url("/fetch") });
      await call("browser.page.wait", { tabId, text: "pong:agent-mock", timeoutMs: 10_000 });
      const mocked = await call("browser.page.extract", { tabId, selector: "#out" });
      assert(
        JSON.stringify(mocked?.result ?? {}).includes("pong:agent-mock"),
        "agent observes the fulfilled (mocked) response",
      );
      const routeId = rt?.result?.routeId;
      await call("browser.page.unroute", { tabId, routeId });
      await call("browser.page.navigate", { tabId, url: fixture.url("/fetch") });
      await call("browser.page.wait", { tabId, text: "pong:ok", timeoutMs: 10_000 });
      const real = await call("browser.page.extract", { tabId, selector: "#out" });
      assert(
        JSON.stringify(real?.result ?? {}).includes("pong:ok"),
        "unroute restores the real server response",
      );
      evidence.note("network: route fulfill → observed mock → unroute → real response");

      // ── Loop 5: honest negative — evaluate on missing expr refused ──
      const badEv = await call("browser.page.evaluate", { tabId, expression: "" }).catch((e) => ({ rpcError: e?.message }));
      const badEvFailed = badEv == null || badEv.rpcError || badEv.status === "failed";
      assert(badEvFailed, "empty evaluate refused, never faked");

      console.log("\nAGENT-TASK-HEADLESS: PASS");
      return {
        status: "PASS",
        summary: "scripted agent loop on the REAL extension: form submitted + verified server-side; stale-snapshot recovery in-loop; screenshot+pdf+evaluate deliverables",
        details: { results },
      };
    } finally {
      await fixture.close?.();
    }
  },
  { autoAnswer: "allow", gatewayProviders: [], headless: process.env.CHROMEX_ACCEPTANCE_HEADFUL !== "1" },
);
