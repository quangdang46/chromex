// S3 — Multi-tab work without scope bleed. Two tasks on the same extension
// backend; each gets its own browser.mcp scope token. Task A creates/owns a
// tab on fixture page A, task B on fixture page B. PASS = each task reads
// back only its own page, and cross-task tab access is refused
// (browser.not_in_scope / failed), never silently redirected.
import { runScenario, sleep } from "./lib/harness.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "s3-multitab";
const BACKEND = { backendId: "chrome-extension", pinnedBy: "user" };

function extractTabId(outcome) {
  const r = outcome?.result;
  const s = JSON.stringify(r ?? {});
  const m = s.match(/"tabId"\s*:\s*"?([0-9]+)"?/);
  // tabId is schema-integer — a string is silently ignored by the scope
  // check (tool-server treats non-number tabId as "no explicit tab")
  return m ? Number(m[1]) : null;
}

await runScenario(
  SCENARIO,
  async ({ runner, browser, evidence }) => {
    const fixture = await startFixtureServer();
    try {
      // distinct content per tab so we can prove which page each task sees
      const mkTask = async (name) => {
        const taskId = await runner.createTask({
          title: `s3 ${name}`,
          cwd: "/tmp",
          backend: BACKEND,
          tabIntent: { scope: "untitled" },
        });
        const { token } = await runner.spawnBrowserScope(taskId);
        return { taskId, token, name };
      };
      const A = await mkTask("taskA");
      const B = await mkTask("taskB");
      evidence.note(`taskA=${A.taskId} taskB=${B.taskId}`);

      // each task opens its own tab via browser.tab.create (acquires scope)
      const createFor = async (t, path, tag) => {
        const out = await runner.browserToolCall(
          t.taskId,
          "browser.tab.create",
          { url: fixture.url(path), active: false },
          t.token,
          60_000,
        );
        evidence.note(`${t.name} tab.create → ${JSON.stringify(out)?.slice(0, 300)}`);
        return out;
      };
      const outA = await createFor(A, "/?tag=A", "A");
      const outB = await createFor(B, "/form?tag=B", "B");
      const tabA = extractTabId(outA);
      const tabB = extractTabId(outB);
      evidence.note(`tabA=${tabA} tabB=${tabB}`);

      // give tabs a moment to load, then read each task's own page
      await sleep(800);
      const getFor = (t, tabId) =>
        runner.browserToolCall(t.taskId, "browser.page.get", tabId ? { tabId } : {}, t.token, 60_000);

      const getA = await getFor(A, tabA);
      const getB = await getFor(B, tabB);
      const textA = JSON.stringify(getA?.result ?? {});
      const textB = JSON.stringify(getB?.result ?? {});
      evidence.note(`A sees: ${textA.slice(0, 300)}`);
      evidence.note(`B sees: ${textB.slice(0, 300)}`);

      // cross-talk check 1: task A explicitly targets task B's tab
      let cross = null;
      try {
        cross = await runner.browserToolCall(A.taskId, "browser.page.get", { tabId: tabB }, A.token, 30_000);
      } catch (e) {
        cross = { rpcError: e?.message };
      }
      evidence.note(`A→B tab.get outcome: ${JSON.stringify(cross)?.slice(0, 300)}`);
      if (cross && !cross.rpcError && cross.status !== "failed") {
        evidence.note(
          "PRODUCT NOTE: cross-task tab.get did not return browser.not_in_scope — " +
            "inspect whether the foreign tabId was honored or silently replaced by the task's own tab",
        );
      }
      const crossDenied =
        cross == null ||
        cross.rpcError ||
        cross.status === "failed" ||
        /not_in_scope|denied|outside/.test(JSON.stringify(cross));

      // cross-talk check 2: implicit-target reads must stay in own scope —
      // task A snapshot should not return B's form page
      const snapA = await runner.browserToolCall(A.taskId, "browser.page.snapshot", {}, A.token, 60_000);
      const snapText = JSON.stringify(snapA?.result ?? {});
      const sawB = /Signup Form/.test(snapText) && !/Fixture Home/.test(snapText);

      // page.get returns tab metadata (title), not body — "Fixture Form"
      // is B's page title; "Signup Form" is asserted via snapshot below.
      const ownOk =
        getA?.status === "completed" &&
        getB?.status === "completed" &&
        /Fixture Home/.test(textA) &&
        /Fixture Form/.test(textB);

      // screenshots of both real tabs for evidence
      const pages = browser.context.pages();
      for (const [i, p] of pages.entries()) {
        if (p.url().includes("127.0.0.1") || p.url().includes("localhost")) {
          await evidence.screenshot(p, `s3-tab-${i}-${p.url().slice(0, 60)}`);
        }
      }

      const pass = ownOk && crossDenied && !sawB;
      return {
        status: pass ? "PASS" : "FAIL",
        summary: pass
          ? "two tasks held isolated tab scopes; cross-task tab access refused"
          : `ownOk=${ownOk} crossDenied=${crossDenied} sawB=${sawB}`,
        details: { tabA, tabB, ownOk, crossDenied, sawB, cross, getA: getA?.status, getB: getB?.status },
      };
    } finally {
      await fixture.close();
    }
  },
  { autoAnswer: "allow", gatewayProviders: [] },
);
