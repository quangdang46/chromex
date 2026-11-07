/**
 * PlaywrightIsolatedBackend — plan §6.5/P2-07.
 *
 * Executes browser tools on a dedicated Chromium instance with a fresh
 * isolated BrowserContext: NO user cookies, NO user tabs, NO access to
 * the user's logged-in session. `playwright-core` is lazy-loaded — an
 * absent package surfaces `browser.backend_unavailable`, never a crash.
 *
 * Role separation (§6.5): PlaywrightRuntimeManager (detect/install) is
 * untouched; this class is the execution backend; dev driver scripts
 * and the gateway dependency stay where they are.
 */

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BACKEND_CAPABILITIES,
  effectiveBackendCapabilities,
  protocolError,
  type BrowserBackend,
  type BrowserBackendCapabilities,
  type BrowserToolName,
} from "@codex-sidepanel/shared";

const MODULE_REQUIRE = createRequire(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../../package.json"),
);

/** Tools this backend can execute honestly. Everything else returns
 *  proto.unsupported — never faked. */
const SUPPORTED_TOOLS: ReadonlySet<BrowserToolName> = new Set([
  "browser.tabs.list",
  "browser.tab.activate",
  "browser.tab.close",
  "browser.page.snapshot",
  "browser.page.get",
  "browser.page.extract",
  "browser.page.screenshot",
  "browser.page.click",
  "browser.page.focus",
  "browser.page.type",
  "browser.page.fill",
  "browser.page.select",
  "browser.page.submit",
  "browser.page.scroll",
  "browser.page.navigate",
  "browser.page.wait",
  "browser.page.upload",
]);

const MAX_EXTRACT_CHARS = 64 * 1024;
const DEFAULT_NAV_TIMEOUT_MS = 30_000;

type PwModule = typeof import("playwright-core");
type PwBrowser = import("playwright-core").Browser;
type PwBrowserContext = import("playwright-core").BrowserContext;
type PwPage = import("playwright-core").Page;

export interface IsolatedBackendOptions {
  /** injectable for tests — defaults to lazy createRequire import */
  loadPlaywright?: () => Promise<PwModule>;
  /** chromium executable override (from PlaywrightRuntimeManager) */
  executablePath?: () => Promise<string | null>;
  /** launch args for tests (e.g. headless) */
  launchOptions?: Record<string, unknown>;
}

export class PlaywrightIsolatedBackend implements BrowserBackend {
  readonly id = "playwright-isolated" as const;
  readonly capabilities: BrowserBackendCapabilities =
    DEFAULT_BACKEND_CAPABILITIES["playwright-isolated"];
  readonly supportedTools = [...SUPPORTED_TOOLS];

  readonly #opts: IsolatedBackendOptions;
  #pw: PwModule | null = null;
  #pwFailed = false;
  #browser: PwBrowser | null = null;
  /** taskId → isolated context (one context per task = session isolation) */
  readonly #contexts = new Map<string, PwBrowserContext>();
  #closed = false;

  constructor(opts: IsolatedBackendOptions = {}) {
    this.#opts = opts;
  }

  /** Lazy-load playwright-core; absent dep → browser.backend_unavailable. */
  async #playwright(): Promise<PwModule> {
    if (this.#pw) return this.#pw;
    if (this.#pwFailed) {
      throw protocolError("browser.backend_unavailable", "playwright-core is not installed");
    }
    try {
      const load = this.#opts.loadPlaywright ?? (async () => MODULE_REQUIRE("playwright-core") as PwModule);
      this.#pw = await load();
      return this.#pw;
    } catch {
      this.#pwFailed = true;
      throw protocolError("browser.backend_unavailable", "playwright-core is not installed");
    }
  }

