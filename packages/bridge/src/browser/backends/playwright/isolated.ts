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
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_BACKEND_CAPABILITIES,
  effectiveBackendCapabilities,
  protocolError,
  summarizeCoverage,
  summarizeMetrics,
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
  "browser.tabs.wait",
  "browser.tab.activate",
  "browser.tab.close",
  "browser.tab.create",
  "browser.tab.duplicate",
  "browser.tab.update",
  "browser.page.setInputFiles",
  "browser.page.dialog",
  "browser.page.snapshot",
  "browser.page.get",
  "browser.page.extract",
  "browser.page.screenshot",
  "browser.page.console",
  "browser.page.evaluate",
  "browser.page.emulate",
  "browser.page.pdf",
  "browser.page.mhtml",
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
  "browser.page.cookies",
  "browser.page.localStorage",
  "browser.page.indexedDB",
  "browser.page.caches",
  "browser.page.serviceWorker",
  "browser.page.cdp",
  "browser.page.coverage",
  "browser.page.metrics",
  "browser.page.screencast",
  "browser.history.search",
  "browser.history.delete",
  "browser.bookmarks",
  "browser.browsingData.clear",
  "browser.siteSettings",
  "browser.sessions",
  "browser.page.network",
  "browser.page.responseBody",
  "browser.page.webSocket",
  "browser.page.route",
  "browser.page.unroute",
  "browser.downloads.list",
  "browser.downloads.save",
  "browser.downloads.cancel",
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
type PwCDPSession = import("playwright-core").CDPSession;
type PwResponse = import("playwright-core").Response;
type PwRoute = import("playwright-core").Route;
type PwWebSocket = import("playwright-core").WebSocket;
type PwDialog = import("playwright-core").Dialog;
type PwFrame = import("playwright-core").Frame;
/** Element-scoped target — a Page or one of its Frames. Frame shares
 *  the locator/evaluate/wait API surface used by the handlers below;
 *  page-level APIs (mouse/keyboard/screenshot/pdf) stay Page-only and
 *  those arg shapes refuse honestly when args.frameId is set. */
type PwTarget = PwPage | PwFrame;

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

