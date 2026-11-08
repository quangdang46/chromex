// Acceptance harness — real-Chrome (Playwright Chromium/Chrome-for-Testing)
// + isolated gateway + extension backend. Never touches the user's real
// Chrome profile or ~/.chromex/gateway: every run gets a fresh
// CHROMEX_GATEWAY_HOME under a mktemp dir and a throwaway user-data-dir.
//
// Env:
//   CHROMEX_ACCEPTANCE_HEADLESS=1  → headless chromium (extensions usually
//     fail to load headless; default is headful)
//   BROWSER_EXECUTABLE_PATH        → explicit chromium binary
//   PLAYWRIGHT_BROWSERS_PATH       → playwright browser cache root
//   CHROMEX_E2E_PROVIDER / CHROMEX_E2E_MODEL / CHROMEX_E2E_TIMEOUT_MS
//     → live-provider scenario knobs (same as gateway-e2e-*.mjs)
import { createHash, randomUUID } from "node:crypto";
import { access, cp, mkdtemp, readFile, readdir, rm, stat, writeFile, appendFile, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import process from "node:process";
import { ensureGateway } from "../../../packages/native-host/dist/gateway-client.js";
export { ensureGateway };

// Real-browser scenarios spawn Chromium + fixture servers + gateways.
// They are OFF by default so routine work (agents, watchers, editors)
// never opens browser windows on the user's machine. Arm a run by
// writing a token file once, then passing it via env:
//   echo "$(uuidgen)" > /tmp/chromex-acceptance-token
//   CHROMEX_ACCEPTANCE_TOKEN=$(cat /tmp/chromex-acceptance-token) \
//     node scripts/acceptance/run-all.mjs
// The gate lives in runScenario(), NOT at module top level — report.mjs
// imports ARTIFACTS_ROOT from this file and must stay importable so the
// tokenless isolated scenarios (agent-loop-*, content-script-*,
// gateway-mcp-isolated) can still run under run-all.
import { readFileSync } from "node:fs";
const __acceptTokenPath = "/tmp/chromex-acceptance-token";
let __acceptExpected = null;
try {
  __acceptExpected = readFileSync(__acceptTokenPath, "utf8").trim();
} catch {
  /* no token file → disabled */
}
export function realBrowserScenariosEnabled() {
  return Boolean(__acceptExpected) && process.env.CHROMEX_ACCEPTANCE_TOKEN === __acceptExpected;
}
function requireAcceptanceToken() {
  if (!realBrowserScenariosEnabled()) {
    console.error("[acceptance] real-browser scenarios are disabled.");
    process.exit(3);
  }
}

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const EXTENSION_DIST = join(REPO_ROOT, "packages/extension/dist");
export const ARTIFACTS_ROOT = join(REPO_ROOT, "artifacts/acceptance");
export const GATEWAY_BIN = join(REPO_ROOT, "packages/bridge/dist/gateway/bin.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export { sleep };

/**
 * Gateways are spawned detached and outlive their IPC clients by design —
 * conn.close() only drops our socket. The lifetime lock inside the fixture
 * dataDir records the owning pid, so teardown can find and stop the real
 * process (including a gateway the native host respawned mid-scenario).
 */
async function killGatewayForDataDir(dataDir) {
  try {
    const raw = await readFile(join(dataDir, "gateway.lock"), "utf8");
    const pid = JSON.parse(raw)?.pid;
    if (typeof pid !== "number") return;
    const { execFileSync } = await import("node:child_process");
    const cmd = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
    if (!cmd.includes("gateway/bin.js")) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch {}
    await sleep(500);
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGKILL");
    } catch {}
  } catch {}
}

// ---------------------------------------------------------------------------
// Playwright / chromium launch (pattern ported from scripts/smoke-extension.mjs)
// ---------------------------------------------------------------------------

export async function loadPlaywright() {
  for (const moduleName of ["playwright", "playwright-core"]) {
    try {
      return await import(moduleName);
    } catch {
      continue;
    }
  }
  const nodePath = process.env.NODE_PATH;
  if (nodePath) {
    const require = createRequire(import.meta.url);
    for (const moduleName of ["playwright", "playwright-core"]) {
      try {
        return require(join(nodePath, moduleName));
      } catch {
        continue;
      }
    }
  }
  throw new Error("Playwright is not installed (playwright/playwright-core).");
}

async function findPlaywrightChromiumExecutable() {
  const roots = [];
  const envRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (envRoot && envRoot !== "0") roots.push(resolve(envRoot));
  const home = homedir();
  if (platform() === "darwin") roots.push(join(home, "Library", "Caches", "ms-playwright"));
  else if (platform() === "linux") roots.push(join(home, ".cache", "ms-playwright"));
  else if (platform() === "win32") {
    roots.push(join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "ms-playwright"));
  }
  const suffixes =
    platform() === "darwin"
      ? [
          join("chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
          join("chrome-mac", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
          join("chrome-mac-arm64", "Chromium.app", "Contents", "MacOS", "Chromium"),
          join("chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
        ]
      : platform() === "linux"
        ? [join("chrome-linux", "chrome"), join("chrome-linux64", "chrome")]
        : platform() === "win32"
          ? [join("chrome-win", "chrome.exe"), join("chrome-win64", "chrome.exe")]
          : [];
  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const dirs = [];
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.startsWith("chromium-")) continue;
      // Revision number decides recency — dir mtime lies (a failed or
      // partial install can touch an old revision's dir).
      const rev = Number(e.name.slice("chromium-".length)) || 0;
      try {
        const st = await stat(join(root, e.name));
        dirs.push({ path: join(root, e.name), mtimeMs: st.mtimeMs, rev });
      } catch {}
    }
    dirs.sort((a, b) => b.rev - a.rev || b.mtimeMs - a.mtimeMs);
    for (const d of dirs) {
      for (const suffix of suffixes) {
        const p = join(d.path, suffix);
        try {
          await access(p, fsConstants.X_OK);
          // A Chrome-for-Testing dir can keep its main executable while
          // the Framework dylib is missing (interrupted install) — the
          // binary then dlopen-crashes at launch. Verify the framework
          // before trusting the candidate.
          if (p.includes("Google Chrome for Testing.app") && platform() === "darwin") {
            // p = <app>/Contents/MacOS/<bin> → framework lives at
            // <app>/Contents/Frameworks/… (sibling of MacOS).
            const fw = join(
              dirname(p),
              "..",
              "Frameworks",
              "Google Chrome for Testing Framework.framework",
              "Versions",
              "Current",
              "Google Chrome for Testing Framework",
            );
            try {
              await access(fw);
            } catch {
              continue;
            }
          }
          found.push(p);
        } catch {}
      }
    }
  }
  if (found.length === 0) return null;
  // Chrome for Testing only reads NM manifests from the root-owned
  // /Library/Google/ChromeForTesting dir → connectNative always fails there.
  // Real Chromium reads ~/Library/Application Support/Chromium — prefer it.
  const realChromium = found.find((p) => p.includes("/Chromium.app/"));
  const override = process.env.CHROMEX_ACCEPTANCE_BROWSER;
  if (override === "cft") return found.find((p) => p.includes("Chrome for Testing")) ?? found[0];
  if (override === "chromium") return realChromium ?? found[0];
  return realChromium ?? found[0];
}

