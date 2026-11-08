// iframe-headless — real-extension frame-scoped browser tools.
//
// The chrome-extension backend advertises args.frameId on page.* tools
// (all_frames content scripts + per-frame sendMessage + per-frame
// snapshot registry). This scenario proves it end-to-end in headless
// Chrome for Testing: MCP → gateway → native host → SW → content script
// inside BOTH a same-origin and a cross-origin (localhost vs 127.0.0.1)
// iframe — snapshot mints per-frame refs, click lands inside the frame,
// and cross-frame snapshotIds are refused loudly.
import { runScenario, sleep } from "./lib/harness.mjs";
import process from "node:process";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "iframe-headless";

function findSnapshotId(outcome) {
  const s = JSON.stringify(outcome?.result ?? {});
  const m = s.match(/"snapshotId"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

// pull the ref of the element labelled `label` out of a snapshot result
function refForLabel(outcome, label) {
  const els = outcome?.result?.elements;
  if (!Array.isArray(els)) return null;
  const el = els.find(
    (e) => String(e.label ?? "").includes(label) || String(e.text ?? "").includes(label),
  );
  return el?.ref ?? null;
}

await runScenario(
  SCENARIO,
  async ({ runner, browser, evidence }) => {
    const fixture = await startFixtureServer();
    try {
      const taskId = await runner.createTask({
        title: "iframe frame-scoped tools e2e",
        cwd: "/tmp",
        backend: { backendId: "chrome-extension", pinnedBy: "user" },
        tabIntent: { scope: "untitled" },
      });
      const { token } = await runner.spawnBrowserScope(taskId);

      const page = await browser.context.newPage();
      await page.goto(fixture.url("/iframe-parent"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();

      // wait until webNavigation reports top + both child frames
      let frames = [];
      const frameDeadline = Date.now() + 15_000;
      while (Date.now() < frameDeadline) {
        const get = await runner.browserToolCall(taskId, "browser.page.get", {}, token, 60_000);
        frames = get?.result?.frames ?? get?.frames ?? [];
        const childFrames = frames.filter((f) => String(f.url ?? "").includes("/iframe-child"));
        if (childFrames.length >= 2) break;
        await sleep(400);
      }
      evidence.note(`frames=${JSON.stringify(frames)}`);
      const sameFrame = frames.find((f) => String(f.url ?? "").includes("127.0.0.1") && String(f.url ?? "").includes("/iframe-child"));
      const crossFrame = frames.find((f) => String(f.url ?? "").includes("localhost") && String(f.url ?? "").includes("/iframe-child"));
      if (!sameFrame || !crossFrame) {
        return { status: "FAIL", summary: "page.get did not report both iframe frameIds", details: { frames } };
      }

      const results = {};
      for (const [name, frame] of [["same-origin", sameFrame], ["cross-origin", crossFrame]]) {
        const fid = frame.frameId;
        const snap = await runner.browserToolCall(
          taskId, "browser.page.snapshot", { frameId: fid }, token, 60_000,
        );
        const snapId = findSnapshotId(snap);
        const ref = refForLabel(snap, "frame-btn");
        evidence.note(`${name} frame=${fid} snapshot=${snap?.status} snapId=${snapId} ref=${ref}`);
        if (snap?.status !== "completed" || !snapId || !ref) {
          results[name] = { ok: false, stage: "snapshot", snap };
          continue;
        }
        const click = await runner.browserToolCall(
          taskId, "browser.page.click",
          { ref, snapshotId: snapId, frameId: fid },
          token, 60_000,
        );
        evidence.note(`${name} click → ${JSON.stringify(click)?.slice(0, 250)}`);
        results[name] = { ok: click?.status === "completed", clickStatus: click?.status, frameId: fid };
      }

      // beacons: each iframe's fetch hits /api/frame-hit?src=<origin>
      const hitDeadline = Date.now() + 10_000;
      let hits = [];
      while (Date.now() < hitDeadline) {
        hits = fixture.requests.filter((r) => r.path === "/api/frame-hit");
        const origins = new Set(hits.map((h) => h.src));
        if (origins.has(`http://127.0.0.1:${fixture.port}`) && origins.has(`http://localhost:${fixture.port}`)) break;
        await sleep(300);
      }
      evidence.note(`frame-hit beacons=${JSON.stringify(hits)}`);
      const sameHit = hits.some((h) => h.src === `http://127.0.0.1:${fixture.port}`);
      const crossHit = hits.some((h) => h.src === `http://localhost:${fixture.port}`);

      // negative: top-frame snapshotId must not drive a child frame
      const topSnap = await runner.browserToolCall(taskId, "browser.page.snapshot", {}, token, 60_000);
      const topSnapId = findSnapshotId(topSnap);
      const crossSnap = await runner.browserToolCall(
        taskId, "browser.page.snapshot", { frameId: crossFrame.frameId }, token, 60_000,
      );
      const crossRef = refForLabel(crossSnap, "frame-btn");
      let crossFrameReject = null;
      if (topSnapId && crossRef) {
        try {
          crossFrameReject = await runner.browserToolCall(
            taskId, "browser.page.click",
            { ref: crossRef, snapshotId: topSnapId, frameId: crossFrame.frameId },
            token, 60_000,
          );
        } catch (e) {
          crossFrameReject = { rpcError: e?.message };
        }
        evidence.note(`cross-frame snapshotId click → ${JSON.stringify(crossFrameReject)?.slice(0, 300)}`);
      }
      const rejected =
        crossFrameReject == null ||
        crossFrameReject.rpcError ||
        crossFrameReject.status === "failed" ||
        /stale|frame|snapshot/i.test(JSON.stringify(crossFrameReject?.error ?? crossFrameReject));

      // evaluate in MAIN world: top frame + the OOPIF cross-origin child
      // (chrome.scripting frameIds reach out-of-process frames).
      let evalTop = null, evalFrame = null;
      try {
        evalTop = await runner.browserToolCall(
          taskId, "browser.page.evaluate", { expression: "location.pathname" }, token, 60_000,
        );
        if (crossFrame?.frameId) {
          evalFrame = await runner.browserToolCall(
            taskId, "browser.page.evaluate",
            { expression: "location.origin", frameId: crossFrame.frameId }, token, 60_000,
          );
        }
      } catch (e) {
        evalTop = evalTop ?? { rpcError: e?.message };
      }
      const evalTopVal = evalTop?.result?.value ?? evalTop?.value;
      const evalFrameVal = evalFrame?.result?.value ?? evalFrame?.value;
      evidence.note(`evaluate top=${JSON.stringify(evalTopVal)} frame=${JSON.stringify(evalFrameVal)}`);
      results.evaluate = {
        ok: evalTopVal === "/iframe-parent" && typeof evalFrameVal === "string" && evalFrameVal.includes("localhost"),
        top: evalTopVal, frame: evalFrameVal,
      };

      // negative: nonexistent frameId must fail honestly, not hit the top frame
      let badFrame = null;
      try {
        badFrame = await runner.browserToolCall(
          taskId, "browser.page.snapshot", { frameId: 99999 }, token, 60_000,
        );
      } catch (e) {
        badFrame = { rpcError: e?.message };
      }
      evidence.note(`frameId=99999 → ${JSON.stringify(badFrame)?.slice(0, 250)}`);
      const badFrameFailed =
        badFrame == null || badFrame.rpcError || badFrame.status === "failed";

      const pass =
        results["same-origin"]?.ok === true &&
        results["cross-origin"]?.ok === true &&
        results.evaluate?.ok === true &&
        sameHit && crossHit && rejected && badFrameFailed;
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "frameId end-to-end on real extension: snapshot+click/evaluate inside same- AND cross-origin iframes (incl. OOPIF MAIN world); cross-frame snapshotId refused; bad frameId fails honestly"
          : `same=${JSON.stringify(results["same-origin"])} cross=${JSON.stringify(results["cross-origin"])} sameHit=${sameHit} crossHit=${crossHit} rejected=${rejected} badFrameFailed=${badFrameFailed}`,
        details: { results, sameHit, crossHit, rejected, badFrameFailed, hits },
      };
    } finally {
      await fixture.close();
    }
  },
  { autoAnswer: "allow", gatewayProviders: [], headless: process.env.CHROMEX_ACCEPTANCE_HEADFUL !== "1" },
);
