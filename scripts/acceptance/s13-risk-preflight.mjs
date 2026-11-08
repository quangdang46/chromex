// S13 — §4.8 ground-truth target preflight: a destructive-labeled button
// targeted by bare snapshot ref (args carry NO label) must still demand
// contextual approval; denial is honored and the handler never fires.
// A benign button on the same page stays approval-free.
// Real extension backend via browser.tool.call (deterministic).
import { runScenario, sleep } from "./lib/harness.mjs";
import process from "node:process";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "s13-risk-preflight";

await runScenario(
  SCENARIO,
  async ({ runner, browser, evidence }) => {
    const fixture = await startFixtureServer();
    try {
      const taskId = await runner.createTask({
        title: "s13 risk preflight e2e",
        cwd: "/tmp",
        backend: { backendId: "chrome-extension", pinnedBy: "user" },
        tabIntent: { scope: "untitled" },
      });
      evidence.note(`task ${taskId}`);
      const { token } = await runner.spawnBrowserScope(taskId);
      evidence.note("browser.mcp scope acquired");

      // autoAnswer is "none" so the destructive approval can be denied
      // explicitly — but page-text egress (snapshot/extract to a cloud
      // destination) legitimately requests approval too. Track answered
      // requestIds and auto-grant egress with the task-scoped option.
      const answered = new Set();
      const pendingRequests = () =>
        runner
          .eventsFor(taskId, "permission.requested")
          .map((e) => e.payload?.request)
          .filter((r) => r?.requestId && !answered.has(r.requestId));
      const respond = async (req, optionId) => {
        answered.add(req.requestId);
        await runner.conn.request("permission.respond", { requestId: req.requestId, optionId });
        evidence.note(`permission.respond ${req.requestId} → ${optionId} (${req.kind})`);
      };
      const grantEgress = async (req) => {
        const opt =
          (req.options ?? []).find((o) => /allow_egress_task/.test(String(o.id))) ??
          (req.options ?? []).find((o) => /allow_once|approve|yes/i.test(String(o.id))) ??
          (req.options ?? []).find((o) => o.kind !== "deny");
        if (opt) await respond(req, opt.id);
      };
      // Race a tool call against permission requests: grant every
      // agent_egress request that appears while the call is in flight.
      const callGrantingEgress = async (tool, args = {}, timeoutMs = 60_000) => {
        let done = false;
        const p = runner.browserToolCall(taskId, tool, args, token, timeoutMs);
        const watcher = (async () => {
          const deadline = Date.now() + timeoutMs;
          while (!done && Date.now() < deadline) {
            for (const req of pendingRequests()) {
              if (req.kind === "agent_egress") await grantEgress(req);
            }
            await sleep(300);
          }
        })();
        try {
          return await p;
        } finally {
          done = true;
          await watcher.catch(() => {});
        }
      };

      // extension-owned tab — same pattern as agent-task-headless
      const created = await callGrantingEgress("browser.tab.create", { url: fixture.url("/risky") });
      const tabId = created?.result?.tabId ?? created?.result?.id ?? created?.tabId;
      evidence.note(`tab.create → tabId=${tabId}`);
      if (!Number.isInteger(tabId)) {
        return { status: "FAIL", summary: "tab.create did not return a tabId", details: { created } };
      }
      await sleep(800);

      // snapshot → mint refs; the click args will carry ONLY ref+snapshotId
      const snapOutcome = await callGrantingEgress("browser.page.snapshot", { tabId });
      const snapResult = snapOutcome?.result ?? {};
      const elements = Array.isArray(snapResult.elements) ? snapResult.elements : [];
      const danger = elements.find((e) => /delete account/i.test(e.label ?? e.text ?? ""));
      const benign = elements.find((e) => /^search$/i.test((e.label ?? e.text ?? "").trim()));
      evidence.note(`snapshot elements=${elements.length} dangerRef=${danger?.ref} benignRef=${benign?.ref}`);
      if (!danger?.ref || !benign?.ref) {
        return {
          status: "FAIL",
          summary: "snapshot did not mint refs for both buttons",
          details: { elements: elements.map((e) => ({ ref: e.ref, label: e.label })) },
        };
      }

      // ---------- Part 1: destructive click by bare ref → approval ----------
      let denyOutcome = null;
      let denyError = null;
      const denyCall = runner
        .browserToolCall(
          taskId,
          "browser.page.click",
          { tabId, ref: danger.ref, snapshotId: snapResult.snapshotId },
          token,
          90_000,
        )
        .then((o) => (denyOutcome = o))
        .catch((e) => (denyError = e));

      // wait for the ACTION approval (skip any straggler egress requests)
      let denyReq = null;
      const denyDeadline = Date.now() + 30_000;
      while (Date.now() < denyDeadline && !denyReq) {
        for (const req of pendingRequests()) {
          if (req.kind === "agent_egress") await grantEgress(req);
          else {
            denyReq = req;
            break;
          }
        }
        if (!denyReq) await sleep(300);
      }
      if (!denyReq) {
        await Promise.race([denyCall, sleep(3_000)]);
        return {
          status: "FAIL",
          summary: "no permission.requested for destructive-labeled ref click",
          details: { denyError: denyError?.message, denyOutcome },
        };
      }
      evidence.note(
        `permission.requested id=${denyReq.requestId} kind=${denyReq.kind} tool=${denyReq.details?.tool} ` +
          `targetLabel=${denyReq.details?.targetLabel} options=${JSON.stringify((denyReq.options ?? []).map((o) => o.id))}`,
      );
      const denyOpt =
        (denyReq.options ?? []).find((o) => o.kind === "deny" || /deny|dismiss|reject|cancel/i.test(String(o.id))) ??
        (denyReq.options ?? [])[denyReq.options.length - 1];
      await respond(denyReq, denyOpt?.id);
      await Promise.race([denyCall, sleep(30_000)]);
      const denied =
        denyOutcome?.status === "failed" &&
        (denyOutcome?.error?.code === "browser.approval_denied" || denyOutcome?.error?.code === "browser.denied");
      evidence.note(`deny outcome=${JSON.stringify(denyOutcome ?? denyError?.message)?.slice(0, 300)}`);

      // the denied click must NOT have fired the page handler —
      // read the dedicated output element directly
      const afterDeny = await callGrantingEgress(
        "browser.page.extract",
        { tabId, selector: "#out", format: "text" },
        30_000,
      );
      const denyPageText = JSON.stringify(afterDeny?.result ?? {});
      const dangerNotFired = !denyPageText.includes("danger-fired");
      evidence.note(`post-deny #out=${denyPageText.slice(0, 200)}`);

      // ---------- Part 2: benign click by bare ref → NO approval ----------
      const reqsBefore = pendingRequests().length;
      const benignOutcome = await callGrantingEgress(
        "browser.page.click",
        { tabId, ref: benign.ref, snapshotId: snapResult.snapshotId },
        60_000,
      );
      await sleep(500);
      const reqsAfter = pendingRequests().length;
      const benignOk = benignOutcome?.status !== "failed";
      const noNewApproval = reqsAfter === reqsBefore;
      evidence.note(`benign click outcome=${benignOutcome?.status} pending approvals ${reqsBefore}→${reqsAfter}`);

      const afterOk = await callGrantingEgress(
        "browser.page.extract",
        { tabId, selector: "#out", format: "text" },
        30_000,
      );
      const okPageText = JSON.stringify(afterOk?.result ?? {});
      const benignFired = okPageText.includes("benign-ok");
      evidence.note(`post-click #out=${okPageText.slice(0, 200)}`);

      // screenshot the risky tab for evidence
      for (const p of browser.context.pages()) {
        try {
          if (p.url().includes("/risky")) await evidence.screenshot(p, "s13-final");
        } catch {}
      }

      const pass = denied && dangerNotFired && benignOk && noNewApproval && benignFired;
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "destructive ref-click → approval (denied, handler never fired); benign ref-click → no approval, fired"
          : `denied=${denied} dangerNotFired=${dangerNotFired} benignOk=${benignOk} noNewApproval=${noNewApproval} benignFired=${benignFired}`,
        details: {
          denied,
          dangerNotFired,
          benignOk,
          noNewApproval,
          benignFired,
          denyOutcome,
          benignOutcome,
          denyError: denyError?.message,
        },
      };
    } finally {
      await fixture.close();
    }
  },
  { autoAnswer: "none", gatewayProviders: [], headless: process.env.CHROMEX_ACCEPTANCE_HEADFUL !== "1" },
);
