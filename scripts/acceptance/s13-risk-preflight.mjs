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

      // ---------- Part 2: approve once → destructive action really fires ----------
      let approveOutcome = null;
      let approveError = null;
      const approveCall = runner
        .browserToolCall(
          taskId,
          "browser.page.click",
          { tabId, ref: danger.ref, snapshotId: snapResult.snapshotId },
          token,
          90_000,
        )
        .then((o) => (approveOutcome = o))
        .catch((e) => (approveError = e));

      let approveReq = null;
      const approveDeadline = Date.now() + 30_000;
      while (Date.now() < approveDeadline && !approveReq) {
        for (const req of pendingRequests()) {
          if (req.kind === "agent_egress") await grantEgress(req);
          else {
            approveReq = req;
            break;
          }
        }
        if (!approveReq) await sleep(300);
      }
      if (!approveReq) {
        await Promise.race([approveCall, sleep(3_000)]);
        return {
          status: "FAIL",
          summary: "no permission.requested on approved destructive ref click",
          details: { approveError: approveError?.message, approveOutcome },
        };
      }
      evidence.note(`approve-leg permission.requested id=${approveReq.requestId} kind=${approveReq.kind}`);
      const approveOpt =
        (approveReq.options ?? []).find((o) => /allow_once|approve|yes/i.test(String(o.id)) || o.kind === "allow_once") ??
        (approveReq.options ?? []).find((o) => o.kind !== "deny");
      await respond(approveReq, approveOpt?.id);
      await Promise.race([approveCall, sleep(30_000)]);
      const approved = approveOutcome?.status !== "failed";
      evidence.note(`approve outcome=${JSON.stringify(approveOutcome ?? approveError?.message)?.slice(0, 300)}`);

      const afterApprove = await callGrantingEgress(
        "browser.page.extract",
        { tabId, selector: "#out", format: "text" },
        30_000,
      );
      const approvePageText = JSON.stringify(afterApprove?.result ?? {});
      const dangerFired = approvePageText.includes("danger-fired");
      evidence.note(`post-approve #out=${approvePageText.slice(0, 200)}`);

      // ---------- Part 3: benign click by bare ref → NO approval ----------
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

      // ---------- Part 4: trusted/CDP approve-then-mutate TOCTOU ----------
      // The classifier approves "Delete account permanently"; while the
      // approval is pending the page relabels the button. The trusted
      // dispatch must re-verify expectedTarget and refuse — the click
      // handler must never fire. Positive control: restore the label,
      // approve again, and the trusted click really fires (isTrusted).
      const tcCreated = await callGrantingEgress("browser.tab.create", { url: fixture.url("/toctou") });
      const tcTabId = tcCreated?.result?.tabId ?? tcCreated?.result?.id ?? tcCreated?.tabId;
      evidence.note(`toctou tab.create → tabId=${tcTabId}`);
      let toctou = { attempted: false, refused: false, notFired: false, controlFired: false };
      if (Number.isInteger(tcTabId)) {
        await sleep(800);
        const tcSnap = await callGrantingEgress("browser.page.snapshot", { tabId: tcTabId });
        const tcSnapResult = tcSnap?.result ?? {};
        const tcElements = Array.isArray(tcSnapResult.elements) ? tcSnapResult.elements : [];
        const tcBtn = tcElements.find((e) => /delete account/i.test(e.label ?? e.text ?? ""));
        evidence.note(`toctou snapshot elements=${tcElements.length} btnRef=${tcBtn?.ref}`);

        // the Playwright-side page for this tab — mutate the DOM
        // directly while the approval is pending (no tool approval
        // needed, deterministic timing).
        let pwPage = null;
        const pwDeadline = Date.now() + 10_000;
        while (Date.now() < pwDeadline && !pwPage) {
          for (const p of browser.context.pages()) {
            try {
              if (p.url().includes("/toctou")) { pwPage = p; break; }
            } catch {}
          }
          if (!pwPage) await sleep(300);
        }
        evidence.note(`toctou pwPage=${pwPage ? pwPage.url() : "NOT FOUND"}`);

        if (tcBtn?.ref && pwPage) {
          toctou.attempted = true;
          let tcOutcome = null;
          let tcError = null;
          const tcCall = runner
            .browserToolCall(
              taskId,
              "browser.page.click",
              { tabId: tcTabId, ref: tcBtn.ref, snapshotId: tcSnapResult.snapshotId, trusted: true },
              token,
              90_000,
            )
            .then((o) => (tcOutcome = o))
            .catch((e) => (tcError = e));

          // wait for the action approval, then mutate BEFORE answering
          let tcReq = null;
          const tcDeadline = Date.now() + 30_000;
          while (Date.now() < tcDeadline && !tcReq) {
            for (const req of pendingRequests()) {
              if (req.kind === "agent_egress") await grantEgress(req);
              else { tcReq = req; break; }
            }
            if (!tcReq) await sleep(300);
          }
          if (tcReq) {
            evidence.note(`toctou approval id=${tcReq.requestId} kind=${tcReq.kind} targetLabel=${tcReq.details?.targetLabel}`);
            await pwPage.evaluate(() => window.__mutate?.());
            await sleep(200); // let the mutation commit before dispatch
            const tcOpt =
              (tcReq.options ?? []).find((o) => /allow_once|approve|yes/i.test(String(o.id)) || o.kind === "allow_once") ??
              (tcReq.options ?? []).find((o) => o.kind !== "deny");
            await respond(tcReq, tcOpt?.id);
            await Promise.race([tcCall, sleep(30_000)]);
            const tcCode = tcOutcome?.error?.code;
            toctou.refused = tcOutcome?.status === "failed" && tcCode === "browser.target_changed";
            evidence.note(`toctou outcome=${JSON.stringify(tcOutcome ?? tcError?.message)?.slice(0, 300)}`);

            const tcAfter = await callGrantingEgress(
              "browser.page.extract",
              { tabId: tcTabId, selector: "#out", format: "text" },
              30_000,
            );
            const tcText = JSON.stringify(tcAfter?.result ?? {});
            toctou.notFired = !tcText.includes("clicked:");
            evidence.note(`toctou post-refuse #out=${tcText.slice(0, 200)}`);

            // positive control — restore facts, approve again, real
            // trusted click must fire (proves the gate is not a blanket
            // block on trusted input).
            await pwPage.evaluate(() => window.__restore?.());
            let tc2Outcome = null;
            const tc2Call = runner
              .browserToolCall(
                taskId,
                "browser.page.click",
                { tabId: tcTabId, ref: tcBtn.ref, snapshotId: tcSnapResult.snapshotId, trusted: true },
                token,
                90_000,
              )
              .then((o) => (tc2Outcome = o))
              .catch(() => {});
            let tc2Req = null;
            const tc2Deadline = Date.now() + 30_000;
            while (Date.now() < tc2Deadline && !tc2Req) {
              for (const req of pendingRequests()) {
                if (req.kind === "agent_egress") await grantEgress(req);
                else { tc2Req = req; break; }
              }
              if (!tc2Req) await sleep(300);
            }
            if (tc2Req) {
              const tc2Opt =
                (tc2Req.options ?? []).find((o) => /allow_once|approve|yes/i.test(String(o.id)) || o.kind === "allow_once") ??
                (tc2Req.options ?? []).find((o) => o.kind !== "deny");
              await respond(tc2Req, tc2Opt?.id);
              await Promise.race([tc2Call, sleep(30_000)]);
              evidence.note(`toctou control outcome=${JSON.stringify(tc2Outcome)?.slice(0, 300)}`);
              const tc2After = await callGrantingEgress(
                "browser.page.extract",
                { tabId: tcTabId, selector: "#out", format: "text" },
                30_000,
              );
              toctou.controlFired = JSON.stringify(tc2After?.result ?? {}).includes("clicked:Delete account permanently");
              evidence.note(`toctou control #out=${JSON.stringify(tc2After?.result ?? {}).slice(0, 200)}`);
            } else {
              evidence.note("toctou control: no approval request seen");
            }
          } else {
            evidence.note("toctou: no approval request seen — aborting leg");
            await Promise.race([tcCall, sleep(3_000)]);
          }
        } else {
          evidence.note(`toctou leg skipped: btnRef=${tcBtn?.ref} pwPage=${!!pwPage}`);
        }
      }

      // screenshot the risky tab for evidence
      for (const p of browser.context.pages()) {
        try {
          if (p.url().includes("/risky")) await evidence.screenshot(p, "s13-final");
        } catch {}
      }

      const pass =
        denied && dangerNotFired && approved && dangerFired && benignOk && noNewApproval && benignFired &&
        toctou.attempted && toctou.refused && toctou.notFired && toctou.controlFired;
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "destructive ref-click → approval (denied→not fired, approved→danger-fired); benign ref-click → no approval, fired; trusted approve-then-mutate → browser.target_changed, handler never fired, restored-label control click fires"
          : `denied=${denied} dangerNotFired=${dangerNotFired} approved=${approved} dangerFired=${dangerFired} benignOk=${benignOk} noNewApproval=${noNewApproval} benignFired=${benignFired} toctou=${JSON.stringify(toctou)}`,
        details: {
          denied,
          dangerNotFired,
          approved,
          dangerFired,
          benignOk,
          noNewApproval,
          benignFired,
          toctou,
          denyOutcome,
          approveOutcome,
          benignOutcome,
          denyError: denyError?.message,
          approveError: approveError?.message,
        },
      };
    } finally {
      await fixture.close();
    }
  },
  { autoAnswer: "none", gatewayProviders: [], headless: process.env.CHROMEX_ACCEPTANCE_HEADFUL !== "1" },
);
