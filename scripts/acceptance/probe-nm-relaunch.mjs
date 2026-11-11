// probe-nm-relaunch — does connectNative work on a RELAUNCHED browser
// (same profile), and does call timing (SW-start vs later) matter?
import { launchChromiumWithExtension, installAcceptanceNativeHost } from "./lib/harness.mjs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gwHome = await mkdtemp(join(tmpdir(), "chromex-probe-gw-"));
const nmHost = await installAcceptanceNativeHost(gwHome);

const b1 = await launchChromiumWithExtension({
  gatewayHome: gwHome,
  headless: true,
  prepareProfile: (d) => nmHost.installIntoProfile(d),
});
try {
  const sp = await b1.context.newPage();
  await sp.goto(`chrome-extension://${b1.extensionId}/sidepanel.html?mode=popup`, { waitUntil: "domcontentloaded" });
  console.log("b1 sidepanel OK, extId:", b1.extensionId);
  await sleep(2000);
} finally {
  await b1.context.close().catch(() => {});
}
console.log("b1 closed — relaunching same profile");

const b2 = await launchChromiumWithExtension({
  gatewayHome: gwHome,
  headless: true,
  userDataDir: b1.userDataDir,
});
try {
  // SW should be up already (waitForExtensionServiceWorker inside launch)
  const sws = b2.context.serviceWorkers();
  console.log("b2 sws:", sws.map((w) => w.url().split("/").pop()));

  // 1) page-level connectNative smoke test
  const sp = await b2.context.newPage();
  await sp.goto(`chrome-extension://${b2.extensionId}/sidepanel.html?mode=popup&debug=1`, { waitUntil: "domcontentloaded", timeout: 20_000 });
  const nmResult = await sp.evaluate(
    () =>
      new Promise((resolve) => {
        try {
          const port = chrome.runtime.connectNative("com.codex.sidepanel.bridge");
          const to = setTimeout(() => {
            port.disconnect();
            resolve("timeout-no-disconnect");
          }, 8000);
          port.onDisconnect.addListener(() => {
            clearTimeout(to);
            resolve(`disconnected: ${chrome.runtime.lastError?.message ?? "?"}`);
          });
          port.onMessage.addListener(() => {});
        } catch (e) {
          resolve(`threw: ${e?.message ?? e}`);
        }
      }),
  );
  console.log("page connectNative result:", nmResult);
  await sp.close().catch(() => {});

  // 2) gateway.tasks via SW — did the SW's own gateway client connect?
  const sp2 = await b2.context.newPage();
  await sp2.goto(`chrome-extension://${b2.extensionId}/sidepanel.html?mode=popup&debug=1`, { waitUntil: "domcontentloaded" });
  const gt = await sp2.evaluate(() =>
    chrome.runtime.sendMessage({ type: "gateway.tasks" }).then((p) => JSON.stringify({ enabled: p?.enabled, state: p?.state })),
  );
  console.log("gateway.tasks:", gt);
  const dbg = await sp2.evaluate(() =>
    chrome.storage.local.get(["chromex.debug.gwClient", "chromex.debug.gwRuntime"]).then((r) => JSON.stringify(r)),
  );
  console.log("debug:", dbg?.slice(0, 1500));
  await sp2.close().catch(() => {});
} finally {
  await b2.context.close().catch(() => {});
  const { rm } = await import("node:fs/promises");
  await rm(b2.staged.root, { recursive: true, force: true }).catch(() => {});
  await rm(b1.staged.root, { recursive: true, force: true }).catch(() => {});
  await rm(b1.userDataDir, { recursive: true, force: true }).catch(() => {});
  await rm(gwHome, { recursive: true, force: true }).catch(() => {});
  await nmHost.restore().catch(() => {});
}