export async function resolveChromiumLaunchOptions() {
  if (process.env.PLAYWRIGHT_CHANNEL) return { channel: process.env.PLAYWRIGHT_CHANNEL };
  if (process.env.BROWSER_EXECUTABLE_PATH) return { executablePath: process.env.BROWSER_EXECUTABLE_PATH };
  const pw = await findPlaywrightChromiumExecutable();
  if (pw) return { executablePath: pw };
  throw new Error(
    "No Chromium/Chrome-for-Testing binary found. Set BROWSER_EXECUTABLE_PATH or run playwright install chromium.",
  );
}

/** Copy the built extension to a staging dir (avoids mutating dist). */
export async function stageExtension() {
  const root = await mkdtemp(join(tmpdir(), "chromex-accept-ext-"));
  const dest = join(root, "extension");
  await cp(EXTENSION_DIST, dest, { recursive: true });
  return { root, path: dest };
}

export function extensionIdFromManifestKey(key) {
  const digest = createHash("sha256").update(Buffer.from(key, "base64")).digest();
  return Array.from(digest.subarray(0, 16), (b) => b.toString(16).padStart(2, "0"))
    .join("")
    .replace(/[0-9a-f]/gu, (n) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(n, 16)));
}

async function waitForExtensionServiceWorker(context, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [sw] = context.serviceWorkers();
    if (sw) return sw;
    await sleep(250);
  }
  return null;
}

