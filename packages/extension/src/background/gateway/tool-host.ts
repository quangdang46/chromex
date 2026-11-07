/**
 * Browser tool host — executes `browser.tool.request` envelopes that
 * the Gateway pushes to this extension (P1-09 §9.2 step 4).
 *
 * Maps the §9 tool surface onto existing primitives:
 *  - tabs.*        → chrome.tabs
 *  - page.snapshot/get → page.dom.snapshot / chrome.tabs.get
 *  - page.click/focus/fill/select/submit/type/scroll/navigate
 *                → page.dom.perform steps (same engine as planner path)
 *  - page.wait     → bounded sleep
 *  - extract/screenshot/upload → proto.unsupported (not yet implemented;
 *    never fake a result)
 *
 * Args convention: `tabId` optional → active tab of current window;
 * element targeting uses `ref` (from a prior page.snapshot) or
 * `selector`/`label`.
 */

import { SnapshotRegistry, urlOriginPath } from "@codex-sidepanel/shared";
import type { BrowserDomActionResult, BrowserDomSnapshot } from "@codex-sidepanel/shared";

export interface ToolHostDeps {
  /** chrome.tabs.sendMessage with content-script ensure (index.ts helper) */
  sendToTab(tabId: number, message: Record<string, unknown>): Promise<unknown>;
  getTab(tabId: number): Promise<chrome.tabs.Tab | undefined>;
  queryTabs(): Promise<chrome.tabs.Tab[]>;
  activateTab(tabId: number): Promise<void>;
  closeTab(tabId: number): Promise<void>;
  activeTabId(): Promise<number | null>;
}

function toolError(code: string, message: string): Error {
  const e = new Error(message) as Error & { code?: string };
  e.code = code;
  return e;
}

const SUPPORTED = new Set([
  "browser.tabs.list",
  "browser.tab.activate",
  "browser.tab.close",
  "browser.page.snapshot",
  "browser.page.get",
  "browser.page.click",
  "browser.page.focus",
  "browser.page.type",
  "browser.page.fill",
  "browser.page.select",
  "browser.page.submit",
  "browser.page.scroll",
  "browser.page.navigate",
  "browser.page.wait",
]);

