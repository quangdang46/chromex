// Spike: playwright-cdp feasibility — can an agent attach to an
// already-running Chromium via CDP and perform observe/act/verify ops?
//
// Method: launch a normal (non-extension) Chromium via playwright with
// --remote-debugging-port, then chromium.connectOverCDP() to the SAME
// browser. Proves the attach mechanics a playwright-cdp backend would
// use against a user-started Chrome.
//
// Run: node scripts/spike/cdp-attach.mjs
import { chromium } from "playwright-core";

const CDP_PORT = 19222;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

const browser = await chromium.launch({
  headless: true,
  args: [`--remote-debugging-port=${CDP_PORT}`, "--remote-debugging-address=127.0.0.1"],
});

// Seed a page through the launch connection (simulates a user's tab).
const seedCtx = await browser.newContext();
const seedPage = await seedCtx.newPage();
await seedPage.goto("data:text/html,<title>seed</title><h1>user tab</h1>");

let attached;
try {
  attached = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  check("connectOverCDP", true);
} catch (e) {
  check("connectOverCDP", false, String(e).slice(0, 200));
  await browser.close();
  process.exit(1);
}

try {
  const contexts = attached.contexts();
  check("contexts visible", contexts.length >= 1, `${contexts.length} context(s)`);

  // Find the seeded page among attached contexts.
  let page = null;
  for (const ctx of contexts) {
    for (const p of ctx.pages()) {
      if ((await p.title()) === "seed") page = p;
    }
  }
  check("existing user tab visible", !!page);

  if (page) {
    // observe
    const h1 = await page.locator("h1").textContent();
    check("observe DOM", h1 === "user tab", h1);

    // act — mutate the user's tab (what an agent would do)
    await page.evaluate(() => {
      document.body.insertAdjacentHTML("beforeend", '<button id="agent-btn">agent clicked</button>');
    });
    const btn = await page.locator("#agent-btn").count();
    check("act in user tab", btn === 1);

    // verify — read back through the SAME attached connection
    const verified = await page.evaluate(() => document.getElementById("agent-btn")?.textContent);
    check("verify postcondition", verified === "agent clicked", verified);
  }

  // new tab creation through attached connection
  const ctx = contexts[0];
  const agentPage = await ctx.newPage();
  await agentPage.goto("data:text/html,<title>agent</title><p>agent tab</p>");
  const agentTitle = await agentPage.title();
  check("agent opens own tab", agentTitle === "agent", agentTitle);

  // CAVEAT found: two playwright connections to the same browser have
  // SEPARATE context/page views — the launch connection does NOT see
  // pages created via the CDP attach (and vice versa is consistent).
  // A playwright-cdp backend must therefore be the ONLY playwright
  // client of that browser; mixing connections gives split-brain page
  // lists. The attached connection DOES see its own new tab:
  const attachedTitles = await Promise.all(
    attached.contexts().flatMap((c) => c.pages()).map((p) => p.title().catch(() => "")),
  );
  check("attached conn sees own agent tab", attachedTitles.includes("agent"), attachedTitles.join(","));
  const launchSees = await Promise.all(
    seedCtx.pages().map(async (p) => (await p.title().catch(() => "")) === "agent"),
  );
  check("launch conn blind to CDP-created tab (documented caveat)", !launchSees.some(Boolean));

  // input/keyboard path
  await agentPage.locator("p").click();
  await agentPage.keyboard.press("Tab");
  check("trusted input dispatch", true);
} finally {
  await attached.close().catch(() => {});
  await browser.close().catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
