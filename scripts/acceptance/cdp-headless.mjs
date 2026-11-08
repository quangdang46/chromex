// cdp-headless — debugger-tier (chrome.debugger/CDP) tools on the real
// built extension in headless Chrome for Testing.
//
// Proves the production path MCP → gateway → native host → SW →
// chrome.debugger for every capability the DOM tier cannot express
// (docs/adr/debugger-tier.md):
//   - snapshot mode:"aria"  → Accessibility.getFullAXTree
//   - click args.trusted     → Input.dispatchMouseEvent (isTrusted=true)
//   - press/type args.trusted → Input.dispatchKeyEvent (isTrusted=true)
//   - hover args.trusted    → Input.dispatchMouseEvent (isTrusted + :hover)
//   - fill args.trusted     → select-all + Backspace + per-char keys (replace)
//   - drag args.trusted     → press + interpolated moves + release
//   - page.dialog            → Page.javascriptDialogOpening/handle
//   - page.setInputFiles     → DOM.setFileInputFiles by absolute path
//   - page.responseBody      → Network tap + getResponseBody
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runScenario, sleep } from "./lib/harness.mjs";
import process from "node:process";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "cdp-headless";

function findSnapshotId(outcome) {
  const s = JSON.stringify(outcome?.result ?? {});
  const m = s.match(/"snapshotId"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

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
    const uploadDir = mkdtempSync(join(tmpdir(), "chromex-cdp-"));
    const uploadPath = join(uploadDir, "chromex-cdp-upload.txt");
    writeFileSync(uploadPath, "cdp-upload-proof\n");
    try {
      const taskId = await runner.createTask({
        title: "cdp debugger-tier tools e2e",
        cwd: "/tmp",
        backend: { backendId: "chrome-extension", pinnedBy: "user" },
        tabIntent: { scope: "untitled" },
      });
      const { token } = await runner.spawnBrowserScope(taskId);

      const page = await browser.context.newPage();
      // Playwright auto-dismisses JS dialogs it observes — keep the
      // dialog alive so the extension's CDP handler is what resolves it.
      page.on("dialog", () => {});

      const results = {};

      // --- responseBody: attach the network tap BEFORE the request ---
      await page.goto(fixture.url("/"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      const prime = await runner.browserToolCall(
        taskId, "browser.page.responseBody", { urlContains: "/api/ping" }, token, 60_000,
      );
      evidence.note(`responseBody prime → ${JSON.stringify(prime)?.slice(0, 200)}`);
      await page.goto(fixture.url("/fetch"), { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.getElementById("out")?.textContent?.startsWith("pong:"),
        { timeout: 10_000 },
      );
      // the tap captured /api/ping during navigation
      let bodyRes = null;
      const bodyDeadline = Date.now() + 15_000;
      while (Date.now() < bodyDeadline) {
        const list = await runner.browserToolCall(
          taskId, "browser.page.responseBody", { urlContains: "/api/ping" }, token, 60_000,
        );
        const reqs = list?.result?.requests ?? list?.requests ?? [];
        const hit = reqs.find((r) => r.finished === true);
        if (hit?.requestId) {
          bodyRes = await runner.browserToolCall(
            taskId, "browser.page.responseBody", { requestId: hit.requestId }, token, 60_000,
          );
          break;
        }
        await sleep(400);
      }
      const bodyPayload = bodyRes?.result ?? bodyRes ?? {};
      const bodyText = JSON.stringify(bodyPayload);
      evidence.note(`responseBody → ${bodyText.slice(0, 300)}`);
      results.responseBody = {
        ok: bodyPayload?.body === '{"v":"ok"}',
        snippet: bodyText.slice(0, 200),
      };

      // --- aria snapshot ---
      const aria = await runner.browserToolCall(
        taskId, "browser.page.snapshot", { mode: "aria" }, token, 60_000,
      );
      const ariaText = JSON.stringify(aria?.result ?? aria ?? {});
      evidence.note(`aria snapshot → ${ariaText.slice(0, 300)}`);
      results.aria = { ok: /button|RootWebArea/i.test(ariaText) };

      // --- trusted vs untrusted click ---
      await page.goto(fixture.url("/trusted"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      const snap = await runner.browserToolCall(taskId, "browser.page.snapshot", {}, token, 60_000);
      const snapId = findSnapshotId(snap);
      evidence.note(`trusted snap=${snap?.status} snapId=${snapId}`);
      let untrustedClick = null;
      let trustedClick = null;
      if (snapId) {
        untrustedClick = await runner.browserToolCall(
          taskId, "browser.page.click",
          { selector: "#t-untrusted", snapshotId: snapId },
          token, 60_000,
        );
      }
      // re-snapshot: the first click may have mutated the DOM
      const snap2 = await runner.browserToolCall(taskId, "browser.page.snapshot", {}, token, 60_000);
      const snapId2 = findSnapshotId(snap2);
      if (snapId2) {
        trustedClick = await runner.browserToolCall(
          taskId, "browser.page.click",
          { selector: "#t-trusted", snapshotId: snapId2, trusted: true },
          token, 60_000,
        );
      }
      evidence.note(`untrusted click → ${JSON.stringify(untrustedClick)?.slice(0, 200)}`);
      evidence.note(`trusted click → ${JSON.stringify(trustedClick)?.slice(0, 200)}`);
      const rUntrusted = await page.locator("#r-untrusted").textContent();
      const rTrusted = await page.locator("#r-trusted").textContent();
      evidence.note(`isTrusted results: untrusted=${rUntrusted} trusted=${rTrusted}`);
      results.trustedClick = {
        ok: rUntrusted === "isTrusted:false" && rTrusted === "isTrusted:true",
        untrusted: rUntrusted,
        trusted: rTrusted,
        clickStatus: trustedClick?.status,
      };

      // trusted hover: CDP mouseMoved → isTrusted mouseover + :hover CSS
      const hoverRes = await runner.browserToolCall(
        taskId, "browser.page.hover",
        { selector: "#hov", trusted: true }, token, 60_000,
      );
      await sleep(200);
      const rHover = await page.locator("#r-hover").textContent();
      // move onto the CSS-hover probe and read computed style
      await runner.browserToolCall(
        taskId, "browser.page.hover",
        { selector: "#hov-css", trusted: true }, token, 60_000,
      );
      await sleep(200);
      const hovCssOutline = await page.evaluate(
        () => getComputedStyle(document.getElementById("hov-css")).outlineStyle,
      );
      evidence.note(`hover: mouseover=${rHover} cssOutline=${hovCssOutline} status=${hoverRes?.status}`);
      results.trustedHover = {
        ok: rHover === "isTrusted:true" && hovCssOutline !== "none" && hoverRes?.status === "completed",
        mouseover: rHover,
        cssOutline: hovCssOutline,
      };

      // --- trusted press: CDP key events vs synthetic DOM key events ---
      await page.goto(fixture.url("/keys"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      // /keys #k records 'key:<key>,trusted:<isTrusted>' on keydown
      const untrustedPress = await runner.browserToolCall(
        taskId, "browser.page.press",
        { selector: "#k", key: "a" }, token, 60_000,
      );
      await sleep(200);
      const outUntrusted = await page.locator("#out").textContent();
      const trustedPress = await runner.browserToolCall(
        taskId, "browser.page.press",
        { selector: "#k", key: "Enter", trusted: true }, token, 60_000,
      );
      await sleep(200);
      const outTrusted = await page.locator("#out").textContent();
      evidence.note(`press: untrusted=${outUntrusted} trusted=${outTrusted}`);
      evidence.note(`press statuses: ${untrustedPress?.status}/${trustedPress?.status}`);
      results.trustedPress = {
        ok: outUntrusted === "key:a,trusted:false" && outTrusted === "key:Enter,trusted:true",
        untrusted: outUntrusted,
        trusted: outTrusted,
      };

      // trusted type: per-char CDP key events insert real text
      const typeRes = await runner.browserToolCall(
        taskId, "browser.page.type",
        { selector: "#k", text: "Hi!", trusted: true }, token, 60_000,
      );
      const typedValue = await page.locator("#k").inputValue();
      const outAfterType = await page.locator("#out").textContent();
      evidence.note(`trusted type → status=${typeRes?.status} value=${JSON.stringify(typedValue)} out=${outAfterType}`);
      results.trustedType = {
        ok: typeRes?.status === "completed" && typedValue === "Hi!" && /trusted:true/.test(outAfterType ?? ""),
        status: typeRes?.status,
        value: typedValue,
        out: outAfterType,
      };

      // trusted fill: select-all + delete + retype replaces "Hi!" → "xy"
      const fillRes = await runner.browserToolCall(
        taskId, "browser.page.fill",
        { selector: "#k", text: "xy", trusted: true }, token, 60_000,
      );
      const filledValue = await page.locator("#k").inputValue();
      const outAfterFill = await page.locator("#out").textContent();
      evidence.note(`trusted fill → status=${fillRes?.status} value=${JSON.stringify(filledValue)} out=${outAfterFill}`);
      results.trustedFill = {
        ok: fillRes?.status === "completed" && filledValue === "xy" && /trusted:true/.test(outAfterFill ?? ""),
        status: fillRes?.status,
        value: filledValue,
      };

      // trusted drag: CDP press→moves→release, isTrusted mousedown
      await page.goto(fixture.url("/drag"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      const dragRes = await runner.browserToolCall(
        taskId, "browser.page.drag",
        { selector: "#src", toSelector: "#dst", trusted: true }, token, 60_000,
      );
      await sleep(300);
      const rDown = await page.locator("#r-down").textContent();
      const dragOut = await page.locator("#out").textContent();
      evidence.note(`drag: down=${rDown} out=${dragOut} status=${dragRes?.status}`);
      results.trustedDrag = {
        ok: dragRes?.status === "completed" && rDown === "isTrusted:true" && /^up@\d+/.test(dragOut ?? ""),
        down: rDown,
        out: dragOut,
        status: dragRes?.status,
      };

      // trusted keyboard inside an iframe: focus happens in the child
      // frame's content script; CDP key events follow the focused frame.
      await page.goto(fixture.url("/iframe-parent"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      const getFrames = await runner.browserToolCall(taskId, "browser.page.get", {}, token, 60_000);
      const frames = getFrames?.result?.frames ?? getFrames?.frames ?? [];
      const childFrame = frames.find(
        (f) => String(f.url ?? "").includes("127.0.0.1") && String(f.url ?? "").includes("/iframe-child"),
      );
      const crossFrame = frames.find(
        (f) => String(f.url ?? "").includes("localhost") && String(f.url ?? "").includes("/iframe-child"),
      );
      let framePress = null;
      let koutText = null;
      if (childFrame?.frameId) {
        framePress = await runner.browserToolCall(
          taskId, "browser.page.press",
          { selector: "#fin", key: "x", trusted: true, frameId: childFrame.frameId },
          token, 60_000,
        );
        await sleep(300);
        const pwFrame = page.frames().find((f) => f.url().includes("127.0.0.1") && f.url().includes("/iframe-child"));
        koutText = pwFrame ? await pwFrame.locator("#kout").textContent() : null;
      }
      evidence.note(`frame press → status=${framePress?.status} kout=${koutText}`);
      results.trustedFramePress = {
        ok: framePress?.status === "completed" && koutText === "key:x,trusted:true",
        status: framePress?.status,
        kout: koutText,
      };

      // trusted pointer inside iframes — same-origin AND cross-origin
      // (possibly out-of-process): element targets resolve to absolute
      // viewport coords via the content-script postMessage geometry
      // chain, then CDP Input dispatches isTrusted=true events.
      const frameClickResults = {};
      for (const [name, fr, urlMatch] of [
        ["same", childFrame, "127.0.0.1"],
        ["cross", crossFrame, "localhost"],
      ]) {
        let clickRes = null;
        let pout = null;
        if (fr?.frameId) {
          clickRes = await runner.browserToolCall(
            taskId, "browser.page.click",
            { selector: "#pb", trusted: true, frameId: fr.frameId },
            token, 60_000,
          );
          await sleep(300);
          const pwFr = page.frames().find((f) => f.url().includes(urlMatch) && f.url().includes("/iframe-child"));
          pout = pwFr ? await pwFr.locator("#pout").textContent() : null;
        }
        frameClickResults[name] = {
          ok: clickRes?.status === "completed" && pout === "down:true up:true",
          status: clickRes?.status,
          pout,
        };
        evidence.note(`frame click ${name} → status=${clickRes?.status} pout=${pout}`);
      }
      results.trustedFrameClick = {
        ok: frameClickResults.same?.ok === true && frameClickResults.cross?.ok === true,
        same: frameClickResults.same,
        cross: frameClickResults.cross,
      };

      // setInputFiles inside the same-origin iframe: content script
      // marks the element, pierced DOM.getDocument finds the node.
      let frameFiles = null;
      let fout2 = null;
      if (childFrame?.frameId) {
        frameFiles = await runner.browserToolCall(
          taskId, "browser.page.setInputFiles",
          { selector: "#ffile", files: [uploadPath], frameId: childFrame.frameId },
          token, 60_000,
        );
        await sleep(300);
        const pwFr3 = page.frames().find((f) => f.url().includes("127.0.0.1") && f.url().includes("/iframe-child"));
        fout2 = pwFr3 ? await pwFr3.locator("#fout2").textContent() : null;
      }
      evidence.note(`frame setInputFiles → status=${frameFiles?.status} fout2=${fout2}`);
      results.frameSetInputFiles = {
        ok: frameFiles?.status === "completed" && fout2 === "files:chromex-cdp-upload.txt",
        status: frameFiles?.status,
        fout2,
      };

      // element screenshot inside the iframe: geometry chain resolves
      // the clip rect, CDP Page.captureScreenshot returns the bytes.
      let frameShot = null;
      if (childFrame?.frameId) {
        frameShot = await runner.browserToolCall(
          taskId, "browser.page.screenshot",
          { selector: "#pb", frameId: childFrame.frameId },
          token, 60_000,
        );
      }
      const shotResult = frameShot?.result ?? frameShot ?? {};
      evidence.note(`frame screenshot → status=${frameShot?.status} bytes=${shotResult?.bytes}`);
      results.frameElementScreenshot = {
        ok: frameShot?.status === "completed" && typeof shotResult?.dataBase64 === "string" && shotResult.dataBase64.length > 100,
        status: frameShot?.status,
        bytes: shotResult?.bytes,
      };

      // in-memory upload inside the iframe: DataTransfer works in any
      // frame's content script — no CDP needed.
      let frameUpload = null;
      let fout2b = null;
      if (childFrame?.frameId) {
        frameUpload = await runner.browserToolCall(
          taskId, "browser.page.upload",
          {
            selector: "#ffile",
            frameId: childFrame.frameId,
            files: [{ name: "mem.txt", mimeType: "text/plain", base64: "aGVsbG8=" }],
          },
          token, 60_000,
        );
        await sleep(300);
        const pwFr4 = page.frames().find((f) => f.url().includes("127.0.0.1") && f.url().includes("/iframe-child"));
        fout2b = pwFr4 ? await pwFr4.locator("#fout2").textContent() : null;
      }
      evidence.note(`frame upload → status=${frameUpload?.status} fout2=${fout2b}`);
      results.frameUpload = {
        ok: frameUpload?.status === "completed" && fout2b === "files:mem.txt",
        status: frameUpload?.status,
        fout2: fout2b,
      };

      // --- dialog: click schedules confirm(), CDP handles it ---
      await page.goto(fixture.url("/dialog"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      const dsnap = await runner.browserToolCall(taskId, "browser.page.snapshot", {}, token, 60_000);
      const dSnapId = findSnapshotId(dsnap);
      evidence.note(`dialog snap=${dsnap?.status} snapId=${dSnapId}`);
      let dialogRes = null;
      if (dSnapId) {
        await runner.browserToolCall(
          taskId, "browser.page.click",
          { selector: "#ask", snapshotId: dSnapId },
          token, 60_000,
        );
        // confirm opens ~50ms later on a macrotask — the dialog tool
        // subscribes then waits for Page.javascriptDialogOpening.
        dialogRes = await runner.browserToolCall(
          taskId, "browser.page.dialog", { accept: true, timeoutMs: 8000 }, token, 60_000,
        );
      }
      const dialogText = JSON.stringify(dialogRes?.result ?? dialogRes ?? {});
      evidence.note(`dialog → ${dialogText.slice(0, 300)}`);
      const rDialog = await page.locator("#r").textContent();
      evidence.note(`dialog result text=${rDialog}`);
      results.dialog = {
        ok: /"handled"\s*:\s*true/.test(dialogText) && rDialog === "confirm:true",
        handled: /"handled"\s*:\s*true/.test(dialogText),
        pageText: rDialog,
      };

      // --- setInputFiles: absolute path onto input[type=file] ---
      await page.goto(fixture.url("/keys"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      const fsnap = await runner.browserToolCall(taskId, "browser.page.snapshot", {}, token, 60_000);
      const fSnapId = findSnapshotId(fsnap);
      const fileRef = refForLabel(fsnap, "") ?? null;
      // /keys file input has no label — target by selector instead
      let setRes = null;
      setRes = await runner.browserToolCall(
        taskId, "browser.page.setInputFiles",
        { selector: "#f", snapshotId: fSnapId ?? undefined, files: [uploadPath] },
        token, 60_000,
      );
      const setText = JSON.stringify(setRes?.result ?? setRes ?? {});
      evidence.note(`setInputFiles → ${setText.slice(0, 300)}`);
      const fname = await page.locator("#fname").textContent();
      evidence.note(`fname=${fname}`);
      results.setInputFiles = {
        ok: setRes?.status === "completed" && fname === "chromex-cdp-upload.txt",
        status: setRes?.status,
        fname,
      };
      void fileRef;

      const pass = Object.values(results).every((r) => r.ok === true);
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get"
          : `results=${JSON.stringify(results)}`,
        details: { results },
      };
    } finally {
      await fixture.close();
    }
  },
  { autoAnswer: "allow", gatewayProviders: [], headless: process.env.CHROMEX_ACCEPTANCE_HEADFUL !== "1" },
);
