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

      // --- trusted scroll: real wheel events vs programmatic scrollBy ---
      // /wheel-probe counts wheel events + isTrusted — synthetic scrollBy
      // fires NO wheel event; CDP mouseWheel must produce trusted:true.
      await page.goto(fixture.url("/wheel-probe"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();
      const untrustedScroll = await runner.browserToolCall(
        taskId, "browser.page.scroll",
        { direction: "down", amountPx: 300 }, token, 60_000,
      );
      await sleep(200);
      const wheelAfterDom = await page.locator("#r").textContent();
      const scrollYDom = await page.evaluate(() => window.scrollY);
      const trustedScrollRes = await runner.browserToolCall(
        taskId, "browser.page.scroll",
        { direction: "down", amountPx: 300, trusted: true }, token, 60_000,
      );
      await sleep(300);
      const wheelAfterTrusted = await page.locator("#r").textContent();
      const scrollYTrusted = await page.evaluate(() => window.scrollY);
      const scrollBadTarget = await runner.browserToolCall(
        taskId, "browser.page.scroll",
        { selector: "#r", trusted: true }, token, 60_000,
      );
      evidence.note(`scroll: dom=${wheelAfterDom} y=${scrollYDom} | trusted=${wheelAfterTrusted} y=${scrollYTrusted} | badTarget=${scrollBadTarget?.status}`);
      results.trustedScroll = {
        ok:
          untrustedScroll?.status === "completed" &&
          wheelAfterDom === "count:0 trusted:none delta:0" &&
          scrollYDom > 0 &&
          trustedScrollRes?.status === "completed" &&
          /trusted:true/.test(wheelAfterTrusted ?? "") &&
          /count:[1-9]/.test(wheelAfterTrusted ?? "") &&
          scrollYTrusted > scrollYDom &&
          scrollBadTarget?.status === "failed",
        afterDom: wheelAfterDom,
        afterTrusted: wheelAfterTrusted,
        scrollYDom,
        scrollYTrusted,
        badTargetStatus: scrollBadTarget?.status,
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
      // page.get liveness probe: real readyState/visibilityState plus
      // chrome.tabs fields (status/discarded/autoDiscardable/muted).
      const getPayload = getFrames?.result ?? getFrames ?? {};
      results.pageGetLiveness = {
        ok:
          typeof getPayload?.page?.readyState === "string" &&
          typeof getPayload?.page?.visibilityState === "string" &&
          typeof getPayload?.status === "string",
        page: getPayload?.page,
        status: getPayload?.status,
        discarded: getPayload?.discarded,
        autoDiscardable: getPayload?.autoDiscardable,
        muted: getPayload?.muted,
      };
      evidence.note(`page.get liveness → ${JSON.stringify(results.pageGetLiveness)}`);
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

      // --- mhtml: Page.captureSnapshot → artifact ---
      let mhtmlRes = null;
      try {
        mhtmlRes = await runner.browserToolCall(
          taskId, "browser.page.mhtml", {}, token, 60_000,
        );
      } catch (e) {
        mhtmlRes = { rpcError: e?.message };
      }
      const mhtmlPayload = mhtmlRes?.result ?? mhtmlRes ?? {};
      evidence.note(`mhtml → ${JSON.stringify(mhtmlPayload).slice(0, 200)}`);
      results.mhtml = {
        ok: mhtmlRes?.status === "completed" && mhtmlPayload?.mimeType === "multipart/related" && (mhtmlPayload?.bytes ?? 0) > 200,
        bytes: mhtmlPayload?.bytes,
        artifactRef: typeof mhtmlPayload?.artifactRef === "string" ? "present" : mhtmlPayload?.artifactRef,
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
        // frame discovery lags navigation — poll until both iframes
        // register in webNavigation.getAllFrames (OOPIF commits last).
        let cdpFrames = [];
        let cdpCross = null;
        let cdpSame = null;
        for (let i = 0; i < 20; i++) {
          const cdpFramesRes = await runner.browserToolCall(
            taskId, "browser.page.get", { tabId: cdpFrameTabId }, token, 60_000,
          );
          cdpFrames = cdpFramesRes?.result?.frames ?? cdpFramesRes?.frames ?? [];
          cdpCross = cdpFrames.find(
            (f) => String(f.url ?? "").includes("localhost") && String(f.url ?? "").includes("/iframe-child"),
          );
          cdpSame = cdpFrames.find(
            (f) => String(f.url ?? "").includes("127.0.0.1") && String(f.url ?? "").includes("/iframe-child"),
          );
          if (cdpCross?.frameId && cdpSame?.frameId) break;
          await sleep(250);
        }
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

      // --- page.coverage: Profiler domain availability is build-dependent ---
      // Older Chrome-for-Testing builds filter Profiler.* out of
      // chrome.debugger sessions (-32601 → proto.unsupported). Newer
      // builds expose it — when start succeeds we verify REAL coverage
      // data instead of asserting the boundary.
      let cv = {};
      try {
        const cvTab = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/keys"), active: false }, token, 60_000,
        );
        const cvId = cvTab?.result?.tabId ?? cvTab?.result?.openedTabId ?? cvTab?.tabId;
        const cvCall = (tool, args) => runner.browserToolCall(taskId, tool, args, token, 60_000);
        const cvSt0 = await cvCall("browser.page.coverage", { tabId: cvId, action: "status" });
        cv.statusIdleOk = (cvSt0?.result ?? cvSt0 ?? {}).running === false;
        const cvBadStop = await cvCall("browser.page.coverage", { tabId: cvId, action: "stop" });
        cv.stopRefusedOk = (cvBadStop?.error?.code ?? "") === "proto.invalid";
        const cvStart = await cvCall("browser.page.coverage", { tabId: cvId, action: "start" });
        cv.startCode = cvStart?.error?.code ?? "";
        cv.startOk = (cvStart?.result ?? cvStart ?? {}).started === true;
        cv.startUnsupportedOk = cv.startCode === "proto.unsupported" &&
          /Profiler|chrome\.debugger/.test(cvStart?.error?.message ?? "");
        if (cv.startOk) {
          // Profiler is exposed on this build — verify real data:
          // navigate a scripted page, evaluate, stop → scripts+functions.
          await cvCall("browser.page.navigate", { tabId: cvId, url: fixture.url("/form") });
          await cvCall("browser.page.evaluate", { tabId: cvId, expression: "document.title" });
          const cvStop = await cvCall("browser.page.coverage", { tabId: cvId, action: "stop" });
          const cov = (cvStop?.result ?? cvStop ?? {});
          const covScripts = Array.isArray(cov.scripts) ? cov.scripts.length : (cov.scripts ?? 0);
          cv.realCoverageOk = covScripts > 0;
          const cvSt1 = await cvCall("browser.page.coverage", { tabId: cvId, action: "status" });
          cv.statusRunOk = (cvSt1?.result ?? cvSt1 ?? {}).running === false;
          cv.scripts = cov.scripts;
        } else {
          const cvSt1 = await cvCall("browser.page.coverage", { tabId: cvId, action: "status" });
          cv.statusRunOk = (cvSt1?.result ?? cvSt1 ?? {}).running === false;
        }
        await cvCall("browser.tab.close", { tabId: cvId });
      } catch (e) {
        cv.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`coverage → ${JSON.stringify(cv).slice(0, 300)}`);
      results.coverage = {
        ok: cv.statusIdleOk === true && cv.stopRefusedOk === true &&
          (cv.startUnsupportedOk === true || (cv.startOk === true && cv.realCoverageOk === true && cv.statusRunOk === true)),
        ...cv,
      };

      // --- page.metrics: Performance domain — same build-dependent
      // chrome.debugger filtering as Profiler. When start succeeds we
      // verify REAL counters (JSHeapUsedSize, LayoutCount, Documents).
      let mt = {};
      try {
        const mtTab = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/keys"), active: false }, token, 60_000,
        );
        const mtId = mtTab?.result?.tabId ?? mtTab?.result?.openedTabId ?? mtTab?.tabId;
        const mtCall = (tool, args) => runner.browserToolCall(taskId, tool, args, token, 60_000);
        const mtSt0 = await mtCall("browser.page.metrics", { tabId: mtId, action: "status" });
        mt.statusIdleOk = (mtSt0?.result ?? mtSt0 ?? {}).running === false;
        const mtBadRead = await mtCall("browser.page.metrics", { tabId: mtId, action: "read" });
        mt.readRefusedOk = (mtBadRead?.error?.code ?? "") === "proto.invalid";
        const mtStart = await mtCall("browser.page.metrics", { tabId: mtId, action: "start" });
        mt.startCode = mtStart?.error?.code ?? "";
        mt.startOk = (mtStart?.result ?? mtStart ?? {}).started === true;
        mt.startUnsupportedOk = mt.startCode === "proto.unsupported" &&
          /Performance|chrome\.debugger/.test(mtStart?.error?.message ?? "");
        if (mt.startOk) {
          await mtCall("browser.page.navigate", { tabId: mtId, url: fixture.url("/form") });
          const mtRead = await mtCall("browser.page.metrics", { tabId: mtId, action: "read" });
          const mm = (mtRead?.result ?? mtRead ?? {}).metrics ?? {};
          mt.realMetricsOk =
            typeof mm.JSHeapUsedSize === "number" && mm.JSHeapUsedSize > 0 &&
            typeof mm.LayoutCount === "number" && typeof mm.Documents === "number";
          mt.sample = { heap: mm.JSHeapUsedSize, layouts: mm.LayoutCount, docs: mm.Documents };
          const mtStop = await mtCall("browser.page.metrics", { tabId: mtId, action: "stop" });
          mt.stopOk = (mtStop?.result ?? mtStop ?? {}).stopped === true;
          const mtSt1 = await mtCall("browser.page.metrics", { tabId: mtId, action: "status" });
          mt.statusRunOk = (mtSt1?.result ?? mtSt1 ?? {}).running === false;
        } else {
          const mtSt1 = await mtCall("browser.page.metrics", { tabId: mtId, action: "status" });
          mt.statusRunOk = (mtSt1?.result ?? mtSt1 ?? {}).running === false;
        }
        await mtCall("browser.tab.close", { tabId: mtId });
      } catch (e) {
        mt.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`metrics → ${JSON.stringify(mt).slice(0, 300)}`);
      results.pageMetrics = {
        ok: mt.statusIdleOk === true && mt.readRefusedOk === true &&
          (mt.startUnsupportedOk === true || (mt.startOk === true && mt.realMetricsOk === true && mt.stopOk === true && mt.statusRunOk === true)),
        ...mt,
      };

      // --- page.screencast: real CDP frame capture → per-frame
      // artifacts. Same build-dependent domain exposure as coverage —
      // start either works (frames+artifactRefs verified) or reports
      // proto.unsupported honestly. ---
      let sc = {};
      try {
        const scTab = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/keys"), active: false }, token, 60_000,
        );
        const scId = scTab?.result?.tabId ?? scTab?.result?.openedTabId ?? scTab?.tabId;
        const scCall = (tool, args) => runner.browserToolCall(taskId, tool, args, token, 90_000);
        const scSt0 = await scCall("browser.page.screencast", { tabId: scId, action: "status" });
        sc.statusIdleOk = (scSt0?.result ?? scSt0 ?? {}).running === false;
        const scBad = await scCall("browser.page.screencast", { tabId: scId, action: "stop" });
        sc.stopRefusedOk = (scBad?.error?.code ?? "") === "proto.invalid";
        const scStart = await scCall("browser.page.screencast", { tabId: scId, action: "start", maxFrames: 30, maxWidth: 640 });
        sc.startCode = scStart?.error?.code ?? "";
        sc.startOk = (scStart?.result ?? scStart ?? {}).started === true;
        sc.startUnsupportedOk = sc.startCode === "proto.unsupported" &&
          /Screencast|chrome\.debugger|artifact/.test(scStart?.error?.message ?? "");
        if (sc.startOk) {
          // continuous repaint so compositor frames flow
          await scCall("browser.page.evaluate", {
            tabId: scId,
            expression: `window.__sc = setInterval(() => { document.body.style.background = \`hsl(\${Math.random()*360},60%,80%)\`; }, 30); "animating"`,
          });
          await new Promise((r) => setTimeout(r, 700));
          const scStatus = await scCall("browser.page.screencast", { tabId: scId, action: "status" });
          sc.statusRunOk = (scStatus?.result ?? scStatus ?? {}).running === true;
          const scStop = await scCall("browser.page.screencast", { tabId: scId, action: "stop" });
          const sres = scStop?.result ?? scStop ?? {};
          sc.stopOk = sres.stopped === true;
          sc.realFramesOk = typeof sres.frames === "number" && sres.frames > 0 &&
            Array.isArray(sres.artifactRefs) && sres.artifactRefs.length > 0 &&
            sres.artifactRefs.every((a) => typeof a.artifactRef === "string" && a.artifactRef.startsWith("artifact:"));
          sc.sample = { frames: sres.frames, refs: sres.artifactRefs?.length, dur: sres.durationMs };
          await scCall("browser.page.evaluate", { tabId: scId, expression: "clearInterval(window.__sc); 'stopped'" });
        } else {
          const scSt1 = await scCall("browser.page.screencast", { tabId: scId, action: "status" });
          sc.statusRunOk = (scSt1?.result ?? scSt1 ?? {}).running === false;
        }
        await scCall("browser.tab.close", { tabId: scId });
      } catch (e) {
        sc.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`screencast → ${JSON.stringify(sc).slice(0, 300)}`);
      results.pageScreencast = {
        ok: sc.statusIdleOk === true && sc.stopRefusedOk === true &&
          (sc.startUnsupportedOk === true || (sc.startOk === true && sc.statusRunOk === true && sc.stopOk === true && sc.realFramesOk === true)),
        ...sc,
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

      // --- tab.update index: real chrome.tabs.move reorder on the extension ---
      let mv = {};
      try {
        const mvA = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/keys"), active: false }, token, 60_000,
        );
        const mvB = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/form"), active: false }, token, 60_000,
        );
        const mvAId = mvA?.result?.tabId ?? mvA?.result?.openedTabId ?? mvA?.tabId;
        const mvBId = mvB?.result?.tabId ?? mvB?.result?.openedTabId ?? mvB?.tabId;
        // fresh tabs lag in tabScope registration — tabs.list filters
        // foreignTabIds, so a just-created tab can be invisible for a
        // few ms. Poll until both appear with a real strip index.
        const idxOf = async (tid) => {
          for (let i = 0; i < 40; i++) {
            const l = await runner.browserToolCall(
              taskId, "browser.tabs.list", {}, token, 60_000,
            );
            const tabs = (l?.result ?? l ?? {}).tabs ?? [];
            const idx = tabs.find((t) => (t.id ?? t.tabId) === tid)?.index;
            if (typeof idx === "number") return idx;
            await new Promise((r) => setTimeout(r, 100));
          }
          return undefined;
        };
        const beforeA = await idxOf(mvAId);
        const beforeB = await idxOf(mvBId);
        // strip order is not guaranteed by creation order — pick the
        // later tab as the mover and the earlier one's index as target
        const first = beforeA <= beforeB ? { id: mvAId, idx: beforeA } : { id: mvBId, idx: beforeB };
        const second = beforeA <= beforeB ? { id: mvBId, idx: beforeB } : { id: mvAId, idx: beforeA };
        mv.listOk = typeof first.idx === "number" && typeof second.idx === "number";
        // move the later tab onto the earlier one's position — the
        // earlier tab must shift by exactly one slot
        await runner.browserToolCall(
          taskId, "browser.tab.update", { tabId: second.id, index: first.idx }, token, 60_000,
        );
        const afterFirst = await idxOf(first.id);
        const afterSecond = await idxOf(second.id);
        mv.moveOk = afterSecond === first.idx &&
          typeof afterFirst === "number" && Math.abs(afterFirst - first.idx) === 1;
        // bogus index refused host-side
        const mvBad = await runner.browserToolCall(
          taskId, "browser.tab.update", { tabId: second.id, index: -5 }, token, 60_000,
        );
        mv.badIndexOk = (mvBad?.error?.code ?? "") === "proto.invalid";
        // autoDiscardable:false protects the tab — verify it lands in
        // tabs.list (chrome.tabs.update real field, not an echo)
        await runner.browserToolCall(
          taskId, "browser.tab.update", { tabId: second.id, autoDiscardable: false }, token, 60_000,
        );
        const adList = await runner.browserToolCall(taskId, "browser.tabs.list", {}, token, 60_000);
        const adTabs = (adList?.result ?? adList ?? {}).tabs ?? [];
        const adTab = adTabs.find((t) => (t.id ?? t.tabId) === second.id);
        mv.autoDiscardableOk = adTab?.autoDiscardable === false;
        // frozen → CDP Page.setWebLifecycleState via chrome.debugger.
        // WICG semantics: freeze only halts HIDDEN/occluded pages — a
        // visible page ignores it. Headless Chrome may keep inactive
        // tabs "visible", so we probe visibilityState and only require
        // timer-halt when the tab is genuinely hidden; the command
        // itself + page survival + resume must always work.
        const frzTab = await runner.browserToolCall(
          taskId, "browser.page.navigate", { url: fixture.url("/keys"), tabId: second.id }, token, 60_000,
        ).catch(() => null);
        // Read state via page.cdp Runtime.evaluate — the content-script
        // page.evaluate path goes through the page's (possibly frozen)
        // event loop, while CDP evaluate is a direct protocol call.
        const ev = async (expr) => {
          const r = await runner.browserToolCall(
            taskId, "browser.page.cdp",
            { tabId: second.id, method: "Runtime.evaluate", params: { expression: expr, returnByValue: true } },
            token, 60_000,
          ).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }));
          const res = r?.result ?? r ?? {};
          return res?.result?.result?.value ?? res?.result?.value ?? res?.value;
        };
        await ev("window.__fz = 0; setInterval(() => window.__fz++, 50); 'armed'");
        mv.visibility = await ev("document.visibilityState");
        const frzRes = await runner.browserToolCall(
          taskId, "browser.tab.update", { tabId: second.id, frozen: true }, token, 60_000,
        );
        mv.freezeOk = (frzRes?.result?.frozen ?? frzRes?.frozen) === true;
        await new Promise((r) => setTimeout(r, 200));
        const fz1 = await ev("window.__fz");
        await new Promise((r) => setTimeout(r, 200));
        const fz2 = await ev("window.__fz");
        mv.freezeHalted = typeof fz1 === "number" && fz1 === fz2;
        // page must still evaluate while "frozen" (not unloaded/crashed)
        mv.freezeAliveOk = typeof fz1 === "number" || typeof fz2 === "number";
        const actRes = await runner.browserToolCall(
          taskId, "browser.tab.update", { tabId: second.id, frozen: false }, token, 60_000,
        );
        mv.unfreezeOk = (actRes?.result?.frozen ?? actRes?.frozen) === false;
        await new Promise((r) => setTimeout(r, 300));
        const fz3 = await ev("window.__fz");
        mv.resumeOk = typeof fz3 === "number" && (fz2 === undefined || fz3 >= fz2);
        // hidden+frozen must halt; visible+frozen may legitimately no-op
        mv.freezeEffectiveOk = mv.visibility !== "hidden" || mv.freezeHalted === true;
        await runner.browserToolCall(
          taskId, "browser.tab.close", { tabId: mvAId }, token, 60_000,
        );
        await runner.browserToolCall(
          taskId, "browser.tab.close", { tabId: mvBId }, token, 60_000,
        );
      } catch (e) {
        mv.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`tabMove → ${JSON.stringify(mv).slice(0, 300)}`);
      results.tabMove = {
        ok: mv.listOk === true && mv.moveOk === true && mv.badIndexOk === true && mv.autoDiscardableOk === true
          && mv.freezeOk === true && mv.freezeAliveOk === true && mv.unfreezeOk === true && mv.resumeOk === true
          && mv.freezeEffectiveOk === true,
        ...mv,
      };

      // --- tab.highlight: chrome.tabs.highlight selects the tab in its
      // window's strip — verify via tabs.list highlighted round-trip.
      // Headless note: strip selection coincides with activation there
      // (active flips true — verified CfT 158); headed Chrome selects
      // without activating. We assert the highlight itself, record the
      // active side-effect honestly. ---
      const hl = {};
      const hlCreate = await runner.browserToolCall(
        taskId, "browser.tab.create", { url: fixture.url("/keys"), active: false }, token, 60_000,
      );
      const hlTabId = (hlCreate?.result ?? hlCreate ?? {}).openedTabId ??
        (hlCreate?.result ?? hlCreate ?? {}).tabId;
      hl.createOk = typeof hlTabId === "number";
      if (hl.createOk) {
        const hlRes = await runner.browserToolCall(
          taskId, "browser.tab.highlight", { tabId: hlTabId }, token, 60_000,
        );
        hl.callOk = (hlRes?.result ?? hlRes ?? {}).highlighted === hlTabId;
        await sleep(300);
        const hlList = await runner.browserToolCall(taskId, "browser.tabs.list", {}, token, 30_000);
        const hlTabs = (hlList?.result ?? hlList ?? {}).tabs ?? [];
        const hlTab = hlTabs.find((t) => t.id === hlTabId);
        hl.highlightedOk = hlTab?.highlighted === true;
        hl.activeAfter = hlTab?.active; // headless: expected true (selection==activation)
        await runner.browserToolCall(
          taskId, "browser.tab.close", { tabId: hlTabId }, token, 60_000,
        ).catch(() => null);
      } else {
        hl.callOk = hl.highlightedOk = false;
      }
      evidence.note(`tab.highlight → ${JSON.stringify(hl).slice(0, 300)}`);
      results.tabHighlight = {
        ok: hl.createOk === true && hl.callOk === true && hl.highlightedOk === true,
        ...hl,
      };

      // --- tab.update windowId: cross-window move (chrome.tabs.move
      // {windowId}) — relocate a task tab into another window, verify
      // via tabs.list, move back, and prove the headless last-tab-out
      // guard refuses window teardown ---
      const mw = {};
      try {
        const wc = await runner.browserToolCall(
          taskId, "browser.windows.create", { url: fixture.url("/keys"), focused: false }, token, 60_000,
        );
        const wres = wc?.result ?? wc ?? {};
        const w2 = wres.windowId ?? wres.id;
        const t1 = wres.openedTabId ?? wres.tabId ?? wres.tabs?.[0]?.id;
        mw.createOk = typeof w2 === "number" && typeof t1 === "number";
        // sibling in W2 so moving T1 out cannot tear the window down
        const sib = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/"), windowId: w2, active: false }, token, 60_000,
        );
        const t2 = sib?.result?.openedTabId ?? sib?.result?.tabId ?? sib?.openedTabId ?? sib?.tabId;
        mw.siblingOk = typeof t2 === "number";
        // target = the main task window (any scoped tab in a different window)
        const tl = await runner.browserToolCall(taskId, "browser.tabs.list", {}, token, 30_000);
        const tTabs = (tl?.result ?? tl ?? {}).tabs ?? [];
        const w1 = tTabs.find((t) => t.windowId !== w2)?.windowId;
        mw.targetOk = typeof w1 === "number" && w1 !== w2;
        if (mw.createOk && mw.siblingOk && mw.targetOk) {
          // windowId alone → end of target strip
          const mv1 = await runner.browserToolCall(
            taskId, "browser.tab.update", { tabId: t1, windowId: w1 }, token, 60_000,
          );
          mw.callOk = (mv1?.result ?? mv1 ?? {}).windowId === w1;
          await sleep(300);
          const tl2 = await runner.browserToolCall(taskId, "browser.tabs.list", {}, token, 30_000);
          const t1After = ((tl2?.result ?? tl2 ?? {}).tabs ?? []).find((t) => t.id === t1);
          mw.movedOk = t1After?.windowId === w1;
          // move back (windowId + explicit index) — W2 still has T2, safe
          await runner.browserToolCall(
            taskId, "browser.tab.update", { tabId: t1, windowId: w2, index: 0 }, token, 60_000,
          ).catch(() => null);
          await sleep(300);
          const tl3 = await runner.browserToolCall(taskId, "browser.tabs.list", {}, token, 30_000);
          const t1Back = ((tl3?.result ?? tl3 ?? {}).tabs ?? []).find((t) => t.id === t1);
          mw.backOk = t1Back?.windowId === w2 && t1Back?.index === 0;
          // cleanup: close T1 (W2 keeps T2 — no teardown); T2 stays as
          // W2's last tab, browser teardown handles it at scenario end
          await runner.browserToolCall(
            taskId, "browser.tab.close", { tabId: t1 }, token, 60_000,
          ).catch(() => null);
        } else {
          mw.callOk = mw.movedOk = mw.backOk = false;
        }
        // headless guard: a window whose ONLY tab is moved out would
        // tear down → crash. Dedicated 1-tab window must be refused.
        const wc2 = await runner.browserToolCall(
          taskId, "browser.windows.create", { url: fixture.url("/"), focused: false }, token, 60_000,
        );
        const w3r = wc2?.result ?? wc2 ?? {};
        const w3 = w3r.windowId ?? w3r.id;
        const t3 = w3r.openedTabId ?? w3r.tabId ?? w3r.tabs?.[0]?.id;
        if (typeof w3 === "number" && typeof t3 === "number" && typeof w1 === "number") {
          const guard = await runner.browserToolCall(
            taskId, "browser.tab.update", { tabId: t3, windowId: w1 }, token, 60_000,
          );
          mw.guardOk = (guard?.error?.code ?? "") === "proto.unsupported";
          // browser must still be alive — W3 still listed
          const wl = await runner.browserToolCall(taskId, "browser.windows.list", {}, token, 30_000).catch(() => null);
          const wlist = (wl?.result ?? wl ?? {}).windows ?? [];
          mw.aliveOk = wlist.some((w) => (w.id ?? w.windowId) === w3);
        } else {
          mw.guardOk = mw.aliveOk = false;
        }
      } catch (e) {
        mw.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`tabMoveWindow → ${JSON.stringify(mw).slice(0, 300)}`);
      results.tabMoveWindow = {
        ok: mw.createOk === true && mw.siblingOk === true && mw.targetOk === true && mw.callOk === true
          && mw.movedOk === true && mw.backOk === true && mw.guardOk === true && mw.aliveOk === true,
        ...mw,
      };

      // --- page.history bypassCache: /cache-probe serves a constant
      // ETag + hit-counter body. Normal reload revalidates → 304 → old
      // body; bypassCache ignores cache → fresh 200 → higher counter.
      // Proves the arg reaches chrome.tabs.reload {bypassCache} / CDP
      // Page.reload {ignoreCache} for real, not just dispatch. ---
      const cb = {};
      try {
        const cbCreate = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/cache-probe"), active: false }, token, 60_000,
        );
        const cbTab = (cbCreate?.result ?? cbCreate ?? {}).openedTabId ??
          (cbCreate?.result ?? cbCreate ?? {}).tabId;
        cb.createOk = typeof cbTab === "number";
        const readCv = async () => {
          const r = await runner.browserToolCall(
            taskId, "browser.page.evaluate",
            { tabId: cbTab, expression: "document.getElementById('cv')?.textContent ?? ''" },
            token, 60_000,
          ).catch(() => null);
          const v = (r?.result ?? r ?? {}).value ?? "";
          const m = /cache-v(\d+)/.exec(String(v));
          return m ? Number(m[1]) : null;
        };
        if (cb.createOk) {
          await sleep(800);
          const v1 = await readCv();
          cb.v1 = v1;
          // invalid combos refused before dispatch
          const badBack = await runner.browserToolCall(
            taskId, "browser.page.history", { tabId: cbTab, action: "back", bypassCache: true }, token, 60_000,
          ).catch(() => null);
          cb.badBackOk = (badBack?.error?.code ?? "") === "proto.invalid";
          const badType = await runner.browserToolCall(
            taskId, "browser.page.history", { tabId: cbTab, action: "reload", bypassCache: "yes" }, token, 60_000,
          ).catch(() => null);
          cb.badTypeOk = (badType?.error?.code ?? "") === "proto.invalid";
          // normal reload — conditional revalidation → 304 → SAME body
          await runner.browserToolCall(
            taskId, "browser.page.history", { tabId: cbTab, action: "reload" }, token, 60_000,
          );
          await sleep(1000);
          const vNorm = await readCv();
          cb.normalOk = typeof v1 === "number" && vNorm === v1;
          // bypassCache reload — cache ignored → fresh 200 → HIGHER counter
          const bc = await runner.browserToolCall(
            taskId, "browser.page.history", { tabId: cbTab, action: "reload", bypassCache: true }, token, 60_000,
          );
          cb.callOk = (bc?.result ?? bc ?? {}).bypassCache === true;
          await sleep(1000);
          const vBypass = await readCv();
          cb.versions = { v1, vNorm, vBypass };
          cb.bypassOk = typeof vNorm === "number" && typeof vBypass === "number" && vBypass > vNorm;
          await runner.browserToolCall(
            taskId, "browser.tab.close", { tabId: cbTab }, token, 60_000,
          ).catch(() => null);
        } else {
          cb.badBackOk = cb.badTypeOk = cb.normalOk = cb.callOk = cb.bypassOk = false;
        }
      } catch (e) {
        cb.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`cacheBypass → ${JSON.stringify(cb).slice(0, 300)}`);
      results.cacheBypass = {
        ok: cb.createOk === true && cb.badBackOk === true && cb.badTypeOk === true &&
          cb.normalOk === true && cb.callOk === true && cb.bypassOk === true,
        ...cb,
      };

      // --- screenshot fullPage: /tall is 5000px+ tall — a viewport
      // shot and a fullPage shot must differ in JPEG pixel height
      // (parse the SOF marker). Proves captureBeyondViewport reached
      // CDP for real, not just arg acceptance. ---
      const fp = {};
      const jpegSize = (b64) => {
        const buf = Buffer.from(String(b64), "base64");
        let i = 2;
        while (i < buf.length - 9) {
          if (buf[i] !== 0xff) { i += 1; continue; }
          const marker = buf[i + 1];
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
          }
          i += 2 + buf.readUInt16BE(i + 2);
        }
        return null;
      };
      try {
        const fpCreate = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/tall"), active: false }, token, 60_000,
        );
        const fpTab = (fpCreate?.result ?? fpCreate ?? {}).openedTabId ??
          (fpCreate?.result ?? fpCreate ?? {}).tabId;
        fp.createOk = typeof fpTab === "number";
        if (fp.createOk) {
          await sleep(800);
          const vpShot = await runner.browserToolCall(
            taskId, "browser.page.screenshot", { tabId: fpTab }, token, 60_000,
          );
          const fullShot = await runner.browserToolCall(
            taskId, "browser.page.screenshot", { tabId: fpTab, fullPage: true }, token, 60_000,
          );
          const vpDim = jpegSize((vpShot?.result ?? vpShot ?? {}).dataBase64);
          const fullDim = jpegSize((fullShot?.result ?? fullShot ?? {}).dataBase64);
          fp.viewport = vpDim; fp.full = fullDim;
          fp.ok = typeof vpDim?.height === "number" && typeof fullDim?.height === "number"
            && fullDim.height > vpDim.height * 2;
          // invalid combos refused before dispatch
          const badCombo = await runner.browserToolCall(
            taskId, "browser.page.screenshot", { tabId: fpTab, fullPage: true, selector: "#x" }, token, 60_000,
          ).catch(() => null);
          fp.badComboOk = (badCombo?.error?.code ?? "") === "proto.invalid";
          const badType = await runner.browserToolCall(
            taskId, "browser.page.screenshot", { tabId: fpTab, fullPage: "yes" }, token, 60_000,
          ).catch(() => null);
          fp.badTypeOk = (badType?.error?.code ?? "") === "proto.invalid";
          await runner.browserToolCall(
            taskId, "browser.tab.close", { tabId: fpTab }, token, 60_000,
          ).catch(() => null);
        } else {
          fp.ok = fp.badComboOk = fp.badTypeOk = false;
        }
      } catch (e) {
        fp.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`screenshotFullPage → ${JSON.stringify(fp).slice(0, 300)}`);
      results.screenshotFullPage = {
        ok: fp.createOk === true && fp.ok === true && fp.badComboOk === true && fp.badTypeOk === true,
        ...fp,
      };

      // NOTE: real renderer-crash recovery (Page.crash → page.get
      // crashed:true → reload revive) is NOT exercised here — on headless
      // CfT, Page.crash kills the browser host connection entirely
      // (same destructive class as window teardown). The crashed:true
      // probe in page.get is unit-tested; verify on headed Chrome.

      // --- wait responseUrl: completed-response condition over the
      // persistent webRequest log — the "did my submit land" primitive.
      // /cache-probe's document response lands in the log; the wait
      // must match it with status+ts evidence, time out honestly on a
      // nonexistent path, and refuse frameId. ---
      const wr = {};
      try {
        const wrCreate = await runner.browserToolCall(
          taskId, "browser.tab.create", { url: fixture.url("/cache-probe"), active: false }, token, 60_000,
        );
        const wrTab = (wrCreate?.result ?? wrCreate ?? {}).openedTabId ??
          (wrCreate?.result ?? wrCreate ?? {}).tabId;
        wr.createOk = typeof wrTab === "number";
        if (wr.createOk) {
          await sleep(700);
          const wrRes = await runner.browserToolCall(
            taskId, "browser.page.wait", { tabId: wrTab, responseUrl: "cache-probe", timeoutMs: 5000 }, token, 60_000,
          );
          const wrBody = wrRes?.result ?? wrRes ?? {};
          wr.matchedOk = wrBody.matched === "response";
          wr.statusOk = wrBody.response?.status === 200;
          wr.evidenceOk = typeof wrBody.response?.ts === "number" && typeof wrBody.response?.url === "string";
          const wrNo = await runner.browserToolCall(
            taskId, "browser.page.wait", { tabId: wrTab, responseUrl: "/definitely-not-here", timeoutMs: 300 }, token, 60_000,
          ).catch(() => null);
          wr.timeoutOk = (wrNo?.error?.code ?? "") === "browser.timeout";
          const wrBad = await runner.browserToolCall(
            taskId, "browser.page.wait", { tabId: wrTab, responseUrl: "x", frameId: 1 }, token, 60_000,
          ).catch(() => null);
          wr.frameOk = (wrBad?.error?.code ?? "") === "proto.invalid";
          await runner.browserToolCall(
            taskId, "browser.tab.close", { tabId: wrTab }, token, 60_000,
          ).catch(() => null);
        } else {
          wr.matchedOk = wr.statusOk = wr.evidenceOk = wr.timeoutOk = wr.frameOk = false;
        }
      } catch (e) {
        wr.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`waitResponse → ${JSON.stringify(wr).slice(0, 300)}`);
      results.waitResponse = {
        ok: wr.createOk === true && wr.matchedOk === true && wr.statusOk === true &&
          wr.evidenceOk === true && wr.timeoutOk === true && wr.frameOk === true,
        ...wr,
      };

      // --- waitConsole: consoleText/consoleLevel over the MAIN-world buffer ---
      // Prime browser.page.console first — the capture hook only records
      // from install time, so the pre-click prime is what makes the
      // post-click message visible to the wait's lookback window.
      let wc = {};
      try {
        const wcCreate = await runner.browserToolCall(
          taskId, "browser.tab.create",
          { url: fixture.url("/console-probe"), active: false }, token, 60_000,
        );
        const wcTab = (wcCreate?.result ?? wcCreate ?? {}).openedTabId ??
          (wcCreate?.result ?? wcCreate ?? {}).tabId;
        wc.createOk = typeof wcTab === "number";
        if (wc.createOk) {
          await sleep(700);
          const prime = await runner.browserToolCall(
            taskId, "browser.page.console", { tabId: wcTab }, token, 60_000,
          );
          wc.primeOk = prime?.status === "completed";
          await runner.browserToolCall(
            taskId, "browser.page.click", { tabId: wcTab, selector: "#err" }, token, 60_000,
          ).catch(() => null);
          const wcRes = await runner.browserToolCall(
            taskId, "browser.page.wait",
            { tabId: wcTab, consoleText: "probe-error-marker", consoleLevel: "error", timeoutMs: 5000 }, token, 60_000,
          );
          const wcBody = wcRes?.result ?? wcRes ?? {};
          wc.matchedOk = wcBody.matched === "console";
          wc.levelOk = wcBody.console?.level === "error";
          wc.evidenceOk = typeof wcBody.console?.ts === "number" && typeof wcBody.console?.text === "string";
          // wrong level filter → honest timeout
          await runner.browserToolCall(
            taskId, "browser.page.click", { tabId: wcTab, selector: "#warn" }, token, 60_000,
          ).catch(() => null);
          const wcNo = await runner.browserToolCall(
            taskId, "browser.page.wait",
            { tabId: wcTab, consoleText: "probe-warn-marker", consoleLevel: "error", timeoutMs: 400 }, token, 60_000,
          ).catch(() => null);
          wc.levelTimeoutOk = (wcNo?.error?.code ?? "") === "browser.timeout";
          const wcBad = await runner.browserToolCall(
            taskId, "browser.page.wait",
            { tabId: wcTab, consoleLevel: "error" }, token, 60_000,
          ).catch(() => null);
          wc.badArgOk = (wcBad?.error?.code ?? "") === "proto.invalid";
          await runner.browserToolCall(
            taskId, "browser.tab.close", { tabId: wcTab }, token, 60_000,
          ).catch(() => null);
        } else {
          wc.matchedOk = wc.levelOk = wc.evidenceOk = wc.levelTimeoutOk = wc.badArgOk = false;
        }
      } catch (e) {
        wc.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`waitConsole → ${JSON.stringify(wc).slice(0, 300)}`);
      results.waitConsole = {
        ok: wc.createOk === true && wc.primeOk === true && wc.matchedOk === true &&
          wc.levelOk === true && wc.evidenceOk === true && wc.levelTimeoutOk === true &&
          wc.badArgOk === true,
        ...wc,
      };

      // --- tabsWait: async popup barrier (OAuth/target=_blank flow) ---
      // Start the wait BEFORE the trusted click — the popup arrives
      // asynchronously, which is exactly what post-action openedTabs[]
      // cannot cover. Baseline-diff: the already-open popup can't
      // re-match a second wait.
      let tw = {};
      try {
        const twCreate = await runner.browserToolCall(
          taskId, "browser.tab.create",
          { url: fixture.url("/popup-link"), active: true }, token, 60_000,
        );
        const twTab = (twCreate?.result ?? twCreate ?? {}).openedTabId ??
          (twCreate?.result ?? twCreate ?? {}).tabId;
        tw.createOk = typeof twTab === "number";
        if (tw.createOk) {
          await sleep(800);
          const waitP = runner.browserToolCall(
            taskId, "browser.tabs.wait", { urlContains: "popup-done", timeoutMs: 8000 }, token, 60_000,
          );
          await runner.browserToolCall(
            taskId, "browser.page.click", { tabId: twTab, selector: "#go", trusted: true }, token, 60_000,
          ).catch(() => null);
          const twRes = await waitP;
          const twBody = twRes?.result ?? twRes ?? {};
          const popupId = twBody.newTabId ?? twBody.tab?.tabId ?? twBody.tab?.id;
          tw.matchedOk = twBody.matched === "newTab";
          tw.tabOk = typeof popupId === "number";
          tw.urlOk = String(twBody.tab?.url ?? "").includes("popup-done");
          // scope harvest: newTabId must let the task operate the popup
          const pg = popupId !== undefined
            ? await runner.browserToolCall(taskId, "browser.page.get", { tabId: popupId }, token, 60_000).catch(() => null)
            : null;
          tw.scopeOk = pg?.status === "completed";
          // stale baseline: popup already open → second wait times out
          const twNo = await runner.browserToolCall(
            taskId, "browser.tabs.wait", { urlContains: "popup-done", timeoutMs: 500 }, token, 60_000,
          ).catch(() => null);
          tw.staleOk = (twNo?.error?.code ?? "") === "browser.timeout";
          const twBad = await runner.browserToolCall(
            taskId, "browser.tabs.wait", {}, token, 60_000,
          ).catch(() => null);
          tw.badArgOk = (twBad?.error?.code ?? "") === "proto.invalid";
          // cleanup launcher + popup
          await runner.browserToolCall(taskId, "browser.tab.close", { tabId: twTab }, token, 60_000).catch(() => null);
          if (typeof popupId === "number") {
            await runner.browserToolCall(taskId, "browser.tab.close", { tabId: popupId }, token, 60_000).catch(() => null);
          }
          // waitForLoad: /popup-slow answers ~1.2s late — the URL matches
          // immediately but status stays "loading"; waitForLoad must
          // hold until complete and report elapsed ≥ the server delay.
          const slCreate = await runner.browserToolCall(
            taskId, "browser.tab.create",
            { url: fixture.url("/popup-link-slow"), active: true }, token, 60_000,
          );
          const slTab = (slCreate?.result ?? slCreate ?? {}).openedTabId ??
            (slCreate?.result ?? slCreate ?? {}).tabId;
          if (typeof slTab === "number") {
            await sleep(800);
            const slWaitP = runner.browserToolCall(
              taskId, "browser.tabs.wait",
              { urlContains: "popup-slow", waitForLoad: true, timeoutMs: 10000 }, token, 60_000,
            );
            const slT0 = Date.now();
            await runner.browserToolCall(
              taskId, "browser.page.click", { tabId: slTab, selector: "#go", trusted: true }, token, 60_000,
            ).catch(() => null);
            const slRes = await slWaitP;
            const slBody = slRes?.result ?? slRes ?? {};
            const slPopup = slBody.newTabId ?? slBody.tab?.tabId ?? slBody.tab?.id;
            tw.loadOk = slBody.matched === "newTab" && slBody.tab?.status === "complete";
            tw.loadElapsedOk = Date.now() - slT0 >= 900;
            const slBad = await runner.browserToolCall(
              taskId, "browser.tabs.wait",
              { urlContains: "x", waitForLoad: "yes" }, token, 60_000,
            ).catch(() => null);
            tw.loadBadOk = (slBad?.error?.code ?? "") === "proto.invalid";
            await runner.browserToolCall(taskId, "browser.tab.close", { tabId: slTab }, token, 60_000).catch(() => null);
            if (typeof slPopup === "number") {
              await runner.browserToolCall(taskId, "browser.tab.close", { tabId: slPopup }, token, 60_000).catch(() => null);
            }
          } else {
            tw.loadOk = tw.loadElapsedOk = tw.loadBadOk = false;
          }
        } else {
          tw.matchedOk = tw.tabOk = tw.urlOk = tw.scopeOk = tw.staleOk = tw.badArgOk =
            tw.loadOk = tw.loadElapsedOk = tw.loadBadOk = false;
        }
      } catch (e) {
        tw.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`tabsWait → ${JSON.stringify(tw).slice(0, 300)}`);
      results.tabsWait = {
        ok: tw.createOk === true && tw.matchedOk === true && tw.tabOk === true &&
          tw.urlOk === true && tw.scopeOk === true && tw.staleOk === true && tw.badArgOk === true &&
          tw.loadOk === true && tw.loadElapsedOk === true && tw.loadBadOk === true,
        ...tw,
      };

      // --- tabsWait disappear: self-closing popup (OAuth window.close
      // pattern). window.open from a trusted click → popup lives ~600ms
      // → disappear wait observes it go away. Also: a still-open tab
      // must make disappear time out, and the combo with waitForLoad is
      // refused.
      let td = {};
      try {
        const tgCreate = await runner.browserToolCall(
          taskId, "browser.tab.create",
          { url: fixture.url("/popup-link-close"), active: true }, token, 60_000,
        );
        const tgTab = (tgCreate?.result ?? tgCreate ?? {}).openedTabId ??
          (tgCreate?.result ?? tgCreate ?? {}).tabId;
        td.createOk = typeof tgTab === "number";
        if (td.createOk) {
          await sleep(800);
          const goneP = runner.browserToolCall(
            taskId, "browser.tabs.wait",
            { urlContains: "popup-closing", disappear: true, timeoutMs: 8000 }, token, 60_000,
          );
          await runner.browserToolCall(
            taskId, "browser.page.click", { tabId: tgTab, selector: "#go", trusted: true }, token, 60_000,
          ).catch(() => null);
          const goneRes = await goneP;
          const goneBody = goneRes?.result ?? goneRes ?? {};
          td.goneOk = goneBody.matched === "disappear";
          // still-open tab → disappear must time out honestly
          const stayCreate = await runner.browserToolCall(
            taskId, "browser.tab.create",
            { url: fixture.url("/popup-done"), active: false }, token, 60_000,
          );
          const stayTab = (stayCreate?.result ?? stayCreate ?? {}).openedTabId ??
            (stayCreate?.result ?? stayCreate ?? {}).tabId;
          // tab.create resolves before the navigation commits — wait for
          // the URL to land or disappear sees "no match" and returns
          // instantly instead of timing out.
          if (typeof stayTab === "number") {
            const loadDeadline = Date.now() + 8000;
            while (Date.now() < loadDeadline) {
              const tl = await runner.browserToolCall(
                taskId, "browser.tabs.list", {}, token, 60_000,
              ).catch(() => null);
              const tabs = (tl?.result ?? tl ?? {}).tabs ?? [];
              const hit = tabs.find((t) => (t.tabId ?? t.id) === stayTab);
              if (String(hit?.url ?? "").includes("popup-done")) break;
              await sleep(200);
            }
          }
          const stayRes = typeof stayTab === "number"
            ? await runner.browserToolCall(
                taskId, "browser.tabs.wait",
                { urlContains: "popup-done", disappear: true, timeoutMs: 600 }, token, 60_000,
              ).catch(() => null)
            : null;
          td.stayTimeoutOk = (stayRes?.error?.code ?? "") === "browser.timeout";
          // already-gone → immediate matched:"disappear" (no matching tab at call time)
          const instant = await runner.browserToolCall(
            taskId, "browser.tabs.wait",
            { urlContains: "popup-closing", disappear: true, timeoutMs: 2000 }, token, 60_000,
          ).catch(() => null);
          td.instantOk = (instant?.result ?? instant ?? {}).matched === "disappear";
          const combo = await runner.browserToolCall(
            taskId, "browser.tabs.wait",
            { urlContains: "x", disappear: true, waitForLoad: true }, token, 60_000,
          ).catch(() => null);
          td.comboOk = (combo?.error?.code ?? "") === "proto.invalid";
          await runner.browserToolCall(taskId, "browser.tab.close", { tabId: tgTab }, token, 60_000).catch(() => null);
          if (typeof stayTab === "number") {
            await runner.browserToolCall(taskId, "browser.tab.close", { tabId: stayTab }, token, 60_000).catch(() => null);
          }
        } else {
          td.goneOk = td.stayTimeoutOk = td.instantOk = td.comboOk = false;
        }
      } catch (e) {
        td.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`tabsWaitDisappear → ${JSON.stringify(td).slice(0, 300)}`);
      results.tabsWaitDisappear = {
        ok: td.createOk === true && td.goneOk === true && td.stayTimeoutOk === true &&
          td.instantOk === true && td.comboOk === true,
        ...td,
      };

      // --- pierce: closed shadow roots via CDP DOM pierce. Content
      // scripts cannot see inside mode:"closed" roots; the pierce tool
      // must surface the button and a pz ref click must land (verified
      // by window.__pierceClicks in the MAIN world).
      let pj = {};
      try {
        const pjCreate = await runner.browserToolCall(
          taskId, "browser.tab.create",
          { url: fixture.url("/closed-shadow"), active: true }, token, 60_000,
        );
        const pjTab = (pjCreate?.result ?? pjCreate ?? {}).openedTabId ??
          (pjCreate?.result ?? pjCreate ?? {}).tabId;
        pj.createOk = typeof pjTab === "number";
        if (pj.createOk) {
          await sleep(800);
          const pierceRes = await runner.browserToolCall(
            taskId, "browser.page.pierce", { tabId: pjTab }, token, 60_000,
          );
          const pjBody = pierceRes?.result ?? pierceRes ?? {};
          pj.rootsOk = (pjBody.closedRoots ?? 0) >= 1;
          const elements = Array.isArray(pjBody.elements) ? pjBody.elements : [];
          const btn = elements.find((e) => e.tagName === "button");
          pj.btnOk = typeof btn?.ref === "string" && /^pz-\d+$/.test(btn.ref);
          pj.nameOk = String(btn?.name ?? "") !== "";
          pj.boxOk = btn?.box != null && btn.box.width > 0;
          if (pj.btnOk) {
            // no trusted flag — pz refs auto-route to CDP dispatch
            const clk = await runner.browserToolCall(
              taskId, "browser.page.click", { tabId: pjTab, ref: btn.ref }, token, 60_000,
            ).catch(() => null);
            pj.clickOk = (clk?.result ?? clk ?? {}).pierced === true || clk?.status === "completed";
            const ev = await runner.browserToolCall(
              taskId, "browser.page.evaluate",
              { tabId: pjTab, expression: "window.__pierceClicks||0" }, token, 60_000,
            ).catch(() => null);
            pj.effectOk = String(ev?.result?.value ?? ev?.value ?? "").includes("1");
            const bad = await runner.browserToolCall(
              taskId, "browser.page.click", { tabId: pjTab, ref: "pz-999999" }, token, 60_000,
            ).catch(() => null);
            pj.badRefOk = (bad?.error?.code ?? "") === "browser.element_not_found";
            // keyboard ops on pz refs — fill replaces, type appends; both
            // must land as trusted keystrokes (input events on the field)
            const inp = elements.find((e) => e.tagName === "input");
            pj.inpOk = typeof inp?.ref === "string";
            if (pj.inpOk) {
              const fl = await runner.browserToolCall(
                taskId, "browser.page.fill", { tabId: pjTab, ref: inp.ref, text: "pierce-text" },
                token, 60_000,
              ).catch(() => null);
              pj.fillOk = (fl?.result ?? fl ?? {}).pierced === true;
              const ty = await runner.browserToolCall(
                taskId, "browser.page.type", { tabId: pjTab, ref: inp.ref, text: "!" },
                token, 60_000,
              ).catch(() => null);
              pj.typeOk = (ty?.result ?? ty ?? {}).pierced === true;
              const ev2 = await runner.browserToolCall(
                taskId, "browser.page.evaluate",
                { tabId: pjTab, expression: "window.__pierceValue||''" }, token, 60_000,
              ).catch(() => null);
              pj.valueOk = String(ev2?.result?.value ?? ev2?.value ?? "") === "pierce-text!";
              // element-scoped evaluate — `this` binds to the closed-root
              // input; reads state content scripts cannot reach
              const pev = await runner.browserToolCall(
                taskId, "browser.page.evaluate",
                { tabId: pjTab, ref: inp.ref, expression: "this.value" },
                token, 60_000,
              ).catch(() => null);
              pj.evalOk = String(pev?.result?.value ?? "") === "pierce-text!";
              // file input inside the closed root — setInputFiles via
              // backendNodeId, verified by the change handler
              const up = elements.find((e) => e.id === "upload");
              pj.upOk = typeof up?.ref === "string";
              if (pj.upOk) {
                const upDir = mkdtempSync(join(tmpdir(), "chromex-pierce-"));
                const upPath = join(upDir, "pierce-upload.txt");
                writeFileSync(upPath, "pierce-bytes");
                const upRes = await runner.browserToolCall(
                  taskId, "browser.page.setInputFiles",
                  { tabId: pjTab, ref: up.ref, files: [upPath] }, token, 60_000,
                ).catch(() => null);
                pj.uploadOk = (upRes?.result ?? upRes ?? {}).pierced === true;
                const ev3 = await runner.browserToolCall(
                  taskId, "browser.page.evaluate",
                  { tabId: pjTab, expression: "window.__pierceFiles||''" }, token, 60_000,
                ).catch(() => null);
                pj.filesOk = String(ev3?.result?.value ?? ev3?.value ?? "") === "pierce-upload.txt";
                // select + drag inside the closed root
                const sel = elements.find((e) => e.id === "choice");
                const ds = elements.find((e) => e.id === "dsrc");
                const dd = elements.find((e) => e.id === "ddst");
                pj.selOk = typeof sel?.ref === "string";
                pj.dragOk = typeof ds?.ref === "string" && typeof dd?.ref === "string";
                if (pj.selOk) {
                  const sRes = await runner.browserToolCall(
                    taskId, "browser.page.select",
                    { tabId: pjTab, ref: sel.ref, value: "b" }, token, 60_000,
                  ).catch(() => null);
                  pj.selectOk = (sRes?.result ?? sRes ?? {}).pierced === true;
                  const ev4 = await runner.browserToolCall(
                    taskId, "browser.page.evaluate",
                    { tabId: pjTab, expression: "window.__pierceSelect||''" }, token, 60_000,
                  ).catch(() => null);
                  pj.selectValOk = String(ev4?.result?.value ?? ev4?.value ?? "") === "b";
                } else {
                  pj.selectOk = pj.selectValOk = false;
                }
                if (pj.dragOk) {
                  const dRes = await runner.browserToolCall(
                    taskId, "browser.page.drag",
                    { tabId: pjTab, ref: ds.ref, toRef: dd.ref }, token, 60_000,
                  ).catch(() => null);
                  pj.dragCallOk = (dRes?.result ?? dRes ?? {}).pierced === true;
                  const ev5 = await runner.browserToolCall(
                    taskId, "browser.page.evaluate",
                    { tabId: pjTab, expression: "window.__pierceDrag||''" }, token, 60_000,
                  ).catch(() => null);
                  pj.dragValOk = String(ev5?.result?.value ?? ev5?.value ?? "").includes(",");
                } else {
                  pj.dragCallOk = pj.dragValOk = false;
                }
              } else {
                pj.uploadOk = pj.filesOk = pj.selOk = pj.selectOk = pj.selectValOk = false;
                pj.dragOk = pj.dragCallOk = pj.dragValOk = false;
              }
            } else {
              pj.fillOk = pj.typeOk = pj.valueOk = pj.evalOk = false;
              pj.upOk = pj.uploadOk = pj.filesOk = pj.selOk = pj.selectOk = pj.selectValOk = false;
              pj.dragOk = pj.dragCallOk = pj.dragValOk = false;
            }
            const filt = await runner.browserToolCall(
              taskId, "browser.page.pierce", { tabId: pjTab, text: "closed action" }, token, 60_000,
            ).catch(() => null);
            pj.filterOk = ((filt?.result ?? filt ?? {}).elements ?? []).length >= 1;
          } else {
            pj.clickOk = pj.effectOk = pj.badRefOk = pj.filterOk = false;
            pj.inpOk = pj.fillOk = pj.typeOk = pj.valueOk = pj.evalOk = false;
            pj.upOk = pj.uploadOk = pj.filesOk = pj.selOk = pj.selectOk = pj.selectValOk = false;
            pj.dragOk = pj.dragCallOk = pj.dragValOk = false;
          }
          await runner.browserToolCall(taskId, "browser.tab.close", { tabId: pjTab }, token, 60_000).catch(() => null);
        } else {
          pj.rootsOk = pj.btnOk = pj.nameOk = pj.boxOk = pj.clickOk = pj.effectOk = pj.badRefOk = pj.filterOk = false;
          pj.inpOk = pj.fillOk = pj.typeOk = pj.valueOk = pj.evalOk = false;
          pj.upOk = pj.uploadOk = pj.filesOk = pj.selOk = pj.selectOk = pj.selectValOk = false;
          pj.dragOk = pj.dragCallOk = pj.dragValOk = false;
        }
      } catch (e) {
        pj.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`pierce → ${JSON.stringify(pj).slice(0, 300)}`);
      results.pierce = {
        ok: pj.createOk === true && pj.rootsOk === true && pj.btnOk === true &&
          pj.nameOk === true && pj.boxOk === true && pj.clickOk === true &&
          pj.effectOk === true && pj.badRefOk === true && pj.filterOk === true &&
          pj.inpOk === true && pj.fillOk === true && pj.typeOk === true && pj.valueOk === true &&
          pj.evalOk === true && pj.upOk === true && pj.uploadOk === true && pj.filesOk === true &&
          pj.selOk === true && pj.selectOk === true && pj.selectValOk === true &&
          pj.dragOk === true && pj.dragCallOk === true && pj.dragValOk === true,
        ...pj,
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

      // --- sessions: optional "sessions" permission — ungranted → honest unsupported ---
      let sn = {};
      const snRes = await runner.browserToolCall(
        taskId, "browser.sessions", { action: "list" }, token, 60_000,
      );
      const snErr = snRes?.error ?? {};
      sn.listUnsupportedOk = snRes?.status === "failed" && snErr.code === "proto.unsupported";
      sn.msg = String(snErr.message ?? "").slice(0, 160);
      const snRestore = await runner.browserToolCall(
        taskId, "browser.sessions", { action: "restore", sessionId: "bogus" }, token, 60_000,
      );
      const snRestoreErr = snRestore?.error ?? {};
      sn.restoreUnsupportedOk = snRestore?.status === "failed" && snRestoreErr.code === "proto.unsupported";
      evidence.note(`sessions → ${JSON.stringify(sn).slice(0, 300)}`);
      results.sessions = {
        ok: sn.listUnsupportedOk === true && sn.restoreUnsupportedOk === true,
        ...sn,
      };

      // --- proxy: optional "proxy" permission — ungranted → honest unsupported ---
      let px = {};
      const pxRes = await runner.browserToolCall(
        taskId, "browser.proxy", { action: "get" }, token, 60_000,
      );
      const pxErr = pxRes?.error ?? {};
      px.getUnsupportedOk = pxRes?.status === "failed" && pxErr.code === "proto.unsupported";
      px.msg = String(pxErr.message ?? "").slice(0, 160);
      const pxSet = await runner.browserToolCall(
        taskId, "browser.proxy",
        { action: "set", mode: "direct" }, token, 60_000,
      );
      const pxSetErr = pxSet?.error ?? {};
      px.setUnsupportedOk = pxSet?.status === "failed" && pxSetErr.code === "proto.unsupported";
      evidence.note(`proxy → ${JSON.stringify(px).slice(0, 300)}`);
      results.proxy = {
        ok: px.getUnsupportedOk === true && px.setUnsupportedOk === true,
        ...px,
      };

      // --- privacy: optional "privacy" permission — ungranted → honest unsupported ---
      let pv = {};
      const pvRes = await runner.browserToolCall(
        taskId, "browser.privacy", { action: "get" }, token, 60_000,
      );
      const pvErr = pvRes?.error ?? {};
      pv.getUnsupportedOk = pvRes?.status === "failed" && pvErr.code === "proto.unsupported";
      pv.msg = String(pvErr.message ?? "").slice(0, 160);
      const pvSet = await runner.browserToolCall(
        taskId, "browser.privacy",
        { action: "set", setting: "websites.doNotTrackEnabled", value: true }, token, 60_000,
      );
      const pvSetErr = pvSet?.error ?? {};
      pv.setUnsupportedOk = pvSet?.status === "failed" && pvSetErr.code === "proto.unsupported";
      evidence.note(`privacy → ${JSON.stringify(pv).slice(0, 300)}`);
      results.privacy = {
        ok: pv.getUnsupportedOk === true && pv.setUnsupportedOk === true,
        ...pv,
      };

      // --- management: optional "management" permission — ungranted → honest unsupported ---
      let mg = {};
      const mgRes = await runner.browserToolCall(
        taskId, "browser.management", { action: "list" }, token, 60_000,
      );
      const mgErr = mgRes?.error ?? {};
      mg.listUnsupportedOk = mgRes?.status === "failed" && mgErr.code === "proto.unsupported";
      mg.msg = String(mgErr.message ?? "").slice(0, 160);
      const mgUn = await runner.browserToolCall(
        taskId, "browser.management",
        { action: "uninstall", id: "bogus-extension-id" }, token, 60_000,
      );
      const mgUnErr = mgUn?.error ?? {};
      mg.uninstallUnsupportedOk = mgUn?.status === "failed" && mgUnErr.code === "proto.unsupported";
      evidence.note(`management → ${JSON.stringify(mg).slice(0, 300)}`);
      results.management = {
        ok: mg.listUnsupportedOk === true && mg.uninstallUnsupportedOk === true,
        ...mg,
      };

      // --- notifications: optional "notifications" permission — ungranted → honest unsupported ---
      let nt = {};
      const ntRes = await runner.browserToolCall(
        taskId, "browser.notifications", { action: "list" }, token, 60_000,
      );
      const ntErr = ntRes?.error ?? {};
      nt.listUnsupportedOk = ntRes?.status === "failed" && ntErr.code === "proto.unsupported";
      nt.msg = String(ntErr.message ?? "").slice(0, 160);
      const ntSend = await runner.browserToolCall(
        taskId, "browser.notifications",
        { action: "send", title: "t", message: "m" }, token, 60_000,
      );
      const ntSendErr = ntSend?.error ?? {};
      nt.sendUnsupportedOk = ntSend?.status === "failed" && ntSendErr.code === "proto.unsupported";
      evidence.note(`notifications → ${JSON.stringify(nt).slice(0, 300)}`);
      results.notifications = {
        ok: nt.listUnsupportedOk === true && nt.sendUnsupportedOk === true,
        ...nt,
      };

      // --- dnr: optional "declarativeNetRequest" permission — ungranted → honest unsupported ---
      let dn = {};
      const dnRes = await runner.browserToolCall(
        taskId, "browser.dnr", { action: "list" }, token, 60_000,
      );
      const dnErr = dnRes?.error ?? {};
      dn.listUnsupportedOk = dnRes?.status === "failed" && dnErr.code === "proto.unsupported";
      dn.msg = String(dnErr.message ?? "").slice(0, 160);
      const dnAdd = await runner.browserToolCall(
        taskId, "browser.dnr",
        { action: "add", rules: [{ action: { type: "block" }, condition: { urlFilter: "||x^" } }] },
        token, 60_000,
      );
      const dnAddErr = dnAdd?.error ?? {};
      dn.addUnsupportedOk = dnAdd?.status === "failed" && dnAddErr.code === "proto.unsupported";
      evidence.note(`dnr → ${JSON.stringify(dn).slice(0, 300)}`);
      results.dnr = {
        ok: dn.listUnsupportedOk === true && dn.addUnsupportedOk === true,
        ...dn,
      };

      // --- userScripts: optional "userScripts" permission — ungranted → honest unsupported ---
      let us = {};
      const usRes = await runner.browserToolCall(
        taskId, "browser.userScripts", { action: "list" }, token, 60_000,
      );
      const usErr = usRes?.error ?? {};
      us.listUnsupportedOk = usRes?.status === "failed" && usErr.code === "proto.unsupported";
      us.msg = String(usErr.message ?? "").slice(0, 160);
      const usReg = await runner.browserToolCall(
        taskId, "browser.userScripts",
        { action: "register", scripts: [{ id: "acc", matches: ["https://example.com/*"], js: [{ code: "1" }] }] },
        token, 60_000,
      );
      const usRegErr = usReg?.error ?? {};
      us.registerUnsupportedOk = usReg?.status === "failed" && usRegErr.code === "proto.unsupported";
      evidence.note(`userScripts → ${JSON.stringify(us).slice(0, 300)}`);
      results.userScripts = {
        ok: us.listUnsupportedOk === true && us.registerUnsupportedOk === true,
        ...us,
      };

      // --- system/processes: optional permissions — ungranted → honest unsupported ---
      let sys = {};
      const sysRes = await runner.browserToolCall(
        taskId, "browser.system", { action: "memory" }, token, 60_000,
      );
      const sysErr = sysRes?.error ?? {};
      sys.memoryUnsupportedOk = sysRes?.status === "failed" && sysErr.code === "proto.unsupported";
      sys.msg = String(sysErr.message ?? "").slice(0, 160);
      const procRes = await runner.browserToolCall(
        taskId, "browser.processes", { action: "list" }, token, 60_000,
      );
      const procErr = procRes?.error ?? {};
      sys.processesUnsupportedOk = procRes?.status === "failed" && procErr.code === "proto.unsupported";
      // terminate: arg validation fires before the permission boundary;
      // a well-formed call then hits the same ungranted-permission wall.
      const termNoPid = await runner.browserToolCall(
        taskId, "browser.processes", { action: "terminate" }, token, 60_000,
      );
      sys.termNoPidOk = (termNoPid?.error?.code ?? "") === "proto.invalid";
      const termRes = await runner.browserToolCall(
        taskId, "browser.processes", { action: "terminate", processId: 1 }, token, 60_000,
      );
      sys.termUnsupportedOk = termRes?.status === "failed" &&
        (termRes?.error?.code ?? "") === "proto.unsupported" &&
        /processes permission/.test(termRes?.error?.message ?? "");
      evidence.note(`system/processes → ${JSON.stringify(sys).slice(0, 300)}`);
      results.systemProcesses = {
        ok: sys.memoryUnsupportedOk === true && sys.processesUnsupportedOk === true &&
          sys.termNoPidOk === true && sys.termUnsupportedOk === true,
        ...sys,
      };

      // --- dns/power: optional permissions — ungranted → honest unsupported ---
      let dp = {};
      const dnsRes = await runner.browserToolCall(
        taskId, "browser.dns", { action: "resolve", hostname: "example.com" }, token, 60_000,
      );
      const dnsErr = dnsRes?.error ?? {};
      dp.dnsUnsupportedOk = dnsRes?.status === "failed" && dnsErr.code === "proto.unsupported";
      dp.msg = String(dnsErr.message ?? "").slice(0, 160);
      const powerRes = await runner.browserToolCall(
        taskId, "browser.power", { action: "request" }, token, 60_000,
      );
      const powerErr = powerRes?.error ?? {};
      dp.powerUnsupportedOk = powerRes?.status === "failed" && powerErr.code === "proto.unsupported";
      evidence.note(`dns/power → ${JSON.stringify(dp).slice(0, 300)}`);
      results.dnsPower = {
        ok: dp.dnsUnsupportedOk === true && dp.powerUnsupportedOk === true,
        ...dp,
      };

      // --- downloads.open: approval-gated OS handoff — bogus id proves
      // real dispatch (Chrome rejects before any app can launch) ---
      let dlo = {};
      const dloRes = await runner.browserToolCall(
        taskId, "browser.downloads.open", { downloadId: 999999 }, token, 60_000,
      );
      const dloErr = dloRes?.error ?? {};
      // Reached chrome.downloads.open → Chrome's own "id does not
      // exist" error, NOT a proto refusal and NOT a fake success.
      dlo.reachedChrome = dloRes?.status === "failed" &&
        dloErr.code !== "proto.unsupported" && dloErr.code !== "proto.invalid" &&
        /download|id|exist|invalid/i.test(String(dloErr.message ?? ""));
      dlo.msg = String(dloErr.message ?? "").slice(0, 160);
      evidence.note(`downloads.open → ${JSON.stringify(dlo).slice(0, 300)}`);
      results.downloadsOpen = { ok: dlo.reachedChrome === true, ...dlo };

      // --- downloads.pause/resume/erase: same bogus-id dispatch proof.
      // pause/resume → Chrome's real "Invalid download id"; erase →
      // our existence preflight refuses before chrome.downloads.erase
      // can silently no-op (erased:true would be a lie). ---
      let dmq = {};
      try {
        for (const op of ["pause", "resume", "erase"]) {
          const res = await runner.browserToolCall(
            taskId, `browser.downloads.${op}`, { downloadId: 999999 }, token, 60_000,
          );
          const err = res?.error ?? {};
          dmq[`${op}Ok`] = res?.status === "failed" &&
            err.code !== "proto.unsupported" && err.code !== "proto.invalid" &&
            /download|id|exist|invalid|not found/i.test(String(err.message ?? ""));
          dmq[`${op}Msg`] = String(err.message ?? "").slice(0, 120);
        }
      } catch (e) {
        dmq.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`downloads.manage → ${JSON.stringify(dmq).slice(0, 400)}`);
      results.downloadsManage = {
        ok: dmq.pauseOk === true && dmq.resumeOk === true && dmq.eraseOk === true,
        ...dmq,
      };

      // --- windows.get: real chrome.windows.get / getLastFocused ---
      let wg = {};
      const wlRes = await runner.browserToolCall(taskId, "browser.windows.list", {}, token, 60_000);
      const wlWins = (wlRes?.result ?? wlRes ?? {}).windows ?? [];
      wg.listOk = wlWins.length > 0 && typeof wlWins[0]?.id === "number";
      const firstWinId = wlWins[0]?.id;
      const wgById = await runner.browserToolCall(
        taskId, "browser.windows.get", { windowId: firstWinId }, token, 60_000,
      );
      const wgWin = (wgById?.result ?? wgById ?? {}).window ?? {};
      wg.byIdOk = wgWin.id === firstWinId && typeof wgWin.tabCount === "number";
      const wgLf = await runner.browserToolCall(
        taskId, "browser.windows.get", { lastFocused: true }, token, 60_000,
      );
      const wgLfWin = (wgLf?.result ?? wgLf ?? {}).window ?? {};
      // lastFocused must be a REAL window — its id appears in windows.list
      wg.lastFocusedOk = typeof wgLfWin.id === "number" &&
        wlWins.some((w) => w.id === wgLfWin.id);
      const wgBad = await runner.browserToolCall(
        taskId, "browser.windows.get", { windowId: 999999 }, token, 60_000,
      );
      wg.badIdOk = (wgBad?.error?.code ?? "") !== "proto.unsupported" &&
        /no window|not found|invalid/i.test(String(wgBad?.error?.message ?? ""));
      evidence.note(`windows.get → ${JSON.stringify(wg).slice(0, 300)}`);
      results.windowsGet = {
        ok: wg.listOk === true && wg.byIdOk === true && wg.lastFocusedOk === true && wg.badIdOk === true,
        ...wg,
      };

      // --- windows.create type:"popup" + windows.list coverage ---
      // Popup windows are real browsing surface — they must be
      // creatable AND visible in windows.list (previously filtered to
      // "normal" only). Left open: closing it would teardown-crash
      // headless; scenario teardown quits the browser cleanly.
      const wp = {};
      const wpBad = await runner.browserToolCall(
        taskId, "browser.windows.create", { type: "devtools" }, token, 60_000,
      ).catch(() => null);
      wp.badTypeOk = wpBad?.status === "failed" &&
        (wpBad?.error?.code ?? "") === "proto.invalid";
      const wpCreate = await runner.browserToolCall(
        taskId, "browser.windows.create",
        { url: fixture.url("/fetch"), type: "popup", focused: false, width: 400, height: 300 },
        token, 60_000,
      );
      const wpRes = wpCreate?.result ?? wpCreate ?? {};
      wp.createOk = wpRes.type === "popup" && typeof wpRes.windowId === "number";
      wp.windowId = wpRes.windowId ?? null;
      await sleep(500);
      const wpList = await runner.browserToolCall(taskId, "browser.windows.list", {}, token, 30_000);
      const wpWins = (wpList?.result ?? wpList ?? {}).windows ?? [];
      wp.listedOk = wpWins.some((w) => w.id === wp.windowId && w.type === "popup");
      // bounds update round-trip: resize the popup, read it back via
      // windows.get — proves left/top/width/height reach chrome.windows.update
      if (wp.createOk) {
        const wpUpd = await runner.browserToolCall(
          taskId, "browser.windows.update",
          { windowId: wp.windowId, width: 500, height: 400 }, token, 60_000,
        );
        wp.updateOk = (wpUpd?.result ?? wpUpd ?? {}).updated === wp.windowId;
        await sleep(300);
        const wpGet = await runner.browserToolCall(
          taskId, "browser.windows.get", { windowId: wp.windowId }, token, 30_000,
        );
        const wpG = (wpGet?.result ?? wpGet ?? {}).window ?? {};
        wp.bounds = { width: wpG.width ?? null, height: wpG.height ?? null };
        wp.boundsOk = wpG.width === 500 && wpG.height === 400;
        // bogus bounds refused before Chrome
        const wpBadB = await runner.browserToolCall(
          taskId, "browser.windows.update", { windowId: wp.windowId, width: 0 }, token, 60_000,
        ).catch(() => null);
        wp.badBoundsOk = wpBadB?.status === "failed" && (wpBadB?.error?.code ?? "") === "proto.invalid";
        // drawAttention: dispatch must reach chrome.windows.update —
        // visual flash is unverifiable headless, but the call completing
        // (not erroring) proves the field is forwarded
        const wpAtt = await runner.browserToolCall(
          taskId, "browser.windows.update",
          { windowId: wp.windowId, drawAttention: true }, token, 60_000,
        );
        wp.attOk = (wpAtt?.result ?? wpAtt ?? {}).updated === wp.windowId;
      }
      evidence.note(`windows.popup → ${JSON.stringify(wp).slice(0, 300)}`);
      results.windowsPopup = {
        ok: wp.badTypeOk === true && wp.createOk === true && wp.listedOk === true &&
          wp.updateOk === true && wp.boundsOk === true && wp.badBoundsOk === true &&
          wp.attOk === true,
        ...wp,
      };

      // --- windows.remove: window teardown crashes headless Chromium
      // (chrome.windows.remove AND last-tab-close both BUS_ADRALN) —
      // the dep is omitted on HeadlessChrome so the tool must refuse
      // with proto.unsupported instead of killing the browser. ---
      const wrRes = await runner.browserToolCall(
        taskId, "browser.windows.remove", { windowId: 1 }, token, 60_000,
      );
      const wrErr = wrRes?.error ?? {};
      results.windowsRemove = {
        ok: wrRes?.status === "failed" && wrErr.code === "proto.unsupported",
        status: wrRes?.status ?? null,
        code: wrErr.code ?? null,
        msg: String(wrErr.message ?? "").slice(0, 160),
      };
      evidence.note(`windows.remove headless → ${JSON.stringify(results.windowsRemove).slice(0, 300)}`);

      // --- runtime: no permission needed — verify REAL host info ---
      const rtRes = await runner.browserToolCall(
        taskId, "browser.runtime", { action: "info" }, token, 60_000,
      );
      const rt = rtRes?.result ?? {};
      const rtBrowser = rt.browser ?? {};
      const rtExt = rt.extension ?? {};
      const rtOk =
        rtRes?.status === "completed" &&
        typeof rtBrowser.version === "string" &&
        rtBrowser.version.length > 0 &&
        typeof rtExt.id === "string" &&
        rtExt.id.length > 0 &&
        rtExt.manifestVersion === 3 &&
        typeof rt.platform?.os === "string";
      evidence.note(`runtime → ${JSON.stringify(rt).slice(0, 300)}`);
      results.runtime = { ok: rtOk === true, browserVersion: rtBrowser.version ?? null, extId: rtExt.id ?? null };

      // --- permissions: getAll/contains real; request validated BEFORE
      // any prompt (invalid names → proto.invalid, never a dialog) ---
      let pm = {};
      try {
        const pmAll = await runner.browserToolCall(
          taskId, "browser.permissions", { action: "getAll" }, token, 60_000,
        );
        const pmAllRes = pmAll?.result ?? {};
        pm.getAllOk = pmAll?.status === "completed" &&
          Array.isArray(pmAllRes.permissions) && pmAllRes.permissions.includes("tabs");
        const pmC = await runner.browserToolCall(
          taskId, "browser.permissions", { action: "contains", permissions: ["history"] }, token, 60_000,
        );
        pm.containsOk = pmC?.status === "completed" && (pmC?.result ?? {}).granted === false;
        const pmBad = await runner.browserToolCall(
          taskId, "browser.permissions", { action: "request", permissions: ["history", "bogusPerm"] }, token, 60_000,
        );
        pm.badNameOk = (pmBad?.error?.code ?? "") === "proto.invalid" &&
          /bogusPerm/.test(pmBad?.error?.message ?? "");
        const pmOrig = await runner.browserToolCall(
          taskId, "browser.permissions", { action: "contains", permissions: ["history"], origins: ["https://x.com/*"] }, token, 60_000,
        );
        pm.originsOk = (pmOrig?.error?.code ?? "") === "proto.invalid";
      } catch (e) {
        pm.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`permissions → ${JSON.stringify(pm).slice(0, 300)}`);
      results.permissions = {
        ok: pm.getAllOk === true && pm.containsOk === true && pm.badNameOk === true && pm.originsOk === true,
        ...pm,
      };

      // --- action: badge set/get/clear on the real toolbar icon ---
      // agent text merges UNDER the attention count — verify set→get→
      // clear round-trips through chrome.action on a live browser.
      let ac = {};
      try {
        const acSet = await runner.browserToolCall(
          taskId, "browser.action", { action: "set", text: "agent", color: "#336699", title: "chromex agent busy" }, token, 60_000,
        );
        ac.setOk = acSet?.status === "completed" && (acSet?.result ?? {}).set === true;
        // badge is owned by this task — auto-clears on terminal status
        ac.ownerOk = (acSet?.result ?? {}).ownerTaskId === taskId;
        const acGet = await runner.browserToolCall(
          taskId, "browser.action", {}, token, 60_000,
        );
        ac.getOk = acGet?.status === "completed" && typeof (acGet?.result ?? {}).text === "string";
        const acClear = await runner.browserToolCall(
          taskId, "browser.action", { action: "clear" }, token, 60_000,
        );
        ac.clearOk = acClear?.status === "completed" && (acClear?.result ?? {}).cleared === true;
        const acBad = await runner.browserToolCall(
          taskId, "browser.action", { action: "set", text: "x".repeat(33) }, token, 60_000,
        );
        ac.badTextOk = (acBad?.error?.code ?? "") === "proto.invalid";
      } catch (e) {
        ac.error = String(e?.message ?? e).slice(0, 200);
      }
      evidence.note(`action → ${JSON.stringify(ac).slice(0, 300)}`);
      results.action = {
        ok: ac.setOk === true && ac.ownerOk === true && ac.getOk === true && ac.clearOk === true && ac.badTextOk === true,
        ...ac,
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