  async #ensureBrowser(): Promise<PwBrowser> {
    if (this.#closed) {
      throw protocolError("browser.backend_unavailable", "backend is closed");
    }
    if (this.#browser?.isConnected()) return this.#browser;
    const pw = await this.#playwright();
    const executablePath = await this.#opts.executablePath?.().catch(() => null);
    this.#browser = await pw.chromium.launch({
      ...(executablePath ? { executablePath } : {}),
      ...(this.#opts.launchOptions ?? {}),
    });
    return this.#browser;
  }

  /** One isolated context per task — fresh storage/cookies every task,
   *  so nothing leaks between tasks or into the user's real profile. */
  async #contextFor(taskId: string): Promise<PwBrowserContext> {
    const existing = this.#contexts.get(taskId);
    if (existing) return existing;
    const browser = await this.#ensureBrowser();
    const context = await browser.newContext();
    this.#contexts.set(taskId, context);
    return context;
  }

  async #pageFor(taskId: string, args: Record<string, unknown>): Promise<PwPage> {
    const context = await this.#contextFor(taskId);
    const pages = context.pages();
    const tabRef = args.tabId ?? args.tabRef;
    if (typeof tabRef === "string" || typeof tabRef === "number") {
      const idx = Number(tabRef);
      const page = pages[idx];
      if (page) return page;
      throw protocolError("browser.element_not_found", `no isolated tab ${String(tabRef)}`);
    }
    // default: last page, or create one
    const last = pages[pages.length - 1];
    if (last) return last;
    return context.newPage();
  }

  /** Execute a browser tool on the isolated backend. Throws
   *  ProtocolError-coded failures; returns the tool result payload. */
  async execute(taskId: string, tool: BrowserToolName, args: Record<string, unknown>): Promise<unknown> {
    if (!SUPPORTED_TOOLS.has(tool)) {
      throw protocolError("proto.unsupported", `playwright-isolated does not support ${tool}`);
    }
    switch (tool) {
      case "browser.tabs.list":
        return this.#tabsList(taskId);
      case "browser.tab.activate":
        return this.#tabActivate(taskId, args);
      case "browser.tab.close":
        return this.#tabClose(taskId, args);
      case "browser.page.navigate":
        return this.#navigate(taskId, args);
      case "browser.page.snapshot":
        return this.#snapshot(taskId, args);
      case "browser.page.get":
        return this.#get(taskId, args);
      case "browser.page.extract":
        return this.#extract(taskId, args);
      case "browser.page.screenshot":
        return this.#screenshot(taskId, args);
      case "browser.page.click":
      case "browser.page.focus":
      case "browser.page.type":
      case "browser.page.fill":
      case "browser.page.select":
      case "browser.page.submit":
      case "browser.page.scroll":
        return this.#domAction(taskId, tool, args);
      case "browser.page.wait":
        return this.#wait(taskId, args);
      case "browser.page.upload":
        return this.#upload(taskId, args);
      default:
        throw protocolError("proto.unsupported", `playwright-isolated does not support ${tool}`);
    }
  }

  // ---- tabs (isolated pages only — never the user's tabs) ----

  async #tabsList(taskId: string): Promise<unknown> {
    const context = await this.#contextFor(taskId);
    return {
      tabs: context.pages().map((p, i) => ({
        tabId: i,
        url: stripQuery(p.url()),
        title: "",
        active: i === context.pages().length - 1,
      })),
    };
  }

  async #tabActivate(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    await page.bringToFront();
    return { activated: true };
  }

  async #tabClose(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    await page.close();
    return { closed: true };
  }

  // ---- navigation / observation ----

  async #navigate(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const url = typeof args.url === "string" ? args.url : "";
    if (!url) throw protocolError("proto.invalid", "browser.page.navigate requires args.url");
    const page = await this.#pageFor(taskId, args);
    await page.goto(url, { timeout: DEFAULT_NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    return { url: stripQuery(page.url()), title: await page.title() };
  }

  async #snapshot(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    // aria snapshot per spike-B4; bounded text fallback
    try {
      const aria = await page.locator("body").ariaSnapshot();
      return { snapshot: boundText(aria ?? "", MAX_EXTRACT_CHARS), url: stripQuery(page.url()) };
    } catch {
      const text = await page.locator("body").innerText().catch(() => "");
      return { snapshot: boundText(text, MAX_EXTRACT_CHARS), url: stripQuery(page.url()) };
    }
  }

  async #get(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const key = typeof args.key === "string" ? args.key : "text";
    if (key === "text") {
      const text = await page.locator("body").innerText().catch(() => "");
      return { value: boundText(text, MAX_EXTRACT_CHARS), url: stripQuery(page.url()) };
    }
    if (key === "title") return { value: await page.title(), url: stripQuery(page.url()) };
    if (key === "url") return { value: stripQuery(page.url()) };
    throw protocolError("proto.invalid", `unsupported page.get key ${key}`);
  }

  async #extract(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const selector = typeof args.selector === "string" ? args.selector : "body";
    const maxChars = typeof args.maxChars === "number" ? args.maxChars : MAX_EXTRACT_CHARS;
    const text = await page.locator(selector).first().innerText().catch(() => "");
    const bounded = boundText(text, Math.min(maxChars, MAX_EXTRACT_CHARS));
    return { text: bounded.text, truncated: bounded.truncated, url: stripQuery(page.url()) };
  }

  async #screenshot(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const buf = await page.screenshot({ type: "png" });
    // artifact-backed: return base64 bounded — caller (tool-server/host
    // channel) persists via artifact.upload; never inline unbounded.
    return { dataBase64: buf.toString("base64"), mimeType: "image/png", bytes: buf.length };
  }

  // ---- DOM actions ----

  async #requireSelector(args: Record<string, unknown>): Promise<string> {
    const sel = args.selector ?? args.ref;
    if (typeof sel !== "string" || !sel) {
      throw protocolError("proto.invalid", "dom action requires args.selector");
    }
    return sel;
  }

  async #domAction(taskId: string, tool: BrowserToolName, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const selector = await this.#requireSelector(args);
    const locator = page.locator(selector).first();
    switch (tool) {
      case "browser.page.click":
        await locator.click({ timeout: DEFAULT_NAV_TIMEOUT_MS });
        return { clicked: true };
      case "browser.page.focus":
        await locator.focus();
        return { focused: true };
      case "browser.page.type": {
        const text = typeof args.text === "string" ? args.text : "";
        await locator.pressSequentially(text);
        return { typed: text.length };
      }
      case "browser.page.fill": {
        const text = typeof args.text === "string" ? args.text : "";
        await locator.fill(text);
        return { filled: true };
      }
      case "browser.page.select": {
        const value = typeof args.value === "string" ? args.value : "";
        await locator.selectOption(value);
        return { selected: value };
      }
      case "browser.page.submit":
        await locator.evaluate((el) => {
          const form = (el as HTMLElement).closest("form");
          if (form) (form as HTMLFormElement).requestSubmit();
        });
        return { submitted: true };
      case "browser.page.scroll": {
        const dir = typeof args.direction === "string" ? args.direction : "down";
        await page.mouse.wheel(0, dir === "up" ? -600 : 600);
        return { scrolled: dir };
      }
      default:
        throw protocolError("proto.unsupported", `unsupported dom action ${tool}`);
    }
  }

  async #wait(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const timeout = typeof args.timeoutMs === "number" ? args.timeoutMs : 10_000;
    const selector = typeof args.selector === "string" ? args.selector : null;
    const urlContains = typeof args.urlContains === "string" ? args.urlContains : null;
    const deadline = Date.now() + Math.min(timeout, 60_000);
    for (;;) {
      if (selector) {
        const count = await page.locator(selector).count().catch(() => 0);
        if (count > 0) return { satisfied: "selector", selector };
      }
      if (urlContains && page.url().includes(urlContains)) {
        return { satisfied: "url", url: stripQuery(page.url()) };
      }
      if (!selector && !urlContains) {
        // plain timed wait
        await page.waitForTimeout(Math.min(timeout, deadline - Date.now()));
        return { satisfied: "timeout" };
      }
      if (Date.now() >= deadline) {
        throw protocolError("browser.element_not_found", "wait condition not met before timeout");
      }
      await page.waitForTimeout(100);
    }
  }

  async #upload(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    // playwright path = setInputFiles by path — NOT the user's native
    // picker (capability filePicker:false already reflects this).
    const page = await this.#pageFor(taskId, args);
    const selector = await this.#requireSelector(args);
    const files = Array.isArray(args.files) ? args.files.filter((f): f is string => typeof f === "string") : [];
    if (files.length === 0) {
      throw protocolError("proto.invalid", "browser.page.upload requires args.files[] paths");
    }
    await page.locator(selector).first().setInputFiles(files);
    return { uploaded: files.length };
  }

  // ---- lifecycle ----

  /** Release a task's isolated context (task.purge / shutdown). */
  async releaseTask(taskId: string): Promise<void> {
    const ctx = this.#contexts.get(taskId);
    this.#contexts.delete(taskId);
    await ctx?.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const ctx of this.#contexts.values()) await ctx.close().catch(() => {});
    this.#contexts.clear();
    await this.#browser?.close().catch(() => {});
    this.#browser = null;
  }
}

function boundText(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/** Never leak query strings into tool results (§privacy). */
function stripQuery(url: string): string {
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}