/**
 * Launch a persistent Chromium context with the extension loaded.
 * headless:false by default — MV3 extensions do not run in old headless.
 * Sets CHROMEX_GATEWAY_HOME on process.env BEFORE launch so the spawned
 * native-messaging host (a child of the browser) inherits the isolated
 * gateway home.
 */
export async function launchChromiumWithExtension({ gatewayHome, headless, prepareProfile } = {}) {
  const staged = await stageExtension();
  const userDataDir = await mkdtemp(join(tmpdir(), "chromex-accept-profile-"));
  // Playwright/Chromium resolves native-messaging manifests inside the
  // profile: <user-data-dir>/NativeMessagingHosts/<host>.json (verified on
  // Chromium 129 — user-level ~/Library dirs are NOT consulted).
  if (prepareProfile) await prepareProfile(userDataDir);
  if (gatewayHome) process.env.CHROMEX_GATEWAY_HOME = gatewayHome;

  const { chromium } = await loadPlaywright();
  const launchOptions = await resolveChromiumLaunchOptions();
  const useHeadless = headless ?? process.env.CHROMEX_ACCEPTANCE_HEADLESS === "1";

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: useHeadless,
    acceptDownloads: true,
    args: [
      `--disable-extensions-except=${staged.path}`,
      `--load-extension=${staged.path}`,
      // keep the acceptance browser quiet — no first-run bubbles stealing focus
      "--no-first-run",
      "--no-default-browser-check",
    ],
    ...launchOptions,
  });

  const sw = await waitForExtensionServiceWorker(context);
  let extensionId;
  if (sw) {
    extensionId = new URL(sw.url()).host;
  } else {
    const manifest = JSON.parse(await readFile(join(staged.path, "manifest.json"), "utf8"));
    extensionId = manifest.key ? extensionIdFromManifestKey(manifest.key) : null;
  }
  if (!extensionId) {
    await context.close().catch(() => {});
    throw new Error("extension service worker never appeared and manifest has no key");
  }

  return {
    context,
    extensionId,
    userDataDir,
    staged,
    headless: useHeadless,
    async cleanup() {
      await context.close().catch(() => {});
      await rm(staged.root, { recursive: true, force: true }).catch(() => {});
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Acceptance native-messaging host
// ---------------------------------------------------------------------------
// Chrome does NOT propagate the browser process env to native-messaging
// hosts (verified: CHROMEX_GATEWAY_HOME set on the browser is absent in the
// spawned host). Without help the installed run-bridge falls back to
// ~/.chromex/gateway — the user's REAL gateway. So for the duration of a
// run we temporarily point the browser's NM manifest at our own launcher
// that exports the isolated CHROMEX_GATEWAY_HOME, and restore afterwards.

const NM_HOST_NAME = "com.codex.sidepanel.bridge";
const WEBSTORE_EXTENSION_ID = "odlalmnpmmakfigepbaabimjcmcppgfo";

function nmManifestDirs() {
  const sup = join(homedir(), "Library", "Application Support");
  return [
    join(sup, "Google", "ChromeForTesting", "NativeMessagingHosts"),
    join(sup, "Google", "Chrome for Testing", "NativeMessagingHosts"),
    join(sup, "Chromium", "NativeMessagingHosts"),
    // NOTE: real "Google/Chrome" is deliberately excluded — the acceptance
    // browser is always Playwright Chromium/Chrome-for-Testing.
  ];
}

/**
 * Install an acceptance NM host for `gatewayHome`. Returns restore().
 * Backs up any existing manifest and writes ours; fails closed (the
 * launcher exits) if somehow invoked without the pointer env.
 */
export async function installAcceptanceNativeHost(gatewayHome) {
  const nmRoot = await mkdtemp(join(tmpdir(), "chromex-accept-nm-"));
  const hostDir = join(nmRoot, "host");
  await cp(join(REPO_ROOT, "packages/native-host/dist"), hostDir, { recursive: true });
  await writeFile(join(nmRoot, "package.json"), JSON.stringify({ type: "module" }, null, 2));
  // dist has no bundled deps (fs-ext, @codex-sidepanel/shared) — ESM ignores
  // NODE_PATH, so symlink the repo's node_modules for resolution.
  const { symlink } = await import("node:fs/promises");
  await symlink(join(REPO_ROOT, "node_modules"), join(nmRoot, "node_modules"), "dir").catch(() => {});

  const nodeDir = dirname(process.execPath);
  const launcherPath = join(nmRoot, "run-accept");
  const bridgeEntry = join(REPO_ROOT, "packages/bridge/dist/cli.js");
  const launcher = [
    "#!/bin/sh",
    `export BRIDGE_ENTRY="${bridgeEntry}"`,
    "export CHROMEX_GATEWAY_MODE=1",
    `export GATEWAY_ENTRY="${GATEWAY_BIN}"`,
    // isolated gateway home — baked per run; never the user's ~/.chromex
    `export CHROMEX_GATEWAY_HOME="${gatewayHome}"`,
    `export PATH="${nodeDir}:$PATH"`,
    `exec "${process.execPath}" "${join(hostDir, "bin.js")}" "$@"`,
    "",
  ].join("\n");
  await writeFile(launcherPath, launcher, { mode: 0o755 });
  const { chmod } = await import("node:fs/promises");
  await chmod(launcherPath, 0o755);

  // extension id is fixed by the manifest key
  const manifestJson = JSON.parse(await readFile(join(EXTENSION_DIST, "manifest.json"), "utf8"));
  const extId = manifestJson.key ? extensionIdFromManifestKey(manifestJson.key) : WEBSTORE_EXTENSION_ID;

  const backups = [];
  const targets = [];
  for (const dir of nmManifestDirs()) {
    try {
      await stat(dir);
    } catch {
      continue; // browser not installed → no manifest dir
    }
    const mp = join(dir, `${NM_HOST_NAME}.json`);
    let backup = null;
    try {
      backup = await readFile(mp, "utf8");
    } catch {}
    backups.push({ mp, backup, dir });
    targets.push(dir);
  }
  // System/user-level dirs are best-effort (Playwright Chromium uses the
  // profile-local dir instead); absence is not fatal.
  if (targets.length === 0) {
    console.log("  [nm] no ~/Library NativeMessagingHosts dirs — relying on profile-local manifest");
  }

  const manifest = {
    name: NM_HOST_NAME,
    description: "Chromex native host (acceptance)",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [
      `chrome-extension://${extId}/`,
      `chrome-extension://${WEBSTORE_EXTENSION_ID}/`,
    ],
  };
  for (const { mp } of backups) {
    await writeFile(mp, JSON.stringify(manifest, null, 2));
  }

  // Profile-local manifest: Playwright Chromium reads
  // <user-data-dir>/NativeMessagingHosts, not the ~/Library dirs above.
  // installIntoProfile() is invoked by launchChromiumWithExtension via
  // prepareProfile before the browser starts; restore() removes it again.
  const profileTargets = [];
  const installIntoProfile = async (userDataDir) => {
    const dir = join(userDataDir, "NativeMessagingHosts");
    const mp = join(dir, `${NM_HOST_NAME}.json`);
    await mkdir(dir, { recursive: true });
    await writeFile(mp, JSON.stringify(manifest, null, 2));
    profileTargets.push(mp);
    return mp;
  };

  return {
    dirs: targets,
    installIntoProfile,
    async restore() {
      for (const mp of profileTargets) {
        await rm(mp, { force: true }).catch(() => {});
      }
      for (const { mp, backup } of backups) {
        try {
          if (backup === null) await rm(mp, { force: true });
          else await writeFile(mp, backup);
        } catch (e) {
          console.error(`!!! failed to restore NM manifest ${mp}: ${e?.message ?? e}`);
        }
      }
      await rm(nmRoot, { recursive: true, force: true }).catch(() => {});
    },
  };
}

// ---------------------------------------------------------------------------
// Isolated gateway
// ---------------------------------------------------------------------------

/**
 * Create a fresh CHROMEX_GATEWAY_HOME (mktemp), write a gateway.json that
 * enables the providers the scenario needs, spawn/connect the gateway.
 * NEVER points at ~/.chromex/gateway.
 */
export async function ensureIsolatedGateway({ providers = ["codex", "claude"], configPatch = {}, acpProviders = {} } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "chromex-accept-gw-"));
  const providerCfg = {};
  for (const p of providers) {
    providerCfg[p] = { enabled: true, command: null, env: {}, models: null, additionalModels: null, defaultModel: null };
  }
  const config = {
    version: 1,
    // durable store: tasks/events survive a gateway restart (s5 exercises
    // this); the default "memory" store loses everything on SIGKILL.
    store: "sqlite",
    providers: { ...providerCfg, acp: acpProviders },
    browser: {
      defaultBackend: "chrome-extension",
      allowedBackends: ["chrome-extension"],
      playwright: { enabledByUser: false },
    },
    ...configPatch,
  };
  await writeFile(join(dataDir, "gateway.json"), JSON.stringify(config, null, 2));

  // env override: our spawned gateway + the NM host both resolve the bin
  // via GATEWAY_ENTRY or sibling layout; set it explicitly for safety.
  const prevGatewayEntry = process.env.GATEWAY_ENTRY;
  process.env.GATEWAY_ENTRY = GATEWAY_BIN;
  try {
    const conn = await ensureGateway(dataDir, {
      hello: {
        protocolVersion: 1,
        clientId: `accept-${randomUUID().slice(0, 8)}`,
        clientVersion: "0.0.0-acceptance",
        profileId: "default",
        hostInstanceId: "", // "" = plain client, NOT a browser host (else gateway routes tool calls to us)
        browserInstanceId: null,
      },
      startupTimeoutMs: 30_000,
      gatewayBin: GATEWAY_BIN,
      log: (m) => console.log("[gw]", m),
    });
    return {
      dataDir,
      conn,
      async cleanup() {
        try {
          await conn.close?.();
        } catch {}
        await killGatewayForDataDir(dataDir);
        if (prevGatewayEntry === undefined) delete process.env.GATEWAY_ENTRY;
        else process.env.GATEWAY_ENTRY = prevGatewayEntry;
        await rm(dataDir, { recursive: true, force: true }).catch(() => {});
      },
    };
  } catch (err) {
    if (prevGatewayEntry === undefined) delete process.env.GATEWAY_ENTRY;
    else process.env.GATEWAY_ENTRY = prevGatewayEntry;
    await rm(dataDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Evidence writer
// ---------------------------------------------------------------------------

export class EvidenceWriter {
  constructor(scenario, runId = new Date().toISOString().replace(/[:.]/g, "-") + "-" + randomUUID().slice(0, 6)) {
    this.scenario = scenario;
    this.runId = runId;
    this.dir = join(ARTIFACTS_ROOT, scenario, runId);
    this.eventsPath = join(this.dir, "events.jsonl");
    this.screenshotsDir = join(this.dir, "screenshots");
    this.notes = [];
    this._mkdir = mkdir(this.dir, { recursive: true });
  }
  async init() {
    await this._mkdir;
    await mkdir(this.screenshotsDir, { recursive: true });
  }
  async event(entry) {
    await this._mkdir;
    await appendFile(this.eventsPath, JSON.stringify(entry) + "\n");
  }
  async writeTaskSync(taskId, sync) {
    await this._mkdir;
    await writeFile(join(this.dir, `task.sync.${taskId}.json`), JSON.stringify(sync, null, 2));
  }
  async screenshot(page, name) {
    await this._mkdir;
    const safe = name.replace(/[^a-z0-9_.-]/gi, "_");
    const p = join(this.screenshotsDir, `${safe}.png`);
    await page.screenshot({ path: p, fullPage: false }).catch((e) => this.note(`screenshot ${name} failed: ${e?.message}`));
    return p;
  }
  note(msg) {
    this.notes.push(`[${new Date().toISOString()}] ${msg}`);
    console.log("  [note]", msg);
  }
  async writeResult(result) {
    await this._mkdir;
    await writeFile(
      join(this.dir, "result.json"),
      JSON.stringify({ scenario: this.scenario, runId: this.runId, ...result, notes: this.notes }, null, 2),
    );
    return join(this.dir, "result.json");
  }
}

// ---------------------------------------------------------------------------
// TaskRunner — connection + per-task event capture + permission auto-answer
// ---------------------------------------------------------------------------

export class TaskRunner {
  /**
   * @param conn       GatewayConnection from ensureIsolatedGateway
   * @param evidence   EvidenceWriter (may be null)
   * @param opts.autoAnswer  "allow" | "deny" | "first" | "none" — how to
   *   answer permission.requested (default "allow" picks first non-deny).
   */
  constructor(conn, evidence = null, opts = {}) {
    this.conn = conn;
    this.evidence = evidence;
    this.autoAnswer = opts.autoAnswer ?? "allow";
    this.events = []; // all captured envelopes {taskId,type,payload,seq}
    this.responded = new Set();
    this._handlers = [];
    conn.onEvent((env) => this._onEnvelope(env));
  }

  _onEnvelope(env) {
    if (env.kind !== "event") return;
    const p = env.payload ?? {};
    const type = p.type ?? env.type;
    const taskId = env.taskId ?? p.taskId ?? null;
    const entry = { seq: env.seq ?? null, taskId, type, payload: p, at: Date.now() };
    this.events.push(entry);
    if (this.evidence) void this.evidence.event(entry).catch(() => {});
    for (const h of this._handlers) {
      try {
        h(entry);
      } catch {}
    }
    if (type === "permission.requested" && p.request?.requestId && this.autoAnswer !== "none") {
      void this.answerPermission(p.request.requestId, p.request).catch(() => {});
    }
  }

  onEvent(fn) {
    this._handlers.push(fn);
    return () => {
      const i = this._handlers.indexOf(fn);
      if (i >= 0) this._handlers.splice(i, 1);
    };
  }

  eventsFor(taskId, type) {
    return this.events.filter((e) => e.taskId === taskId && (!type || e.type === type));
  }

  /** Pick an option per autoAnswer policy; returns respond payload or null. */
  _pickOption(request) {
    const options = request?.options ?? [];
    const denyRe = /deny|dismiss|reject|cancel/i;
    if (this.autoAnswer === "deny") {
      const deny = options.find((o) => o.kind === "deny" || denyRe.test(String(o.id))) ?? options[options.length - 1];
      return { optionId: deny?.id, allowTask: false };
    }
    // "allow"/"first": prefer explicit allow_once/approve, never allow_task
    const allow =
      options.find((o) => /allow_once|allow-once|approve|yes|accept/i.test(String(o.id))) ??
      options.find((o) => o.kind !== "deny" && !denyRe.test(String(o.id))) ??
      options.find((o) => o.kind !== "deny") ??
      options[0];
    return { optionId: allow?.id, allowTask: false };
  }

  async answerPermission(requestId, request) {
    if (this.responded.has(requestId)) return false;
    this.responded.add(requestId);
    const pick = this._pickOption(request);
    const payload = { requestId };
    if (pick.optionId) payload.optionId = pick.optionId;
    const questions = request?.details?.argsPreview?.questions;
    if (Array.isArray(questions) && questions.length) {
      payload.answers = {};
      for (const q of questions) {
        const qOpts = Array.isArray(q.options) ? q.options : [];
        const qPick =
          qOpts.find((o) => !/deny|reject|dismiss/i.test(String(o.id ?? "") + " " + String(o.label ?? ""))) ??
          qOpts[0];
        payload.answers[String(q.id ?? "")] = [String(qPick?.label ?? qPick?.id ?? "yes")];
      }
    }
    if (!payload.optionId && !payload.answers) {
      console.log("!!! permission.requested", requestId, "has no answerable option — left pending");
      this.responded.delete(requestId);
      return false;
    }
    try {
      await this.conn.request("permission.respond", payload);
      console.log(">>> permission.respond", requestId, "→", payload.optionId ?? "answers");
      return true;
    } catch (err) {
      console.log("!!! permission.respond failed:", err?.message ?? err);
      this.responded.delete(requestId);
      return false;
    }
  }

  /** Find a permission.requested for a task — live events, then task.sync replay. */
  async findPermissionRequest(taskId, deadlineMs, { respond = true } = {}) {
    const deadline = Date.now() + deadlineMs;
    while (Date.now() < deadline) {
      const live = this.eventsFor(taskId, "permission.requested").find((e) => e.payload?.request?.requestId);
      if (live) {
        if (respond) await this.answerPermission(live.payload.request.requestId, live.payload.request);
        return live.payload.request;
      }
      try {
        const sync = await this.taskSync(taskId);
        for (const e of sync.events ?? []) {
          const t = e.type ?? e.payload?.type;
          const pay = e.payload ?? e;
          if (t === "permission.requested" && pay.request?.requestId) {
            if (respond) await this.answerPermission(pay.request.requestId, pay.request);
            return pay.request;
          }
        }
      } catch {
        /* replay may lag */
      }
      await sleep(400);
    }
    return null;
  }

  async createTask({ providerId = "codex", model = "xxx", title, cwd = "/tmp", backend, tabIntent, browserInstanceId } = {}) {
    const created = await this.conn.request("task.create", {
      cwd,
      providerId,
      model,
      title,
      ...(backend ? { backend } : {}),
      ...(tabIntent ? { tabIntent } : {}),
      ...(browserInstanceId ? { browserInstanceId } : {}),
    });
    return created.taskId ?? created.task?.taskId ?? created.id;
  }

  async sendTurn(taskId, text, clientMessageId) {
    const res = await this.conn.request("task.send", {
      taskId,
      clientMessageId: clientMessageId ?? `accept-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      content: [{ type: "text", text }],
    });
    return res.turnId ?? res.turn?.turnId ?? res;
  }

  async taskSync(taskId, { fromSeq = 0, maxEvents = 10_000 } = {}) {
    const sync = await this.conn.request("task.sync", { taskId, fromSeq, maxEvents });
    if (this.evidence) {
      await this.evidence.writeTaskSync(taskId, sync).catch(() => {});
    }
    return sync;
  }

  async spawnBrowserScope(taskId) {
    const spawn = await this.conn.request("browser.mcp.spawn", { taskId });
    const scope = JSON.parse(await readFile(spawn.scopeFile, "utf8"));
    return { scopeFile: spawn.scopeFile, token: scope.token, spawn };
  }

  /** Raw browser.tool.call — returns the ToolCallOutcome or throws. */
  browserToolCall(taskId, tool, args, token, timeoutMs = 90_000, extra = {}) {
    return this.conn.request(
      "browser.tool.call",
      { taskId, tool, args: args ?? {}, token, ...extra },
      timeoutMs,
    );
  }

  async waitTerminal(taskId, turnId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    const TERM = ["turn.completed", "turn.failed", "turn.cancelled", "turn.unknown"];
    while (Date.now() < deadline) {
      const hit = this.events.find(
        (e) => e.taskId === taskId && (!turnId || e.payload?.turnId === turnId || e.turnId === turnId) && TERM.includes(e.type),
      );
      if (hit) return hit;
      await sleep(300);
    }
    return null;
  }

  /** Normalized durable event list for a task (task.sync replay). */
  async syncEvents(taskId) {
    const sync = await this.taskSync(taskId);
    const evs = sync.events ?? sync.replay?.events ?? [];
    return evs.map((e) => {
      const p = e.payload ?? e;
      return { seq: e.seq, type: e.type ?? p.type, payload: p };
    });
  }
}

// ---------------------------------------------------------------------------
// Scenario plumbing
// ---------------------------------------------------------------------------

export const TERMINAL_TURN = ["turn.completed", "turn.failed", "turn.cancelled", "turn.unknown"];

/**
 * Standard scenario wrapper: evidence dir, optional browser + gateway,
 * run fn({runner, browser, evidence, gateway}), always write result.json.
 * fn returns {status:"PASS"|"FAIL"|"BLOCKED"|"SKIP", summary, details?, notes?}.
 */
export async function runScenario(
  scenario,
  fn,
  { needsBrowser = true, needsGateway = true, gatewayProviders = ["codex", "claude"], gatewayAcpProviders = {}, autoAnswer = "allow", headless } = {},
) {
  // headless:true launches Chrome for Testing with no windows — the token
  // gate exists to stop routine work opening browser UI, which headless
  // never does. Callers must opt in explicitly per scenario.
  if (headless !== true) requireAcceptanceToken();
  const evidence = new EvidenceWriter(scenario);
  await evidence.init();
  const t0 = Date.now();
  let browser = null;
  let gw = null;
  let nmHost = null;
  const cleanups = [];
  try {
    if (needsGateway) gw = await ensureIsolatedGateway({ providers: gatewayProviders, acpProviders: gatewayAcpProviders });
    // One isolated home shared by gateway + browser NM host. When there is
    // no gateway (pure-UI scenario) the home is unused but still isolated.
    const gatewayHome = gw?.dataDir ?? (await mkdtemp(join(tmpdir(), "chromex-accept-gw-empty-")));
    if (!gw) cleanups.push(async () => {
      await killGatewayForDataDir(gatewayHome);
      await rm(gatewayHome, { recursive: true, force: true }).catch(() => {});
    });
    if (needsBrowser) {
      // Chrome strips env for NM hosts → install a per-run manifest that
      // bakes the isolated CHROMEX_GATEWAY_HOME into the launcher.
      nmHost = await installAcceptanceNativeHost(gatewayHome);
      browser = await launchChromiumWithExtension({
        gatewayHome,
        headless,
        prepareProfile: (dir) => nmHost.installIntoProfile(dir),
      });
      // give the extension a moment to connect its NM host to the gateway
      await sleep(2500);
    }
    const runner = gw ? new TaskRunner(gw.conn, evidence, { autoAnswer }) : null;
    if (runner && browser) {
      // wait until the extension's NM host shows up as a second authed conn
      const deadline = Date.now() + 20_000;
      let authed = 0;
      while (Date.now() < deadline) {
        try {
          const d = await gw.conn.request("diagnostics.snapshot", {});
          authed = d?.diagnostics?.endpoint?.authedConnections ?? d?.endpoint?.authedConnections ?? 0;
        } catch {}
        if (authed >= 2) break;
        await sleep(500);
      }
      evidence.note(`authed gateway connections=${authed} (1=client, 2+=browser host)`);
      if (authed < 2) evidence.note("WARNING: extension native host never registered with the isolated gateway");
    }
    const result = await fn({ runner, browser, evidence, gateway: gw });
    const out = {
      status: result.status,
      summary: result.summary ?? "",
      durationMs: Date.now() - t0,
      ...(result.details ? { details: result.details } : {}),
    };
    const p = await evidence.writeResult(out);
    console.log(`\n=== ${scenario}: ${result.status} — ${result.summary ?? ""}`);
    console.log("evidence:", p);
    return { ...out, evidenceDir: evidence.dir, resultPath: p };
  } catch (err) {
    const out = {
      status: "FAIL",
      summary: `harness error: ${err?.message ?? err}`,
      durationMs: Date.now() - t0,
      error: String(err?.stack ?? err),
    };
    await evidence.writeResult(out).catch(() => {});
    console.log(`\n=== ${scenario}: FAIL — ${out.summary}`);
    return { ...out, evidenceDir: evidence.dir };
  } finally {
    if (browser) await browser.cleanup().catch(() => {});
    if (nmHost) await nmHost.restore().catch((e) => console.error("NM restore:", e?.message ?? e));
    if (gw) await gw.cleanup().catch(() => {});
    for (const c of cleanups) await c();
  }
}
