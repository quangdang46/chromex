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
//   - page.webSocket         → Network webSocket* events (sent+recv frames)
//   - page.route/unroute     → Fetch.enable fulfillRequest + continueRequest
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
    const crossPath = join(uploadDir, "cross.txt");
    writeFileSync(crossPath, "oopif upload");
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

      // --- webSocket: prime the tap BEFORE the socket opens, then the
      // /ws fixture page connects + echoes — frames must be captured ---
      await runner.browserToolCall(
        taskId, "browser.page.webSocket", { urlContains: "/ws" }, token, 60_000,
      );
      await page.goto(fixture.url("/ws"), { waitUntil: "domcontentloaded" });
      await page.waitForFunction(
        () => document.getElementById("wout")?.textContent?.startsWith("echo:"),
        { timeout: 10_000 },
      );
      await sleep(500); // let CDP deliver the frame events
      let wsList = null, wsFrames = null;
      const wsDeadline = Date.now() + 15_000;
      while (Date.now() < wsDeadline && !wsFrames) {
        wsList = await runner.browserToolCall(
          taskId, "browser.page.webSocket", { urlContains: "/ws" }, token, 60_000,
        );
        const socks = wsList?.result?.sockets ?? wsList?.sockets ?? [];
        const hit = socks.find((s) => /\/ws/.test(s.url ?? ""));
        if (hit?.requestId) {
          wsFrames = await runner.browserToolCall(
            taskId, "browser.page.webSocket", { requestId: hit.requestId }, token, 60_000,
          );
          break;
        }
        await sleep(400);
      }
      const wsPayload = wsFrames?.result ?? wsFrames ?? {};
      const wsFrameList = wsPayload?.frames ?? [];
      const wsDirs = wsFrameList.map((f) => `${f.dir}:${f.data}`).join(" | ");
      evidence.note(`webSocket → ${JSON.stringify({ sockets: wsList?.result?.sockets?.length ?? wsList?.sockets?.length, frames: wsFrameList.length, sample: wsDirs.slice(0, 200) })}`);
      results.webSocket = {
        ok:
          wsFrameList.some((f) => f.dir === "sent" && f.data === "hello-agent") &&
          wsFrameList.some((f) => f.dir === "recv" && f.data === "echo:hello-agent"),
        frames: wsFrameList.length,
        snippet: wsDirs.slice(0, 200),
      };

      // --- route: Fetch-domain interception mocks /api/ping, then
      // unroute restores the real response ---
      let routeRes = null, mockedOut = null, unrouteRes = null, realOut = null, abortedOut = null, modifiedOut = null;
      try {
        routeRes = await runner.browserToolCall(
          taskId, "browser.page.route",
          { match: "/api/ping", status: 200, contentType: "application/json", body: '{"v":"mocked"}' },
          token, 60_000,
        );
        await page.goto(fixture.url("/fetch"), { waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          () => document.getElementById("out")?.textContent !== "pending",
          { timeout: 10_000 },
        );
        mockedOut = await page.evaluate(() => document.getElementById("out")?.textContent);
        const routeId = routeRes?.result?.routeId ?? routeRes?.routeId;
        unrouteRes = await runner.browserToolCall(
          taskId, "browser.page.unroute", { routeId }, token, 60_000,
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          () => document.getElementById("out")?.textContent !== "pending",
          { timeout: 10_000 },
        );
        realOut = await page.evaluate(() => document.getElementById("out")?.textContent);
        // abort action: matching requests fail → page's catch fires
        const abortRes = await runner.browserToolCall(
          taskId, "browser.page.route",
          { match: "/api/ping", action: "abort" }, token, 60_000,
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          () => document.getElementById("out")?.textContent !== "pending",
          { timeout: 10_000 },
        );
        abortedOut = await page.evaluate(() => document.getElementById("out")?.textContent);
        await runner.browserToolCall(taskId, "browser.page.unroute", {}, token, 60_000);
        // modify action: rewrite /api/ping → /api/pong2 before it is sent
        await runner.browserToolCall(
          taskId, "browser.page.route",
          { match: "/api/ping", action: "modify", url: "/api/pong2" }, token, 60_000,
        );
        await page.reload({ waitUntil: "domcontentloaded" });
        await page.waitForFunction(
          () => document.getElementById("out")?.textContent !== "pending",
          { timeout: 10_000 },
        );
        modifiedOut = await page.evaluate(() => document.getElementById("out")?.textContent);
        await runner.browserToolCall(taskId, "browser.page.unroute", {}, token, 60_000);
      } catch (e) {
        routeRes = routeRes ?? { rpcError: e?.message };
      }
      evidence.note(`route → mocked=${mockedOut} real=${realOut} aborted=${abortedOut} modified=${modifiedOut}`);
      results.route = {
        ok:
          routeRes?.status === "completed" &&
          mockedOut === "pong:mocked" &&
          unrouteRes?.status === "completed" &&
          realOut === "pong:ok" &&
          abortedOut === "fetch-failed" &&
          modifiedOut === "pong:rerouted",
        mocked: mockedOut,
        real: realOut,
        aborted: abortedOut,
        modified: modifiedOut,
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

      // OOPIF setInputFiles: cross-origin iframe lives in its own
      // debugger target — the pierced tab DOM cannot see it.
      let oopifFout = null;
      if (crossFrame?.frameId) {
        const oof = await runner.browserToolCall(
          taskId, "browser.page.setInputFiles",
          { selector: "#ffile", frameId: crossFrame.frameId, files: [crossPath] },
          token, 60_000,
        ).catch((e) => ({ error: String(e) }));
        const pwFr5 = page.frames().find((f) => f.url().includes("localhost") && f.url().includes("/iframe-child"));
        oopifFout = pwFr5 ? await pwFr5.locator("#fout2").textContent() : null;
        evidence.note(`oopif setInputFiles → ${JSON.stringify(oof).slice(0, 200)} fout2=${oopifFout}`);
      }
      results.oopifSetInputFiles = {
        ok: oopifFout === "files:cross.txt",
        fout2: oopifFout,
      };

      // responseBody sees subframe requests: prime the tap, click the
      // iframe button (fires fetch('/api/frame-hit')), read the body.
      let frameBody = null;
      if (childFrame?.frameId) {
        await runner.browserToolCall(
          taskId, "browser.page.responseBody", { urlContains: "/api/frame-hit" }, token, 60_000,
        );
        await runner.browserToolCall(
          taskId, "browser.page.click",
          { selector: "#fb", frameId: childFrame.frameId },
          token, 60_000,
        );
        const deadline = Date.now() + 15_000;
        while (Date.now() < deadline) {
          const list = await runner.browserToolCall(
            taskId, "browser.page.responseBody", { urlContains: "/api/frame-hit" }, token, 60_000,
          );
          const reqs = list?.result?.requests ?? list?.requests ?? [];
          const hit = reqs.find((r) => r.finished === true);
          if (hit?.requestId) {
            frameBody = await runner.browserToolCall(
              taskId, "browser.page.responseBody", { requestId: hit.requestId }, token, 60_000,
            );
            break;
          }
          await sleep(400);
        }
      }
      const fbPayload = frameBody?.result ?? frameBody ?? {};
      evidence.note(`frame responseBody → ${JSON.stringify(fbPayload).slice(0, 200)}`);
      results.frameResponseBody = {
        ok: fbPayload?.body === '{"ok":true}',
        body: fbPayload?.body,
      };

      // --- pdf: Page.printToPDF → artifact ---
      let pdfRes = null;
      try {
        pdfRes = await runner.browserToolCall(
          taskId, "browser.page.pdf", { landscape: true }, token, 60_000,
        );
      } catch (e) {
        pdfRes = { rpcError: e?.message };
      }
      const pdfPayload = pdfRes?.result ?? pdfRes ?? {};
      evidence.note(`pdf → ${JSON.stringify(pdfPayload).slice(0, 200)}`);
      results.pdf = {
        ok: pdfRes?.status === "completed" && pdfPayload?.mimeType === "application/pdf" && (pdfPayload?.bytes ?? 0) > 100,
        bytes: pdfPayload?.bytes,
        artifactRef: typeof pdfPayload?.artifactRef === "string" ? "present" : pdfPayload?.artifactRef,
      };

      // --- emulate: viewport + dark colorScheme, verified via evaluate ---
      let emu = null, emuCheck = null, emuReset = null;
      try {
        emu = await runner.browserToolCall(
          taskId, "browser.page.emulate",
          { width: 390, height: 844, colorScheme: "dark" }, token, 60_000,
        );
        emuCheck = await runner.browserToolCall(
          taskId, "browser.page.evaluate",
          { expression: "({w: window.innerWidth, dark: matchMedia('(prefers-color-scheme: dark)').matches})" },
          token, 60_000,
        );
        emuReset = await runner.browserToolCall(
          taskId, "browser.page.emulate", { reset: true }, token, 60_000,
        );
      } catch (e) {
        emu = emu ?? { rpcError: e?.message };
      }
      const emuVal = emuCheck?.result?.value ?? emuCheck?.value;
      evidence.note(`emulate → ${JSON.stringify(emu?.result ?? emu).slice(0, 160)} check=${JSON.stringify(emuVal)}`);
      results.emulate = {
        ok: emu?.status === "completed" && emuVal?.w === 390 && emuVal?.dark === true && emuReset?.status === "completed",
        check: emuVal,
        reset: emuReset?.status,
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

      // --- alert dialog: second dialog type through the same handler ---
      let alertRes = null;
      try {
        const asnap = await runner.browserToolCall(taskId, "browser.page.snapshot", {}, token, 60_000);
        const aSnapId = findSnapshotId(asnap);
        await runner.browserToolCall(
          taskId, "browser.page.click",
          { selector: "#alertBtn", snapshotId: aSnapId ?? undefined },
          token, 60_000,
        );
        alertRes = await runner.browserToolCall(
          taskId, "browser.page.dialog", { accept: true, timeoutMs: 8000 }, token, 60_000,
        );
      } catch (e) {
        alertRes = { rpcError: e?.message };
      }
      const alertText = JSON.stringify(alertRes?.result ?? alertRes ?? {});
      const aText = await page.locator("#a").textContent();
      evidence.note(`alert → ${alertText.slice(0, 200)} page=${aText}`);
      results.alertDialog = {
        ok: /"handled"\s*:\s*true/.test(alertText) && aText === "alert-done",
        pageText: aText,
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

      // --- cookies: CDP Network cookie storage incl. HttpOnly ---
      // set → server echo proves the cookie rides real requests; list
      // withholds values; httpOnly is invisible to document.cookie but
      // visible to the tool; includeValues/set/delete/clear are
      // approval-gated (auto-answered "allow" by the runner).
      let ck = {};
      try {
        const ckSet = await runner.browserToolCall(
          taskId, "browser.page.cookies",
          { action: "set", name: "cdpack", value: "cv1" }, token, 60_000,
        );
        const ckEcho = await runner.browserToolCall(
          taskId, "browser.page.evaluate",
          { expression: "fetch('/api/cookie-echo').then(r=>r.json()).then(j=>j.cookie)" },
          token, 60_000,
        );
        const echoVal = String(ckEcho?.result?.value ?? ckEcho?.value ?? "");
        ck.setOk = ckSet?.status === "completed" && echoVal.includes("cdpack=cv1");
        ck.echo = echoVal.slice(0, 120);

        const ckList = await runner.browserToolCall(
          taskId, "browser.page.cookies", { action: "list" }, token, 60_000,
        );
        const ckCookies = ckList?.result?.cookies ?? ckList?.cookies ?? [];
        const ckRow = ckCookies.find((c) => c.name === "cdpack");
        ck.listOk = !!ckRow && ckRow.value === undefined;

        await runner.browserToolCall(
          taskId, "browser.page.cookies",
          { action: "set", name: "cdpho", value: "hv", httpOnly: true }, token, 60_000,
        );
        const docCk = await runner.browserToolCall(
          taskId, "browser.page.evaluate",
          { expression: "document.cookie" }, token, 60_000,
        );
        const docVal = String(docCk?.result?.value ?? docCk?.value ?? "");
        const ckList2 = await runner.browserToolCall(
          taskId, "browser.page.cookies", { action: "list" }, token, 60_000,
        );
        const hoRow = (ckList2?.result?.cookies ?? ckList2?.cookies ?? []).find((c) => c.name === "cdpho");
        ck.httpOnlyOk = !docVal.includes("cdpho") && hoRow?.httpOnly === true;

        const ckVals = await runner.browserToolCall(
          taskId, "browser.page.cookies",
          { action: "list", includeValues: true }, token, 60_000,
        );
        const valRow = (ckVals?.result?.cookies ?? ckVals?.cookies ?? []).find((c) => c.name === "cdpack");
        ck.valuesOk = valRow?.value === "cv1";

        await runner.browserToolCall(
          taskId, "browser.page.cookies",
          { action: "clear", url: fixture.url("/") }, token, 60_000,
        );
        const ckList3 = await runner.browserToolCall(
          taskId, "browser.page.cookies", { action: "list" }, token, 60_000,
        );
        ck.clearOk = (ckList3?.result?.cookies ?? ckList3?.cookies ?? []).length === 0;
      } catch (e) {
        ck.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`cookies → ${JSON.stringify(ck).slice(0, 300)}`);
      results.cookies = {
        ok: ck.setOk === true && ck.listOk === true && ck.httpOnlyOk === true &&
          ck.valuesOk === true && ck.clearOk === true,
        ...ck,
      };

      // --- localStorage/sessionStorage: fixed-shape MAIN-world access ---
      // keys-only list is read; get/values/mutations are approval-gated
      // (auto-answered). In-page DOM check proves real storage writes.
      let ls = {};
      try {
        await runner.browserToolCall(
          taskId, "browser.page.localStorage",
          { action: "set", key: "cdplsk", value: "lsv" }, token, 60_000,
        );
        const lsList = await runner.browserToolCall(
          taskId, "browser.page.localStorage", {}, token, 60_000,
        );
        const lsRes = lsList?.result ?? lsList ?? {};
        ls.keysOk = Array.isArray(lsRes.keys) && lsRes.keys.includes("cdplsk") && lsRes.entries === undefined;
        const lsGet = await runner.browserToolCall(
          taskId, "browser.page.localStorage", { action: "get", key: "cdplsk" }, token, 60_000,
        );
        ls.getOk = (lsGet?.result ?? lsGet ?? {}).value === "lsv";
        const lsDom = await runner.browserToolCall(
          taskId, "browser.page.evaluate",
          { expression: "localStorage.getItem('cdplsk')" }, token, 60_000,
        );
        ls.domOk = String(lsDom?.result?.value ?? lsDom?.value ?? "") === "lsv";
        await runner.browserToolCall(
          taskId, "browser.page.localStorage",
          { area: "session", action: "set", key: "cdpss", value: "1" }, token, 60_000,
        );
        const ssList = await runner.browserToolCall(
          taskId, "browser.page.localStorage", { area: "session" }, token, 60_000,
        );
        ls.sessionOk = ((ssList?.result ?? ssList ?? {}).keys ?? []).includes("cdpss");
        await runner.browserToolCall(
          taskId, "browser.page.localStorage", { action: "clear" }, token, 60_000,
        );
        const lsAfter = await runner.browserToolCall(
          taskId, "browser.page.localStorage", {}, token, 60_000,
        );
        ls.clearOk = !((lsAfter?.result ?? lsAfter ?? {}).keys ?? []).includes("cdplsk");
      } catch (e) {
        ls.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`localStorage → ${JSON.stringify(ls).slice(0, 300)}`);
      results.localStorage = {
        ok: ls.keysOk === true && ls.getOk === true && ls.domOk === true &&
          ls.sessionOk === true && ls.clearOk === true,
        ...ls,
      };

      // --- indexedDB: fixed-shape MAIN-world access (chromexIdbOp) ---
      // put/get/delete are approval-gated (auto-answered); read ops
      // never create a missing database. In-page check proves the
      // extension wrote real IndexedDB, not a parallel store.
      let idb = {};
      try {
        const idbMissing = await runner.browserToolCall(
          taskId, "browser.page.indexedDB",
          { database: "cdp-idb", store: "kv", action: "keys" }, token, 60_000,
        );
        idb.noCreate = (idbMissing?.result ?? idbMissing ?? {}).exists === false;
        const idbCreate = await runner.browserToolCall(
          taskId, "browser.page.indexedDB",
          { database: "cdp-idb", store: "kv", action: "createStore" }, token, 60_000,
        );
        idb.createOk = (idbCreate?.result ?? idbCreate ?? {}).created === true;
        await runner.browserToolCall(
          taskId, "browser.page.indexedDB",
          { database: "cdp-idb", store: "kv", action: "put",
            key: "doc1", value: { title: "CDP Doc", rev: 7 } }, token, 60_000,
        );
        const idbGet = await runner.browserToolCall(
          taskId, "browser.page.indexedDB",
          { database: "cdp-idb", store: "kv", action: "get", key: "doc1" }, token, 60_000,
        );
        const idbVal = (idbGet?.result ?? idbGet ?? {}).value;
        idb.getOk = idbVal?.title === "CDP Doc" && idbVal?.rev === 7;
        const idbKeys = await runner.browserToolCall(
          taskId, "browser.page.indexedDB",
          { database: "cdp-idb", store: "kv", action: "keys" }, token, 60_000,
        );
        idb.keysOk = ((idbKeys?.result ?? idbKeys ?? {}).keys ?? []).includes("doc1");
        const idbDom = await runner.browserToolCall(
          taskId, "browser.page.evaluate",
          { expression: `new Promise((res) => {
            const r = indexedDB.open('cdp-idb');
            r.onsuccess = () => {
              const tx = r.result.transaction('kv').objectStore('kv').get('doc1');
              tx.onsuccess = () => res(tx.result?.title ?? 'missing');
            };
            r.onerror = () => res('open-failed');
          })` }, token, 60_000,
        );
        idb.domOk = String(idbDom?.result?.value ?? idbDom?.value ?? "") === "CDP Doc";
        await runner.browserToolCall(
          taskId, "browser.page.indexedDB",
          { database: "cdp-idb", store: "kv", action: "delete", key: "doc1" }, token, 60_000,
        );
        const idbAfter = await runner.browserToolCall(
          taskId, "browser.page.indexedDB",
          { database: "cdp-idb", store: "kv", action: "get", key: "doc1" }, token, 60_000,
        );
        idb.deleteOk = (idbAfter?.result ?? idbAfter ?? {}).found === false;
      } catch (e) {
        idb.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`indexedDB → ${JSON.stringify(idb).slice(0, 300)}`);
      results.indexedDB = {
        ok: idb.noCreate === true && idb.createOk === true && idb.getOk === true &&
          idb.keysOk === true && idb.domOk === true && idb.deleteOk === true,
        ...idb,
      };

      // --- caches: Cache API via chromexCacheOp MAIN-world helper ---
      // put/match/delete/clear are approval-gated (auto-answered);
      // reads never create a missing cache. In-page proof via evaluate.
      let cc = {};
      try {
        const ccMissing = await runner.browserToolCall(
          taskId, "browser.page.caches",
          { cache: "cdp-cache", action: "listKeys" }, token, 60_000,
        );
        cc.noCreate = (ccMissing?.result ?? ccMissing ?? {}).exists === false;
        const ccPut = await runner.browserToolCall(
          taskId, "browser.page.caches",
          { cache: "cdp-cache", action: "put",
            url: fixture.url("/api/ping"), bodyText: '{"v":"cdpcached"}',
            headers: { "content-type": "application/json" } }, token, 60_000,
        );
        cc.putOk = (ccPut?.result ?? ccPut ?? {}).put === true;
        const ccKeys = await runner.browserToolCall(
          taskId, "browser.page.caches",
          { cache: "cdp-cache", action: "listKeys" }, token, 60_000,
        );
        cc.keysOk = ((ccKeys?.result ?? ccKeys ?? {}).entries ?? [])
          .some((e) => String(e.url).includes("/api/ping"));
        const ccMatch = await runner.browserToolCall(
          taskId, "browser.page.caches",
          { cache: "cdp-cache", action: "match", url: fixture.url("/api/ping") }, token, 60_000,
        );
        const ccBody = (ccMatch?.result ?? ccMatch ?? {}).bodyBase64
          ? Buffer.from((ccMatch?.result ?? ccMatch ?? {}).bodyBase64, "base64").toString("utf8")
          : "";
        cc.matchOk = ccBody === '{"v":"cdpcached"}';
        const ccDom = await runner.browserToolCall(
          taskId, "browser.page.evaluate",
          { expression: `caches.open('cdp-cache').then(c => c.match(${JSON.stringify(fixture.url("/api/ping"))})).then(r => r ? r.text() : 'missing')` },
          token, 60_000,
        );
        cc.domOk = String(ccDom?.result?.value ?? ccDom?.value ?? "").includes('"cdpcached"');
        await runner.browserToolCall(
          taskId, "browser.page.caches",
          { cache: "cdp-cache", action: "clear" }, token, 60_000,
        );
        const ccAfter = await runner.browserToolCall(
          taskId, "browser.page.caches", {}, token, 60_000,
        );
        cc.clearOk = !((ccAfter?.result ?? ccAfter ?? {}).caches ?? []).includes("cdp-cache");
      } catch (e) {
        cc.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`caches → ${JSON.stringify(cc).slice(0, 300)}`);
      results.caches = {
        ok: cc.noCreate === true && cc.putOk === true && cc.keysOk === true &&
          cc.matchOk === true && cc.domOk === true && cc.clearOk === true,
        ...cc,
      };

      // --- serviceWorker: registration list + unregister via chromexSwOp ---
      let sw = {};
      try {
        const swTab = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/sw") }, token, 60_000,
        );
        const swTabId = swTab?.result?.tabId ?? swTab?.result?.openedTabId ?? swTab?.tabId;
        // registration is async — and a fresh registration can appear in
        // getRegistrations() before its worker slot populates
        // (scriptURL:null/state:"none") — poll until it materializes
        let swList;
        for (let i = 0; i < 30; i++) {
          swList = await runner.browserToolCall(
            taskId, "browser.page.serviceWorker", { tabId: swTabId }, token, 60_000,
          );
          const regs = (swList?.result ?? swList ?? {}).registrations ?? [];
          if (regs.some((r) => typeof r?.scriptURL === "string" && r.scriptURL)) break;
          await new Promise((r) => setTimeout(r, 250));
        }
        const swRes = swList?.result ?? swList ?? {};
        const swReg = (swRes.registrations ?? [])[0];
        sw.listOk = String(swReg?.scriptURL ?? "").endsWith("/sw.js") &&
          String(swReg?.scope ?? "").startsWith(fixture.url("/"));
        sw.stateOk = ["active", "waiting", "installing"].includes(swReg?.state);
        const swUpd = await runner.browserToolCall(
          taskId, "browser.page.serviceWorker",
          { tabId: swTabId, action: "update" }, token, 60_000,
        );
        sw.updOk = ((swUpd?.result ?? swUpd ?? {}).count ?? 0) >= 1;
        const swUn = await runner.browserToolCall(
          taskId, "browser.page.serviceWorker",
          { tabId: swTabId, action: "unregister", scope: swReg?.scope }, token, 60_000,
        );
        sw.unregOk = (swUn?.result ?? swUn ?? {}).unregistered === true;
        const swAfter = await runner.browserToolCall(
          taskId, "browser.page.serviceWorker", { tabId: swTabId }, token, 60_000,
        );
        sw.emptyOk = ((swAfter?.result ?? swAfter ?? {}).count ?? -1) === 0;
        await runner.browserToolCall(
          taskId, "browser.tab.close", { tabId: swTabId }, token, 60_000,
        );
      } catch (e) {
        sw.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`serviceWorker → ${JSON.stringify(sw).slice(0, 300)}`);
      results.serviceWorker = {
        ok: sw.listOk === true && sw.stateOk === true && sw.updOk === true && sw.unregOk === true && sw.emptyOk === true,
        ...sw,
      };

      // --- cdp: raw CDP passthrough via chrome.debugger ---
      let cdp = {};
      try {
        const cdpTab = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/keys") }, token, 60_000,
        );
        const cdpTabId = cdpTab?.result?.tabId ?? cdpTab?.result?.openedTabId ?? cdpTab?.tabId;
        const cdpTreeRes = await runner.browserToolCall(
          taskId, "browser.page.cdp",
          { tabId: cdpTabId, method: "Page.getFrameTree" }, token, 60_000,
        );
        const cdpTree = cdpTreeRes?.result ?? cdpTreeRes ?? {};
        const cdpFrameUrl = cdpTree?.result?.frameTree?.frame?.url ?? "";
        cdp.treeOk = cdpTree?.ok === true && cdpFrameUrl.startsWith(fixture.url("/"));
        const cdpBadRes = await runner.browserToolCall(
          taskId, "browser.page.cdp",
          { tabId: cdpTabId, method: "Nope.nothing" }, token, 60_000,
        );
        const cdpBad = cdpBadRes?.result ?? cdpBadRes ?? {};
        cdp.errOk = cdpBad?.ok === false && typeof cdpBad?.error?.message === "string";
        await runner.browserToolCall(
          taskId, "browser.tab.close", { tabId: cdpTabId }, token, 60_000,
        );
        // frame-scoped CDP: the cross-origin iframe is an OOPIF with its
        // own debugger target — Runtime.evaluate must run INSIDE it.
        const cdpFrameTab = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/iframe-parent") }, token, 60_000,
        );
        const cdpFrameTabId = cdpFrameTab?.result?.tabId ?? cdpFrameTab?.result?.openedTabId ?? cdpFrameTab?.tabId;
        const cdpFramesRes = await runner.browserToolCall(
          taskId, "browser.page.get", { tabId: cdpFrameTabId }, token, 60_000,
        );
        const cdpFrames = cdpFramesRes?.result?.frames ?? cdpFramesRes?.frames ?? [];
        const cdpCross = cdpFrames.find(
          (f) => String(f.url ?? "").includes("localhost") && String(f.url ?? "").includes("/iframe-child"),
        );
        const cdpSame = cdpFrames.find(
          (f) => String(f.url ?? "").includes("127.0.0.1") && String(f.url ?? "").includes("/iframe-child"),
        );
        if (cdpCross?.frameId) {
          const cdpFrRes = await runner.browserToolCall(
            taskId, "browser.page.cdp",
            {
              tabId: cdpFrameTabId, frameId: cdpCross.frameId,
              method: "Runtime.evaluate",
              params: { expression: "location.href", returnByValue: true },
            },
            token, 60_000,
          );
          const cdpFr = cdpFrRes?.result ?? cdpFrRes ?? {};
          const cdpFrVal = cdpFr?.result?.result?.value ?? "";
          cdp.frameOk = cdpFr?.ok === true
            && cdpFr?.resolvedFrameId === cdpCross.frameId
            && String(cdpFrVal).includes("localhost")
            && String(cdpFrVal).includes("/iframe-child");
          cdp.frameVal = String(cdpFrVal).slice(0, 120);
        }
        // same-process frame → honest proto.unsupported (shares tab session)
        if (cdpSame?.frameId) {
          const cdpSameRes = await runner.browserToolCall(
            taskId, "browser.page.cdp",
            { tabId: cdpFrameTabId, frameId: cdpSame.frameId, method: "Page.getFrameTree" },
            token, 60_000,
          );
          const cdpSameErr = cdpSameRes?.error ?? {};
          cdp.sameUnsupported = cdpSameRes?.status === "failed" && cdpSameErr.code === "proto.unsupported";
        }
        await runner.browserToolCall(
          taskId, "browser.tab.close", { tabId: cdpFrameTabId }, token, 60_000,
        );
      } catch (e) {
        cdp.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`cdp → ${JSON.stringify(cdp).slice(0, 300)}`);
      results.cdp = {
        ok: cdp.treeOk === true && cdp.errOk === true && cdp.frameOk === true && cdp.sameUnsupported === true,
        ...cdp,
      };

      // --- tabGroups: real chrome.tabs.group/tabGroups on the extension ---
      let tg = {};
      try {
        const tgA = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/keys"), active: false }, token, 60_000,
        );
        const tgB = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/form"), active: false }, token, 60_000,
        );
        const tgAId = tgA?.result?.tabId ?? tgA?.result?.openedTabId ?? tgA?.tabId;
        const tgBId = tgB?.result?.tabId ?? tgB?.result?.openedTabId ?? tgB?.tabId;
        const tgCreate = await runner.browserToolCall(
          taskId, "browser.tabGroups",
          { action: "create", tabIds: [tgAId, tgBId], title: "Agent Group", color: "blue" },
          token, 60_000,
        );
        const tgCreated = tgCreate?.result ?? tgCreate ?? {};
        tg.createOk = typeof tgCreated?.groupId === "number" && tgCreated?.title === "Agent Group";
        const tgGid = tgCreated?.groupId;
        // list must surface the group with exactly our two tabs
        const tgListRes = await runner.browserToolCall(
          taskId, "browser.tabGroups", { action: "list" }, token, 60_000,
        );
        const tgGroups = (tgListRes?.result ?? tgListRes ?? {}).groups ?? [];
        const tgFound = tgGroups.find((g) => g?.id === tgGid);
        tg.listOk = tgFound?.title === "Agent Group" && tgFound?.color === "blue" &&
          (tgFound?.tabIds ?? []).length === 2;
        // update collapsed via chrome.tabGroups.update
        await runner.browserToolCall(
          taskId, "browser.tabGroups", { action: "update", groupId: tgGid, collapsed: true },
          token, 60_000,
        );
        const tgList2Res = await runner.browserToolCall(
          taskId, "browser.tabGroups", { action: "list" }, token, 60_000,
        );
        const tgFound2 = ((tgList2Res?.result ?? tgList2Res ?? {}).groups ?? [])
          .find((g) => g?.id === tgGid);
        tg.updateOk = tgFound2?.collapsed === true;
        // ungroup dissolves membership — empty groups vanish from list
        await runner.browserToolCall(
          taskId, "browser.tabGroups", { action: "ungroup", tabIds: [tgAId, tgBId] },
          token, 60_000,
        );
        const tgList3Res = await runner.browserToolCall(
          taskId, "browser.tabGroups", { action: "list" }, token, 60_000,
        );
        const tgAfter = ((tgList3Res?.result ?? tgList3Res ?? {}).groups ?? [])
          .find((g) => g?.id === tgGid);
        tg.ungroupOk = tgAfter === undefined || (tgAfter?.tabIds ?? []).length === 0;
        // bogus color refused host-side
        const tgBad = await runner.browserToolCall(
          taskId, "browser.tabGroups",
          { action: "create", tabIds: [tgAId], color: "chartreuse" }, token, 60_000,
        );
        tg.badColorOk = (tgBad?.error?.code ?? "") === "proto.invalid";
        await runner.browserToolCall(
          taskId, "browser.tab.close", { tabId: tgAId }, token, 60_000,
        );
        await runner.browserToolCall(
          taskId, "browser.tab.close", { tabId: tgBId }, token, 60_000,
        );
      } catch (e) {
        tg.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`tabGroups → ${JSON.stringify(tg).slice(0, 300)}`);
      results.tabGroups = {
        ok: tg.createOk === true && tg.listOk === true && tg.updateOk === true &&
          tg.ungroupOk === true && tg.badColorOk === true,
        ...tg,
      };

      // --- siteSettings: optional "contentSettings" permission — ungranted → honest unsupported ---
      // Same pattern as bookmarks/history: the acceptance profile never
      // grants it → proto.unsupported, approval gate fires first for
      // mutations (get is a read and passes straight through).
      let ss = {};
      const ssRes = await runner.browserToolCall(
        taskId, "browser.siteSettings",
        { action: "set", contentType: "notifications", origin: new URL(fixture.url("/")).origin, setting: "allow" },
        token, 60_000,
      );
      const ssErr = ssRes?.error ?? {};
      ss.setStatus = ssRes?.status;
      ss.setCode = ssErr.code;
      ss.setUnsupportedOk = ssRes?.status === "failed" && ssErr.code === "proto.unsupported";
      ss.setMsg = String(ssErr.message ?? "").slice(0, 160);
      const ssGetRes = await runner.browserToolCall(
        taskId, "browser.siteSettings",
        { contentType: "notifications", origin: new URL(fixture.url("/")).origin },
        token, 60_000,
      );
      const ssGetErr = ssGetRes?.error ?? {};
      ss.getUnsupportedOk = ssGetRes?.status === "failed" && ssGetErr.code === "proto.unsupported";
      evidence.note(`siteSettings → ${JSON.stringify(ss).slice(0, 300)}`);
      results.siteSettings = {
        ok: ss.setUnsupportedOk === true && ss.getUnsupportedOk === true,
        ...ss,
      };

      // --- bookmarks: optional permission — ungranted → honest unsupported ---
      // The acceptance profile never grants "bookmarks", so the tool must
      // fail proto.unsupported rather than fake an empty jar.
      let bm = {};
      const bmRes = await runner.browserToolCall(
        taskId, "browser.bookmarks", { action: "list" }, token, 60_000,
      );
      const bmErr = bmRes?.error ?? {};
      bm.status = bmRes?.status;
      bm.code = bmErr.code;
      bm.unsupportedOk = bmRes?.status === "failed" && bmErr.code === "proto.unsupported";
      bm.msg = String(bmErr.message ?? "").slice(0, 160);
      evidence.note(`bookmarks → ${JSON.stringify(bm).slice(0, 300)}`);
      results.bookmarks = { ok: bm.unsupportedOk === true, ...bm };

      // --- history.delete: optional permission — ungranted → honest unsupported ---
      // Same "history" optional permission as history.search; the
      // acceptance profile never grants it → proto.unsupported, and the
      // approval gate must fire first (deletion is never task-eligible).
      let hd = {};
      const hdRes = await runner.browserToolCall(
        taskId, "browser.history.delete", { url: fixture.url("/keys") }, token, 60_000,
      );
      const hdErr = hdRes?.error ?? {};
      hd.status = hdRes?.status;
      hd.code = hdErr.code;
      hd.unsupportedOk = hdRes?.status === "failed" && hdErr.code === "proto.unsupported";
      hd.msg = String(hdErr.message ?? "").slice(0, 160);
      evidence.note(`history.delete → ${JSON.stringify(hd).slice(0, 300)}`);
      results.historyDelete = { ok: hd.unsupportedOk === true, ...hd };

      // --- browsingData.clear: optional permission — ungranted → honest unsupported ---
      // Same pattern: approval gate fires (never task-eligible), then the
      // "browsingData" optional permission is absent → proto.unsupported.
      let bd = {};
      const bdRes = await runner.browserToolCall(
        taskId, "browser.browsingData.clear", { dataTypes: ["cookies", "history"] }, token, 60_000,
      );
      const bdErr = bdRes?.error ?? {};
      bd.status = bdRes?.status;
      bd.code = bdErr.code;
      bd.unsupportedOk = bdRes?.status === "failed" && bdErr.code === "proto.unsupported";
      bd.msg = String(bdErr.message ?? "").slice(0, 160);
      evidence.note(`browsingData.clear → ${JSON.stringify(bd).slice(0, 300)}`);
      results.browsingDataClear = { ok: bd.unsupportedOk === true, ...bd };

      const pass = Object.values(results).every((r) => r.ok === true);
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "CDP tier end-to-end on real extension: aria AX tree, trusted click+press+type+fill+hover+drag (isTrusted=true, real :hover CSS), JS dialog accept, setInputFiles by path, responseBody tap+get, cookies + web storage + indexedDB + caches + serviceWorker + raw CDP + browsingData.clear boundary"
          : `results=${JSON.stringify(results)}`,
        details: { results },
      };
    } finally {
      await fixture.close();
    }
  },
  { autoAnswer: "allow", gatewayProviders: [], headless: process.env.CHROMEX_ACCEPTANCE_HEADFUL !== "1" },
);
