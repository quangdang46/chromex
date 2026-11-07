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

import { existsSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BACKEND_CAPABILITIES,
  effectiveBackendCapabilities,
  protocolError,
  type BrowserBackend,
  type BrowserBackendCapabilities,
  type BrowserExpectCondition,
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
  "browser.page.drag",
  "browser.page.upload",
  "browser.page.find",
  "browser.page.history",
  "browser.page.network",
  "browser.downloads.list",
  "browser.downloads.save",
]);

const MAX_CONSOLE_ENTRIES = 200;
const MAX_CONSOLE_TEXT = 1000;
const MAX_NETWORK_ENTRIES = 500;
const MAX_URL_LEN = 2000;
const MAX_MIME_LEN = 200;

const MAX_EXTRACT_CHARS = 64 * 1024;
const DEFAULT_NAV_TIMEOUT_MS = 30_000;
/** Screenshot inline-payload bound — mirrors the gateway artifact.upload
 *  decoded cap (512KiB, packages/bridge/src/gateway/main.ts). */
const SCREENSHOT_MAX_BYTES = 512 * 1024;
const SCREENSHOT_JPEG_QUALITIES = [70, 45, 25] as const;

type PwModule = typeof import("playwright-core");
type PwBrowser = import("playwright-core").Browser;
type PwBrowserContext = import("playwright-core").BrowserContext;
type PwPage = import("playwright-core").Page;
type PwDownload = import("playwright-core").Download;
type PwRequest = import("playwright-core").Request;

/** One observed network request — mirrors browser.page.network entries
 *  on chrome-extension (metadata only, bodies never captured). */
interface NetworkLogEntry {
  method: string;
  url: string;
  type: string;
  status?: number;
  error?: string;
  mimeType?: string;
  ts: number;
}

/** One observed download on the isolated backend — mirrors the fields
 *  browser.downloads.list returns on chrome-extension. `path` is the
 *  absolute on-disk location after saveAs (null until saved). */
