#!/usr/bin/env node
/**
 * Spike B4 — Playwright snapshot API verification (chromex-uuy).
 *
 * Verifies on real Chrome (channel:'chrome' fallback to bundled
 * chromium):
 *  1. page.accessibility.snapshot existence on pinned playwright-core
 *  2. locator.ariaSnapshot() output shape + iframe penetration
 *  3. per-frame ariaSnapshot for iframe content
 *  4. setInputFiles by path (upload) vs native filePicker
 *
 * Run: node scripts/spike/b4-playwright-snapshot.mjs
 * Exit 0 = all checks recorded (PASS/FAIL lines), findings printed.
 */

import { chromium } from "playwright-core";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
const check = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function launch() {
  try {
    return await chromium.launch({ headless: true, channel: "chrome" });
  } catch {
    return chromium.launch({ headless: true });
  }
}

const browser = await launch();
try {
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <button id="b1">Click me</button>
      <a href="/target">nav link</a>
      <input type="file" id="f">
      <iframe srcdoc="<button>inner-btn</button><p>frame text</p>"></iframe>
    </main>`);

  // 1. legacy a11y API
  check(
    "page.accessibility.snapshot exists",
    typeof page.accessibility?.snapshot === "function",
    `type=${typeof page.accessibility?.snapshot}`,
  );

  // 2. ariaSnapshot on body
  let aria = null;
  try {
    aria = await page.locator("body").ariaSnapshot();
    check("locator.ariaSnapshot() returns YAML tree", typeof aria === "string" && aria.includes("button"), aria.split("\n").length + " lines");
  } catch (e) {
    check("locator.ariaSnapshot() returns YAML tree", false, e.message.slice(0, 120));
  }

  // 3. iframe penetration: parent snapshot should NOT contain inner content
  const frames = page.frames();
  check("page.frames() exposes iframe", frames.length === 2, `${frames.length} frames`);
  let frameAria = null;
  try {
    frameAria = await frames[1].locator("body").ariaSnapshot();
    check("per-frame ariaSnapshot reads iframe content", frameAria?.includes("inner-btn") === true);
  } catch (e) {
    check("per-frame ariaSnapshot reads iframe content", false, e.message.slice(0, 120));
  }
  if (aria) {
    check("parent snapshot does not auto-pierce iframe", !aria.includes("inner-btn"));
  }

  // 4. upload: setInputFiles by path vs native picker
  const tmp = mkdtempSync(join(tmpdir(), "b4-"));
  const file = join(tmp, "upload.txt");
  writeFileSync(file, "b4");
  try {
    await page.locator("#f").setInputFiles(file);
    check("setInputFiles(path) uploads without picker", true);
  } catch (e) {
    check("setInputFiles(path) uploads without picker", false, e.message.slice(0, 120));
  }
  // native file picker cannot be driven — capability stays filePicker:false
  check("native filePicker not drivable (stays false)", true, "no API; setInputFiles covers upload:true");
} finally {
  await browser.close();
}

const failed = results.filter((r) => !r.pass);
console.log(`\nB4 spike: ${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
