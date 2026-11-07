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
 *  proto.unsupported — never faked. Exported so the Gateway can write
 *  the same set into MCP scope files/tokens (chromex-51ua): tools/list
 *  must advertise exactly what execute() will serve. */
export const PLAYWRIGHT_ISOLATED_SUPPORTED_TOOLS: ReadonlySet<BrowserToolName> = new Set([
  "browser.tabs.list",
  "browser.tab.activate",
  "browser.tab.close",
  "browser.tab.create",
  "browser.page.snapshot",
  "browser.page.get",
  "browser.page.extract",
  "browser.page.screenshot",
  "browser.page.console",
  "browser.page.click",
  "browser.page.focus",
  "browser.page.type",
  "browser.page.fill",
  "browser.page.select",
  "browser.page.submit",
  "browser.page.scroll",
  "browser.page.navigate",
  "browser.page.wait",
  "browser.page.hover",
  "browser.page.press",
  "browser.page.upload",
  "browser.page.find",
  "browser.page.history",
  // browser.downloads.list intentionally absent — download events are
  // not wired on this backend; the tool stays proto.unsupported.
]);

const MAX_CONSOLE_ENTRIES = 200;
const MAX_CONSOLE_TEXT = 1000;

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
  readonly supportedTools = [...PLAYWRIGHT_ISOLATED_SUPPORTED_TOOLS];

  readonly #opts: IsolatedBackendOptions;
  #pw: PwModule | null = null;
  #pwFailed = false;
  #browser: PwBrowser | null = null;
  /** taskId → isolated context (one context per task = session isolation) */
  readonly #contexts = new Map<string, PwBrowserContext>();
  /** page → bounded console buffer (page.on('console'/'pageerror')) */
  readonly #consoleBuffers = new Map<PwPage, Array<{ level: string; text: string; ts: number }>>();
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
      throw protocolError("browser.tab_not_found", `no isolated tab ${String(tabRef)}`);
    }
    // default: last page, or create one
    const last = pages[pages.length - 1];
    if (last) return last;
    return context.newPage();
  }

  /** Execute a browser tool on the isolated backend. Throws
   *  ProtocolError-coded failures; returns the tool result payload. */
  async execute(taskId: string, tool: BrowserToolName, args: Record<string, unknown>): Promise<unknown> {
    if (!PLAYWRIGHT_ISOLATED_SUPPORTED_TOOLS.has(tool)) {
      throw protocolError("proto.unsupported", `playwright-isolated does not support ${tool}`);
    }
    switch (tool) {
      case "browser.tabs.list":
        return this.#tabsList(taskId);
      case "browser.tab.activate":
        return this.#tabActivate(taskId, args);
      case "browser.tab.close":
        return this.#tabClose(taskId, args);
      case "browser.tab.create":
        return this.#tabCreate(taskId, args);
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
      case "browser.page.console":
        return this.#console(taskId, args);
      case "browser.page.click":
      case "browser.page.focus":
      case "browser.page.type":
      case "browser.page.fill":
      case "browser.page.select":
      case "browser.page.submit":
      case "browser.page.scroll":
      case "browser.page.hover":
      case "browser.page.press":
        return this.#domAction(taskId, tool, args);
      case "browser.page.wait":
        return this.#wait(taskId, args);
      case "browser.page.upload":
        return this.#upload(taskId, args);
      case "browser.page.find":
        return this.#find(taskId, args);
      case "browser.page.history":
        return this.#history(taskId, args);
      default:
        throw protocolError("proto.unsupported", `playwright-isolated does not support ${tool}`);
    }
  }

  // ---- tabs (isolated pages only — never the user's tabs) ----

  async #tabsList(taskId: string): Promise<unknown> {
    const context = await this.#contextFor(taskId);
    const pages = context.pages();
    // real titles — an empty string here would fake a loaded page state
    const titles = await Promise.all(pages.map((p) => p.title().catch(() => "")));
    return {
      tabs: pages.map((p, i) => ({
        tabId: i,
        url: stripQuery(p.url()),
        title: titles[i] ?? "",
        active: i === pages.length - 1,
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

  /** browser.tab.create — a new isolated page inside the task's context.
   *  tabId is the page index, matching tabs.list / #pageFor addressing. */
  async #tabCreate(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const context = await this.#contextFor(taskId);
    const url = typeof args.url === "string" ? args.url : "";
    if (url) {
      let protocol = "";
      try {
        protocol = new URL(url).protocol;
      } catch {
        protocol = "";
      }
      if (protocol !== "http:" && protocol !== "https:") {
        throw protocolError("proto.invalid", "browser.tab.create only supports http(s) urls");
      }
    }
    const page = await context.newPage();
    if (url) {
      await page.goto(url, { timeout: DEFAULT_NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    }
    const tabId = context.pages().indexOf(page);
    return {
      openedTabId: tabId,
      tabId,
      url: stripQuery(page.url()),
      title: await page.title(),
    };
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
      const b = boundText(aria ?? "", MAX_EXTRACT_CHARS);
      return { snapshot: b.text, truncated: b.truncated, url: stripQuery(page.url()) };
    } catch {
      const text = await page.locator("body").innerText().catch(() => "");
      const b = boundText(text, MAX_EXTRACT_CHARS);
      return { snapshot: b.text, truncated: b.truncated, url: stripQuery(page.url()) };
    }
  }

  async #get(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const key = typeof args.key === "string" ? args.key : "text";
    if (key === "text") {
      const text = await page.locator("body").innerText().catch(() => "");
      return { value: boundText(text, MAX_EXTRACT_CHARS).text, url: stripQuery(page.url()) };
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

  /** Lazily attach console/pageerror capture to a page; buffer lives on
   *  the Page object so it survives across tool calls until navigation
   *  or context close (Playwright keeps listeners per page). */
  #ensureConsoleCapture(page: PwPage): Array<{ level: string; text: string; ts: number }> {
    const existing = this.#consoleBuffers.get(page);
    if (existing) return existing;
    const buf: Array<{ level: string; text: string; ts: number }> = [];
    this.#consoleBuffers.set(page, buf);
    page.on("console", (msg) => {
      buf.push({ level: msg.type(), text: msg.text().slice(0, MAX_CONSOLE_TEXT), ts: Date.now() });
      if (buf.length > MAX_CONSOLE_ENTRIES) buf.splice(0, buf.length - MAX_CONSOLE_ENTRIES);
    });
    page.on("pageerror", (err) => {
      buf.push({ level: "error", text: String(err).slice(0, MAX_CONSOLE_TEXT), ts: Date.now() });
      if (buf.length > MAX_CONSOLE_ENTRIES) buf.splice(0, buf.length - MAX_CONSOLE_ENTRIES);
    });
    return buf;
  }

  async #console(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const buf = this.#ensureConsoleCapture(page);
    const level = typeof args.level === "string" ? args.level : "";
    const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.floor(args.limit), 1), MAX_CONSOLE_ENTRIES) : 100;
    const filtered = level ? buf.filter((e) => e.level === level) : buf;
    return { entries: filtered.slice(-limit), captured: true };
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
    // press may target the focused element/page with no selector —
    // page.keyboard.press is the honest equivalent.
    if (tool === "browser.page.press") {
      const key = typeof args.key === "string" ? args.key : "";
      if (!key) throw protocolError("proto.invalid", "browser.page.press requires args.key");
      const chord = pressChord(key, args.modifiers);
      const sel = args.selector ?? args.ref;
      if (typeof sel === "string" && sel.length > 0) {
        await page.locator(sel).first().press(chord, { timeout: DEFAULT_NAV_TIMEOUT_MS });
      } else {
        await page.keyboard.press(chord);
      }
      return { pressed: key };
    }
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
      case "browser.page.hover":
        await locator.hover({ timeout: DEFAULT_NAV_TIMEOUT_MS });
        return { hovered: true };
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
    const started = Date.now();
    const timeout = typeof args.timeoutMs === "number" ? args.timeoutMs : typeof args.ms === "number" ? args.ms : 10_000;
    const deadline = started + Math.min(timeout, 30_000);
    const selector = typeof args.selector === "string" ? args.selector : null;
    const urlContains = typeof args.urlContains === "string" ? args.urlContains : null;
    const text = typeof args.text === "string" ? args.text : null;
    const textGone = typeof args.textGone === "string" ? args.textGone : null;
    const hasCondition = selector !== null || urlContains !== null || text !== null || textGone !== null;
    if (!hasCondition) {
      // plain timed wait — same contract as the extension host's ms sleep
      await page.waitForTimeout(Math.min(timeout, 30_000));
      return { ok: true, waitedMs: Math.min(timeout, 30_000) };
    }
    for (;;) {
      if (selector) {
        const count = await page.locator(selector).count().catch(() => 0);
        if (count === 0) {
          if (Date.now() >= deadline) {
            throw protocolError("browser.timeout", "wait condition not met before timeout");
          }
          await page.waitForTimeout(100);
          continue;
        }
      }
      if (urlContains && !page.url().includes(urlContains)) {
        if (Date.now() >= deadline) {
          throw protocolError("browser.timeout", "wait condition not met before timeout");
        }
        await page.waitForTimeout(100);
        continue;
      }
      if (text !== null || textGone !== null) {
        const bodyText = await page.locator("body").innerText().catch(() => "");
        if (text !== null && !bodyText.includes(text)) {
          if (Date.now() >= deadline) {
            throw protocolError("browser.timeout", "wait condition not met before timeout");
          }
          await page.waitForTimeout(100);
          continue;
        }
        if (textGone !== null && bodyText.includes(textGone)) {
          if (Date.now() >= deadline) {
            throw protocolError("browser.timeout", "wait condition not met before timeout");
          }
          await page.waitForTimeout(100);
          continue;
        }
      }
      return { ok: true, matched: "conditions", elapsedMs: Date.now() - started };
    }
  }

  /** browser.page.history — page.goBack/goForward/reload parity with
   *  chrome.tabs.goBack/goForward/reload on the extension host. */
  async #history(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const action = typeof args.action === "string" ? args.action : "";
    // goBack/goForward resolve null when there is no history entry —
    // report that honestly instead of claiming a navigation.
    let moved: boolean | null = null;
    if (action === "back") {
      moved = (await page.goBack({ timeout: DEFAULT_NAV_TIMEOUT_MS }).catch(() => null)) !== null;
    } else if (action === "forward") {
      moved = (await page.goForward({ timeout: DEFAULT_NAV_TIMEOUT_MS }).catch(() => null)) !== null;
    } else if (action === "reload") {
      await page.reload({ timeout: DEFAULT_NAV_TIMEOUT_MS });
      moved = true;
    } else {
      throw protocolError("proto.invalid", "browser.page.history requires args.action back|forward|reload");
    }
    return { navigated: action, ...(moved !== null ? { moved } : {}), url: stripQuery(page.url()) };
  }

  /** browser.page.find — bounded DOM text search. No content-side ref
   *  map exists on this backend, so matches carry selectors + text only
   *  (the "bounded text matches with selectors" fallback). */
  async #find(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const text = typeof args.text === "string" ? args.text : null;
    const regex = typeof args.regex === "string" ? args.regex : null;
    if (!text && !regex) {
      throw protocolError("proto.invalid", "browser.page.find requires args.text or args.regex");
    }
    if (regex) {
      try {
        new RegExp(regex, args.caseSensitive === true ? "" : "i");
      } catch {
        throw protocolError("proto.invalid", "browser.page.find args.regex is not a valid pattern");
      }
    }
    const limit = typeof args.limit === "number" && Number.isFinite(args.limit)
      ? Math.min(Math.max(Math.floor(args.limit), 1), 200)
      : 50;
    const scopeSelector = typeof args.scopeSelector === "string" ? args.scopeSelector : null;
    const matches = (await page.evaluate(
      ({ text, regex, caseSensitive, limit, scopeSelector }) => {
        const flags = caseSensitive ? "" : "i";
        let matcher: (haystack: string) => boolean;
        if (regex) {
          const re = new RegExp(regex, flags);
          matcher = (h) => re.test(h);
        } else {
          const needle = caseSensitive ? (text as string) : (text as string).toLowerCase();
          matcher = (h) => (caseSensitive ? h.includes(needle) : h.toLowerCase().includes(needle));
        }
        let root: ParentNode = document;
        if (scopeSelector) {
          try {
            root = document.querySelector(scopeSelector) ?? document;
          } catch {
            root = document;
          }
        }
        const out: Array<{ selector: string; tagName: string; role: string; text: string }> = [];
        const matched: Element[] = [];
        const candidates = root.querySelectorAll("*");
        const scanned = Math.min(candidates.length, 5000);
        for (let i = 0; i < scanned && out.length < limit; i++) {
          const el = candidates[i] as HTMLElement;
          if (!(el instanceof HTMLElement)) continue;
          const raw = el.textContent ?? "";
          if (!raw || raw.length > 200000) continue;
          const haystack = raw.replace(/\s+/g, " ").trim();
          if (!haystack || !matcher(haystack)) continue;
          if (matched.some((prev) => prev.contains(el))) continue;
          matched.push(el);
          const id = el.id ? `#${CSS.escape(el.id)}` : "";
          const cls =
            typeof el.className === "string" && el.className.trim()
              ? "." + el.className.trim().split(/\s+/).slice(0, 2).map((c) => CSS.escape(c)).join(".")
              : "";
          out.push({
            selector: `${el.tagName.toLowerCase()}${id}${cls}`,
            tagName: el.tagName.toLowerCase(),
            role: el.getAttribute("role") ?? "",
            text: haystack.slice(0, 240),
          });
        }
        return { matches: out, scanned, truncated: candidates.length > scanned };
      },
      { text, regex, caseSensitive: args.caseSensitive === true, limit, scopeSelector },
    )) as { matches?: unknown[]; scanned?: number; truncated?: boolean } | undefined;
    return {
      ok: true,
      matches: Array.isArray(matches?.matches) ? matches.matches : [],
      scanned: matches?.scanned ?? 0,
      truncated: matches?.truncated === true,
    };
  }

  async #upload(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    // playwright path = setInputFiles — file bytes via {name,mimeType,
    // buffer} or local paths. NOT the user's native picker (capability
    // filePicker:false already reflects this).
    const page = await this.#pageFor(taskId, args);
    const selector = await this.#requireSelector(args);
    const raw = Array.isArray(args.files) ? args.files : [];
    if (raw.length === 0) {
      throw protocolError("proto.invalid", "browser.page.upload requires args.files[]");
    }
    const files = raw.map((entry) => {
      if (typeof entry === "string") return entry;
      const o = (entry ?? {}) as Record<string, unknown>;
      if (typeof o.base64 === "string" && o.base64.length > 0) {
        return {
          name: typeof o.name === "string" && o.name ? o.name : "file",
          mimeType: typeof o.mimeType === "string" ? o.mimeType : "",
          buffer: Buffer.from(o.base64, "base64"),
        };
      }
      if (typeof o.path === "string" && o.path) return o.path;
      throw protocolError("proto.invalid", "upload file entries require {name, mimeType, base64} or a path");
    });
    await page.locator(selector).first().setInputFiles(files as never);
    return { uploaded: files.length };
  }

  // ---- lifecycle ----

  /** Release a task's isolated context (task.purge / shutdown). */
  async releaseTask(taskId: string): Promise<void> {
    const ctx = this.#contexts.get(taskId);
    this.#contexts.delete(taskId);
    for (const p of ctx?.pages() ?? []) this.#consoleBuffers.delete(p);
    await ctx?.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const ctx of this.#contexts.values()) await ctx.close().catch(() => {});
    this.#contexts.clear();
    this.#consoleBuffers.clear();
    await this.#browser?.close().catch(() => {});
    this.#browser = null;
  }
}