interface DownloadLogEntry {
  id: number;
  url: string;
  suggestedFilename: string;
  state: "in_progress" | "complete" | "interrupted";
  startTime: number;
  path: string | null;
  error: string | null;
  download: PwDownload;
}

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
  /** taskId → last page explicitly bringToFront'd — playwright has no
   *  real "active tab" concept; this is the closest honest signal. */
  readonly #activePages = new Map<string, PwPage>();
  /** page → bounded console buffer (page.on('console'/'pageerror')) */
  readonly #consoleBuffers = new Map<PwPage, Array<{ level: string; text: string; ts: number }>>();
  /** taskId → observed downloads (context 'download' events + saveAs) */
  readonly #downloadLogs = new Map<string, DownloadLogEntry[]>();
  #downloadSeq = 0;
  /** page → bounded network metadata buffer (request/response/failed) */
  readonly #networkBuffers = new Map<PwPage, NetworkLogEntry[]>();
  /** in-flight request → its log entry, for status/error/mime backfill */
  readonly #pendingRequests = new Map<PwRequest, NetworkLogEntry>();
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
    return this.#trackPage(await context.newPage());
  }

  /** Execute a browser tool on the isolated backend. Throws
   *  ProtocolError-coded failures; returns the tool result payload. */
  async execute(taskId: string, tool: BrowserToolName, args: Record<string, unknown>): Promise<unknown> {
    if (!PLAYWRIGHT_ISOLATED_SUPPORTED_TOOLS.has(tool)) {
      throw protocolError("proto.unsupported", `playwright-isolated does not support ${tool}`);
    }
    // chromex-0fza: a malformed args.expect must fail BEFORE the action
    // dispatches — #withExpect re-parses after the fact for the poll.
    if (EXPECTABLE_TOOLS.has(tool)) parseExpectCondition(args.expect);
    // args.frameId targets a subframe — playwright locators do not pierce
    // frame boundaries, so silently ignoring it would act on the TOP
    // document while the caller believes it targeted the iframe. Refuse
    // honestly until frameLocator support lands.
    if (typeof args.frameId === "number" && args.frameId !== 0) {
      throw protocolError(
        "proto.unsupported",
        "args.frameId is not supported on playwright-isolated (frame locators unimplemented)",
      );
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
        return this.#withExpect(taskId, args, await this.#navigate(taskId, args));
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
      case "browser.page.drag":
        return this.#withExpect(taskId, args, await this.#domAction(taskId, tool, args));
      case "browser.page.wait":
        return this.#wait(taskId, args);
      case "browser.page.upload":
        return this.#withExpect(taskId, args, await this.#upload(taskId, args));
      case "browser.page.find":
        return this.#find(taskId, args);
      case "browser.page.network":
        return this.#network(taskId, args);
      case "browser.page.history":
        return this.#history(taskId, args);
      case "browser.downloads.list":
        return this.#downloadsList(taskId, args);
      case "browser.downloads.save":
        return this.#downloadsSave(taskId, args);
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
    const active = this.#activePages.get(taskId) ?? pages[pages.length - 1];
    return {
      tabs: pages.map((p, i) => ({
        tabId: i,
        url: stripQuery(p.url()),
        title: titles[i] ?? "",
        active: p === active,
      })),
    };
  }

  async #tabActivate(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    await page.bringToFront();
    this.#activePages.set(taskId, page);
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
    // isolated context has no windows — refuse rather than silently drop
    if (args.windowId !== undefined) {
      throw protocolError("proto.unsupported", "playwright-isolated has no windows; args.windowId is chrome-extension only");
    }
    // pin/mute are chrome tab-strip state with no playwright equivalent —
    // silently dropping them would lie about the created tab's state.
    if (args.pinned !== undefined || args.muted !== undefined) {
      throw protocolError("proto.unsupported", "playwright-isolated cannot pin or mute tabs; args.pinned/args.muted are chrome-extension only");
    }
    const page = this.#trackPage(await context.newPage());
    this.#activePages.set(taskId, page);
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
    // Same contract as the extension host's performNavigateAction —
    // http(s) only; file:/javascript: would bypass the egress model.
    let protocol = "";
    try {
      protocol = new URL(url).protocol;
    } catch {
      protocol = "";
    }
    if (protocol !== "http:" && protocol !== "https:") {
      throw protocolError("proto.invalid", "browser.page.navigate only supports http(s) urls");
    }
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
    // Scroll/viewport parity with the extension host's page.scrollpos
    // probe — evaluate is backend-internal, not the agent-facing tool.
    const scroll = await page
      .evaluate(() => ({
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
      }))
      .catch(() => undefined);
    const context = await this.#contextFor(taskId);
    const base = {
      tabId: context.pages().indexOf(page),
      url: stripQuery(page.url()),
      ...(scroll ? { scroll } : {}),
    };
    if (key === "text") {
      const text = await page.locator("body").innerText().catch(() => "");
      return { value: boundText(text, MAX_EXTRACT_CHARS).text, ...base };
    }
    if (key === "title") return { value: await page.title(), ...base };
    if (key === "url") return { value: stripQuery(page.url()) };
    throw protocolError("proto.invalid", `unsupported page.get key ${key}`);
  }

  async #extract(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const selector = typeof args.selector === "string" && args.selector ? args.selector : "body";
    const maxChars = typeof args.maxChars === "number" ? args.maxChars : MAX_EXTRACT_CHARS;
    const format = args.format === undefined ? "text" : args.format === "html" ? "html" : null;
    if (format === null) {
      throw protocolError("proto.invalid", "browser.page.extract args.format must be text|html");
    }
    const locator = page.locator(selector).first();
    const raw =
      format === "html"
        ? await locator.evaluate((el) => (el as Element).outerHTML).catch(() => "")
        : await locator.innerText().catch(() => "");
    const bounded = boundText(raw, Math.min(maxChars, MAX_EXTRACT_CHARS));
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

  /** Attach observation listeners at page birth so navigation-time
   *  requests/console messages are captured — lazy attach would miss the
   *  very first page load. */
  #trackPage(page: PwPage): PwPage {
    // fake pages in unit tests may not implement the event emitter API
    if (typeof page.on !== "function") return page;
    this.#ensureConsoleCapture(page);
    this.#ensureNetworkCapture(page);
    return page;
  }

  async #console(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const buf = this.#ensureConsoleCapture(page);
    const level = typeof args.level === "string" ? args.level : "";
    const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.floor(args.limit), 1), MAX_CONSOLE_ENTRIES) : 100;
    // playwright msg.type() emits "warning"; the extension host records
    // the console method name "warn" — accept both spellings.
    const wanted = level === "warn" ? "warning" : level;
    const filtered = wanted ? buf.filter((e) => e.level === wanted) : buf;
    return { entries: filtered.slice(-limit), captured: true };
  }

  /** Lazily attach request/response/requestfailed capture to a page.
   *  Entries appear on request fire; status/mime backfill when the
   *  response (or failure) arrives — same metadata-only contract as the
   *  extension's webRequest log. */
  #ensureNetworkCapture(page: PwPage): NetworkLogEntry[] {
    const existing = this.#networkBuffers.get(page);
    if (existing) return existing;
    const buf: NetworkLogEntry[] = [];
    this.#networkBuffers.set(page, buf);
    const push = (entry: NetworkLogEntry) => {
      buf.push(entry);
      if (buf.length > MAX_NETWORK_ENTRIES) buf.splice(0, buf.length - MAX_NETWORK_ENTRIES);
    };
    page.on("request", (req) => {
      const entry: NetworkLogEntry = {
        method: req.method(),
        url: stripQuery(req.url()).slice(0, MAX_URL_LEN),
        type: req.resourceType(),
        ts: Date.now(),
      };
      push(entry);
      this.#pendingRequests.set(req, entry);
    });
    page.on("response", (res) => {
      const entry = this.#pendingRequests.get(res.request());
      this.#pendingRequests.delete(res.request());
      if (!entry) return;
      entry.status = res.status();
      const mime = res.headers()["content-type"];
      if (mime) entry.mimeType = mime.split(";")[0]!.slice(0, MAX_MIME_LEN);
    });
    page.on("requestfailed", (req) => {
      const entry = this.#pendingRequests.get(req);
      this.#pendingRequests.delete(req);
      if (!entry) return;
      entry.error = (req.failure()?.errorText ?? "failed").slice(0, MAX_CONSOLE_TEXT);
    });
    return buf;
  }

  async #network(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const buf = this.#ensureNetworkCapture(page);
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(Math.max(Math.floor(args.limit), 1), 200)
        : 50;
    const status = typeof args.status === "string" ? args.status : "";
    if (status && status !== "error" && !/^[245]xx$/.test(status)) {
      throw protocolError("proto.invalid", "browser.page.network args.status must be error|2xx|4xx|5xx");
    }
    const urlContains = typeof args.urlContains === "string" ? args.urlContains : "";
    const type = typeof args.type === "string" ? args.type : "";
    const filtered = buf
      .filter((e) => !urlContains || e.url.includes(urlContains))
      .filter((e) => !type || e.type === type)
      .filter((e) => {
        if (!status) return true;
        if (status === "error") return e.error !== undefined || (e.status === undefined && e.ts < Date.now());
        if (e.status === undefined) return false;
        const cls = `${Math.floor(e.status / 100)}xx`;
        return status === cls;
      })
      // newest first — the extension returns newest-first too
      .reverse()
      .slice(0, limit)
      .map((e) => ({ ...e }));
    return { requests: filtered, captured: true };
  }

  async #screenshot(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    // chromex-22wi: the result IS the provider's image input — there is
    // no artifact.upload channel on this backend, so the payload must be
    // bounded inline. Same 512KiB decoded ceiling the gateway artifact
    // store enforces; retry at lower jpeg quality, then fail honestly.
    for (const quality of SCREENSHOT_JPEG_QUALITIES) {
      const buf = await page.screenshot({ type: "jpeg", quality });
      if (buf.length <= SCREENSHOT_MAX_BYTES) {
        return { dataBase64: buf.toString("base64"), mimeType: "image/jpeg", bytes: buf.length };
      }
    }
    throw protocolError(
      "artifact.too_large",
      `screenshot exceeds ${SCREENSHOT_MAX_BYTES} bytes even at the lowest jpeg quality`,
    );
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
    // Coordinate click — canvas/WebGL/map surfaces have no DOM target.
    // page.mouse.click hit-tests exactly like a real pointer.
    if (tool === "browser.page.click") {
      const x = typeof args.x === "number" && Number.isFinite(args.x) ? args.x : undefined;
      const y = typeof args.y === "number" && Number.isFinite(args.y) ? args.y : undefined;
      if (x === undefined && y === undefined) {
        // fall through to the selector path below
      } else {
        if (x === undefined || y === undefined) {
          throw protocolError("proto.invalid", "browser.page.click args.x and args.y must be provided together");
        }
        if (x < 0 || y < 0) {
          throw protocolError("proto.invalid", "browser.page.click coordinates must be non-negative viewport pixels");
        }
        if (args.ref !== undefined || args.selector !== undefined || args.label !== undefined) {
          throw protocolError("proto.invalid", "browser.page.click accepts coordinates or an element target, not both");
        }
        const button = typeof args.button === "string" ? args.button : "left";
        if (!["left", "right", "middle"].includes(button)) {
          throw protocolError("proto.invalid", "browser.page.click args.button must be left|right|middle");
        }
        const clickCount = typeof args.clickCount === "number" ? args.clickCount : 1;
        if (clickCount !== 1 && clickCount !== 2) {
          throw protocolError("proto.invalid", "browser.page.click args.clickCount must be 1|2");
        }
        const mods = Array.isArray(args.modifiers)
          ? args.modifiers
              .filter((m): m is string => typeof m === "string")
              .map((m) => {
                const lower = m.toLowerCase();
                return lower === "control" || lower === "alt" || lower === "shift" || lower === "meta"
                  ? (m[0]!.toUpperCase() + m.slice(1).toLowerCase() as "Alt" | "Control" | "Meta" | "Shift")
                  : null;
              })
              .filter((m): m is "Alt" | "Control" | "Meta" | "Shift" => m !== null)
          : [];
        for (const mod of mods) await page.keyboard.down(mod);
        try {
          await page.mouse.click(x, y, {
            button: button as "left" | "right" | "middle",
            clickCount: clickCount as 1 | 2,
          });
        } finally {
          for (const mod of [...mods].reverse()) await page.keyboard.up(mod).catch(() => {});
        }
        return { clicked: true, x, y, ...(clickCount === 2 ? { clickCount: 2 } : {}) };
      }
    }
    // Coordinate hover — canvas/surface hover states, no DOM target.
    if (tool === "browser.page.hover") {
      const x = typeof args.x === "number" && Number.isFinite(args.x) ? args.x : undefined;
      const y = typeof args.y === "number" && Number.isFinite(args.y) ? args.y : undefined;
      if (x !== undefined || y !== undefined) {
        if (x === undefined || y === undefined) {
          throw protocolError("proto.invalid", "browser.page.hover args.x and args.y must be provided together");
        }
        if (x < 0 || y < 0) {
          throw protocolError("proto.invalid", "browser.page.hover coordinates must be non-negative viewport pixels");
        }
        if (args.ref !== undefined || args.selector !== undefined || args.label !== undefined) {
          throw protocolError("proto.invalid", "browser.page.hover accepts coordinates or an element target, not both");
        }
        await page.mouse.move(x, y);
        return { hovered: true, x, y };
      }
    }
    // Drag resolves its own targets — coordinate form has no selector,
    // element form needs source + drop selectors (not the single-target
    // #requireSelector path).
    if (tool === "browser.page.drag") {
      return this.#drag(page, args);
    }
    // Page-level scroll needs no selector — window scroll is a valid
    // target (extension host parity). Handled before #requireSelector.
    if (tool === "browser.page.scroll") {
      const dir = typeof args.direction === "string" ? args.direction : "down";
      if (!["up", "down", "left", "right", "top", "bottom"].includes(dir)) {
        throw protocolError("proto.invalid", "browser.page.scroll args.direction must be up|down|left|right|top|bottom");
      }
      const amount =
        typeof args.amountPx === "number" && Number.isFinite(args.amountPx)
          ? Math.min(Math.max(args.amountPx, 0), 10_000)
          : 600;
      // Element-targeted scroll when a selector/ref resolves — same
      // contract as the extension host's scroll step. evaluate args
      // are serialized, so dir/amount travel as parameters.
      const sel = args.selector ?? args.ref;
      const scrollOpts = { d: dir, a: amount };
      const scrollEl = (el: Element | Window, o: { d: string; a: number }) => {
        const target = el instanceof Window ? el.document.documentElement : (el as HTMLElement);
        if (o.d === "top") target.scrollTo({ top: 0 });
        else if (o.d === "bottom") target.scrollTo({ top: target.scrollHeight });
        else {
          const dx = o.d === "left" ? -o.a : o.d === "right" ? o.a : 0;
          const dy = o.d === "up" ? -o.a : o.d === "down" ? o.a : 0;
          target.scrollBy({ left: dx, top: dy });
        }
      };
      if (typeof sel === "string" && sel.length > 0) {
        await page
          .locator(sel)
          .first()
          .evaluate(scrollEl, scrollOpts)
          .catch(() => null);
      } else {
        await page
          .evaluate((o) => {
            const de = document.documentElement;
            if (o.d === "top") de.scrollTo({ top: 0 });
            else if (o.d === "bottom") de.scrollTo({ top: de.scrollHeight });
            else {
              const dx = o.d === "left" ? -o.a : o.d === "right" ? o.a : 0;
              const dy = o.d === "up" ? -o.a : o.d === "down" ? o.a : 0;
              de.scrollBy({ left: dx, top: dy });
            }
          }, scrollOpts)
          .catch(() => null);
      }
      return { scrolled: dir };
    }
    const selector = await this.#requireSelector(args);
    const locator = page.locator(selector).first();
    switch (tool) {
      case "browser.page.click": {
        const button = typeof args.button === "string" ? args.button : "left";
        if (!["left", "right", "middle"].includes(button)) {
          throw protocolError("proto.invalid", "browser.page.click args.button must be left|right|middle");
        }
        const clickCount = typeof args.clickCount === "number" ? args.clickCount : 1;
        if (clickCount !== 1 && clickCount !== 2) {
          throw protocolError("proto.invalid", "browser.page.click args.clickCount must be 1|2");
        }
        const clickMods = Array.isArray(args.modifiers)
          ? args.modifiers
              .filter((m): m is string => typeof m === "string")
              .map((m) => {
                const lower = m.toLowerCase();
                return lower === "control" || lower === "alt" || lower === "shift" || lower === "meta"
                  ? (m[0]!.toUpperCase() + m.slice(1).toLowerCase() as "Alt" | "Control" | "Meta" | "Shift")
                  : null;
              })
              .filter((m): m is "Alt" | "Control" | "Meta" | "Shift" => m !== null)
          : undefined;
        if (clickCount === 2) {
          await locator.dblclick({ timeout: DEFAULT_NAV_TIMEOUT_MS, ...(clickMods?.length ? { modifiers: clickMods } : {}) });
          return { clicked: true, clickCount: 2 };
        }
        await locator.click({
          button: button as "left" | "right" | "middle",
          timeout: DEFAULT_NAV_TIMEOUT_MS,
          ...(clickMods?.length ? { modifiers: clickMods } : {}),
        });
        return { clicked: true };
      }
      case "browser.page.focus":
        await locator.focus();
        return { focused: true };
      case "browser.page.type": {
        const text = typeof args.text === "string" ? args.text : typeof args.value === "string" ? args.value : "";
        await locator.pressSequentially(text);
        return { typed: text.length };
      }
      case "browser.page.fill": {
        const text = typeof args.text === "string" ? args.text : typeof args.value === "string" ? args.value : "";
        await locator.fill(text);
        return { filled: true };
      }
      case "browser.page.select": {
        const value = typeof args.value === "string" ? args.value : "";
        const values = Array.isArray(args.values)
          ? args.values.filter((v): v is string => typeof v === "string" && v.length > 0)
          : undefined;
        if (values && values.length === 0) {
          throw protocolError("proto.invalid", "browser.page.select args.values must contain at least one string");
        }
        if (values && values.length > 0 && value) {
          throw protocolError("proto.invalid", "browser.page.select accepts value or values, not both");
        }
        await locator.selectOption((values ?? [value]) as never);
        return { selected: values ?? value };
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
      default:
        throw protocolError("proto.unsupported", `unsupported dom action ${tool}`);
    }
  }

  /** browser.page.drag — mouse-based drag parity with the extension
   *  host's pointer-move sequence: move → down → interpolated moves → up.
   *  Element form resolves source/drop bounding-box centers; invisible
   *  targets fail with retryable browser.element_not_visible, matching
   *  the extension's pointer-reachability gate. */
  async #drag(page: PwPage, args: Record<string, unknown>): Promise<unknown> {
    const mouseDrag = async (sx: number, sy: number, dx: number, dy: number) => {
      await page.mouse.move(sx, sy);
      await page.mouse.down();
      await page.mouse.move(dx, dy, { steps: 12 });
      await page.mouse.up();
    };
    const coordFields = [args.x, args.y, args.dropX, args.dropY];
    const coordCount = coordFields.filter((v) => v !== undefined && v !== null).length;
    if (coordCount > 0) {
      if (coordCount !== 4) {
        throw protocolError("proto.invalid", "browser.page.drag coordinate drag requires x, y, dropX and dropY together");
      }
      const [x, y, dropX, dropY] = coordFields as [number, number, number, number];
      if ([x, y, dropX, dropY].some((v) => typeof v !== "number" || !Number.isFinite(v) || v < 0)) {
        throw protocolError("proto.invalid", "browser.page.drag coordinates must be non-negative finite viewport pixels");
      }
      if (
        args.ref !== undefined || args.selector !== undefined || args.label !== undefined ||
        args.toRef !== undefined || args.toSelector !== undefined || args.toLabel !== undefined
      ) {
        throw protocolError("proto.invalid", "browser.page.drag accepts coordinates or element targets, not both");
      }
      await mouseDrag(x, y, dropX, dropY);
      return { dragged: true, x, y, dropX, dropY };
    }
    const srcSel = args.selector ?? args.ref;
    const dstSel = args.toSelector ?? args.toRef;
    if (typeof srcSel !== "string" || !srcSel || typeof dstSel !== "string" || !dstSel) {
      throw protocolError(
        "proto.invalid",
        "browser.page.drag requires a source target (selector/ref) and a drop target (toSelector/toRef)",
      );
    }
    const src = page.locator(srcSel).first();
    const dst = page.locator(dstSel).first();
    const sb = await src.boundingBox({ timeout: DEFAULT_NAV_TIMEOUT_MS }).catch(() => null);
    const db = await dst.boundingBox({ timeout: DEFAULT_NAV_TIMEOUT_MS }).catch(() => null);
    if (!sb) {
      throw protocolError("browser.element_not_visible", "browser.page.drag source element is not visible");
    }
    if (!db) {
      throw protocolError("browser.element_not_visible", "browser.page.drag drop target is not visible");
    }
    await mouseDrag(
      sb.x + sb.width / 2,
      sb.y + sb.height / 2,
      db.x + db.width / 2,
      db.y + db.height / 2,
    );
    return { dragged: true };
  }

  /** chromex-0fza: when args.expect is present, poll the page briefly
   *  for the declared postcondition and attach an honest `verified`
   *  verdict + `expect` evidence to the action result. */
  async #withExpect(
    taskId: string,
    args: Record<string, unknown>,
    result: unknown,
  ): Promise<unknown> {
    const cond = parseExpectCondition(args.expect);
    if (!cond || !result || typeof result !== "object") return result;
    const page = await this.#pageFor(taskId, args);
    const started = Date.now();
    const timeoutMs = Math.min(Math.max(cond.timeoutMs ?? EXPECT_DEFAULT_TIMEOUT_MS, 0), EXPECT_MAX_TIMEOUT_MS);
    const met = await this.#pollExpect(page, cond, timeoutMs);
    return {
      ...(result as Record<string, unknown>),
      verified: met === true ? true : met === false ? false : "unknown",
      expect: { met, elapsedMs: Date.now() - started },
    };
  }

  /** Poll until every expect condition holds or the deadline passes.
   *  "unknown" only when the page itself became unreachable mid-poll. */
  async #pollExpect(
    page: PwPage,
    cond: BrowserExpectCondition,
    timeoutMs: number,
  ): Promise<boolean | "unknown"> {
    const deadline = Date.now() + timeoutMs;
    try {
      for (;;) {
        if (await this.#expectConditionsMet(page, cond)) return true;
        if (Date.now() >= deadline) return false;
        await page.waitForTimeout(Math.min(EXPECT_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
      }
    } catch {
      return "unknown";
    }
  }

  async #expectConditionsMet(page: PwPage, cond: BrowserExpectCondition): Promise<boolean> {
    // -1 marks an unresolvable selector — fail closed for both
    // `selector` (needs >0) and `goneSelector` (needs exactly 0).
    const count = async (sel: string): Promise<number> => {
      try {
        return await page.locator(sel).count();
      } catch {
        return -1;
      }
    };
    if (cond.selector && (await count(cond.selector)) <= 0) return false;
    if (cond.goneSelector && (await count(cond.goneSelector)) !== 0) return false;
    if (cond.urlContains && !page.url().includes(cond.urlContains)) return false;
    if (cond.text) {
      const bodyText = await page.locator("body").innerText().catch(() => "");
      if (!bodyText.includes(cond.text)) return false;
    }
    if (cond.readyState) {
      const order = ["loading", "interactive", "complete"];
      const want = order.indexOf(cond.readyState);
      const have = order.indexOf(
        await page.evaluate(() => document.readyState).catch(() => "loading"),
      );
      if (want < 0 || have < want) return false;
    }
    return true;
  }

  async #wait(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const started = Date.now();
    const timeout = typeof args.timeoutMs === "number" ? args.timeoutMs : typeof args.ms === "number" ? args.ms : 10_000;
    const deadline = started + Math.min(timeout, 30_000);
    const selector = typeof args.selector === "string" ? args.selector : null;
    const selectorGone = typeof args.selectorGone === "string" ? args.selectorGone : null;
    const urlContains = typeof args.urlContains === "string" ? args.urlContains : null;
    const text = typeof args.text === "string" ? args.text : null;
    const textGone = typeof args.textGone === "string" ? args.textGone : null;
    const readyState = typeof args.readyState === "string" ? args.readyState : null;
    const visibleSelector = typeof args.visibleSelector === "string" ? args.visibleSelector : null;
    const networkIdle = args.networkIdle === true;
    const hasCondition =
      selector !== null || selectorGone !== null || urlContains !== null || text !== null || textGone !== null || readyState !== null ||
      visibleSelector !== null || networkIdle;
    if (selector !== null && selector === selectorGone) {
      throw protocolError("proto.invalid", "browser.page.wait args.selector and args.selectorGone must differ");
    }
    if (!hasCondition) {
      // plain timed wait — same contract as the extension host's ms sleep
      await page.waitForTimeout(Math.min(timeout, 30_000));
      return { ok: true, waitedMs: Math.min(timeout, 30_000) };
    }
    if (readyState !== null) {
      // document.readyState → playwright load state: interactive ≈
      // domcontentloaded, complete ≈ load. "loading" is trivially met.
      const state = readyState === "complete" ? "load" : readyState === "interactive" ? "domcontentloaded" : null;
      if (state === null && readyState !== "loading") {
        throw protocolError("proto.invalid", "browser.page.wait args.readyState must be loading|interactive|complete");
      }
      if (state !== null) {
        const remaining = Math.max(0, deadline - Date.now());
        await page
          .waitForLoadState(state, { timeout: Math.min(remaining, 30_000) })
          .catch(() => {
            throw protocolError("browser.timeout", "wait condition not met before timeout");
          });
      }
    }
    if (networkIdle) {
      const remaining = Math.max(0, deadline - Date.now());
      await page
        .waitForLoadState("networkidle", { timeout: Math.min(remaining, 30_000) })
        .catch(() => {
          throw protocolError("browser.timeout", "network idle not reached before timeout");
        });
      if (selector === null && urlContains === null && text === null && textGone === null && readyState === null && visibleSelector === null) {
        return { ok: true, matched: "networkIdle", elapsedMs: Date.now() - started };
      }
    }
    for (;;) {
      if (visibleSelector) {
        const visible = await page.locator(visibleSelector).first().isVisible().catch(() => false);
        if (!visible) {
          if (Date.now() >= deadline) {
            throw protocolError("browser.timeout", "wait condition not met before timeout");
          }
          await page.waitForTimeout(100);
          continue;
        }
      }
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
      if (selectorGone) {
        const count = await page.locator(selectorGone).count().catch(() => 0);
        if (count !== 0) {
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

  // ---- downloads ----

  /** Lazily attach the context 'download' listener once per task and
   *  return the task's log. Passive page-initiated downloads land here
   *  too — they stay in_progress until saveAs persists them (playwright
   *  deletes unsaved download artifacts when the context closes). */
  async #ensureDownloadLog(taskId: string): Promise<DownloadLogEntry[]> {
    const context = await this.#contextFor(taskId);
    const existing = this.#downloadLogs.get(taskId);
    if (existing) return existing;
    const log: DownloadLogEntry[] = [];
    this.#downloadLogs.set(taskId, log);
    context.on("download", (d) => {
      log.push({
        id: ++this.#downloadSeq,
        url: stripQuery(d.url()),
        suggestedFilename: d.suggestedFilename(),
        state: "in_progress",
        startTime: Date.now(),
        path: null,
        error: null,
        download: d,
      });
    });
    return log;
  }

  #downloadDir(): string {
    return join(tmpdir(), "chromex-playwright-downloads");
  }

  async #downloadsList(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const log = await this.#ensureDownloadLog(taskId);
    const state = typeof args.state === "string" ? args.state : null;
    if (state !== null && !["in_progress", "interrupted", "complete"].includes(state)) {
      throw protocolError("proto.invalid", "browser.downloads.list args.state must be in_progress|interrupted|complete");
    }
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(Math.max(Math.floor(args.limit), 1), 200)
        : 50;
    let since: number | undefined;
    if (typeof args.since === "number" && Number.isFinite(args.since)) {
      since = args.since;
    } else if (typeof args.since === "string") {
      const parsed = Date.parse(args.since);
      if (Number.isNaN(parsed)) {
        throw protocolError("proto.invalid", "browser.downloads.list args.since must be epoch ms or an ISO date");
      }
      since = parsed;
    }
    const items = log
      .filter((e) => (state === null || e.state === state) && (since === undefined || e.startTime >= since))
      .slice(-limit)
      .reverse();
    const sizeOf = (p: string): number => {
      try {
        return statSync(p).size;
      } catch {
        return 0;
      }
    };
    return {
      downloads: items.map((e) => {
        const bytes = e.path !== null ? sizeOf(e.path) : 0;
        return {
          id: e.id,
          state: e.state,
          filename: e.path ?? "",
          bytesReceived: bytes,
          totalBytes: e.path !== null ? bytes : -1,
          ...(e.error !== null ? { error: e.error } : {}),
          startTime: new Date(e.startTime).toISOString(),
          fileExists: e.path !== null && existsSync(e.path),
        };
      }),
    };
  }

  /** browser.downloads.save — navigate a scratch page to the URL; a
   *  Content-Disposition response triggers a real download event which
   *  saveAs persists under the isolated download dir. saveAs waits for
   *  the download to finish, so the returned state is always terminal —
   *  waitForCompletion/timeoutMs are accepted for contract parity but
   *  there is nothing left to wait for. */
  async #downloadsSave(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const url = typeof args.url === "string" ? args.url : "";
    if (!url) {
      throw protocolError("proto.invalid", "browser.downloads.save args.url is required");
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw protocolError("proto.invalid", "browser.downloads.save args.url must be a valid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw protocolError("proto.invalid", "browser.downloads.save args.url must be http(s)");
    }
    const filename = typeof args.filename === "string" ? args.filename : undefined;
    if (filename !== undefined) {
      if (
        filename.length > 200 ||
        filename.startsWith("/") ||
        filename.includes("..") ||
        filename.includes("\\") ||
        /[\x00-\x1f]/.test(filename)
      ) {
        throw protocolError(
          "proto.invalid",
          "browser.downloads.save args.filename must be a relative path inside the download directory",
        );
      }
    }
    const context = await this.#contextFor(taskId);
    const log = await this.#ensureDownloadLog(taskId);
    const dir = this.#downloadDir();
    await mkdir(dir, { recursive: true });
    const page = this.#trackPage(await context.newPage());
    const started = Date.now();
    try {
      const dlPromise = page.waitForEvent("download", { timeout: DEFAULT_NAV_TIMEOUT_MS });
      // goto rejects when the response is a download — that IS the
      // success path, so the error is swallowed and the event awaited.
      await page.goto(url, { timeout: DEFAULT_NAV_TIMEOUT_MS }).catch(() => {});
      const dl = await dlPromise.catch(() => null);
      if (!dl) {
        throw protocolError("browser.timeout", "no download was triggered by the URL within the timeout");
      }
      const name = filename ?? (dl.suggestedFilename() || `download-${Date.now()}`);
      const target = join(dir, name);
      await dl.saveAs(target);
      const failure = await dl.failure().catch(() => null);
      const state = failure === null ? "complete" : "interrupted";
      let entry = log.find((e) => e.download === dl);
      if (!entry) {
        entry = {
          id: ++this.#downloadSeq,
          url: stripQuery(dl.url()),
          suggestedFilename: dl.suggestedFilename(),
          state: "in_progress",
          startTime: Date.now(),
          path: null,
          error: null,
          download: dl,
        };
        log.push(entry);
      }
      entry.path = target;
      entry.state = state;
      entry.error = failure;
      return {
        downloadId: entry.id,
        state,
        filename: target,
        fileExists: existsSync(target),
        ...(failure !== null ? { error: failure } : {}),
        waitedMs: Date.now() - started,
      };
    } finally {
      await page.close().catch(() => {});
    }
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
      // Bytes-only contract — same as the extension host: local paths
      // would let the agent exfiltrate arbitrary files into a page.
      if (typeof entry === "string") {
        throw protocolError("proto.invalid", "browser.page.upload accepts {name, mimeType, base64} files only — local paths are refused");
      }
      const o = (entry ?? {}) as Record<string, unknown>;
      if (typeof o.base64 === "string" && o.base64.length > 0) {
        return {
          name: typeof o.name === "string" && o.name ? o.name : "file",
          mimeType: typeof o.mimeType === "string" ? o.mimeType : "",
          buffer: Buffer.from(o.base64, "base64"),
        };
      }
      throw protocolError("proto.invalid", "upload file entries require {name, mimeType, base64}");
    });
    await page.locator(selector).first().setInputFiles(files as never);
    return { uploaded: files.length };
  }

  // ---- lifecycle ----

  /** Release a task's isolated context (task.purge / shutdown). */
  async releaseTask(taskId: string): Promise<void> {
    const ctx = this.#contexts.get(taskId);
    this.#contexts.delete(taskId);
    this.#activePages.delete(taskId);
    for (const p of ctx?.pages() ?? []) this.#consoleBuffers.delete(p);
    await ctx?.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const ctx of this.#contexts.values()) await ctx.close().catch(() => {});
    this.#contexts.clear();
    this.#activePages.clear();
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

/** chromex-0fza: post-action expectation poll budget — a verification
 *  poll, not a wait; same bounds as the extension host. */
const EXPECT_DEFAULT_TIMEOUT_MS = 2_000;
const EXPECT_MAX_TIMEOUT_MS = 5_000;
const EXPECT_POLL_INTERVAL_MS = 100;
/** Tools that accept args.expect — same set the extension host's
 *  page.dom.perform default branch covers. */
const EXPECTABLE_TOOLS: ReadonlySet<BrowserToolName> = new Set([
  "browser.page.navigate",
  "browser.page.click",
  "browser.page.focus",
  "browser.page.type",
  "browser.page.fill",
  "browser.page.select",
  "browser.page.submit",
  "browser.page.scroll",
  "browser.page.hover",
  "browser.page.press",
  "browser.page.drag",
  "browser.page.upload",
]);

/** Parse args.expect (chromex-0fza). null when absent/empty; throws
 *  proto.invalid on a malformed payload — same contract as the
 *  extension host's parseExpectCondition. */
function parseExpectCondition(raw: unknown): BrowserExpectCondition | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw protocolError(
      "proto.invalid",
      "args.expect must be an object {selector?, text?, urlContains?, goneSelector?, timeoutMs?}",
    );
  }
  const o = raw as Record<string, unknown>;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" && v.length > 0 ? v : undefined;
  const selector = str(o.selector);
  const text = str(o.text);
  const urlContains = str(o.urlContains);
  const goneSelector = str(o.goneSelector);
  const readyState = str(o.readyState);
  if (readyState !== undefined && !["loading", "interactive", "complete"].includes(readyState)) {
    throw protocolError("proto.invalid", "args.expect.readyState must be loading|interactive|complete");
  }
  const timeoutMs = typeof o.timeoutMs === "number" && Number.isFinite(o.timeoutMs) ? o.timeoutMs : undefined;
  const cond: BrowserExpectCondition = {
    ...(selector ? { selector } : {}),
    ...(text ? { text } : {}),
    ...(urlContains ? { urlContains } : {}),
    ...(goneSelector ? { goneSelector } : {}),
    ...(readyState ? { readyState: readyState as "loading" | "interactive" | "complete" } : {}),
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  };
  return cond.selector || cond.text || cond.urlContains || cond.goneSelector || cond.readyState ? cond : null;
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