async function resolveTabId(deps: ToolHostDeps, args: Record<string, unknown>): Promise<number> {
  if (typeof args.tabId === "number") return args.tabId;
  const active = await deps.activeTabId();
  if (active === null) throw toolError("browser.no_tab", "no active tab to run the tool against");
  return active;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** §6.2 snapshot metadata: TTL 5min, LRU 32/task — used by P2-02
 *  stale/verify semantics. Registry is per-extension-install. */
const snapshotRegistry = new SnapshotRegistry();

export function toolHostSnapshotRegistry(): SnapshotRegistry {
  return snapshotRegistry;
}

export function createToolHostHandler(deps: ToolHostDeps) {
  return async function handleToolRequest(payload: unknown): Promise<unknown> {
    const req = (payload ?? {}) as {
      toolCallId?: string;
      taskId?: string;
      turnId?: string;
      tool?: string;
      args?: Record<string, unknown>;
    };
    const tool = req.tool ?? "";
    const args = req.args ?? {};
    if (!SUPPORTED.has(tool)) {
      throw toolError("proto.unsupported", `browser tool ${tool} is not implemented in the extension host`);
    }

    switch (tool) {
      case "browser.tabs.list": {
        // §6.1.1 privacy-first: on-demand only, internal pages excluded,
        // query/hash stripped (may carry sensitive params). Full URLs
        // are available via browser.page.get / snapshot within scope.
        const INTERNAL = /^(chrome|chrome-extension|edge|about|devtools|view-source):/i;
        const tabs = (await deps.queryTabs()).filter((t) => {
          const u = t.url ?? "";
          return u !== "" && !INTERNAL.test(u);
        });
        return {
          tabs: tabs.map((t) => {
            let safeUrl = t.url ?? "";
            let origin = "";
            try {
              const u = new URL(safeUrl);
              origin = u.origin;
              safeUrl = `${u.origin}${u.pathname}`;
            } catch {
              safeUrl = "";
            }
            return {
              id: t.id,
              title: t.title ?? "",
              url: safeUrl,
              origin,
              active: t.active === true,
              windowId: t.windowId,
            };
          }),
        };
      }
      case "browser.tab.activate": {
        const tabId = typeof args.tabId === "number" ? args.tabId : await resolveTabId(deps, args);
        await deps.activateTab(tabId);
        return { activated: tabId };
      }
      case "browser.tab.close": {
        const tabId = typeof args.tabId === "number" ? args.tabId : await resolveTabId(deps, args);
        await deps.closeTab(tabId);
        return { closed: tabId };
      }
      case "browser.page.get": {
        const tabId = await resolveTabId(deps, args);
        const tab = await deps.getTab(tabId);
        if (!tab) throw toolError("browser.no_tab", `tab ${tabId} not found`);
        return { id: tab.id, url: tab.url ?? "", title: tab.title ?? "", active: tab.active === true };
      }
      case "browser.page.snapshot": {
        const tabId = await resolveTabId(deps, args);
        const snap = (await deps.sendToTab(tabId, { type: "page.dom.snapshot" })) as BrowserDomSnapshot;
        if (
          snap.snapshotId &&
          snap.structuralFingerprint &&
          snap.stateFingerprint &&
          typeof snap.saltEpoch === "number"
        ) {
          // §6.2: a structural change on this tab stales every older
          // snapshot's refs — drop them before registering the new one.
          const prior = snapshotRegistry.latestForTab(tabId);
          if (prior && prior.structuralFingerprint !== snap.structuralFingerprint) {
            snapshotRegistry.invalidateTab(tabId);
          }
          snapshotRegistry.put({
            snapshotId: snap.snapshotId,
            tabId,
            ...(req.taskId ? { taskId: req.taskId } : {}),
            structuralFingerprint: snap.structuralFingerprint,
            stateFingerprint: snap.stateFingerprint,
            saltEpoch: snap.saltEpoch,
            ...(typeof snap.metadata?.url === "string"
              ? { urlOriginPath: urlOriginPath(snap.metadata.url) }
              : {}),
            capturedAt: Date.now(),
          });
        }
        return snap;
      }
      case "browser.page.wait": {
        const ms = Math.min(Math.max(typeof args.ms === "number" ? args.ms : 1000, 0), 30_000);
        await new Promise((r) => setTimeout(r, ms));
        return { waitedMs: ms };
      }
      default: {
        // DOM action tools → single page.dom.perform step
        const tabId = await resolveTabId(deps, args);
        const snapId = str(args.snapshotId);
        if (snapId) {
          const meta = snapshotRegistry.get(snapId);
          if (!meta || meta.tabId !== tabId) {
            throw toolError(
              "browser.stale_snapshot",
              "snapshot expired or belongs to another tab; call browser.page.snapshot again",
            );
          }
          if (meta.urlOriginPath) {
            const tab = await deps.getTab(tabId);
            const current = typeof tab?.url === "string" && tab.url ? urlOriginPath(tab.url) : null;
            if (current && current !== meta.urlOriginPath) {
              throw toolError("browser.navigated", "page navigated since the snapshot; call browser.page.snapshot again");
            }
          }
        }
        const step = domStepFor(tool, args);
        const result = (await deps.sendToTab(tabId, {
          type: "page.dom.perform",
          steps: [step],
        })) as BrowserDomActionResult;
        const first = result.results?.[0];
        if (!result.ok || first?.ok === false) {
          const code = typeof first?.code === "string" && first.code.startsWith("browser.") ? first.code : "browser.action_failed";
          throw toolError(code, first?.message ?? result.summary ?? "browser action failed");
        }
        return {
          ok: true,
          summary: result.summary,
          step: first,
          ...(first?.verified !== undefined ? { verified: first.verified } : {}),
        };
      }
    }
  };
}

function domStepFor(tool: string, args: Record<string, unknown>): Record<string, unknown> {
  const base = {
    reason: `gateway tool ${tool}`,
    ...(str(args.ref) ? { targetRef: str(args.ref) } : {}),
    ...(str(args.selector) ? { selector: str(args.selector) } : {}),
    ...(str(args.label) ? { label: str(args.label) } : {}),
  };
  switch (tool) {
    case "browser.page.click":
      return { ...base, action: "click" };
    case "browser.page.focus":
      return { ...base, action: "focus" };
    case "browser.page.fill":
    case "browser.page.type":
      return { ...base, action: "fill", value: typeof args.text === "string" ? args.text : typeof args.value === "string" ? args.value : "" };
    case "browser.page.select":
      return { ...base, action: "select", value: typeof args.value === "string" ? args.value : "" };
    case "browser.page.submit":
      return { ...base, action: "submit" };
    case "browser.page.scroll":
      return {
        ...base,
        action: "scroll",
        direction: typeof args.direction === "string" ? args.direction : "down",
        ...(typeof args.amountPx === "number" ? { amountPx: args.amountPx } : {}),
      };
    case "browser.page.navigate": {
      const url = str(args.url);
      if (!url) throw toolError("proto.invalid", "browser.page.navigate requires args.url");
      return { action: "navigate", url, reason: "gateway tool browser.page.navigate" };
    }
    default:
      throw toolError("proto.unsupported", `no DOM mapping for ${tool}`);
  }
}
