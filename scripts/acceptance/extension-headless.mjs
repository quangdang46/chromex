// Headless real-extension proof: launches the BUILT extension in
// headless Chrome for Testing (new headless supports MV3 extensions),
// installs the acceptance native-messaging host, and drives browser
// tool calls MCP → gateway → native host → real service worker →
// content scripts on fixture pages.
//
// This is the tokenless counterpart of s1–s8: same production chain,
// minus user-visible windows. It proves the extension service worker
// actually owns tabs/DOM in a real Chromium — not a stub — so it stays
// in the run-all tokenless set. chrome.tabs/windows-level ops still
// need the token-gated headful scenarios for window/focus behavior.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  EvidenceWriter,
  TaskRunner,
  ensureIsolatedGateway,
  installAcceptanceNativeHost,
  launchChromiumWithExtension,
  sleep,
} from "./lib/harness.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";

const SCENARIO = "extension-headless";
const evidence = new EvidenceWriter(SCENARIO);
await evidence.init();
const t0 = Date.now();

let browser = null;
let gw = null;
let nmHost = null;
let fixture = null;

try {
  fixture = await startFixtureServer();
  gw = await ensureIsolatedGateway({ providers: [] });
  nmHost = await installAcceptanceNativeHost(gw.dataDir);
  browser = await launchChromiumWithExtension({
    gatewayHome: gw.dataDir,
    headless: true,
    prepareProfile: (dir) => nmHost.installIntoProfile(dir),
  });
  evidence.note(`extension ${browser.extensionId} headless=${browser.headless}`);
  await sleep(2500);

  // The SW connects its native port lazily/on startup — give it a moment,
  // then nudge via sidepanel like a user would if it hasn't registered.
  const authedDeadline = Date.now() + 20_000;
  let authed = 0;
  while (Date.now() < authedDeadline) {
    try {
      const d = await gw.conn.request("diagnostics.snapshot", {});
      authed = d?.diagnostics?.endpoint?.authedConnections ?? d?.endpoint?.authedConnections ?? 0;
    } catch {}
    if (authed >= 2) break;
    await sleep(500);
  }
  if (authed < 2) {
    try {
      const sp = await browser.context.newPage();
      await sp.goto(`chrome-extension://${browser.extensionId}/sidepanel.html?mode=popup&test=1`);
      await sleep(4_000);
      await sp.close().catch(() => {});
      evidence.note("sidepanel opened to wake SW → NM host");
      const d2 = await gw.conn.request("diagnostics.snapshot", {});
      authed = d2?.diagnostics?.endpoint?.authedConnections ?? d2?.endpoint?.authedConnections ?? 0;
    } catch (e) {
      evidence.note(`sidepanel wake failed: ${e?.message ?? e}`);
    }
  }
  evidence.note(`authed gateway connections=${authed} (1=client, 2+=browser host)`);
  if (authed < 2) {
    throw new Error("extension service worker never registered as a browser host");
  }

  const runner = new TaskRunner(gw.conn, evidence, { autoAnswer: "allow" });
  const taskId = await runner.createTask({
    title: "extension-headless e2e",
    cwd: "/tmp",
    backend: { backendId: "chrome-extension", pinnedBy: "user" },
    tabIntent: { scope: "untitled" },
  });
  evidence.note(`task ${taskId}`);
  const { token } = await runner.spawnBrowserScope(taskId);

  const page = await browser.context.newPage();
  await page.goto(fixture.url("/"), { waitUntil: "domcontentloaded" });
  await page.bringToFront();

  const get = await runner.browserToolCall(taskId, "browser.page.get", {}, token, 60_000);
  evidence.note(`page.get → ${JSON.stringify(get)?.slice(0, 200)}`);
  if (get?.status !== "completed") {
    throw new Error(`browser.page.get failed: ${JSON.stringify(get)?.slice(0, 300)}`);
  }
  const got = get.result ?? get;
  if (!String(got.url ?? "").includes("127.0.0.1")) {
    throw new Error(`page.get returned wrong page: ${JSON.stringify(got).slice(0, 200)}`);
  }

  const snap = await runner.browserToolCall(taskId, "browser.page.snapshot", {}, token, 60_000);
  evidence.note(`page.snapshot → ${JSON.stringify(snap)?.slice(0, 200)}`);
  if (snap?.status !== "completed") {
    throw new Error(`browser.page.snapshot failed: ${JSON.stringify(snap)?.slice(0, 300)}`);
  }

  // prove the SW sees the tab through chrome.tabs (host-side op, not content)
  const tabs = await runner.browserToolCall(taskId, "browser.tabs.list", {}, token, 60_000);
  evidence.note(`tabs.list → ${JSON.stringify(tabs)?.slice(0, 200)}`);
  if (tabs?.status !== "completed") {
    throw new Error(`browser.tabs.list failed: ${JSON.stringify(tabs)?.slice(0, 300)}`);
  }

  const result = {
    status: "PASS",
    summary: `real extension SW in headless Chromium: host registered, page.get + page.snapshot + tabs.list completed through MCP→gateway→NM→SW→content`,
    details: {
      extensionId: browser.extensionId,
      authedConnections: authed,
      pageGetStatus: get.status,
      snapshotStatus: snap.status,
      tabsStatus: tabs.status,
    },
  };
  const p = await evidence.writeResult(result);
  console.log(`\n=== ${SCENARIO}: PASS — ${result.summary}`);
  console.log("evidence:", p);
  process.exitCode = 0;
} catch (err) {
  const out = {
    status: "FAIL",
    summary: `harness error: ${err?.message ?? err}`,
    durationMs: Date.now() - t0,
    error: String(err?.stack ?? err),
  };
  await evidence.writeResult(out).catch(() => {});
  console.log(`\n=== ${SCENARIO}: FAIL — ${out.summary}`);
  process.exitCode = 1;
} finally {
  if (browser) await browser.cleanup().catch(() => {});
  if (nmHost) await nmHost.restore().catch((e) => console.error("NM restore:", e?.message ?? e));
  if (gw) await gw.cleanup().catch(() => {});
  if (fixture) await fixture.close().catch(() => {});
}
