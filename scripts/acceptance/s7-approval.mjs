// S7 — Protection: sensitive action (financial-origin navigate) → contextual
// approval; denial honored, approval proceeds. Real extension backend via
// browser.tool.call (deterministic, no provider needed).
//
// auth.localhost trips the §4.8 financial classifier (hostname `auth.*`).
// Part 1: deny → expect tool outcome failed/browser.approval_denied.
// Part 2: approve (allow_once) → expect success + tab actually navigated.
import { runScenario, sleep } from "./lib/harness.mjs";
import process from "node:process";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "s7-approval";

await runScenario(
  SCENARIO,
  async ({ runner, browser, evidence }) => {
    const fixture = await startFixtureServer();
    try {
      // task pinned to the real extension backend
      const taskId = await runner.createTask({
        title: "s7 approval e2e",
        cwd: "/tmp",
        backend: { backendId: "chrome-extension", pinnedBy: "user" },
        tabIntent: { scope: "untitled" },
      });
      evidence.note(`task ${taskId}`);
      const { token } = await runner.spawnBrowserScope(taskId);
      evidence.note("browser.mcp scope acquired");

      // pre-open + activate a fixture tab so untitled scope binds it
      const page = await browser.context.newPage();
      await page.goto(fixture.url("/"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      await evidence.screenshot(page, "s7-bound-tab");

      const gated = fixture.gatedUrl("/");
      evidence.note(`gated target: ${gated}`);

      // ---------- Part 1: DENY ----------
      let denyOutcome = null;
      let denyError = null;
      const denyCall = runner
        .browserToolCall(taskId, "browser.page.navigate", { url: gated }, token, 90_000)
        .then((o) => (denyOutcome = o))
        .catch((e) => (denyError = e));

      const denyReq = await runner.findPermissionRequest(taskId, 30_000, { respond: false });
      if (!denyReq) {
        await Promise.race([denyCall, sleep(3_000)]);
        return {
          status: "FAIL",
          summary: "no permission.requested for financial navigate (deny path)",
          details: { denyError: denyError?.message, denyOutcome },
        };
      }
      evidence.note(`permission.requested id=${denyReq.requestId} kind=${denyReq.kind} tool=${denyReq.details?.tool} options=${JSON.stringify((denyReq.options ?? []).map((o) => o.id))}`);
      // deny explicitly — runner autoAnswer is "none", so respond by hand
      const denyOpts = denyReq.options ?? [];
      const denyOpt =
        denyOpts.find((o) => o.kind === "deny" || /deny|dismiss|reject|cancel/i.test(String(o.id))) ??
        denyOpts[denyOpts.length - 1];
      await runner.conn.request("permission.respond", { requestId: denyReq.requestId, optionId: denyOpt?.id });
      evidence.note(`answered deny with optionId=${denyOpt?.id}`);
      await Promise.race([denyCall, sleep(30_000)]);
      const denied =
        denyOutcome?.status === "failed" &&
        (denyOutcome?.error?.code === "browser.approval_denied" || denyOutcome?.error?.code === "browser.denied");
      evidence.note(`deny outcome=${JSON.stringify(denyOutcome ?? denyError?.message)?.slice(0, 300)}`);

      // ---------- Part 2: ALLOW ----------
      // The runner's auto-answer is disabled; respond manually with allow.
      // Re-fire the same navigate; a fresh permission.requested must appear.
      const allowReqP = (async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const reqs = runner
            .eventsFor(taskId, "permission.requested")
            .map((e) => e.payload?.request)
            .filter(Boolean);
          const fresh = reqs.find((r) => r.requestId !== denyReq.requestId);
          if (fresh) return fresh;
          try {
            const sync = await runner.taskSync(taskId);
            for (const e of sync.events ?? []) {
              const t = e.type ?? e.payload?.type;
              const pay = e.payload ?? e;
              if (t === "permission.requested" && pay.request?.requestId && pay.request.requestId !== denyReq.requestId) {
                return pay.request;
              }
            }
          } catch {}
          await sleep(400);
        }
        return null;
      })();

      let allowOutcome = null;
      let allowError = null;
      const allowCall = runner
        .browserToolCall(taskId, "browser.page.navigate", { url: gated }, token, 90_000)
        .then((o) => (allowOutcome = o))
        .catch((e) => (allowError = e));

      const allowReq = await allowReqP;
      if (!allowReq) {
        await Promise.race([allowCall, sleep(3_000)]);
        return {
          status: "FAIL",
          summary: "no second permission.requested for approve path",
          details: { denied, allowError: allowError?.message },
        };
      }
      evidence.note(`second permission.requested id=${allowReq.requestId} options=${JSON.stringify((allowReq.options ?? []).map((o) => ({ id: o.id, kind: o.kind })))}`);
      // approve: pick allow_once-ish option
      const options = allowReq.options ?? [];
      const allowOpt =
        options.find((o) => /allow_once|approve|yes|accept/i.test(String(o.id))) ??
        options.find((o) => o.kind !== "deny" && !/deny|reject|dismiss|cancel/i.test(String(o.id))) ??
        options[0];
      await runner.conn.request("permission.respond", { requestId: allowReq.requestId, optionId: allowOpt?.id });
      evidence.note(`answered allow with optionId=${allowOpt?.id}`);
      await Promise.race([allowCall, sleep(30_000)]);
      const allowed = allowOutcome && allowOutcome.status !== "failed";
      evidence.note(`allow outcome=${JSON.stringify(allowOutcome ?? allowError?.message)?.slice(0, 300)}`);

      // verify the tab actually navigated to the gated origin — ask the
      // tool surface (tabs.list) rather than trusting the Playwright page
      // handle, which may not be the bound tab.
      await sleep(500);
      let finalUrl = "";
      try {
        finalUrl = page.url();
      } catch {}
      let tabsOutcome = null;
      try {
        tabsOutcome = await runner.browserToolCall(taskId, "browser.tabs.list", {}, token, 30_000);
      } catch (e) {
        tabsOutcome = { rpcError: e?.message };
      }
      const tabsText = JSON.stringify(tabsOutcome?.result ?? tabsOutcome ?? {});
      evidence.note(`tabs.list → ${tabsText.slice(0, 500)}`);
      const navigated = finalUrl.includes("auth.localhost") || tabsText.includes("auth.localhost");
      await evidence.screenshot(page, "s7-after-allow").catch(() => {});
      // screenshot whatever tab is showing the gated origin if we can find it
      for (const p of browser.context.pages()) {
        try {
          if (p.url().includes("auth.localhost")) await evidence.screenshot(p, "s7-gated-tab");
        } catch {}
      }

      // recovery probe: is the browser host wedged for OTHER tasks too?
      let probe = null;
      try {
        const taskId2 = await runner.createTask({
          title: "s7 probe",
          cwd: "/tmp",
          backend: { backendId: "chrome-extension", pinnedBy: "user" },
          tabIntent: { scope: "untitled" },
        });
        const scope2 = await runner.spawnBrowserScope(taskId2);
        probe = await runner.browserToolCall(taskId2, "browser.tabs.list", {}, scope2.token, 30_000);
        evidence.note(`probe tabs.list → ${JSON.stringify(probe)?.slice(0, 300)}`);
      } catch (e) {
        probe = { rpcError: e?.message };
        evidence.note(`probe failed: ${e?.message}`);
      }
      const hostAlive = probe && probe.status === "completed";

      // durable evidence
      const resolved = runner.eventsFor(taskId, "permission.resolved").length;
      const sync = await runner.taskSync(taskId);

      const pass = denied && allowed && navigated && resolved >= 2;
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "deny→approval_denied, allow→navigated, permission.resolved×2"
          : `deny=${denied} allow=${allowed} navigated=${navigated} resolved=${resolved}`,
        details: {
          denied,
          allowed,
          navigated,
          finalUrl,
          tabsText: tabsText.slice(0, 800),
          hostAliveAfterApproval: hostAlive,
          resolvedCount: resolved,
          denyOutcome,
          allowOutcome,
          denyError: denyError?.message,
          allowError: allowError?.message,
        },
      };
    } finally {
      await fixture.close();
    }
  },
  { autoAnswer: "none", gatewayProviders: [], headless: process.env.CHROMEX_ACCEPTANCE_HEADFUL !== "1" },
);
