// probe-sw-reload — minimal repro: does chrome.runtime.reload() recovery
// work at all on this Chromium/Windows? Polls SW + retries navigation.
import { launchChromiumWithExtension } from "./lib/harness.mjs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const gwHome = await mkdtemp(join(tmpdir(), "chromex-probe-gw-"));
const browser = await launchChromiumWithExtension({ gatewayHome: gwHome, headless: true });
const { context, extensionId } = browser;
const url = `chrome-extension://${extensionId}/sidepanel.html?mode=popup&debug=1`;

try {
  const sp = await context.newPage();
  await sp.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 });
  console.log("initial sidepanel OK");
  const swsBefore = context.serviceWorkers();
  console.log(`sws before reload: ${swsBefore.length}`);
  try {
    await sp.evaluate(() => chrome.runtime.reload());
  } catch (e) {
    console.log(`reload evaluate threw (expected): ${String(e?.message ?? e).slice(0, 120)}`);
  }
  await sp.close().catch(() => {});

  const deadline = Date.now() + 120_000;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const sws = context.serviceWorkers();
    const fresh = sws.filter((w) => !swsBefore.includes(w));
    console.log(`t=${Math.round((120_000 - (deadline - Date.now())) / 1000)}s sws=${sws.length} fresh=${fresh.length} urls=${sws.map((w) => w.url().split("/").pop()).join(",")}`);
    if (fresh.length > 0) {
      console.log("NEW SW UP:", fresh[0].url());
      break;
    }
    // every ~15s try waking via navigation
    if (attempt % 8 === 0) {
      try {
        const p = await context.newPage();
        await p.goto(url, { waitUntil: "domcontentloaded", timeout: 15_000 });
        console.log("wake goto OK");
        await p.close().catch(() => {});
      } catch (e) {
        console.log(`wake goto failed: ${String(e?.message ?? e).split("\n")[0]}`);
      }
    }
    await sleep(2_000);
  }
  console.log("final sws:", context.serviceWorkers().map((w) => w.url()));
} finally {
  await browser.cleanup();
}
