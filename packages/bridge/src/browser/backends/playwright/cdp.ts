/**
 * PlaywrightCdpBackend — attach to an already-running Chromium over
 * CDP (docs/adr/playwright-cdp.md, spike scripts/spike/cdp-attach.mjs).
 *
 * Reuses the entire PlaywrightIsolatedBackend executor: the ONLY
 * difference is browser acquisition — chromium.connectOverCDP(endpoint)
 * instead of chromium.launch(). Per-task isolation is unchanged:
 * connectOverCDP supports browser.newContext() (verified — each
 * context is a fresh storage partition), so #contextFor still yields
 * one isolated context per task. The attached browser's own default
 * context (the user's real tabs) is never touched — #pageFor only ever
 * resolves pages inside the task's own context.
 *
 * Honest limits (ADR):
 *  - Requires the target Chrome to be launched with
 *    --remote-debugging-port; there is no way to attach to a running
 *    Chrome that lacks it.
 *  - Chrome 136+ ignores remote debugging on the DEFAULT user-data
 *    dir, so "existingUserSession" stays false — tasks run in fresh
 *    contexts, not the user's logged-in profile.
 *  - browser.close() on the attached handle disconnects and closes
 *    task-created contexts only — it does NOT kill the user's Chrome
 *    (verified in the spike: launch connection unaffected).
 */

import {
  DEFAULT_BACKEND_CAPABILITIES,
  protocolError,
  type BrowserBackendCapabilities,
  type BrowserBackendId,
  type BrowserToolName,
} from "@codex-sidepanel/shared";

import {
  PlaywrightIsolatedBackend,
  PLAYWRIGHT_ISOLATED_SUPPORTED_TOOLS,
  type IsolatedBackendOptions,
} from "./isolated.js";

/** Same honest tool surface as playwright-isolated — the executor is
 *  literally the same code; only acquisition differs. Kept as a
 *  separate export so supportedToolsForBackend and future narrowing
 *  (e.g. dropping chrome-only tools) can diverge without touching
 *  isolated. */
export const PLAYWRIGHT_CDP_SUPPORTED_TOOLS: ReadonlySet<BrowserToolName> =
  PLAYWRIGHT_ISOLATED_SUPPORTED_TOOLS;

/** Capabilities: declared in DEFAULT_BACKEND_CAPABILITIES — identical
 *  executor to playwright-isolated over a CDP-attached browser, plus
 *  attachToRunningChrome; existingUser* stay false because the
 *  attached browser's own default context is never surfaced. */
export const PLAYWRIGHT_CDP_CAPABILITIES: BrowserBackendCapabilities =
  DEFAULT_BACKEND_CAPABILITIES["playwright-cdp"];

export interface CdpBackendOptions extends Omit<IsolatedBackendOptions, "acquireBrowser" | "backendId" | "capabilities" | "supportedTools"> {
  /** CDP http(s) endpoint or ws(s) endpoint of the target browser —
   *  e.g. http://127.0.0.1:9222. Resolves per reconnect so an endpoint
   *  that appears later (browser restart) can be picked up. Return
   *  null/throw → browser.backend_unavailable, never a silent launch. */
  endpoint: () => Promise<string | null>;
}

export class PlaywrightCdpBackend extends PlaywrightIsolatedBackend {
  constructor(opts: CdpBackendOptions) {
    const { endpoint, ...rest } = opts;
    super({
      ...rest,
      backendId: "playwright-cdp" satisfies BrowserBackendId,
      capabilities: PLAYWRIGHT_CDP_CAPABILITIES,
      supportedTools: [...PLAYWRIGHT_CDP_SUPPORTED_TOOLS],
      acquireBrowser: async (pw) => {
        const url = await endpoint().catch(() => null);
        if (!url) {
          throw protocolError(
            "browser.backend_unavailable",
            "playwright-cdp has no CDP endpoint configured (launch Chrome with --remote-debugging-port)",
          );
        }
        return pw.chromium.connectOverCDP(url);
      },
    });
  }
}