const PRESS_MODIFIERS = new Set(["control", "alt", "shift", "meta"]);

/** Build a Playwright chord ("Control+Shift+A") from key + modifier args.
 *  Modifier names are case-insensitive; unknown entries are dropped. */
function pressChord(key: string, modifiers: unknown): string {
  const mods = new Set<string>();
  if (Array.isArray(modifiers)) {
    for (const m of modifiers) {
      if (typeof m !== "string") continue;
      const lower = m.toLowerCase();
      if (PRESS_MODIFIERS.has(lower)) mods.add(m[0]!.toUpperCase() + m.slice(1).toLowerCase());
    }
  }
  const order = ["Control", "Alt", "Shift", "Meta"];
  const prefix = order.filter((m) => mods.has(m)).join("+");
  return prefix ? `${prefix}+${key}` : key;
}

function boundText(text: string, max: number): { text: string; truncated: boolean } {
  return text.length > max ? { text: text.slice(0, max), truncated: true } : { text, truncated: false };
}

/** Never leak query strings into tool results (§privacy). */
function stripQuery(url: string): string {
  // data:/blob: URLs embed their entire payload — never echo them back
  if (url.startsWith("data:") || url.startsWith("blob:")) return url.slice(0, url.indexOf(":") + 1);
  try {
    const u = new URL(url);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return url.split(/[?#]/)[0] ?? url;
  }
}