interface IsoRouteRule {
  id: string;
  match: string;
  action: "fulfill" | "abort" | "modify";
  status: number;
  headers: Record<string, string>;
  body: string;
  url?: string;
  requestHeaders?: Record<string, string>;
  requestBody?: string;
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
  /** page → CDP session for Emulation.* overrides — playwright's own
   *  viewport/media API covers only a subset; the rest map 1:1 onto
   *  the same commands the extension debugger tier sends. WeakMap so
   *  closed pages release their session handle. */
  readonly #cdpSessions = new WeakMap<PwPage, PwCDPSession>();
  /** Pages with a running Profiler precise-coverage session — WeakSet
   *  so closed pages drop out without bookkeeping. */
  readonly #coveragePages = new WeakSet<PwPage>();
  /** Pages with Performance metric collection enabled — WeakSet so
   *  closed pages drop out without bookkeeping. */
  readonly #metricsPages = new WeakSet<PwPage>();
  /** page → running screencast hold (frames + ack subscription).
   *  WeakMap so closed pages drop the hold without bookkeeping. */
  readonly #screencastHolds = new WeakMap<PwPage, {
    session: PwCDPSession;
    frames: Array<{ data: string; timestamp: number }>;
    listener: ((e: { method: string; params?: unknown }) => void) | null;
  }>();
  /** page → finished responses kept for lazy body() reads
   *  (browser.page.responseBody). Bounded; Response objects stay
   *  valid for body() after the event loop turns. */
  readonly #responseBuffers = new Map<PwPage, Array<{
    id: string; method: string; url: string; type: string;
    status?: number; mimeType?: string; ts: number; res: PwResponse;
  }>>();
  #responseSeq = 0;
  /** page → WebSocket connections + bounded frames
   *  (browser.page.webSocket). Mirrors the extension tap caps. */
  readonly #wsBuffers = new Map<PwPage, Array<{
    id: string; url: string; ts: number; closed: boolean;
    frames: Array<{ dir: "sent" | "recv"; data: string; binary: boolean; ts: number; truncated?: boolean }>;
  }>>();
  #wsSeq = 0;
  /** page → interception rules (browser.page.route). One catch-all
   *  route handler per page consults this list — first match wins,
   *  same as the extension Fetch tier. */
  readonly #routeRules = new Map<PwPage, IsoRouteRule[]>();
  #routeSeq = 0;
  /** page → bodies served by route.fulfill — playwright's
   *  response.body() cannot read fulfilled payloads back, so the
   *  fulfill branch records them here for responseBody lookups. */
  readonly #fulfilledBodies = new Map<PwPage, Array<{ url: string; body: string; ts: number }>>();
  /** page → currently-open JS dialog (browser.page.dialog). The
   *  listener is installed at track time — playwright auto-dismisses
   *  dialogs only when NO listener exists, so registering it keeps
   *  dialogs open (real browser semantics) until the tool resolves
   *  them. */
  readonly #pendingDialogs = new Map<PwPage, {
    dialog: PwDialog; type: string; message: string; defaultPrompt: string;
  } | null>();

  /** Pages already wired with observation listeners — popup pages arrive
   *  via context "page" events and must not be double-tracked. */
  readonly #trackedPages = new WeakSet<PwPage>();

  /** Per-task visit log backing browser.history.search — isolated
   *  contexts have no browser profile history, so the log records the
   *  pages THIS task created/navigated (honest scope, documented in
   *  the tool description). Capped per task. */
  readonly #visitLogs = new Map<string, Array<{ url: string; title: string; ts: number }>>();
  /** Per-task recently-closed log backing browser.sessions —
   *  playwright has no chrome.sessions equivalent, so tab.close
   *  records {url,title} here and restore reopens it in-context
   *  (scope:"task" honestly — dies with the task). */
  readonly #sessionLogs = new Map<string, Array<{ sessionId: string; lastModified: number; url: string; title: string }>>();
  #sessionSeq = 0;
  /** Per-task bookmark jar — isolated contexts have no browser profile,
   *  so bookmarks live and die with the task (scope:"task" honestly). */
  readonly #bookmarkJars = new Map<
    string,
    { nodes: Array<{ id: string; parentId: string; title: string; url?: string; dateAdded: number }>; nextId: number }
  >();

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
    // Popup tabs (target=_blank, window.open) join the same context and
    // surface here as new pages — track them at birth so console,
    // network, WS, dialog and route capture work on agent-opened tabs.
    if (typeof context.on === "function") {
      context.on("page", (page) => this.#trackPage(page));
    }
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

  /** Page-viewport offset of a frame target — the iframe element's
   *  bounding-box origin. Coordinate mouse ops take page pixels, so a
   *  frame-relative coordinate translates by this offset. Returns null
   *  when the frame element can't be resolved — callers refuse rather
   *  than silently clicking the wrong position. */
  async #frameMouseOffset(page: PwPage, target: PwTarget): Promise<{ x: number; y: number } | null> {
    if (target === page) return { x: 0, y: 0 };
    if (typeof (target as PwFrame).frameElement !== "function") return null;
    const fe = await (target as PwFrame).frameElement().catch(() => null);
    const box = fe ? await fe.boundingBox().catch(() => null) : null;
    return box ? { x: box.x, y: box.y } : null;
  }

  /** Resolve the element-scoped action target: the Page itself, or the
   *  Frame at args.frameId (index into page.frames() — 0/absent = main
   *  frame). Out-of-range ids fail proto.invalid rather than silently
   *  falling back to the top document. Callers that need Page-only APIs
   *  (mouse/keyboard/screenshot) must keep using #pageFor and refuse
   *  frameId themselves. */
  async #frameTarget(taskId: string, args: Record<string, unknown>): Promise<PwTarget> {
    const page = await this.#pageFor(taskId, args);
    const frameId = typeof args.frameId === "number" ? args.frameId : 0;
    if (frameId === 0) return page;
    const frames = typeof page.frames === "function" ? page.frames() : [];
    const frame = frames[frameId];
    if (!frame) {
      throw protocolError(
        "proto.invalid",
        `args.frameId ${frameId} out of range — browser.page.get frames[] lists valid frameIds`,
      );
    }
    return frame;
  }

  /** Execute a browser tool on the isolated backend. Throws
   *  ProtocolError-coded failures; returns the tool result payload.
   *  opts.expectedTarget carries the §4.8 facts the risk classifier
   *  approved — re-derived inside the page immediately before dispatch
   *  so a mutation during the approval round-trip cannot slip through. */
  async execute(
    taskId: string,
    tool: BrowserToolName,
    args: Record<string, unknown>,
    opts?: { expectedTarget?: Record<string, string> },
  ): Promise<unknown> {
    // §4.8 preflight pseudo-tool — resolved inside the page so the risk
    // classifier sees ground truth, not agent-supplied args. Internal:
    // never listed in supportedTools, never agent-visible.
    if ((tool as string) === "browser.internal.describeTarget") {
      return this.#describeTarget(taskId, args);
    }
    if (!PLAYWRIGHT_ISOLATED_SUPPORTED_TOOLS.has(tool)) {
      throw protocolError("proto.unsupported", `playwright-isolated does not support ${tool}`);
    }
    // chromex-0fza: a malformed args.expect must fail BEFORE the action
    // dispatches — #withExpect re-parses after the fact for the poll.
    if (EXPECTABLE_TOOLS.has(tool)) parseExpectCondition(args.expect);
    // args.frameId targets a subframe. Playwright auto-attaches
    // out-of-process iframes, so page.frames()[frameId] reaches them —
    // frameId is the INDEX into that list (0 = main frame), surfaced
    // via browser.page.get frames[]. Tools outside FRAME_CAPABLE_TOOLS
    // (or page-level arg shapes inside it: coordinate mouse ops,
    // selector-less keyboard press, drag) still refuse honestly.
    if (
      typeof args.frameId === "number" &&
      args.frameId !== 0 &&
      !FRAME_CAPABLE_TOOLS.has(tool)
    ) {
      throw protocolError(
        "proto.unsupported",
        "args.frameId is not supported on playwright-isolated for this tool",
      );
    }
    // CDP-tier args (docs/adr/debugger-tier.md): playwright has no
    // chrome.debugger — never silently run the untrusted/DOM path when
    // the caller explicitly asked for the trusted/CDP variant.
    if (args.trusted === true) {
      throw protocolError(
        "proto.unsupported",
        "args.trusted requires the chrome-extension debugger tier",
      );
    }
    if (tool === "browser.page.snapshot" && args.mode === "dom") {
      throw protocolError(
        "proto.unsupported",
        "snapshot mode 'dom' is not supported on playwright-isolated (aria snapshot only)",
      );
    }
    switch (tool) {
      case "browser.tabs.list":
        return this.#tabsList(taskId);
      case "browser.tabs.wait":
        return this.#tabsWait(taskId, args);
      case "browser.tab.activate":
        return this.#tabActivate(taskId, args);
      case "browser.tab.close":
        return this.#tabClose(taskId, args);
      case "browser.tab.create":
        return this.#tabCreate(taskId, args);
      case "browser.tab.duplicate":
        return this.#tabDuplicate(taskId, args);
      case "browser.tab.update":
        return this.#tabUpdate(taskId, args);
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
      case "browser.page.evaluate":
        return this.#withExpect(taskId, args, await this.#evaluate(taskId, args));
      case "browser.page.emulate":
        return this.#withExpect(taskId, args, await this.#emulate(taskId, args));
      case "browser.page.pdf":
        return this.#withExpect(taskId, args, await this.#pdf(taskId, args));
      case "browser.page.mhtml":
        return this.#withExpect(taskId, args, await this.#mhtml(taskId, args));
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
        await this.#assertExpectedTarget(taskId, tool, args, opts?.expectedTarget);
        return this.#withExpect(taskId, args, await this.#domAction(taskId, tool, args));
      case "browser.page.wait":
        return this.#wait(taskId, args);
      case "browser.page.upload":
        return this.#withExpect(taskId, args, await this.#upload(taskId, args));
      case "browser.page.setInputFiles":
        return this.#setInputFiles(taskId, args);
      case "browser.page.find":
        return this.#find(taskId, args);
      case "browser.page.network":
        return this.#network(taskId, args);
      case "browser.page.responseBody":
        return this.#responseBody(taskId, args);
      case "browser.page.webSocket":
        return this.#webSocket(taskId, args);
      case "browser.page.route":
        return this.#route(taskId, args);
      case "browser.page.unroute":
        return this.#unroute(taskId, args);
      case "browser.page.dialog":
        return this.#dialog(taskId, args);
      case "browser.page.history":
        return this.#history(taskId, args);
      case "browser.page.cookies":
        return this.#cookies(taskId, args);
      case "browser.page.localStorage":
        return this.#storage(taskId, args);
      case "browser.page.indexedDB":
        return this.#idb(taskId, args);
      case "browser.page.caches":
        return this.#caches(taskId, args);
      case "browser.page.serviceWorker":
        return this.#serviceWorker(taskId, args);
      case "browser.page.cdp":
        return this.#cdp(taskId, args);
      case "browser.page.coverage":
        return this.#coverage(taskId, args);
      case "browser.page.metrics":
        return this.#metrics(taskId, args);
      case "browser.page.screencast":
        return this.#screencast(taskId, args);
      case "browser.history.search":
        return this.#historySearch(taskId, args);
      case "browser.history.delete":
        return this.#historyDelete(taskId, args);
      case "browser.bookmarks":
        return this.#bookmarks(taskId, args);
      case "browser.browsingData.clear":
        return this.#browsingDataClear(taskId, args);
      case "browser.siteSettings":
        return this.#siteSettings(taskId, args);
      case "browser.sessions":
        return this.#sessions(taskId, args);
      case "browser.downloads.list":
        return this.#downloadsList(taskId, args);
      case "browser.downloads.save":
        return this.#downloadsSave(taskId, args);
      case "browser.downloads.cancel":
        return this.#downloadsCancel(taskId, args);
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
        index: i,
        url: stripQuery(p.url()),
        title: titles[i] ?? "",
        active: p === active,
      })),
    };
  }

  /** browser.tabs.wait — baseline-diff wait for a NEW page whose URL
   *  contains urlContains (async popups/OAuth/target=_blank). Pages
   *  present at call time never match. Same contract as the extension
   *  host's chrome.tabs poll. */
  async #tabsWait(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const urlContains = typeof args.urlContains === "string" ? args.urlContains : "";
    if (urlContains === "" || urlContains.length > 512) {
      throw protocolError("proto.invalid", "browser.tabs.wait requires args.urlContains (non-empty string ≤512 chars)");
    }
    if (args.waitForLoad !== undefined && typeof args.waitForLoad !== "boolean") {
      throw protocolError("proto.invalid", "browser.tabs.wait args.waitForLoad must be a boolean");
    }
    const waitForLoad = args.waitForLoad === true;
    // disappear:true inverts the wait — hold until no page's URL
    // contains urlContains anymore (OAuth-popup self-close pattern).
    // Returns immediately when nothing matches at call time.
    if (args.disappear !== undefined && typeof args.disappear !== "boolean") {
      throw protocolError("proto.invalid", "browser.tabs.wait args.disappear must be a boolean");
    }
    const disappear = args.disappear === true;
    if (disappear && waitForLoad) {
      throw protocolError("proto.invalid", "browser.tabs.wait waitForLoad has no meaning with disappear");
    }
    const timeout = typeof args.timeoutMs === "number" ? args.timeoutMs : 10_000;
    const deadline = Date.now() + Math.min(timeout, 30_000);
    const context = await this.#contextFor(taskId);
    const baseline = new Set(context.pages());
    const matchUrl = (p: PwPage) => {
      const u = p.url();
      return u !== "" && u !== "about:blank" && stripQuery(u).includes(urlContains);
    };
    if (disappear) {
      for (;;) {
        const stillThere = context.pages().some(matchUrl);
        if (!stillThere) return { ok: true, matched: "disappear" };
        if (Date.now() >= deadline) {
          throw protocolError("browser.timeout", `tab matching "${urlContains}" still present before timeout`);
        }
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    let candidate: PwPage | undefined;
    for (;;) {
      const pages = context.pages();
      if (!candidate) {
        const idx = pages.findIndex((p) => !baseline.has(p) && matchUrl(p));
        if (idx >= 0) candidate = pages[idx];
      } else if (!pages.includes(candidate)) {
        // Candidate closed mid-wait — a later new tab may still match.
        candidate = undefined;
      }
      if (candidate) {
        // waitForLoad: readyState "complete" ≈ chrome.tabs status
        // "complete" (load event fired). A navigating/crashed page
        // throws or reports "loading" → keep polling until deadline.
        const ready = !waitForLoad || await candidate
          .evaluate(() => document.readyState)
          .then((s) => s === "complete")
          .catch(() => false);
        if (ready) {
          const p = candidate;
          return {
            ok: true,
            matched: "newTab",
            newTabId: pages.indexOf(p),
            tab: {
              tabId: pages.indexOf(p),
              url: stripQuery(p.url()),
              title: typeof p.title === "function" ? await p.title().catch(() => "") : "",
            },
          };
        }
      }
      if (Date.now() >= deadline) {
        throw protocolError("browser.timeout", `no new tab matching "${urlContains}" before timeout`);
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  async #tabActivate(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    await page.bringToFront();
    this.#activePages.set(taskId, page);
    return { activated: true };
  }

  async #tabClose(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    // Record into the task's recently-closed log BEFORE close so
    // browser.sessions can list/restore it (chrome.sessions parity —
    // scope:"task" honestly, entries die with the task).
    const url = page.url();
    if (url && url !== "about:blank") {
      const log = this.#sessionLogs.get(taskId) ?? [];
      this.#sessionLogs.set(taskId, log);
      log.unshift({
        sessionId: `sess-${++this.#sessionSeq}`,
        lastModified: Date.now(),
        url: stripQuery(url),
        title: typeof page.title === "function" ? await page.title().catch(() => "") : "",
      });
      if (log.length > 25) log.length = 25;
    }
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
    if (args.pinned !== undefined || args.muted !== undefined || args.autoDiscardable !== undefined) {
      throw protocolError("proto.unsupported", "playwright-isolated cannot pin, mute, or set autoDiscardable; args.pinned/args.muted/args.autoDiscardable are chrome-extension only");
    }
    const page = this.#trackPage(await context.newPage());
    this.#activePages.set(taskId, page);
    if (url) {
      await page.goto(url, { timeout: DEFAULT_NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" });
    }
    await this.#recordVisit(taskId, page);
    const tabId = context.pages().indexOf(page);
    return {
      openedTabId: tabId,
      tabId,
      url: stripQuery(page.url()),
      title: await page.title(),
    };
  }

  /** browser.tab.duplicate — a new page in the SAME isolated context,
   *  so cookies/storage (the "session") carry over automatically.
   *  DOM state is not cloned — playwright has no session-snapshot API;
   *  the duplicate lands on the source URL fresh. */
  async #tabDuplicate(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const context = await this.#contextFor(taskId);
    const source = await this.#pageFor(taskId, args);
    const url = source.url();
    const page = this.#trackPage(await context.newPage());
    this.#activePages.set(taskId, page);
    if (url && url !== "about:blank") {
      await page.goto(url, { timeout: DEFAULT_NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" }).catch(() => {});
    }
    await this.#recordVisit(taskId, page);
    const tabId = context.pages().indexOf(page);
    return {
      openedTabId: tabId,
      tabId,
      url: stripQuery(page.url()),
      title: await page.title(),
    };
  }

  /** browser.tab.update — zoomFactor maps to CDP
   *  Emulation.setPageScaleFactor (same zoom the extension's
   *  tabs.setZoom produces). pinned/muted/index are chrome tab-strip
   *  state with no playwright equivalent — refused, never silently
   *  dropped. */
  async #tabUpdate(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    if (args.pinned !== undefined || args.muted !== undefined || args.index !== undefined || args.autoDiscardable !== undefined) {
      throw protocolError("proto.unsupported", "playwright-isolated cannot pin, mute, reorder, or set autoDiscardable; args.pinned/args.muted/args.index/args.autoDiscardable are chrome-extension only");
    }
    const frozen = typeof args.frozen === "boolean" ? args.frozen : undefined;
    const zoomFactor =
      typeof args.zoomFactor === "number" && Number.isFinite(args.zoomFactor)
        ? args.zoomFactor
        : undefined;
    if (args.zoomFactor !== undefined && (zoomFactor === undefined || zoomFactor < 0.25 || zoomFactor > 5)) {
      throw protocolError("proto.invalid", "browser.tab.update args.zoomFactor must be a number in [0.25, 5]");
    }
    if (zoomFactor === undefined && frozen === undefined) {
      throw protocolError("proto.invalid", "browser.tab.update requires args.zoomFactor and/or args.frozen (pinned/muted/index/autoDiscardable unsupported on this backend)");
    }
    const session = await this.#emulationSession(page);
    if (zoomFactor !== undefined) {
      await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: zoomFactor });
    }
    if (frozen !== undefined) {
      // WICG web-lifecycle freeze — same CDP command the extension
      // backend sends through chrome.debugger. Freezing halts the
      // page's event loop (timers/rAF/input) without unloading.
      try {
        await session.send("Page.setWebLifecycleState", { state: frozen ? "frozen" : "active" });
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (msg.includes("wasn't found") || msg.includes("not found") || msg.includes("-32601")) {
          throw protocolError("proto.unsupported", "Page.setWebLifecycleState is not exposed on this Chromium build");
        }
        throw e;
      }
    }
    const context = await this.#contextFor(taskId);
    const idx = context.pages().indexOf(page);
    return {
      updated: idx,
      resolvedTabId: idx,
      ...(zoomFactor !== undefined ? { zoomFactor } : {}),
      ...(frozen !== undefined ? { frozen } : {}),
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
    await this.#recordVisit(taskId, page);
    return { url: stripQuery(page.url()), title: await page.title() };
  }

  async #snapshot(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const target = await this.#frameTarget(taskId, args);
    // aria snapshot per spike-B4; bounded text fallback
    try {
      const aria = await target.locator("body").ariaSnapshot();
      const b = boundText(aria ?? "", MAX_EXTRACT_CHARS);
      return { snapshot: b.text, truncated: b.truncated, url: stripQuery(target.url()) };
    } catch {
      const text = await target.locator("body").evaluate(deepInnerText).catch(() => "");
      const b = boundText(text, MAX_EXTRACT_CHARS);
      return { snapshot: b.text, truncated: b.truncated, url: stripQuery(target.url()) };
    }
  }

  async #get(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const key = typeof args.key === "string" ? args.key : "text";
    // Scroll/viewport + page-liveness parity with the extension host's
    // page.scrollpos / page.state probes — evaluate is backend-internal,
    // not the agent-facing tool.
    let probeError: unknown;
    const probe = await page
      .evaluate(() => ({
        scrollX: window.scrollX,
        scrollY: window.scrollY,
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        documentHeight: document.documentElement.scrollHeight,
        readyState: document.readyState,
        visibilityState: document.visibilityState,
        hasFocus: document.hasFocus(),
        online: navigator.onLine,
      }))
      .catch((e: unknown) => {
        probeError = e;
        return undefined;
      });
    // Parity with the extension host's CDP crash probe: a failed liveness
    // evaluate on a crashed renderer reports crashed:true; other probe
    // failures (mid-navigation etc.) stay ambiguous → field omitted.
    const crashed =
      probe === undefined &&
      probeError instanceof Error &&
      /crash/i.test(probeError.message)
        ? true
        : undefined;
    const scroll = probe
      ? {
          scrollX: probe.scrollX,
          scrollY: probe.scrollY,
          viewportWidth: probe.viewportWidth,
          viewportHeight: probe.viewportHeight,
          documentWidth: probe.documentWidth,
          documentHeight: probe.documentHeight,
        }
      : undefined;
    const pageState = probe
      ? {
          readyState: probe.readyState,
          visibilityState: probe.visibilityState,
          hasFocus: probe.hasFocus,
          online: probe.online,
        }
      : undefined;
    const context = await this.#contextFor(taskId);
    // frameId discovery — index into page.frames() (0 = main frame),
    // the same ids args.frameId accepts on FRAME_CAPABLE tools. OOPIFs
    // appear automatically; parentFrameId is the parent's index (-1
    // for the main frame).
    // fake pages in unit tests may lack frames()
    const frames = typeof page.frames === "function" ? page.frames() : [];
    const framesList = frames.map((f, i) => {
      const parent = f.parentFrame();
      return {
        frameId: i,
        url: stripQuery(f.url()),
        parentFrameId: parent ? frames.indexOf(parent) : -1,
      };
    });
    const base = {
      tabId: context.pages().indexOf(page),
      url: stripQuery(page.url()),
      frames: framesList,
      ...(scroll ? { scroll } : {}),
      ...(pageState ? { page: pageState } : {}),
      ...(crashed === true ? { crashed: true } : {}),
      ...(pageState ? { status: pageState.readyState === "loading" ? "loading" : "complete" } : {}),
    };
    if (key === "text") {
      const text = await page.locator("body").evaluate(deepInnerText).catch(() => "");
      return { value: boundText(text, MAX_EXTRACT_CHARS).text, ...base };
    }
    if (key === "title") return { value: await page.title(), ...base };
    if (key === "url") return { value: stripQuery(page.url()) };
    throw protocolError("proto.invalid", `unsupported page.get key ${key}`);
  }

  async #extract(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const target = await this.#frameTarget(taskId, args);
    const selector = typeof args.selector === "string" && args.selector ? args.selector : "body";
    const maxChars = typeof args.maxChars === "number" ? args.maxChars : MAX_EXTRACT_CHARS;
    const format = args.format === undefined ? "text" : args.format === "html" ? "html" : null;
    if (format === null) {
      throw protocolError("proto.invalid", "browser.page.extract args.format must be text|html");
    }
    const locator = target.locator(selector).first();
    const raw =
      format === "html"
        ? await locator.evaluate((el) => (el as Element).outerHTML).catch(() => "")
        : await locator.evaluate(deepInnerText).catch(() => "");
    const bounded = boundText(raw, Math.min(maxChars, MAX_EXTRACT_CHARS));
    return { text: bounded.text, truncated: bounded.truncated, url: stripQuery(target.url()) };
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
    if (typeof page.on !== "function" || this.#trackedPages.has(page)) return page;
    this.#trackedPages.add(page);
    this.#ensureConsoleCapture(page);
    this.#ensureNetworkCapture(page);
    this.#ensureResponseTap(page);
    this.#ensureWsTap(page);
    this.#ensureDialogCapture(page);
    page.on("close", () => this.#forgetPage(page));
    return page;
  }

  /** Drop every per-page buffer when a page closes — without this the
   *  strong Map keys keep closed Page objects (and their response/WS/
   *  route buffers) alive for the backend's lifetime. */
  #forgetPage(page: PwPage): void {
    this.#consoleBuffers.delete(page);
    this.#networkBuffers.delete(page);
    this.#responseBuffers.delete(page);
    this.#wsBuffers.delete(page);
    this.#routeRules.delete(page);
    this.#fulfilledBodies.delete(page);
    this.#pendingDialogs.delete(page);
  }

  #ensureDialogCapture(page: PwPage): void {
    if (this.#pendingDialogs.has(page)) return;
    this.#pendingDialogs.set(page, null);
    page.on("dialog", (d) => {
      this.#pendingDialogs.set(page, {
        dialog: d,
        type: d.type(),
        message: d.message().slice(0, MAX_CONSOLE_TEXT),
        defaultPrompt: String(d.defaultValue() ?? "").slice(0, 1000),
      });
    });
  }

  /** Body text including open shadow-root content — innerText alone
   *  never crosses shadow boundaries, so wait/text conditions would be
   *  blind to web-component UIs. */
  async #deepBodyText(target: PwTarget): Promise<string> {
    const body = target.locator("body");
    const deep =
      typeof body.evaluate === "function"
        ? await body.evaluate(deepInnerText).catch(() => null)
        : null;
    if (typeof deep === "string") return deep;
    return body.innerText().catch(() => "");
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

  async #evaluate(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const target = await this.#frameTarget(taskId, args);
    const expression = typeof args.expression === "string" ? args.expression.trim() : "";
    if (expression.length === 0 || expression.length > 65536) {
      throw protocolError("proto.invalid", "browser.page.evaluate requires args.expression (≤64KiB)");
    }
    if (args.ref !== undefined) {
      throw protocolError(
        "proto.invalid",
        "element-scoped evaluate (pz pierce refs) is chrome-extension only — isolated has no closed-shadow-root pierce",
      );
    }
    const timeoutMs =
      typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
        ? Math.min(Math.max(args.timeoutMs, 100), 15_000)
        : 10_000;
    // Same contract as the extension path: expression semantics, awaited
    // promises. Playwright string-evaluate already awaits the result.
    let value: unknown;
    try {
      value = await Promise.race([
        target.evaluate(expression),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(protocolError("browser.timeout", `evaluate exceeded ${timeoutMs}ms`)), timeoutMs),
        ),
      ]);
    } catch (e) {
      if (e && typeof e === "object" && "code" in e) throw e;
      // Match the extension contract: page-thrown exceptions come back
      // as {ok:false,error} data, not a tool failure — the agent can
      // read and recover from them. Bounded; still fenced downstream.
      const message = e instanceof Error ? e.message : String(e);
      return { ok: false, error: message.slice(0, 4096), truncated: false };
    }
    let serialized: string | undefined;
    try {
      serialized = JSON.stringify(value);
    } catch {
      serialized = undefined;
    }
    const maxChars = 256 * 1024;
    if (serialized === undefined || serialized.length > maxChars) {
      return { ok: true, value: serialized === undefined ? null : serialized.slice(0, maxChars), truncated: true };
    }
    return { ok: true, value: JSON.parse(serialized) as unknown, truncated: false };
  }

  /** Lazily attach a CDP session to the page — Emulation.* overrides
   *  beyond playwright's viewport/media subset go through the same
   *  commands the extension debugger tier sends. */
  async #emulationSession(page: PwPage): Promise<PwCDPSession> {
    const cached = this.#cdpSessions.get(page);
    if (cached) return cached;
    const session = await page.context().newCDPSession(page);
    this.#cdpSessions.set(page, session);
    return session;
  }

  async #emulate(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const applied: string[] = [];
    let cdpSession: PwCDPSession | null = null;
    const cdp = async (): Promise<PwCDPSession> =>
      (cdpSession ??= await this.#emulationSession(page));

    if (args.reset === true) {
      // playwright's setViewportSize/emulateMedia are themselves CDP
      // Emulation.* overrides under the hood — clearing them via the
      // session covers every path (including width/height-only calls
      // that never touched this session).
      const s = await cdp();
      await Promise.allSettled([
        s.send("Emulation.clearDeviceMetricsOverride"),
        s.send("Emulation.setTimezoneOverride", { timezoneId: "" }),
        s.send("Emulation.setGeolocationOverride", {}),
        s.send("Emulation.setEmulatedMedia", { features: [] }),
        s.send("Emulation.setCPUThrottlingRate", { rate: 1 }),
        s.send("Network.emulateNetworkConditions", {
          offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
        }),
        // {} clears the override — same as the extension reset path;
        // the protocol type marks userAgent required but accepts {}.
        s.send("Emulation.setUserAgentOverride", {} as never),
      ]);
      return { ok: true, reset: true, applied: ["viewport", "media", "device", "network"] };
    }

    const emuNum = (v: unknown, name: string, min: number, max: number): number | undefined => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
        throw protocolError("proto.invalid", `args.${name} must be a number in [${min}, ${max}]`);
      }
      return v;
    };
    const emuStr = (v: unknown, name: string, max = 512): string | undefined => {
      if (v === undefined || v === null) return undefined;
      if (typeof v !== "string" || v.length === 0 || v.length > max) {
        throw protocolError("proto.invalid", `args.${name} must be a non-empty string ≤${max} chars`);
      }
      return v;
    };

    // Metrics group: width/height alone stay on playwright's viewport
    // API; deviceScaleFactor/mobile/screen* need CDP setDeviceMetricsOverride
    // (same command playwright itself sends) — and like the extension
    // tier, any metrics arg requires width+height together.
    const width = emuNum(args.width, "width", 100, 7680);
    const height = emuNum(args.height, "height", 100, 7680);
    const dsf = emuNum(args.deviceScaleFactor, "deviceScaleFactor", 0.5, 4);
    const mobile = typeof args.mobile === "boolean" ? args.mobile : undefined;
    const screenWidth = emuNum(args.screenWidth, "screenWidth", 100, 7680);
    const screenHeight = emuNum(args.screenHeight, "screenHeight", 100, 7680);
    if (width !== undefined || height !== undefined || dsf !== undefined || mobile !== undefined || screenWidth !== undefined || screenHeight !== undefined) {
      if (width === undefined || height === undefined) {
        throw protocolError("proto.invalid", "emulate width/height must be provided together");
      }
      if (dsf !== undefined || mobile !== undefined || screenWidth !== undefined || screenHeight !== undefined) {
        await (await cdp()).send("Emulation.setDeviceMetricsOverride", {
          width, height,
          deviceScaleFactor: dsf ?? 1,
          mobile: mobile ?? false,
          ...(screenWidth !== undefined ? { screenWidth } : {}),
          ...(screenHeight !== undefined ? { screenHeight } : {}),
        });
      } else {
        await page.setViewportSize({ width, height });
      }
      applied.push("viewport");
    }

    const ua = emuStr(args.userAgent, "userAgent", 1024);
    if (ua !== undefined) {
      await (await cdp()).send("Emulation.setUserAgentOverride", { userAgent: ua });
      applied.push("userAgent");
    }
    const tz = emuStr(args.timezoneId, "timezoneId", 128);
    if (tz !== undefined) {
      await (await cdp()).send("Emulation.setTimezoneOverride", { timezoneId: tz });
      applied.push("timezone");
    }
    const geo = args.geolocation as Record<string, unknown> | undefined;
    if (geo !== undefined) {
      const latitude = emuNum(geo?.latitude, "geolocation.latitude", -90, 90);
      const longitude = emuNum(geo?.longitude, "geolocation.longitude", -180, 180);
      const accuracy = emuNum(geo?.accuracy, "geolocation.accuracy", 0, 100000);
      if (latitude === undefined || longitude === undefined) {
        throw protocolError("proto.invalid", "args.geolocation requires latitude and longitude");
      }
      await (await cdp()).send("Emulation.setGeolocationOverride", {
        latitude, longitude, accuracy: accuracy ?? 100,
      });
      applied.push("geolocation");
    }
    const media: { colorScheme?: "light" | "dark" | "no-preference"; reducedMotion?: "reduce" | "no-preference" } = {};
    if (args.colorScheme !== undefined) {
      if (!["light", "dark", "no-preference"].includes(String(args.colorScheme))) {
        throw protocolError("proto.invalid", "args.colorScheme must be light|dark|no-preference");
      }
      media.colorScheme = args.colorScheme as "light" | "dark" | "no-preference";
    }
    if (args.reducedMotion !== undefined) {
      if (!["reduce", "no-preference"].includes(String(args.reducedMotion))) {
        throw protocolError("proto.invalid", "args.reducedMotion must be reduce|no-preference");
      }
      media.reducedMotion = args.reducedMotion as "reduce" | "no-preference";
    }
    if (Object.keys(media).length > 0) {
      await page.emulateMedia(media);
      applied.push("media");
    }
    const cpu = emuNum(args.cpuThrottle, "cpuThrottle", 1, 20);
    if (cpu !== undefined) {
      await (await cdp()).send("Emulation.setCPUThrottlingRate", { rate: cpu });
      applied.push("cpuThrottle");
    }
    const net = args.network as Record<string, unknown> | undefined;
    if (net !== undefined) {
      const offline = net.offline === true;
      const latency = emuNum(net.latency, "network.latency", 0, 60000) ?? -1;
      const down = emuNum(net.downloadThroughput, "network.downloadThroughput", -1, 1e10) ?? -1;
      const up = emuNum(net.uploadThroughput, "network.uploadThroughput", -1, 1e10) ?? -1;
      await (await cdp()).send("Network.emulateNetworkConditions", {
        offline, latency, downloadThroughput: down, uploadThroughput: up,
      });
      applied.push("network");
    }
    if (applied.length === 0) {
      throw protocolError("proto.invalid", "browser.page.emulate requires at least one override arg (or args.reset)");
    }
    return { ok: true, applied };
  }

  async #pdf(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    if (typeof args.frameId === "number" && args.frameId !== 0) {
      throw protocolError("proto.invalid", "browser.page.pdf is tab-scoped; args.frameId is not supported");
    }
    const pdfArgs = {
      landscape: args.landscape === true,
      printBackground: args.printBackground !== false,
      ...(typeof args.paperWidth === "number" ? { width: `${args.paperWidth}in` } : {}),
      ...(typeof args.paperHeight === "number" ? { height: `${args.paperHeight}in` } : {}),
    };
    let buf = await page.pdf(pdfArgs).catch((e: unknown) => {
      throw protocolError("browser.action_failed", `page.pdf failed: ${e instanceof Error ? e.message : String(e)}`);
    });
    // Same 512KiB bound as the extension artifact cap — retry once at
    // reduced scale, then fail honestly rather than exceed it.
    if (buf.length > 512 * 1024) {
      buf = await page.pdf({ ...pdfArgs, scale: 0.6 }).catch(() => buf);
    }
    if (buf.length > 512 * 1024) {
      throw protocolError("proto.payload_too_large", `pdf is ${buf.length} bytes — exceeds the 512KiB cap`);
    }
    const { createHash } = await import("node:crypto");
    return {
      ok: true,
      mimeType: "application/pdf",
      bytes: buf.length,
      sha256: createHash("sha256").update(buf).digest("hex"),
    };
  }

  /** MHTML evidence capture — same CDP Page.captureSnapshot the
   *  extension debugger tier sends; bounded by the 512KiB artifact
   *  cap, oversized captures fail honestly. */
  async #mhtml(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    if (typeof args.frameId === "number" && args.frameId !== 0) {
      throw protocolError("proto.invalid", "browser.page.mhtml is tab-scoped; args.frameId is not supported");
    }
    const session = await this.#emulationSession(page);
    const res = (await (session.send as (m: string, p?: unknown) => Promise<unknown>)(
      "Page.captureSnapshot",
      { format: "mhtml" },
    )) as { data?: unknown } | undefined;
    if (typeof res?.data !== "string" || res.data.length === 0) {
      throw protocolError("browser.action_failed", "Page.captureSnapshot returned no data");
    }
    const bytes = Buffer.byteLength(res.data, "utf8");
    if (bytes > 512 * 1024) {
      throw protocolError(
        "proto.payload_too_large",
        `mhtml is ${bytes} bytes — exceeds the 512KiB artifact cap`,
      );
    }
    const { createHash } = await import("node:crypto");
    return {
      ok: true,
      mimeType: "multipart/related",
      bytes,
      sha256: createHash("sha256").update(res.data, "utf8").digest("hex"),
    };
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

  // ---- response bodies / web sockets / interception ----
  // Same contracts as the extension CDP taps (tool-host.ts), backed by
  // playwright's response/websocket/route events instead of Network.*
  // and Fetch.* domains. Capture starts at page creation — there is no
  // attach moment on this backend, so `capturingSince` is the page's
  // track time rather than a tap time.

  #ensureResponseTap(page: PwPage): void {
    if (this.#responseBuffers.has(page)) return;
    const buf: Array<{
      id: string; method: string; url: string; type: string;
      status?: number; mimeType?: string; ts: number; res: PwResponse;
    }> = [];
    this.#responseBuffers.set(page, buf);
    page.on("response", (res) => {
      const req = res.request();
      // mimeType comes from the response headers directly — the
      // network-capture listener owns #pendingRequests and may have
      // already consumed the entry (listener order is registration
      // order, not guaranteed).
      const mime = res.headers()["content-type"];
      buf.push({
        id: `r${++this.#responseSeq}`,
        method: req.method(),
        url: stripQuery(res.url()).slice(0, MAX_URL_LEN),
        type: req.resourceType(),
        status: res.status(),
        ...(mime ? { mimeType: mime.split(";")[0]!.slice(0, MAX_MIME_LEN) } : {}),
        ts: Date.now(),
        res,
      });
      if (buf.length > MAX_NETWORK_ENTRIES) buf.splice(0, buf.length - MAX_NETWORK_ENTRIES);
    });
  }

  #ensureWsTap(page: PwPage): void {
    if (this.#wsBuffers.has(page)) return;
    const buf: Array<{
      id: string; url: string; ts: number; closed: boolean;
      frames: Array<{ dir: "sent" | "recv"; data: string; binary: boolean; ts: number; truncated?: boolean }>;
    }> = [];
    this.#wsBuffers.set(page, buf);
    const WS_FRAME_MAX = 8 * 1024;
    const WS_CONN_CAP = 50;
    const WS_FRAME_CAP = 200;
    page.on("websocket", (ws: PwWebSocket) => {
      const conn = { id: `ws${++this.#wsSeq}`, url: stripQuery(ws.url()).slice(0, MAX_URL_LEN), ts: Date.now(), closed: false, frames: [] as typeof buf[number]["frames"] };
      buf.push(conn);
      if (buf.length > WS_CONN_CAP) buf.splice(0, buf.length - WS_CONN_CAP);
      const pushFrame = (dir: "sent" | "recv", payload: string | Buffer) => {
        if (conn.frames.length >= WS_FRAME_CAP) return;
        const isBuffer = typeof payload !== "string";
        const raw = isBuffer ? payload : Buffer.from(payload, "utf8");
        const truncated = raw.length > WS_FRAME_MAX;
        conn.frames.push({
          dir,
          data: isBuffer
            ? raw.subarray(0, WS_FRAME_MAX).toString("base64")
            : raw.subarray(0, WS_FRAME_MAX).toString("utf8"),
          binary: isBuffer,
          ts: Date.now(),
          ...(truncated ? { truncated: true } : {}),
        });
      };
      ws.on("framesent", (p) => pushFrame("sent", p.payload));
      ws.on("framereceived", (p) => pushFrame("recv", p.payload));
      ws.on("close", () => { conn.closed = true; });
    });
  }

  async #responseBody(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    this.#ensureResponseTap(page);
    const buf = this.#responseBuffers.get(page) ?? [];
    const requestId = typeof args.requestId === "string" ? args.requestId : "";
    const urlContains = typeof args.urlContains === "string" ? args.urlContains : "";
    const maxBytes =
      typeof args.maxBytes === "number" && Number.isFinite(args.maxBytes)
        ? Math.min(Math.max(Math.floor(args.maxBytes), 1024), 256 * 1024)
        : 64 * 1024;
    const toPublic = (e: (typeof buf)[number]) => ({
      requestId: e.id,
      method: e.method,
      url: e.url,
      ...(e.type ? { type: e.type } : {}),
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.mimeType ? { mimeType: e.mimeType } : {}),
      finished: true,
      ts: e.ts,
    });
    if (requestId) {
      const entry = [...buf].reverse().find((e) => e.id === requestId);
      if (!entry) {
        throw protocolError("browser.action_failed", `no captured response with requestId ${requestId}`);
      }
      let body = await entry.res.body().catch(() => null);
      if (body === null) {
        // Fulfilled-route responses have no network body — recover the
        // payload the fulfill rule served for this URL.
        const fb = (this.#fulfilledBodies.get(page) ?? [])
          .filter((f) => f.url === entry.res.url())
          .at(-1);
        if (fb) body = Buffer.from(fb.body, "utf8");
      }
      if (body === null) {
        throw protocolError("browser.action_failed", `no response body available for ${requestId}`);
      }
      const truncated = body.length > maxBytes;
      return {
        ...toPublic(entry),
        body: body.toString("utf8", 0, Math.min(body.length, maxBytes)),
        bodyBytes: body.length,
        truncated,
      };
    }
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(Math.max(Math.floor(args.limit), 1), 200)
        : 50;
    const filtered = buf.filter((e) => !urlContains || e.url.includes(urlContains));
    return { requests: filtered.slice(-limit).map(toPublic), captured: true };
  }

  async #webSocket(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    this.#ensureWsTap(page);
    const buf = this.#wsBuffers.get(page) ?? [];
    const urlContains = typeof args.urlContains === "string" ? args.urlContains : "";
    const requestId = typeof args.requestId === "string" ? args.requestId : "";
    const toPublic = (s: (typeof buf)[number], withFrames: boolean) => ({
      requestId: s.id,
      url: s.url,
      ts: s.ts,
      closed: s.closed,
      frameCount: s.frames.length,
      ...(withFrames
        ? {
            frames: s.frames.slice(-(
              typeof args.frameLimit === "number" && Number.isFinite(args.frameLimit)
                ? Math.min(Math.max(Math.floor(args.frameLimit), 1), 200)
                : 50
            )).map((f) => ({
              dir: f.dir,
              data: f.data,
              binary: f.binary,
              ...(f.truncated ? { truncated: true } : {}),
              ts: f.ts,
            })),
          }
        : {}),
    });
    if (requestId) {
      const s = [...buf].reverse().find((x) => x.id === requestId);
      if (!s) {
        throw protocolError("browser.action_failed", `no captured WebSocket with requestId ${requestId}`);
      }
      return { ...toPublic(s, true), captured: true };
    }
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(Math.max(Math.floor(args.limit), 1), 50)
        : 20;
    const filtered = buf.filter((s) => !urlContains || s.url.includes(urlContains));
    return { sockets: filtered.slice(-limit).map((s) => toPublic(s, false)), captured: true };
  }

  /** Lazily install the catch-all route handler + rule list for a page. */
  async #ensureRoute(page: PwPage): Promise<IsoRouteRule[]> {
    let rules = this.#routeRules.get(page);
    if (rules) return rules;
    rules = [];
    this.#routeRules.set(page, rules);
    await page.route("**/*", async (route: PwRoute) => {
      const req = route.request();
      const rule = rules.find((r) => req.url().includes(r.match));
      if (!rule) return route.fallback();
      try {
        if (rule.action === "abort") return await route.abort();
        if (rule.action === "modify") {
          const overrides: Parameters<PwRoute["continue"]>[0] = {};
          if (rule.url !== undefined) overrides.url = rule.url;
          if (rule.requestBody !== undefined) overrides.postData = rule.requestBody;
          if (rule.requestHeaders !== undefined) {
            const base = await req.allHeaders().catch(() => req.headers());
            overrides.headers = { ...base, ...rule.requestHeaders };
          }
          return await route.continue(overrides);
        }
        const headers = { ...rule.headers };
        if (!Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
          headers["content-type"] = "text/plain";
        }
        const fulfilled = this.#fulfilledBodies.get(page) ?? [];
        fulfilled.push({ url: req.url(), body: rule.body, ts: Date.now() });
        if (fulfilled.length > 100) fulfilled.splice(0, fulfilled.length - 100);
        this.#fulfilledBodies.set(page, fulfilled);
        return await route.fulfill({ status: rule.status, headers, body: rule.body });
      } catch {
        return route.fallback();
      }
    });
    return rules;
  }

  async #route(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const match = typeof args.match === "string" ? args.match : "";
    if (!match || match.length > 512) {
      throw protocolError("proto.invalid", "browser.page.route requires args.match (URL substring ≤512)");
    }
    const action = args.action === undefined ? "fulfill" : args.action;
    if (action !== "fulfill" && action !== "abort" && action !== "modify") {
      throw protocolError("proto.invalid", "browser.page.route args.action must be fulfill|abort|modify");
    }
    const rules = await this.#ensureRoute(page);
    if (rules.length >= 50) {
      throw protocolError("proto.invalid", "route rule cap reached (50) — unroute first");
    }
    const rule: IsoRouteRule = {
      id: `rt${++this.#routeSeq}`,
      match,
      action: action as IsoRouteRule["action"],
      status: 200,
      headers: {},
      body: "",
    };
    if (action === "fulfill") {
      if (args.status !== undefined) {
        if (typeof args.status !== "number" || args.status < 100 || args.status > 599) {
          throw protocolError("proto.invalid", "args.status must be 100–599");
        }
        rule.status = args.status;
      }
      if (args.contentType !== undefined) {
        if (typeof args.contentType !== "string" || args.contentType.length > 200) {
          throw protocolError("proto.invalid", "args.contentType must be a string ≤200 chars");
        }
        rule.headers["Content-Type"] = args.contentType;
      }
      if (args.headers !== undefined) {
        if (typeof args.headers !== "object" || args.headers === null || Array.isArray(args.headers)) {
          throw protocolError("proto.invalid", "args.headers must be an object of string values");
        }
        for (const [k, v] of Object.entries(args.headers as Record<string, unknown>)) {
          if (typeof v !== "string" || k.length === 0 || k.length > 100 || v.length > 8192) {
            throw protocolError("proto.invalid", "args.headers values must be strings (name ≤100, value ≤8192 chars)");
          }
          rule.headers[k] = v;
        }
      }
      if (args.body !== undefined) {
        if (typeof args.body !== "string") {
          throw protocolError("proto.invalid", "args.body must be a string");
        }
        if (args.body.length > 256 * 1024) {
          throw protocolError("proto.payload_too_large", "args.body exceeds 256KiB");
        }
        rule.body = args.body;
      }
    }
    if (action === "modify") {
      if (args.url !== undefined) {
        if (typeof args.url !== "string" || args.url.length > 2048) {
          throw protocolError("proto.invalid", "args.url must be a string ≤2048 chars");
        }
        rule.url = args.url;
      }
      if (args.requestHeaders !== undefined) {
        if (typeof args.requestHeaders !== "object" || args.requestHeaders === null || Array.isArray(args.requestHeaders)) {
          throw protocolError("proto.invalid", "args.requestHeaders must be an object of string values");
        }
        const hdrs: Record<string, string> = {};
        for (const [k, v] of Object.entries(args.requestHeaders as Record<string, unknown>)) {
          if (typeof v !== "string" || k.length === 0 || k.length > 100 || v.length > 8192) {
            throw protocolError("proto.invalid", "args.requestHeaders values must be strings (name ≤100, value ≤8192 chars)");
          }
          hdrs[k] = v;
        }
        if (Object.keys(hdrs).length > 0) rule.requestHeaders = hdrs;
      }
      if (args.requestBody !== undefined) {
        if (typeof args.requestBody !== "string") {
          throw protocolError("proto.invalid", "args.requestBody must be a string");
        }
        if (args.requestBody.length > 256 * 1024) {
          throw protocolError("proto.payload_too_large", "args.requestBody exceeds 256KiB");
        }
        rule.requestBody = args.requestBody;
      }
      if (rule.url === undefined && rule.requestHeaders === undefined && rule.requestBody === undefined) {
        throw protocolError("proto.invalid", "browser.page.route action:modify requires args.url, args.requestHeaders or args.requestBody");
      }
    }
    rules.push(rule);
    return { routeId: rule.id, match, action, status: rule.status, rules: rules.length };
  }

  async #unroute(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const rules = this.#routeRules.get(page);
    const routeId = typeof args.routeId === "string" ? args.routeId : "";
    if (!rules || rules.length === 0) {
      return { removed: 0, remaining: 0 };
    }
    let removed = 0;
    if (routeId) {
      const idx = rules.findIndex((r) => r.id === routeId);
      if (idx === -1) {
        throw protocolError("browser.action_failed", `no route rule ${routeId} on this page`);
      }
      rules.splice(idx, 1);
      removed = 1;
    } else {
      removed = rules.length;
      rules.length = 0;
    }
    if (rules.length === 0) {
      // Fully detach interception — no phantom route handler left
      // consuming every request through fallback().
      await page.unroute("**/*").catch(() => {});
      this.#routeRules.delete(page);
    }
    return { removed, remaining: rules.length };
  }

  /** browser.page.dialog — resolve the page's open JS dialog. The
   *  capture listener (installed at track time) holds dialogs open
   *  until this tool accepts/dismisses them — same semantics as the
   *  extension's Page.handleJavaScriptDialog, including waiting for a
   *  dialog that has not opened yet. */
  async #dialog(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    this.#ensureDialogCapture(page);
    const accept = args.accept === true; // default dismiss — never confirm implicitly
    const promptText =
      typeof args.promptText === "string" && args.promptText.length <= 8192
        ? args.promptText
        : undefined;
    const timeoutMs =
      typeof args.timeoutMs === "number" && Number.isFinite(args.timeoutMs)
        ? Math.min(Math.max(Math.floor(args.timeoutMs), 100), 30_000)
        : 5_000;
    const deadline = Date.now() + timeoutMs;
    let pending = this.#pendingDialogs.get(page) ?? null;
    while (pending === null && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
      pending = this.#pendingDialogs.get(page) ?? null;
    }
    if (pending === null) {
      return { handled: false, reason: "no_dialog" };
    }
    this.#pendingDialogs.set(page, null);
    try {
      if (accept) {
        await pending.dialog.accept(promptText);
      } else {
        await pending.dialog.dismiss();
      }
    } catch (e) {
      throw protocolError(
        "browser.action_failed",
        `dialog handling failed: ${String((e as Error)?.message ?? e)}`,
      );
    }
    return {
      handled: true,
      accept,
      dialog: {
        type: pending.type,
        message: pending.message,
        ...(pending.defaultPrompt ? { defaultPrompt: pending.defaultPrompt } : {}),
      },
    };
  }

  async #screenshot(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    // Element clips are a chrome-extension CDP capability — refuse
    // rather than silently returning a full-page capture.
    if (args.ref !== undefined || args.selector !== undefined || args.label !== undefined) {
      throw protocolError(
        "proto.unsupported",
        "element-targeted screenshots are not supported on playwright-isolated",
      );
    }
    if (args.fullPage !== undefined && typeof args.fullPage !== "boolean") {
      throw protocolError("proto.invalid", "browser.page.screenshot args.fullPage must be a boolean");
    }
    const fullPage = args.fullPage === true;
    const page = await this.#pageFor(taskId, args);
    // chromex-22wi: the result IS the provider's image input — there is
    // no artifact.upload channel on this backend, so the payload must be
    // bounded inline. Same 512KiB decoded ceiling the gateway artifact
    // store enforces; retry at lower jpeg quality, then fail honestly.
    for (const quality of SCREENSHOT_JPEG_QUALITIES) {
      const buf = await page.screenshot({ type: "jpeg", quality, fullPage });
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

  /** §4.8 preflight: resolve the pending action's target inside the
   *  page and report ground-truth facts — same contract as the
   *  extension host's browser.internal.describeTarget (real label,
   *  input type, form method/action, page origin). Targetless calls
   *  (e.g. page.press) describe document.activeElement. */
  async #describeTarget(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#frameTarget(taskId, args);
    const sel =
      typeof args.selector === "string" && args.selector
        ? args.selector
        : typeof args.ref === "string" && args.ref
          ? args.ref
          : null;
    const facts = await page
      .evaluate((selector: string | null) => {
        // querySelector does not cross shadow boundaries — mirror the
        // extension host's deep lookup so shadow targets describe the
        // same element the (shadow-piercing) locator will act on.
        const deepQueryAll = (sel: string): Element[] => {
          const out = Array.from(document.querySelectorAll(sel));
          const walk = (scope: ParentNode): void => {
            for (const node of Array.from(scope.querySelectorAll("*"))) {
              const sr = (node as HTMLElement).shadowRoot;
              if (sr) {
                out.push(...Array.from(sr.querySelectorAll(sel)));
                walk(sr);
              }
            }
          };
          walk(document);
          return out;
        };
        const el = selector
          ? (deepQueryAll(selector)[0] ?? null)
          : document.activeElement;
        if (!(el instanceof HTMLElement)) {
          return { found: false, reason: "not_found" };
        }
        const labelledBy = el.getAttribute("aria-labelledby");
        const labelledByText = labelledBy
          ? labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.textContent ?? "")
              .join(" ")
          : "";
        const inputLabels = el.id
          ? Array.from(document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`))
              .map((label) => label.textContent ?? "")
              .join(" ")
          : "";
        const label = (
          el.getAttribute("aria-label") ||
          labelledByText ||
          inputLabels ||
          el.getAttribute("placeholder") ||
          el.getAttribute("title") ||
          (el instanceof HTMLInputElement ? el.value : "") ||
          el.innerText ||
          el.textContent ||
          ""
        )
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 160);
        const form = el.closest("form");
        const anchor = el instanceof HTMLAnchorElement ? el : el.querySelector("a[href]");
        let formAction = "";
        const formActionRaw = form?.getAttribute("action") ?? "";
        if (formActionRaw) {
          try {
            const u = new URL(formActionRaw, location.href);
            formAction = `${u.origin}${u.pathname}`;
          } catch {
            /* invalid form action URL */
          }
        }
        let href = "";
        if (anchor instanceof HTMLAnchorElement && anchor.href) {
          try {
            const u = new URL(anchor.href);
            href = `${u.origin}${u.pathname}`;
          } catch {
            /* invalid href */
          }
        }
        return {
          found: true,
          label,
          tagName: el.tagName.toLowerCase(),
          role: el.getAttribute("role") ?? "",
          ...(el instanceof HTMLInputElement ? { inputType: el.type || "text" } : {}),
          ...(el instanceof HTMLButtonElement || el instanceof HTMLInputElement
            ? { controlType: (el.getAttribute("type") || "submit").toLowerCase() }
            : {}),
          ...(form ? { formMethod: (form.getAttribute("method") || "get").toLowerCase() } : {}),
          ...(formAction ? { formAction } : {}),
          ...(href ? { href } : {}),
          pageOrigin: location.origin,
          pageUrl: `${location.origin}${location.pathname}`,
        };
      }, sel)
      .catch(() => null);
    return facts ?? { found: false, reason: "evaluate_failed" };
  }

  /** §4.8 dispatch binding (playwright-isolated parity with the
   *  extension content script): re-derive the approved facts inside
   *  the page immediately before the action and refuse with
   *  browser.target_changed when the target drifted. Coordinate clicks
   *  have no DOM target — same exemption as the extension path. */
  async #assertExpectedTarget(
    taskId: string,
    tool: BrowserToolName,
    args: Record<string, unknown>,
    expectedTarget: Record<string, string> | undefined,
  ): Promise<void> {
    if (!expectedTarget || Object.keys(expectedTarget).length === 0) return;
    const hasElementTarget =
      (typeof args.selector === "string" && args.selector.length > 0) ||
      (typeof args.ref === "string" && args.ref.length > 0) ||
      (typeof args.label === "string" && args.label.length > 0);
    const isCoordinateClick =
      tool === "browser.page.click" &&
      typeof args.x === "number" &&
      typeof args.y === "number" &&
      !hasElementTarget;
    if (isCoordinateClick) return;
    const desc = (await this.#describeTarget(taskId, args)) as Record<string, unknown>;
    // Target vanished → let the dispatch surface its honest not-found;
    // only a RESOLVED-but-different element is target_changed.
    if (desc.found !== true) return;
    for (const [key, expected] of Object.entries(expectedTarget)) {
      const actual = desc[key];
      if (String(actual ?? "") !== String(expected ?? "")) {
        throw protocolError(
          "browser.target_changed",
          `target changed since the action was risk-checked (${key}) — take a fresh browser.page.snapshot and retry`,
        );
      }
    }
  }

  async #domAction(taskId: string, tool: BrowserToolName, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const target = await this.#frameTarget(taskId, args);
    const frameScoped = (typeof args.frameId === "number" ? args.frameId : 0) !== 0;
    // Page-viewport offset of the frame target — coordinate mouse ops
    // take page pixels, so frame-relative coords translate by the
    // iframe element's bounding-box origin (0,0 for the main frame).
    // Unresolvable offset → refuse: a mis-translated click hits the
    // wrong element silently.
    const frameOffset = frameScoped ? await this.#frameMouseOffset(page, target) : { x: 0, y: 0 };
    if (frameScoped && frameOffset === null) {
      throw protocolError("proto.unsupported", "frame mouse offset unresolvable — coordinate ops need the iframe element's bounding box");
    }
    const offset = frameOffset ?? { x: 0, y: 0 };
    // press may target the focused element/page with no selector —
    // page.keyboard.press is the honest equivalent (Page-only API).
    if (tool === "browser.page.press") {
      const key = typeof args.key === "string" ? args.key : "";
      if (!key) throw protocolError("proto.invalid", "browser.page.press requires args.key");
      const chord = pressChord(key, args.modifiers);
      const sel = args.selector ?? args.ref;
      if (typeof sel === "string" && sel.length > 0) {
        await target.locator(sel).first().press(chord, { timeout: DEFAULT_NAV_TIMEOUT_MS });
      } else if (frameScoped) {
        // Selector-less press inside a frame: focus the frame's body
        // and send the chord — keyboard events land in the focused
        // frame's document, the honest equivalent of activeElement.
        await target.locator("body").first().press(chord, { timeout: DEFAULT_NAV_TIMEOUT_MS });
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
          await page.mouse.click(offset.x + x, offset.y + y, {
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
        await page.mouse.move(offset.x + x, offset.y + y);
        return { hovered: true, x, y };
      }
    }
    // Drag resolves its own targets — coordinate form has no selector,
    // element form needs source + drop selectors (not the single-target
    // #requireSelector path). Element bounding boxes are page-absolute
    // even inside frames; coordinate form translates by frameOffset.
    if (tool === "browser.page.drag") {
      return this.#drag(page, target, offset, args);
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
        await target
          .locator(sel)
          .first()
          .evaluate(scrollEl, scrollOpts)
          .catch(() => null);
      } else {
        await target
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
    const locator = target.locator(selector).first();
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
          if (!form) return;
          const submitter =
            (el instanceof HTMLButtonElement || el instanceof HTMLInputElement) &&
            (el.type === "submit" || el.type === "image") &&
            el.form === form
              ? el
              : undefined;
          (form as HTMLFormElement).requestSubmit(submitter);
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
  async #drag(
    page: PwPage,
    target: PwTarget,
    offset: { x: number; y: number },
    args: Record<string, unknown>,
  ): Promise<unknown> {
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
      await mouseDrag(offset.x + x, offset.y + y, offset.x + dropX, offset.y + dropY);
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
    const src = target.locator(srcSel).first();
    const dst = target.locator(dstSel).first();
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
    const target = await this.#frameTarget(taskId, args);
    const started = Date.now();
    const timeoutMs = Math.min(Math.max(cond.timeoutMs ?? EXPECT_DEFAULT_TIMEOUT_MS, 0), EXPECT_MAX_TIMEOUT_MS);
    const met = await this.#pollExpect(target, cond, timeoutMs);
    return {
      ...(result as Record<string, unknown>),
      verified: met === true ? true : met === false ? false : "unknown",
      expect: { met, elapsedMs: Date.now() - started },
    };
  }

  /** Poll until every expect condition holds or the deadline passes.
   *  "unknown" only when the page itself became unreachable mid-poll. */
  async #pollExpect(
    page: PwTarget,
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

  async #expectConditionsMet(page: PwTarget, cond: BrowserExpectCondition): Promise<boolean> {
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
      const bodyText = await this.#deepBodyText(page);
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
    const page = await this.#frameTarget(taskId, args);
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
    const responseUrl = typeof args.responseUrl === "string" ? args.responseUrl : null;
    if (args.responseUrl !== undefined && args.responseUrl !== null &&
        (typeof args.responseUrl !== "string" || args.responseUrl === "" || args.responseUrl.length > 512)) {
      throw protocolError("proto.invalid", "browser.page.wait args.responseUrl must be a non-empty string ≤512 chars");
    }
    if (responseUrl !== null && typeof args.frameId === "number" && args.frameId !== 0) {
      throw protocolError("proto.invalid", "args.frameId is not supported with args.responseUrl");
    }
    // consoleText waits on the per-page console buffer attached at page
    // birth — full lookback coverage, same contract as responseUrl.
    const consoleText = typeof args.consoleText === "string" ? args.consoleText : null;
    if (args.consoleText !== undefined && args.consoleText !== null &&
        (typeof args.consoleText !== "string" || args.consoleText === "" || args.consoleText.length > 512)) {
      throw protocolError("proto.invalid", "browser.page.wait args.consoleText must be a non-empty string ≤512 chars");
    }
    const consoleLevel = typeof args.consoleLevel === "string" ? args.consoleLevel : null;
    if (consoleLevel !== null) {
      if (consoleText === null) {
        throw protocolError("proto.invalid", "args.consoleLevel requires args.consoleText");
      }
      if (!["log", "info", "warn", "error", "debug"].includes(consoleLevel)) {
        throw protocolError("proto.invalid", "args.consoleLevel must be log|info|warn|error|debug");
      }
    }
    if (args.pierceRef !== undefined || args.pierceText !== undefined) {
      throw protocolError(
        "proto.invalid",
        "pierceRef/pierceText waits need browser.page.pierce — chrome-extension only (isolated has no closed-shadow-root pierce)",
      );
    }
    const hasCondition =
      selector !== null || selectorGone !== null || urlContains !== null || text !== null || textGone !== null || readyState !== null ||
      visibleSelector !== null || networkIdle || responseUrl !== null || consoleText !== null;
    if (selector !== null && selector === selectorGone) {
      throw protocolError("proto.invalid", "browser.page.wait args.selector and args.selectorGone must differ");
    }
    if (!hasCondition) {
      // plain timed wait — same contract as the extension host's ms sleep
      await page.waitForTimeout(Math.min(timeout, 30_000));
      return { ok: true, waitedMs: Math.min(timeout, 30_000) };
    }
    if (responseUrl !== null) {
      // Same contract as the extension host: match completed/failed
      // responses in the persistent network buffer within a lookback
      // window equal to the wait timeout — approval latency can exceed
      // a fast local response, and the matched entry's ts is evidence.
      const netPage = await this.#pageFor(taskId, args);
      const buf = this.#ensureNetworkCapture(netPage);
      const since = started - Math.min(timeout, 30_000);
      const respDeadline = deadline;
      let hit: NetworkLogEntry | undefined;
      for (;;) {
        hit = [...buf].reverse().find(
          (e) =>
            e.url.includes(responseUrl) &&
            e.ts >= since &&
            (e.status !== undefined || e.error !== undefined),
        );
        if (hit || Date.now() >= respDeadline) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!hit) {
        throw protocolError("browser.timeout", `no completed response matching "${responseUrl}" before timeout`);
      }
      const onlyResponse =
        selector === null && selectorGone === null && urlContains === null && text === null &&
        textGone === null && readyState === null && visibleSelector === null && !networkIdle &&
        consoleText === null;
      if (onlyResponse) {
        return {
          ok: true,
          matched: "response",
          response: {
            method: hit.method ?? "",
            url: hit.url ?? "",
            ...(typeof hit.status === "number" ? { status: hit.status } : {}),
            ...(hit.error ? { error: hit.error } : {}),
            ts: hit.ts ?? 0,
          },
        };
      }
    }
    if (consoleText !== null) {
      // Console buffer attaches at page birth — lookback covers the
      // whole wait window like responseUrl. Match is substring on the
      // serialized entry text plus optional exact level.
      const cbuf = this.#ensureConsoleCapture(await this.#pageFor(taskId, args));
      const since = started - Math.min(timeout, 30_000);
      let chit: { level: string; text: string; ts: number } | undefined;
      for (;;) {
        chit = [...cbuf].reverse().find(
          (e) =>
            e.ts >= since &&
            e.text.includes(consoleText) &&
            (consoleLevel === null || e.level === consoleLevel),
        );
        if (chit || Date.now() >= deadline) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!chit) {
        throw protocolError("browser.timeout", `no console message matching "${consoleText}" before timeout`);
      }
      const onlyConsole =
        selector === null && selectorGone === null && urlContains === null && text === null &&
        textGone === null && readyState === null && visibleSelector === null && !networkIdle &&
        responseUrl === null;
      if (onlyConsole) {
        return {
          ok: true,
          matched: "console",
          console: { level: chit.level, text: chit.text, ts: chit.ts },
        };
      }
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
        const bodyText = await this.#deepBodyText(page);
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
    let page = await this.#pageFor(taskId, args);
    const action = typeof args.action === "string" ? args.action : "";
    if (args.bypassCache !== undefined && typeof args.bypassCache !== "boolean") {
      throw protocolError("proto.invalid", "browser.page.history args.bypassCache must be a boolean");
    }
    if (args.bypassCache === true && action !== "reload") {
      throw protocolError("proto.invalid", "browser.page.history args.bypassCache only applies to action reload");
    }
    // goBack/goForward resolve null when there is no history entry —
    // report that honestly instead of claiming a navigation.
    let moved: boolean | null = null;
    let recoveredFromCrash = false;
    if (action === "back") {
      moved = (await page.goBack({ timeout: DEFAULT_NAV_TIMEOUT_MS }).catch(() => null)) !== null;
    } else if (action === "forward") {
      moved = (await page.goForward({ timeout: DEFAULT_NAV_TIMEOUT_MS }).catch(() => null)) !== null;
    } else if (action === "reload") {
      try {
        if (args.bypassCache === true) {
          // playwright page.reload has no cache-bypass — CDP
          // Page.reload {ignoreCache:true} is the honest equivalent
          // (same primitive chrome.tabs.reload {bypassCache} wraps).
          const session = await this.#emulationSession(page);
          await session.send("Page.reload", { ignoreCache: true });
        } else {
          await page.reload({ timeout: DEFAULT_NAV_TIMEOUT_MS });
        }
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (!/crash/i.test(msg)) throw e;
        // A crashed renderer cannot reload in place — playwright
        // refuses reload/goto on it. Real Chrome revives the same tab
        // with a fresh renderer; the isolated equivalent is a new page
        // at the same URL. tabId is a page index → it changes; report
        // the new id honestly instead of pretending the old one lived.
        const context = await this.#contextFor(taskId);
        const url = page.url();
        const fresh = this.#trackPage(await context.newPage());
        try {
          await fresh.goto(url || "about:blank", {
            timeout: DEFAULT_NAV_TIMEOUT_MS,
            waitUntil: "domcontentloaded",
          });
          if (args.bypassCache === true) {
            const session = await this.#emulationSession(fresh);
            await session.send("Page.reload", { ignoreCache: true });
          }
        } catch {
          // best-effort revive — the fresh page exists either way
        }
        await page.close().catch(() => {});
        page = fresh;
        recoveredFromCrash = true;
      }
      moved = true;
    } else {
      throw protocolError("proto.invalid", "browser.page.history requires args.action back|forward|reload");
    }
    await this.#recordVisit(taskId, page);
    const context = await this.#contextFor(taskId);
    return {
      navigated: action,
      ...(moved !== null ? { moved } : {}),
      url: stripQuery(page.url()),
      ...(recoveredFromCrash
        ? { recoveredFromCrash: true, tabId: context.pages().indexOf(page) }
        : {}),
    };
  }

  /** Append a visit to the task's log (cap 500 — oldest dropped). */
  async #recordVisit(taskId: string, page: PwPage): Promise<void> {
    const url = page.url();
    if (!url || url === "about:blank") return;
    const log = this.#visitLogs.get(taskId) ?? [];
    this.#visitLogs.set(taskId, log);
    log.push({
      url: stripQuery(url),
      // fake pages in unit tests may lack title()
      title: typeof page.title === "function" ? await page.title().catch(() => "") : "",
      ts: Date.now(),
    });
    if (log.length > 500) log.splice(0, log.length - 500);
  }

  /** browser.history.search over the task visit log — the honest
   *  isolated equivalent of chrome.history (no browser profile here). */
  async #historySearch(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const log = this.#visitLogs.get(taskId) ?? [];
    const text = typeof args.text === "string" && args.text ? args.text.toLowerCase() : undefined;
    const urlFilter = typeof args.url === "string" && args.url ? args.url : undefined;
    const parseTime = (v: unknown): number | undefined => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const t = Date.parse(v);
        if (Number.isFinite(t)) return t;
      }
      return undefined;
    };
    const startTime = parseTime(args.startTime);
    const endTime = parseTime(args.endTime);
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(Math.max(Math.floor(args.limit), 1), 200)
        : 50;
    const visits = log
      .filter((v) => {
        if (text && !(v.url.toLowerCase().includes(text) || v.title.toLowerCase().includes(text))) return false;
        if (urlFilter && !v.url.includes(urlFilter)) return false;
        if (startTime !== undefined && v.ts < startTime) return false;
        if (endTime !== undefined && v.ts > endTime) return false;
        return true;
      })
      .slice(-limit)
      .map((v) => ({ ...v, lastVisitTime: v.ts, lastVisitTimeIso: new Date(v.ts).toISOString() }));
    return { visits, count: visits.length, scope: "task" };
  }

  /** browser.history.delete over the task visit log — same arg
   *  contract as chrome.history.deleteUrl/deleteRange: exact url OR a
   *  startTime+endTime range. Task-scoped, honestly reported. */
  async #historyDelete(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const url = typeof args.url === "string" && args.url ? args.url : undefined;
    const parseTime = (v: unknown): number | undefined => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const t = Date.parse(v);
        if (Number.isFinite(t)) return t;
      }
      return undefined;
    };
    const startTime = parseTime(args.startTime);
    const endTime = parseTime(args.endTime);
    const hasRange = startTime !== undefined || endTime !== undefined;
    if (url && hasRange) {
      throw protocolError("proto.invalid", "browser.history.delete takes args.url OR args.startTime+args.endTime, not both");
    }
    if (!url && (startTime === undefined || endTime === undefined)) {
      throw protocolError("proto.invalid", "browser.history.delete requires args.url or args.startTime+args.endTime");
    }
    const log = this.#visitLogs.get(taskId) ?? [];
    const kept = log.filter((v) => {
      if (url) return v.url !== url;
      return !(v.ts >= startTime! && v.ts <= endTime!);
    });
    const deleted = log.length - kept.length;
    this.#visitLogs.set(taskId, kept);
    return {
      deleted: deleted > 0,
      removed: deleted,
      ...(url ? { url, mode: "url" } : { mode: "range", startTime, endTime }),
      scope: "task",
    };
  }

  /** browser.sessions over the task's recently-closed log — the honest
   *  isolated equivalent of chrome.sessions (no browser profile here).
   *  list returns entries most-recent first; restore reopens the URL in
   *  a new in-context page and removes the entry (chrome.sessions
   *  consumes restored entries the same way). */
  async #sessions(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const action = typeof args.action === "string" ? args.action : "list";
    if (action !== "list" && action !== "restore") {
      throw protocolError("proto.invalid", "browser.sessions args.action must be list|restore");
    }
    const log = this.#sessionLogs.get(taskId) ?? [];
    if (action === "list") {
      let maxResults = 25;
      if (args.maxResults !== undefined && args.maxResults !== null) {
        const n = args.maxResults;
        if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 25) {
          throw protocolError("proto.invalid", "browser.sessions args.maxResults must be an integer 1-25");
        }
        maxResults = n;
      }
      const entries = log.slice(0, maxResults).map((e) => ({
        kind: "tab",
        sessionId: e.sessionId,
        lastModified: e.lastModified,
        url: e.url,
        title: e.title,
      }));
      return { entries, count: entries.length, scope: "task" };
    }
    // restore
    let sessionId: string | undefined;
    if (args.sessionId !== undefined && args.sessionId !== null) {
      if (typeof args.sessionId !== "string" || args.sessionId.length < 1 || args.sessionId.length > 256) {
        throw protocolError("proto.invalid", "browser.sessions args.sessionId must be 1-256 chars");
      }
      sessionId = args.sessionId;
    }
    const idx = sessionId === undefined ? 0 : log.findIndex((e) => e.sessionId === sessionId);
    if (idx === -1 || log.length === 0) {
      return { restored: false, found: false, scope: "task" };
    }
    const entry = log[idx]!;
    const context = await this.#contextFor(taskId);
    const page = this.#trackPage(await context.newPage());
    this.#activePages.set(taskId, page);
    await page.goto(entry.url, { timeout: DEFAULT_NAV_TIMEOUT_MS, waitUntil: "domcontentloaded" }).catch(() => {});
    await this.#recordVisit(taskId, page);
    log.splice(idx, 1);
    const tabId = context.pages().indexOf(page);
    return {
      restored: true,
      found: true,
      sessionId: entry.sessionId,
      tabId,
      url: stripQuery(page.url() || entry.url),
      scope: "task",
    };
  }

  /** browser.browsingData.clear — honest subset on isolated: cookies
   *  (context.clearCookies), history (task visit log), downloads
   *  (download.delete per file). Everything else reports unsupported —
   *  playwright has no profile-wide store to wipe. origins is refused:
   *  there is no per-origin clear API to honor it with. */
  async #browsingDataClear(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const VALID = new Set([
      "appcache", "cache", "cacheStorage", "cookies", "downloads",
      "fileSystems", "formData", "history", "indexedDB", "localStorage",
      "passwords", "serviceWorkers", "webSQL",
    ]);
    const rawTypes = args.dataTypes;
    if (!Array.isArray(rawTypes) || rawTypes.length === 0 || rawTypes.length > 16) {
      throw protocolError("proto.invalid", "browser.browsingData.clear requires args.dataTypes (non-empty array ≤16)");
    }
    const dataTypes = [...new Set(rawTypes.filter((t): t is string => typeof t === "string"))];
    if (dataTypes.length === 0 || dataTypes.some((t) => !VALID.has(t))) {
      throw protocolError("proto.invalid", `browser.browsingData.clear args.dataTypes must be one of ${[...VALID].join("|")}`);
    }
    if (args.origins !== undefined) {
      throw protocolError("proto.unsupported", "playwright-isolated cannot scope browsingData.clear by origins — no per-origin clear API");
    }
    const parseTime = (v: unknown): number | undefined => {
      if (typeof v === "number" && Number.isFinite(v)) return v;
      if (typeof v === "string") {
        const t = Date.parse(v);
        if (Number.isFinite(t)) return t;
      }
      return undefined;
    };
    const sinceMs = parseTime(args.since);
    if (args.since !== undefined && sinceMs === undefined) {
      throw protocolError("proto.invalid", "browser.browsingData.clear args.since must be epoch ms or ISO date string");
    }
    const cleared: string[] = [];
    const unsupported: string[] = [];
    const ignoredSince: string[] = [];
    let removedHistory = 0;
    let removedDownloads = 0;
    const wants = new Set(dataTypes);

    if (wants.has("cookies")) {
      const context = this.#contexts.get(taskId);
      if (context) {
        await context.clearCookies();
        cleared.push("cookies");
        // clearCookies has no time filter — report honestly when since was asked
        if (sinceMs !== undefined && sinceMs > 0) ignoredSince.push("cookies");
      } else {
        unsupported.push("cookies");
      }
    }
    if (wants.has("history")) {
      const log = this.#visitLogs.get(taskId) ?? [];
      const kept = sinceMs !== undefined && sinceMs > 0
        ? log.filter((v) => v.ts < sinceMs)
        : [];
      removedHistory = log.length - kept.length;
      this.#visitLogs.set(taskId, kept);
      cleared.push("history");
    }
    if (wants.has("downloads")) {
      const log = this.#downloadLogs.get(taskId) ?? [];
      for (const entry of log) {
        try {
          await entry.download.delete();
          removedDownloads += 1;
        } catch {
          /* file may already be gone — the log entry still clears */
        }
      }
      this.#downloadLogs.set(taskId, []);
      cleared.push("downloads");
      if (sinceMs !== undefined && sinceMs > 0) ignoredSince.push("downloads");
    }
    for (const t of dataTypes) {
      if (!["cookies", "history", "downloads"].includes(t) && !unsupported.includes(t) && !cleared.includes(t)) {
        unsupported.push(t);
      }
    }
    return {
      cleared,
      unsupported,
      removedHistory,
      removedDownloads,
      ...(ignoredSince.length ? { ignoredSince } : {}),
      ...(sinceMs !== undefined && sinceMs > 0 ? { since: sinceMs } : {}),
      scope: "task",
    };
  }

  /** browser.siteSettings — honest subset on isolated: only the
   *  grantPermissions-mappable content types work, and only 'allow'
   *  (playwright has no deny/ask tri-state and cannot read effective
   *  settings). clear wipes ALL context permission overrides — reported
   *  scope:"context" honestly. */
  async #siteSettings(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const action = typeof args.action === "string" ? args.action : "get";
    if (!["get", "set", "clear"].includes(action)) {
      throw protocolError("proto.invalid", "browser.siteSettings args.action must be get|set|clear");
    }
    const contentType = typeof args.contentType === "string" ? args.contentType : "";
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(contentType)) {
      throw protocolError("proto.invalid", "browser.siteSettings requires args.contentType (snake_case, e.g. notifications)");
    }
    const rawOrigin = typeof args.origin === "string" ? args.origin : "";
    let originUrl: URL;
    try {
      originUrl = new URL(rawOrigin);
    } catch {
      throw protocolError("proto.invalid", "browser.siteSettings args.origin is not a valid URL");
    }
    if (originUrl.protocol !== "http:" && originUrl.protocol !== "https:") {
      throw protocolError("proto.invalid", "browser.siteSettings args.origin must be http(s)");
    }
    const origin = originUrl.origin;
    const context = await this.#contextFor(taskId);
    // contentType → playwright permission names (documented subset)
    const PERMISSION_MAP: Record<string, string[]> = {
      notifications: ["notifications"],
      camera: ["camera"],
      microphone: ["microphone"],
      location: ["geolocation"],
      geolocation: ["geolocation"],
      clipboard: ["clipboard-read", "clipboard-write"],
      midi: ["midi", "midi-sysex"],
      payment_handler: ["payment-handler"],
      storage_access: ["storage-access"],
      font_access: ["local-fonts"],
    };
    if (action === "get") {
      throw protocolError(
        "proto.unsupported",
        "playwright-isolated cannot read effective content settings — use page.evaluate navigator.permissions.query instead",
      );
    }
    if (action === "clear") {
      // playwright clearPermissions is context-wide (no per-origin or
      // per-type granularity in this API version) — say so honestly.
      await context.clearPermissions();
      return { contentType, origin, cleared: true, scope: "context" };
    }
    // set
    const setting = typeof args.setting === "string" ? args.setting : "";
    if (!setting || setting.length > 64) {
      throw protocolError("proto.invalid", "browser.siteSettings set requires args.setting (≤64 chars)");
    }
    const mapped = PERMISSION_MAP[contentType];
    if (!mapped) {
      throw protocolError(
        "proto.unsupported",
        `playwright-isolated has no grantPermissions mapping for content type '${contentType}'`,
      );
    }
    if (setting !== "allow") {
      throw protocolError(
        "proto.unsupported",
        `playwright-isolated can only grant permissions (setting 'allow'); '${setting}' has no deny/ask equivalent`,
      );
    }
    await context.grantPermissions(mapped, { origin });
    return { contentType, origin, setting: "allow", granted: mapped };
  }

  // ---- caches (Cache API) ----

  /** Same contract as the extension backend's chromexCacheOp — fixed
   *  in-page function, agent supplies names/URLs/put-specs never code.
   *  Read ops never create caches. */
  async #caches(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const action = typeof args.action === "string" ? args.action : "listCaches";
    const VALID = ["listCaches", "listKeys", "match", "put", "delete", "clear"];
    if (!VALID.includes(action)) {
      throw protocolError("proto.invalid", `browser.page.caches args.action must be ${VALID.join("|")}`);
    }
    const cache = typeof args.cache === "string" && args.cache ? args.cache : "";
    const cUrl = typeof args.url === "string" && args.url ? args.url : "";
    if (action !== "listCaches" && !cache) {
      throw protocolError("proto.invalid", `browser.page.caches ${action} requires args.cache`);
    }
    if (["match", "put", "delete"].includes(action) && !cUrl) {
      throw protocolError("proto.invalid", `browser.page.caches ${action} requires args.url`);
    }
    const putSpec =
      action === "put"
        ? {
            ...(typeof args.status === "number" ? { status: args.status } : {}),
            ...(args.headers && typeof args.headers === "object" && !Array.isArray(args.headers)
              ? { headers: args.headers as Record<string, string> }
              : {}),
            ...(typeof args.bodyBase64 === "string" ? { bodyBase64: args.bodyBase64 } : {}),
            ...(typeof args.bodyText === "string" ? { bodyText: args.bodyText } : {}),
          }
        : null;
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(Math.max(Math.floor(args.limit), 1), 1000)
        : 100;
    const out = (await page.evaluate(
      async ([act, cn, u, spec, ignSearch, lim]: [
        string, string, string,
        { status?: number; headers?: Record<string, string>; bodyBase64?: string; bodyText?: string } | null,
        boolean, number,
      ]) => {
        const BODY_BYTE_CAP = 128 * 1024;
        const b64encode = (buf: ArrayBuffer): string => {
          const bytes = new Uint8Array(buf);
          let s = "";
          for (let i = 0; i < bytes.length; i += 0x8000) {
            s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)) as number[]);
          }
          return btoa(s);
        };
        try {
          if (act === "listCaches") {
            return { ok: true, result: { caches: await caches.keys() } };
          }
          // Read/delete ops must not create a missing cache — caches.open()
          // would. Check existence before opening.
          const noCreate = act === "listKeys" || act === "match" || act === "delete";
          const existed = noCreate ? await caches.has(cn) : true;
          if (!existed) {
            return {
              ok: true,
              result:
                act === "match"
                  ? { cache: cn, url: u, found: false, exists: false }
                  : act === "delete"
                    ? { cache: cn, url: u, deleted: false, exists: false }
                    : { cache: cn, entries: [], count: 0, truncated: false, exists: false },
            };
          }
          const cache = await caches.open(cn);
          if (act === "listKeys") {
            const keys = await cache.keys();
            const entries = keys.slice(0, lim).map((r) => ({ url: r.url, method: r.method }));
            return {
              ok: true,
              result: { cache: cn, entries, count: entries.length, truncated: keys.length > lim },
            };
          }
          if (act === "match") {
            let res: Response | undefined;
            if (ignSearch) {
              const target = new URL(u);
              const keys = await cache.keys();
              const hit = keys.find((r) => {
                const k = new URL(r.url);
                return k.origin === target.origin && k.pathname === target.pathname;
              });
              res = hit ? await cache.match(hit) : undefined;
            } else {
              res = await cache.match(new Request(u));
            }
            if (!res) return { ok: true, result: { cache: cn, url: u, found: false } };
            const buf = await res.arrayBuffer();
            const truncated = buf.byteLength > BODY_BYTE_CAP;
            const slice = truncated ? buf.slice(0, BODY_BYTE_CAP) : buf;
            const headers: Record<string, string> = {};
            res.headers.forEach((v, k) => {
              headers[k] = v;
            });
            return {
              ok: true,
              result: {
                cache: cn, url: u, found: true, status: res.status,
                statusText: res.statusText, headers,
                bodyBase64: b64encode(slice), bodyBytes: buf.byteLength, truncated,
              },
            };
          }
          if (act === "put") {
            let bytes: Uint8Array;
            if (spec?.bodyBase64) {
              const bin = atob(spec.bodyBase64);
              bytes = new Uint8Array(bin.length);
              for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            } else if (spec?.bodyText !== undefined) {
              bytes = new TextEncoder().encode(spec.bodyText);
            } else {
              bytes = new Uint8Array(0);
            }
            const status = typeof spec?.status === "number" ? spec.status : 200;
            const res = new Response(bytes.buffer as ArrayBuffer, {
              status,
              headers: spec?.headers ?? { "content-type": "application/octet-stream" },
            });
            await cache.put(new Request(u), res);
            return { ok: true, result: { cache: cn, url: u, put: true, status } };
          }
          if (act === "delete") {
            const removed = await cache.delete(new Request(u));
            return { ok: true, result: { cache: cn, url: u, deleted: removed } };
          }
          if (act === "clear") {
            const removed = await caches.delete(cn);
            return { ok: true, result: { cache: cn, cleared: removed } };
          }
          return { ok: false, error: `unknown action: ${act}` };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      [action, cache, cUrl, putSpec, args.ignoreSearch === true, limit] as [
        string, string, string,
        { status?: number; headers?: Record<string, string>; bodyBase64?: string; bodyText?: string } | null,
        boolean, number,
      ],
    )) as { ok?: boolean; result?: Record<string, unknown>; error?: string } | undefined;
    if (!out || out.ok !== true) {
      throw protocolError("browser.action_failed", `cache op failed: ${out?.error ?? "no result"}`);
    }
    return out.result ?? {};
  }

  // ---- serviceWorker ----

  /** Same contract as the extension backend's chromexSwOp — fixed
   *  in-page function; list reads registration metadata, unregister
   *  removes by exact scope. */
  async #serviceWorker(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const action = typeof args.action === "string" ? args.action : "list";
    if (!["list", "unregister", "update"].includes(action)) {
      throw protocolError("proto.invalid", "browser.page.serviceWorker args.action must be list|unregister|update");
    }
    const scope = typeof args.scope === "string" && args.scope ? args.scope : "";
    if (action === "unregister" && !scope) {
      throw protocolError("proto.invalid", "browser.page.serviceWorker unregister requires args.scope");
    }
    const out = (await page.evaluate(
      async ([act, sc]: [string, string]) => {
        try {
          if (!("serviceWorker" in navigator)) {
            return { ok: false, error: "serviceWorker API unavailable (insecure context?)" };
          }
          const sw = navigator.serviceWorker;
          if (act === "list") {
            const regs = await sw.getRegistrations();
            const describe = (r: ServiceWorkerRegistration) => ({
              scope: r.scope,
              scriptURL:
                r.active?.scriptURL ?? r.waiting?.scriptURL ?? r.installing?.scriptURL ?? null,
              state: r.active ? "active" : r.waiting ? "waiting" : r.installing ? "installing" : "none",
              activeState: r.active?.state ?? null,
            });
            return {
              ok: true,
              result: {
                registrations: regs.map(describe),
                count: regs.length,
                controlled: sw.controller !== null,
                controllerScriptURL: sw.controller?.scriptURL ?? null,
              },
            };
          }
          if (act === "unregister") {
            const regs = await sw.getRegistrations();
            const target = regs.find((r) => r.scope === sc);
            if (!target) {
              return { ok: true, result: { scope: sc, unregistered: false, found: false } };
            }
            const ok = await target.unregister();
            return { ok: true, result: { scope: sc, unregistered: ok, found: true } };
          }
          if (act === "update") {
            // update() resolves when the update CHECK completes — not
            // when a new worker installs. Report the check honestly.
            const regs = await sw.getRegistrations();
            const targets = sc ? regs.filter((r) => r.scope === sc) : regs;
            if (sc && targets.length === 0) {
              return { ok: true, result: { scope: sc, found: false, updated: [] } };
            }
            const updated: Array<Record<string, unknown>> = [];
            for (const r of targets) {
              try {
                await r.update();
                updated.push({ scope: r.scope, ok: true });
              } catch (e) {
                updated.push({
                  scope: r.scope, ok: false,
                  error: e instanceof Error ? e.message : String(e),
                });
              }
            }
            return {
              ok: true,
              result: {
                updated,
                count: updated.length,
                ...(sc ? { scope: sc, found: true } : {}),
              },
            };
          }
          return { ok: false, error: `unknown action: ${act}` };
        } catch (e) {
          return { ok: false, error: e instanceof Error ? e.message : String(e) };
        }
      },
      [action, scope] as [string, string],
    )) as { ok?: boolean; result?: Record<string, unknown>; error?: string } | undefined;
    if (!out || out.ok !== true) {
      throw protocolError("browser.action_failed", `serviceWorker op failed: ${out?.error ?? "no result"}`);
    }
    return out.result ?? {};
  }

  // ---- cdp ----

  /** Raw CDP passthrough — same contract as the extension backend's
   *  chrome.debugger path: {method, ok, result|error}. Reuses the
   *  per-page CDPSession cache (#emulationSession is just a cached
   *  session — the name predates this use). */
  async #cdp(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    if (args.targetId !== undefined && args.targetId !== null) {
      throw protocolError(
        "proto.unsupported",
        "args.targetId is chrome-extension only — playwright-isolated has no worker debugger targets",
      );
    }
    const page = await this.#pageFor(taskId, args);
    const method = typeof args.method === "string" ? args.method : "";
    if (
      method.length > 128 ||
      !/^[A-Za-z][A-Za-z0-9]{0,63}\.[A-Za-z][A-Za-z0-9]{0,63}$/.test(method)
    ) {
      throw protocolError(
        "proto.invalid",
        "browser.page.cdp requires args.method as 'Domain.method' (≤128 chars)",
      );
    }
    let params: Record<string, unknown> | undefined;
    if (args.params !== undefined && args.params !== null) {
      if (typeof args.params !== "object" || Array.isArray(args.params)) {
        throw protocolError("proto.invalid", "browser.page.cdp args.params must be a JSON object");
      }
      try {
        if ((JSON.stringify(args.params) ?? "").length > 64 * 1024) {
          throw new Error("params too large");
        }
        params = args.params as Record<string, unknown>;
      } catch {
        throw protocolError("proto.invalid", "browser.page.cdp args.params must be JSON-serializable ≤64KiB");
      }
    }
    const session = await this.#emulationSession(page);
    try {
      // playwright types send() against known CommandParameters keys —
      // browser.page.cdp accepts any protocol method by design.
      // Bounded wait: a command aimed at a target that dies mid-flight
      // (Page.crash, tab kill) never gets a response — without a race
      // the tool call hangs forever.
      const result = await Promise.race([
        (session.send as (m: string, p?: unknown) => Promise<unknown>)(method, params),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`cdp ${method} exceeded ${DEFAULT_NAV_TIMEOUT_MS}ms — target may have crashed`)),
            DEFAULT_NAV_TIMEOUT_MS,
          ),
        ),
      ]);
      const serialized = JSON.stringify(result ?? null);
      const bytes = serialized?.length ?? 0;
      if (bytes > 256 * 1024) {
        return { method, ok: true, result: null, omitted: true, resultBytes: bytes };
      }
      return { method, ok: true, result: result ?? null, resultBytes: bytes };
    } catch (e) {
      return {
        method, ok: false,
        error: { code: "cdp_error", message: String((e as Error)?.message ?? e).slice(0, 500) },
      };
    }
  }

  /** browser.page.coverage — JS coverage via the same cached CDPSession
   *  as #cdp. start holds Profiler state on the session (it persists —
   *  the session is per-page, not per-call); stop takes precise
   *  coverage and summarizes via the shared helper so both backends
   *  report identical shapes. */
  async #coverage(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const action = typeof args.action === "string" ? args.action : "";
    if (action !== "start" && action !== "stop" && action !== "status") {
      throw protocolError(
        "proto.invalid",
        "browser.page.coverage requires args.action start|stop|status",
      );
    }
    const context = await this.#contextFor(taskId);
    const tabId = context.pages().indexOf(page);
    if (action === "status") {
      return { running: this.#coveragePages.has(page), resolvedTabId: tabId };
    }
    const session = await this.#emulationSession(page);
    if (action === "start") {
      if (this.#coveragePages.has(page)) {
        throw protocolError(
          "proto.invalid",
          "coverage is already running for this tab — call action:'stop' first",
        );
      }
      await session.send("Profiler.enable");
      await session.send("Profiler.startPreciseCoverage", {
        callCount: true,
        detailed: false,
      });
      this.#coveragePages.add(page);
      return { started: true, resolvedTabId: tabId };
    }
    if (!this.#coveragePages.has(page)) {
      throw protocolError(
        "proto.invalid",
        "coverage is not running for this tab — call action:'start' first",
      );
    }
    this.#coveragePages.delete(page);
    const cov = (await session.send("Profiler.takePreciseCoverage")) as { result?: unknown };
    await session.send("Profiler.stopPreciseCoverage").catch(() => {});
    await session.send("Profiler.disable").catch(() => {});
    return { ...summarizeCoverage(cov?.result), stopped: true, resolvedTabId: tabId };
  }

  /** browser.page.metrics — Performance-domain counters via the same
   *  cached CDPSession as #cdp/#coverage. start enables collection,
   *  read snapshots the cumulative counters, stop ends + releases.
   *  Pure numeric telemetry — no page content. */
  async #metrics(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const action = typeof args.action === "string" ? args.action : "";
    if (action !== "start" && action !== "read" && action !== "stop" && action !== "status") {
      throw protocolError(
        "proto.invalid",
        "browser.page.metrics requires args.action start|read|stop|status",
      );
    }
    const context = await this.#contextFor(taskId);
    const tabId = context.pages().indexOf(page);
    if (action === "status") {
      return { running: this.#metricsPages.has(page), resolvedTabId: tabId };
    }
    const session = await this.#emulationSession(page);
    if (action === "start") {
      if (this.#metricsPages.has(page)) {
        throw protocolError(
          "proto.invalid",
          "metrics is already running for this tab — call action:'stop' first",
        );
      }
      await session.send("Performance.enable");
      this.#metricsPages.add(page);
      return { started: true, resolvedTabId: tabId };
    }
    if (!this.#metricsPages.has(page)) {
      throw protocolError(
        "proto.invalid",
        "metrics is not running for this tab — call action:'start' first",
      );
    }
    if (action === "read") {
      const snap = (await session.send("Performance.getMetrics")) as { metrics?: unknown };
      return { ...summarizeMetrics(snap), resolvedTabId: tabId };
    }
    this.#metricsPages.delete(page);
    const snap = (await session.send("Performance.getMetrics")) as { metrics?: unknown };
    await session.send("Performance.disable").catch(() => {});
    return { ...summarizeMetrics(snap), stopped: true, resolvedTabId: tabId };
  }

  /** browser.page.screencast — CDP Page.startScreencast, same protocol
   *  the extension debugger tier sends. Frames have no artifact channel
   *  on this backend, so stop returns them INLINE bounded by the same
   *  512KiB ceiling screenshots use (oldest frames kept, truncated flag
   *  honest). */
  async #screencast(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    if (typeof args.frameId === "number" && args.frameId !== 0) {
      throw protocolError("proto.invalid", "browser.page.screencast is tab-scoped; args.frameId is not supported");
    }
    const action = typeof args.action === "string" ? args.action : "";
    if (action !== "start" && action !== "stop" && action !== "status") {
      throw protocolError(
        "proto.invalid",
        "browser.page.screencast requires args.action start|stop|status",
      );
    }
    const context = await this.#contextFor(taskId);
    const tabId = context.pages().indexOf(page);
    const held = this.#screencastHolds.get(page);
    if (action === "status") {
      return { running: held !== undefined, frames: held?.frames.length ?? 0, resolvedTabId: tabId };
    }
    const session = await this.#emulationSession(page);
    if (action === "start") {
      if (held) {
        throw protocolError(
          "proto.invalid",
          "screencast is already running for this tab — call action:'stop' first",
        );
      }
      const numArg = (v: unknown, min: number, max: number): number | undefined =>
        typeof v === "number" && Number.isFinite(v)
          ? Math.min(Math.max(Math.floor(v), min), max)
          : undefined;
      const quality = numArg(args.quality, 1, 100) ?? 70;
      const maxWidth = numArg(args.maxWidth, 320, 1920) ?? 1280;
      const everyNthFrame = numArg(args.everyNthFrame, 1, 10) ?? 1;
      const maxFrames = numArg(args.maxFrames, 1, 120) ?? 60;
      const frames: Array<{ data: string; timestamp: number }> = [];
      const hold = { session, frames, listener: null as ((e: { method: string; params?: unknown }) => void) | null };
      try {
        await session.send("Page.enable");
        await session.send("Page.startScreencast", {
          format: "jpeg",
          quality,
          maxWidth,
          maxHeight: maxWidth,
          everyNthFrame,
        });
      } catch (e) {
        if (/-32601|wasn't found/.test(String((e as Error)?.message ?? e))) {
          throw protocolError(
            "proto.unsupported",
            "Page.startScreencast is not exposed on this Chromium build",
          );
        }
        throw e;
      }
      const onEvent = (e: { method: string; params?: unknown }) => {
        if (e.method !== "Page.screencastFrame") return;
        const p = (e.params ?? {}) as Record<string, unknown>;
        const data = typeof p.data === "string" ? p.data : "";
        const sessionId = typeof p.sessionId === "number" ? p.sessionId : 0;
        const meta = p.metadata as { timestamp?: unknown } | undefined;
        const ts = typeof meta?.timestamp === "number" ? meta.timestamp : 0;
        if (data && frames.length < maxFrames) frames.push({ data, timestamp: ts });
        void session.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
      };
      session.on("event", onEvent);
      hold.listener = onEvent;
      this.#screencastHolds.set(page, hold);
      return { started: true, maxFrames, resolvedTabId: tabId };
    }
    if (!held) {
      throw protocolError(
        "proto.invalid",
        "screencast is not running for this tab — call action:'start' first",
      );
    }
    this.#screencastHolds.delete(page);
    try {
      await session.send("Page.stopScreencast").catch(() => {});
      if (held.listener) session.off("event", held.listener);
      // Inline frames bounded by the 512KiB decoded ceiling — keep the
      // OLDEST frames chronologically until the budget is spent and
      // mark the tail honestly truncated.
      const out: Array<{ dataBase64: string; timestamp: number }> = [];
      let total = 0;
      let dropped = 0;
      for (const f of held.frames) {
        const bytes = Math.ceil((f.data.length * 3) / 4);
        if (total + bytes > 512 * 1024 && out.length > 0) {
          dropped++;
          continue;
        }
        total += bytes;
        out.push({ dataBase64: f.data, timestamp: f.timestamp });
      }
      const first = held.frames[0]?.timestamp;
      const last = held.frames[held.frames.length - 1]?.timestamp;
      return {
        stopped: true,
        frames: held.frames.length,
        returned: out.length,
        truncated: dropped > 0,
        frameData: out,
        firstTimestamp: first ?? null,
        lastTimestamp: last ?? null,
        durationMs: typeof first === "number" && typeof last === "number"
          ? Math.max(0, Math.round((last - first) * 1000))
          : null,
        resolvedTabId: tabId,
      };
    } finally {
      // session stays cached in #cdpSessions — screencast stop already
      // ended capture; nothing else to release.
    }
  }

  // ---- bookmarks ----

  /** Per-task bookmark jar — same fixed-shape contract as the
   *  chrome.bookmarks backend. There is no browser profile in an
   *  isolated context, so results carry scope:"task" honestly. */
  async #bookmarks(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    let jar = this.#bookmarkJars.get(taskId);
    if (!jar) {
      jar = { nodes: [], nextId: 1 };
      this.#bookmarkJars.set(taskId, jar);
    }
    const action = typeof args.action === "string" ? args.action : "list";
    const VALID = ["list", "search", "get", "create", "update", "remove"];
    if (!VALID.includes(action)) {
      throw protocolError("proto.invalid", `browser.bookmarks args.action must be ${VALID.join("|")}`);
    }
    const id = typeof args.id === "string" && args.id ? args.id : undefined;
    const parentId = typeof args.parentId === "string" && args.parentId ? args.parentId : "0";
    const query = typeof args.query === "string" && args.query ? args.query.toLowerCase() : undefined;
    const title = typeof args.title === "string" ? args.title : undefined;
    const url = typeof args.url === "string" && args.url ? args.url : undefined;
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(Math.max(Math.floor(args.limit), 1), 1000)
        : 100;
    if (["get", "update", "remove"].includes(action) && !id) {
      throw protocolError("proto.invalid", `browser.bookmarks ${action} requires args.id`);
    }
    if (action === "search" && !query) {
      throw protocolError("proto.invalid", "browser.bookmarks search requires args.query");
    }
    if ((action === "create" || action === "update") && title === undefined && url === undefined) {
      throw protocolError("proto.invalid", `browser.bookmarks ${action} requires args.title and/or args.url`);
    }
    const norm = (n: (typeof jar.nodes)[number]) => ({
      id: n.id,
      parentId: n.parentId,
      title: n.title,
      ...(n.url ? { url: n.url } : {}),
      dateAdded: n.dateAdded,
    });
    const nodeById = (nid: string) => jar!.nodes.find((n) => n.id === nid);
    switch (action) {
      case "list": {
        if (parentId !== "0" && !nodeById(parentId)) {
          throw protocolError("proto.invalid", `browser.bookmarks list parentId '${parentId}' not found`);
        }
        const children = jar.nodes.filter((n) => n.parentId === parentId);
        return {
          nodes: children.slice(0, limit).map(norm),
          count: Math.min(children.length, limit),
          truncated: children.length > limit,
          scope: "task",
        };
      }
      case "search": {
        const hits = jar.nodes.filter(
          (n) => n.title.toLowerCase().includes(query!) || (n.url ?? "").toLowerCase().includes(query!),
        );
        return {
          nodes: hits.slice(0, limit).map(norm),
          count: Math.min(hits.length, limit),
          truncated: hits.length > limit,
          scope: "task",
        };
      }
      case "get": {
        const n = nodeById(id!);
        return { node: n ? norm(n) : null, scope: "task" };
      }
      case "create": {
        if (parentId !== "0" && !nodeById(parentId)) {
          throw protocolError("proto.invalid", `browser.bookmarks create parentId '${parentId}' not found`);
        }
        if (url !== undefined) {
          try {
            const u = new URL(url);
            if (u.protocol !== "http:" && u.protocol !== "https:") {
              throw new Error("bad protocol");
            }
          } catch {
            throw protocolError("proto.invalid", "browser.bookmarks create args.url must be http(s)");
          }
        }
        const node = {
          id: `bm${jar.nextId++}`,
          parentId,
          title: title ?? "",
          ...(url !== undefined ? { url } : {}),
          dateAdded: Date.now(),
        };
        jar.nodes.push(node);
        return { node: norm(node), scope: "task" };
      }
      case "update": {
        const n = nodeById(id!);
        if (!n) throw protocolError("proto.invalid", `browser.bookmarks update id '${id}' not found`);
        if (title !== undefined) n.title = title;
        if (url !== undefined) {
          try {
            const u = new URL(url);
            if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
          } catch {
            throw protocolError("proto.invalid", "browser.bookmarks update args.url must be http(s)");
          }
          n.url = url;
        }
        return { node: norm(n), scope: "task" };
      }
      case "remove": {
        if (!nodeById(id!)) {
          throw protocolError("proto.invalid", `browser.bookmarks remove id '${id}' not found`);
        }
        // Folder removal deletes descendants — chrome.bookmarks parity.
        const doomed = new Set<string>([id!]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const n of jar.nodes) {
            if (!doomed.has(n.id) && doomed.has(n.parentId)) {
              doomed.add(n.id);
              grew = true;
            }
          }
        }
        const before = jar.nodes.length;
        jar.nodes = jar.nodes.filter((n) => !doomed.has(n.id));
        return { removed: id, removedCount: before - jar.nodes.length, scope: "task" };
      }
    }
  }

  // ---- cookies ----

  /** Same contract as the extension backend's CDP implementation:
   *  list returns metadata only unless includeValues, set/delete/clear
   *  mutate the task context's cookie jar (playwright cookies()
   *  includes HttpOnly — parity with Network.getCookies). */
  async #cookies(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const context = await this.#contextFor(taskId);
    const action = typeof args.action === "string" ? args.action : "list";
    if (!["list", "set", "delete", "clear"].includes(action)) {
      throw protocolError("proto.invalid", "browser.page.cookies args.action must be list|set|delete|clear");
    }
    const domain = typeof args.domain === "string" && args.domain ? args.domain : undefined;
    const cookiePath = typeof args.path === "string" && args.path ? args.path : undefined;
    const name = typeof args.name === "string" && args.name ? args.name : undefined;
    const explicitUrl = typeof args.url === "string" && args.url ? args.url : undefined;
    const scopeUrl = explicitUrl ?? (/^https?:/.test(page.url()) ? page.url() : undefined);

    if (action === "list") {
      if (!scopeUrl) {
        throw protocolError("proto.invalid", "browser.page.cookies requires args.url (page URL is not http(s))");
      }
      const cookies = await context.cookies([scopeUrl]);
      const includeValues = args.includeValues === true;
      return {
        url: scopeUrl,
        cookies: cookies.map((c) => ({
          name: c.name,
          domain: c.domain,
          path: c.path,
          ...(typeof c.expires === "number" && c.expires > 0 ? { expires: c.expires } : { session: true }),
          ...(c.httpOnly ? { httpOnly: true } : {}),
          ...(c.secure ? { secure: true } : {}),
          ...(c.sameSite ? { sameSite: c.sameSite } : {}),
          ...(includeValues ? { value: c.value } : {}),
        })),
        ...(includeValues ? {} : { valuesWithheld: true }),
      };
    }

    if (action === "set") {
      const value = typeof args.value === "string" ? args.value : undefined;
      if (!name || value === undefined) {
        throw protocolError("proto.invalid", "browser.page.cookies set requires args.name and args.value");
      }
      const sameSite = typeof args.sameSite === "string" ? args.sameSite : undefined;
      if (sameSite && !["Strict", "Lax", "None"].includes(sameSite)) {
        throw protocolError("proto.invalid", "browser.page.cookies args.sameSite must be Strict|Lax|None");
      }
      const expires = typeof args.expires === "number" && Number.isFinite(args.expires) && args.expires > 0
        ? args.expires
        : undefined;
      const cookie: Record<string, unknown> = {
        name,
        value,
        ...(scopeUrl && !domain ? { url: scopeUrl } : {}),
        ...(domain ? { domain, path: cookiePath ?? "/" } : cookiePath ? { path: cookiePath } : {}),
        ...(args.secure === true ? { secure: true } : {}),
        ...(args.httpOnly === true ? { httpOnly: true } : {}),
        ...(sameSite ? { sameSite } : {}),
        ...(expires !== undefined ? { expires } : {}),
      };
      if (!cookie.url && !(cookie.domain && cookie.path)) {
        throw protocolError("proto.invalid", "browser.page.cookies set requires args.url or args.domain+args.path");
      }
      await context.addCookies([cookie as never]);
      return { set: true, name };
    }

    if (action === "delete") {
      if (!name) {
        throw protocolError("proto.invalid", "browser.page.cookies delete requires args.name");
      }
      if (!explicitUrl && !domain) {
        throw protocolError("proto.invalid", "browser.page.cookies delete requires args.url or args.domain");
      }
      // playwright clearCookies filters by name/domain/path — resolve the
      // url scope to the matching stored cookies first.
      const stored = explicitUrl ? await context.cookies([explicitUrl]) : await context.cookies();
      const matched = stored.filter(
        (c) =>
          c.name === name &&
          (!domain || String(c.domain ?? "").replace(/^\./, "").endsWith(domain.replace(/^\./, ""))) &&
          (!cookiePath || c.path === cookiePath),
      );
      for (const c of matched) {
        await context.clearCookies({ name: c.name, domain: c.domain, path: c.path });
      }
      return { deleted: name, removed: matched.length };
    }

    // clear — explicit scope required, same as the extension backend.
    if (!explicitUrl && !domain) {
      throw protocolError("proto.invalid", "browser.page.cookies clear requires args.url or args.domain");
    }
    const stored = explicitUrl ? await context.cookies([explicitUrl]) : await context.cookies();
    const matched = stored.filter(
      (c) => !domain || String(c.domain ?? "").replace(/^\./, "").endsWith(domain.replace(/^\./, "")),
    );
    for (const c of matched) {
      await context.clearCookies({ name: c.name, domain: c.domain, path: c.path });
    }
    return { cleared: matched.length };
  }

  // ---- web storage ----

  /** Same contract as the extension backend's chromexStorageOp: fixed
   *  in-page function, agent supplies keys/values never code. Values
   *  are bounded per-entry and the whole result drops to keys-only
   *  past the size cap (truncated flag stays honest). */
  async #storage(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const action = typeof args.action === "string" ? args.action : "list";
    if (!["list", "get", "set", "remove", "clear"].includes(action)) {
      throw protocolError("proto.invalid", "browser.page.localStorage args.action must be list|get|set|remove|clear");
    }
    const area = args.area === "session" ? "session" : "local";
    const key = typeof args.key === "string" ? args.key : "";
    if ((action === "get" || action === "set" || action === "remove") && !key) {
      throw protocolError("proto.invalid", `browser.page.localStorage ${action} requires args.key`);
    }
    if (action === "set" && typeof args.value !== "string") {
      throw protocolError("proto.invalid", "browser.page.localStorage set requires args.value");
    }
    const includeValues = args.includeValues === true;
    const value = typeof args.value === "string" ? args.value : "";
    const out = (await page.evaluate(
      ([a, act, k, v, iv]: [string, string, string, string, boolean]) => {
        const VALUE_CHAR_CAP = 32 * 1024;
        const RESULT_CHAR_CAP = 200 * 1024;
        const s = a === "session" ? window.sessionStorage : window.localStorage;
        if (act === "set") {
          s.setItem(k, v);
          return { area: a, set: true, key: k };
        }
        if (act === "remove") {
          s.removeItem(k);
          return { area: a, removed: k };
        }
        if (act === "clear") {
          s.clear();
          return { area: a, cleared: true };
        }
        if (act === "get") {
          const val = s.getItem(k);
          return {
            area: a, key: k, found: val !== null,
            value: val === null ? null : val.slice(0, VALUE_CHAR_CAP),
            ...(val !== null && val.length > VALUE_CHAR_CAP ? { truncated: true } : {}),
          };
        }
        const keys: string[] = [];
        const entries: Record<string, string> = {};
        for (let i = 0; i < s.length; i += 1) {
          const kk = s.key(i);
          if (kk === null) continue;
          keys.push(kk);
          if (iv) {
            const val = s.getItem(kk);
            if (val !== null) entries[kk] = val.slice(0, VALUE_CHAR_CAP);
          }
        }
        const result: Record<string, unknown> = iv
          ? { area: a, entries, truncatedValues: Object.values(entries).some((x) => x.length >= VALUE_CHAR_CAP) }
          : { area: a, keys };
        if (JSON.stringify(result).length > RESULT_CHAR_CAP) {
          return { area: a, keys, truncated: true };
        }
        return result;
      },
      [area, action, key, value, includeValues] as [string, string, string, string, boolean],
    )) as Record<string, unknown> | undefined;
    return { ...(out ?? {}), area };
  }

  // ---- indexedDB ----

  /** Same contract as the extension backend's chromexIdbOp — fixed
   *  in-page function, agent supplies names/keys/values never code.
   *  Read ops never create a missing database. */
  async #idb(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const page = await this.#pageFor(taskId, args);
    const action = typeof args.action === "string" ? args.action : "listDbs";
    const VALID = ["listDbs", "listStores", "keys", "get", "put", "delete", "clear", "createStore"];
    if (!VALID.includes(action)) {
      throw protocolError("proto.invalid", `browser.page.indexedDB args.action must be ${VALID.join("|")}`);
    }
    const database = typeof args.database === "string" ? args.database : "";
    const store = typeof args.store === "string" ? args.store : "";
    if (action !== "listDbs" && !database) {
      throw protocolError("proto.invalid", `browser.page.indexedDB ${action} requires args.database`);
    }
    if (!["listDbs", "listStores"].includes(action) && !store) {
      throw protocolError("proto.invalid", `browser.page.indexedDB ${action} requires args.store`);
    }
    if ((action === "get" || action === "delete") && args.key === undefined) {
      throw protocolError("proto.invalid", `browser.page.indexedDB ${action} requires args.key`);
    }
    if (action === "put" && args.value === undefined) {
      throw protocolError("proto.invalid", "browser.page.indexedDB put requires args.value");
    }
    const limit =
      typeof args.limit === "number" && Number.isFinite(args.limit)
        ? Math.min(Math.max(Math.floor(args.limit), 1), 1000)
        : 100;
    const out = (await page.evaluate(
      async ([db, st, act, k, v, kp, lim]: [string, string, string, unknown, unknown, string, number]) => {
        const VALUE_CHAR_CAP = 32 * 1024;
        const RESULT_CHAR_CAP = 200 * 1024;
        const bounded = (val: unknown): unknown => {
          if (val === undefined) return { __missing: true };
          try {
            const s = JSON.stringify(val);
            if (s === undefined) return null;
            if (s.length > RESULT_CHAR_CAP) return { __truncated: true, preview: s.slice(0, VALUE_CHAR_CAP) };
            return JSON.parse(s);
          } catch {
            return { __unserializable: true };
          }
        };
        const reqP = <T,>(req: IDBRequest<T>): Promise<T> =>
          new Promise<T>((res, rej) => {
            req.onsuccess = () => res(req.result);
            req.onerror = () => rej(req.error ?? new Error("indexedDB request failed"));
          });
        try {
          if (act === "listDbs") {
            const dbs = await indexedDB.databases();
            return { databases: dbs.map((d) => ({ name: d.name ?? null, version: d.version })) };
          }
          const dbExists = async () =>
            (await indexedDB.databases()).some((d) => d.name === db);
          const openDb = () =>
            new Promise<IDBDatabase>((res, rej) => {
              const req = indexedDB.open(db);
              req.onsuccess = () => res(req.result);
              req.onerror = () => rej(req.error ?? new Error("indexedDB.open failed"));
              req.onblocked = () => rej(new Error("indexedDB.open blocked"));
            });
          if (act === "listStores") {
            if (!(await dbExists())) return { database: db, exists: false, stores: [] };
            const idb = await openDb();
            try {
              return { database: db, version: idb.version, stores: Array.from(idb.objectStoreNames) };
            } finally {
              idb.close();
            }
          }
          if (act === "createStore") {
            const cur = (await indexedDB.databases()).find((d) => d.name === db);
            const idb = await new Promise<IDBDatabase>((res, rej) => {
              const req = indexedDB.open(db, (cur?.version ?? 0) + 1);
              req.onupgradeneeded = () => {
                const d = req.result;
                if (!d.objectStoreNames.contains(st)) {
                  d.createObjectStore(st, kp ? { keyPath: kp } : undefined);
                }
              };
              req.onsuccess = () => res(req.result);
              req.onerror = () => rej(req.error ?? new Error("indexedDB.open failed"));
              req.onblocked = () => rej(new Error("indexedDB.open blocked"));
            });
            idb.close();
            return { database: db, store: st, created: true };
          }
          if (!(await dbExists())) return { database: db, store: st, exists: false };
          const idb = await openDb();
          try {
            if (!Array.from(idb.objectStoreNames).includes(st)) {
              return { database: db, store: st, exists: false };
            }
            const readOnly = act === "get" || act === "keys";
            const tx = idb.transaction(st, readOnly ? "readonly" : "readwrite");
            const os = tx.objectStore(st);
            const txDone = () =>
              new Promise<void>((res, rej) => {
                tx.oncomplete = () => res();
                tx.onerror = () => rej(tx.error ?? new Error("transaction failed"));
                tx.onabort = () => rej(tx.error ?? new Error("transaction aborted"));
              });
            if (act === "keys") {
              const keys = (await reqP(os.getAllKeys())) as IDBValidKey[];
              return {
                database: db, store: st,
                keys: keys.slice(0, lim).map((kk) =>
                  typeof kk === "object" ? JSON.stringify(kk) : (kk as string | number)),
                truncated: keys.length > lim,
              };
            }
            if (act === "get") {
              const val = await reqP(os.get(k as IDBValidKey));
              return { database: db, store: st, key: k, found: val !== undefined, value: bounded(val) };
            }
            if (act === "put") {
              if (k === undefined || k === null) await reqP(os.put(v));
              else await reqP(os.put(v, k as IDBValidKey));
              await txDone();
              return { database: db, store: st, put: true, key: k };
            }
            if (act === "delete") {
              await reqP(os.delete(k as IDBValidKey));
              await txDone();
              return { database: db, store: st, deleted: k };
            }
            if (act === "clear") {
              await reqP(os.clear());
              await txDone();
              return { database: db, store: st, cleared: true };
            }
            throw new Error(`unknown action: ${act}`);
          } finally {
            idb.close();
          }
        } catch (e) {
          return { __error: e instanceof Error ? e.message : String(e) };
        }
      },
      [database, store, action, args.key ?? null, args.value ?? null, typeof args.keyPath === "string" ? args.keyPath : "", limit] as [
        string, string, string, unknown, unknown, string, number,
      ],
    )) as Record<string, unknown> | undefined;
    if (out?.__error) {
      throw protocolError("browser.action_failed", `indexedDB op failed: ${String(out.__error)}`);
    }
    const { __error: _drop, ...rest } = out ?? {};
    return rest;
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

  /** browser.downloads.cancel — playwright's Download.cancel() aborts
   *  the transfer; the log entry flips to interrupted/canceled. A
   *  finished download reports its real terminal state instead of
   *  faking a cancel (same contract as the extension host). */
  async #downloadsCancel(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const id = args.downloadId;
    if (typeof id !== "number" || !Number.isInteger(id)) {
      throw protocolError("proto.invalid", "browser.downloads.cancel requires args.downloadId");
    }
    const log = await this.#ensureDownloadLog(taskId);
    const entry = log.find((e) => e.id === id);
    if (!entry) {
      throw protocolError("proto.invalid", `browser.downloads.cancel unknown downloadId ${id}`);
    }
    if (entry.state !== "in_progress") {
      return { downloadId: id, cancelled: false, state: entry.state };
    }
    await entry.download.cancel().catch(() => {});
    const failure = await entry.download.failure().catch(() => null);
    entry.state = "interrupted";
    entry.error = failure ?? "canceled";
    return { downloadId: id, cancelled: true, state: entry.state, ...(entry.error ? { error: entry.error } : {}) };
  }

  /** browser.page.find — bounded DOM text search. No content-side ref
   *  map exists on this backend, so matches carry selectors + text only
   *  (the "bounded text matches with selectors" fallback). */
  async #find(taskId: string, args: Record<string, unknown>): Promise<unknown> {
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
    const findFn = ({ text, regex, caseSensitive, limit, scopeSelector }: {
      text: string | null; regex: string | null; caseSensitive: boolean;
      limit: number; scopeSelector: string | null;
    }) => {
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
        // querySelectorAll never crosses shadow boundaries — walk open
        // shadow roots recursively so web-component UIs are findable
        // (same coverage as the extension find path).
        const candidates: Element[] = [];
        const collectDeep = (scope: ParentNode): void => {
          for (const el of Array.from(scope.querySelectorAll("*"))) {
            candidates.push(el);
            const sr = (el as HTMLElement).shadowRoot;
            if (sr) collectDeep(sr);
          }
        };
        collectDeep(root);
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
    };
    const findParams = {
      text, regex, caseSensitive: args.caseSensitive === true, limit, scopeSelector,
    };
    type FindRes = { matches?: unknown[]; scanned?: number; truncated?: boolean } | undefined;
    const runFind = (t: { evaluate: (fn: unknown, arg: unknown) => Promise<unknown> }) =>
      t.evaluate(findFn, findParams) as Promise<FindRes>;
    // Unscoped find covers every frame — Playwright auto-attaches OOPIFs
    // so page.frames() reaches cross-origin subframes too; matches are
    // tagged with their frame index (the isolated frameId space).
    if (args.frameId === undefined || args.frameId === null) {
      const page = await this.#pageFor(taskId, args);
      const frames = typeof page.frames === "function" ? page.frames() : [];
      if (frames.length > 1) {
        const merged: Array<Record<string, unknown>> = [];
        let scanned = 0;
        let truncated = false;
        for (let i = 0; i < frames.length && merged.length < limit; i++) {
          const res = await runFind(frames[i] as never).catch(() => undefined);
          if (!res) continue;
          scanned += res.scanned ?? 0;
          truncated = truncated || res.truncated === true;
          for (const m of Array.isArray(res.matches) ? res.matches : []) {
            if (m !== null && typeof m === "object") {
              merged.push({ ...(m as Record<string, unknown>), frameId: i });
            }
          }
        }
        return {
          ok: true,
          matches: merged.slice(0, limit),
          scanned,
          truncated,
          frames: frames.length,
        };
      }
    }
    const target = await this.#frameTarget(taskId, args);
    const matches = await runFind(target as never);
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
    const target = await this.#frameTarget(taskId, args);
    const selector = await this.#requireSelector(args);
    const raw = Array.isArray(args.files) ? args.files : [];
    if (raw.length === 0) {
      throw protocolError("proto.invalid", "browser.page.upload requires args.files[]");
    }
    const payloads: Array<{ name: string; mimeType: string; base64: string }> = [];
    const files = raw.map((entry) => {
      // Bytes-only contract — same as the extension host: local paths
      // would let the agent exfiltrate arbitrary files into a page.
      if (typeof entry === "string") {
        throw protocolError("proto.invalid", "browser.page.upload accepts {name, mimeType, base64} files only — local paths are refused");
      }
      const o = (entry ?? {}) as Record<string, unknown>;
      if (typeof o.base64 === "string" && o.base64.length > 0) {
        const name = typeof o.name === "string" && o.name ? o.name : "file";
        const mimeType = typeof o.mimeType === "string" ? o.mimeType : "";
        payloads.push({ name, mimeType, base64: o.base64 });
        return { name, mimeType, buffer: Buffer.from(o.base64, "base64") };
      }
      throw protocolError("proto.invalid", "upload file entries require {name, mimeType, base64}");
    });
    const loc = target.locator(selector).first();
    try {
      await loc.setInputFiles(files as never);
      return { uploaded: files.length };
    } catch {
      // Not a file input — fall through to the drop-zone path. Any
      // non-input failure also lands here; the drop dispatch is the
      // same contract either way and page acceptance stays honest.
    }
    const dropped = await loc.evaluate(
      (el: Element, payload: Array<{ name: string; mimeType: string; base64: string }>) => {
        const dt = new DataTransfer();
        for (const f of payload) {
          const bin = atob(f.base64);
          const bytes = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          dt.items.add(new File([bytes], f.name, { type: f.mimeType }));
        }
        const r = el.getBoundingClientRect();
        const init = {
          bubbles: true,
          cancelable: true,
          view: window,
          dataTransfer: dt,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        };
        el.dispatchEvent(new DragEvent("dragenter", init));
        el.dispatchEvent(new DragEvent("dragover", init));
        el.dispatchEvent(new DragEvent("drop", init));
        return true;
      },
      payloads,
    );
    return { uploaded: files.length, via: "drop", dispatched: dropped === true };
  }

  /** browser.page.setInputFiles — the path-based counterpart of
   *  browser.page.upload: real filesystem paths attached through
   *  playwright's setInputFiles (which is exactly what upload falls
   *  back from for non-input targets is NOT — this tool is input-only,
   *  matching the extension's DOM.setFileInputFiles contract). Paths
   *  must be absolute and exist; approval gating lives upstream. */
  async #setInputFiles(taskId: string, args: Record<string, unknown>): Promise<unknown> {
    const target = await this.#frameTarget(taskId, args);
    const raw = Array.isArray(args.files) ? args.files : [];
    if (raw.length === 0 || raw.length > 10) {
      throw protocolError("proto.invalid", "browser.page.setInputFiles requires args.files[] (1–10 absolute paths)");
    }
    const paths = raw.map((f) => {
      if (typeof f !== "string" || !isAbsolute(f)) {
        throw protocolError("proto.invalid", "browser.page.setInputFiles paths must be absolute");
      }
      if (!existsSync(f)) {
        throw protocolError("proto.invalid", `browser.page.setInputFiles path does not exist: ${f}`);
      }
      return f;
    });
    const selector = await this.#requireSelector(args);
    await target.locator(selector).first().setInputFiles(paths);
    return { ok: true, files: paths.length };
  }

  // ---- lifecycle ----

  /** Release a task's isolated context (task.purge / shutdown). */
  async releaseTask(taskId: string): Promise<void> {
    const ctx = this.#contexts.get(taskId);
    this.#contexts.delete(taskId);
    this.#activePages.delete(taskId);
    this.#visitLogs.delete(taskId);
    this.#sessionLogs.delete(taskId);
    this.#bookmarkJars.delete(taskId);
    for (const p of ctx?.pages() ?? []) this.#forgetPage(p);
    await ctx?.close().catch(() => {});
  }

  async close(): Promise<void> {
    this.#closed = true;
    for (const ctx of this.#contexts.values()) await ctx.close().catch(() => {});
    this.#contexts.clear();
    this.#activePages.clear();
    for (const map of [
      this.#consoleBuffers, this.#networkBuffers, this.#responseBuffers,
      this.#wsBuffers, this.#routeRules, this.#fulfilledBodies,
      this.#pendingDialogs,
    ]) map.clear();
    this.#visitLogs.clear();
    this.#sessionLogs.clear();
    this.#bookmarkJars.clear();
    await this.#browser?.close().catch(() => {});
    this.#browser = null;
  }
}

const PRESS_MODIFIERS = new Set(["control", "alt", "shift", "meta"]);

/** innerText does not cross shadow boundaries — collect each open
 *  shadow root's top-level children's innerText recursively so
 *  web-component UIs are visible to text extraction. Runs in-page via
 *  locator.evaluate; must stay self-contained (Playwright serializes
 *  the function source). */
function deepInnerText(el: Element): string {
  const parts: string[] = [];
  const own = (el as HTMLElement).innerText;
  if (own) parts.push(own);
  const expand = (sr: ShadowRoot): void => {
    for (const child of Array.from(sr.children)) {
      if (child instanceof HTMLElement && child.innerText) parts.push(child.innerText);
    }
  };
  const walk = (scope: ParentNode): void => {
    const self = scope instanceof Element ? (scope as HTMLElement).shadowRoot : null;
    if (self) {
      expand(self);
      walk(self);
    }
    for (const node of Array.from(scope.querySelectorAll("*"))) {
      const sr = (node as HTMLElement).shadowRoot;
      if (sr) {
        expand(sr);
        walk(sr);
      }
    }
  };
  walk(el);
  return parts.join("\n");
}

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

/** Tools whose handlers resolve args.frameId to a playwright Frame —
 *  element-scoped ops only. Page-level arg shapes inside these tools
 *  (coordinate mouse click/hover, selector-less press, drag) re-check
 *  frameId===0 and refuse proto.unsupported rather than silently act
 *  on the top document. */
const FRAME_CAPABLE_TOOLS: ReadonlySet<BrowserToolName> = new Set([
  "browser.page.evaluate",
  "browser.page.snapshot",
  "browser.page.extract",
  "browser.page.find",
  "browser.page.wait",
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
  "browser.page.setInputFiles",
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
