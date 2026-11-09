import {
  DEFAULT_HARNESS_PERMISSIONS,
  assessBrowserDomActionPlan,
  browserActionNeedsConfirmation,
  type CodexActiveTurn,
  type CodexAppOption,
  type CodexMcpServerOption,
  type CodexModelOption,
  type CodexModelReroute,
  type CodexPluginOption,
  type CodexRateLimits,
  type CodexSkillOption,
  type CodexStructuredInput,
  type CodexThreadSummary,
  type CodexThreadTranscript,
  type CodexTurnDiff,
  type CodexTurnPlan,
  createFallbackAgenticRoutePlan,
  determineReadStrategy,
  inferActionCards,
  listProfileTemplates,
  normalizePageContext,
  normalizeAgenticRoutePlan,
  routePlanToPromptRoutingPlan,
  resolveHarnessPermission,
  withDegradedHarnessAsks,
  type ActionCard,
  type AgenticRouteContextSource,
  type AgenticRouteInput,
  type AgenticRoutePlan,
  type BrowserAutomationMode,
  type BrowserDomActionPlan,
  type BrowserDomActionResult,
  type BrowserDomSnapshot,
  type HarnessPermissionOperation,
  type OpenTabContext,
  type PageContextEnvelope,
  type ProfileTemplate,
  type PromptRoutingPlan,
  type ReadStrategy,
  type SkillArchiveInstallResult,
  type UserFileAttachment,
  type WorkspaceHarnessSnapshot,
  DEFAULT_BACKEND_CAPABILITIES,
} from "@codex-sidepanel/shared";

import { createYouTubeCurrentMomentPromptResult } from "../youtube-current-moment.js";
import {
  getCurrentPageSupport,
  getFileUrlAccessHelpMessage,
  isFileUrl,
} from "../permission-plans.js";
import { normalizeSelectedTextContext } from "../page-selection-context.js";
import {
  buildTabOriginPermission,
  isSitePermissionRequiredError,
  shouldAttemptTabOriginRecovery,
  SitePermissionRequiredError,
} from "../page-access.js";
import {
  BrowserPermissionRequiredError,
  isBrowserPermissionRequiredError,
} from "../browser-permission-errors.js";
import {
  classifyRuntimeMessageError,
  isRecoverableTabMessagingError,
  isRetryableRuntimeMessageError,
  toErrorMessage,
} from "../runtime-errors.js";
import {
  createConversation,
  clearConversations,
  deleteConversation,
  getCurrentConversation,
  getSelectedModel,
  getSelectedProfileId,
  getSelectedReasoningEffort,
  getSelectedServiceTier,
  getStoredSettings,
  listDeletedProfileIds,
  listConversations,
  listCustomProfiles,
  listSkills,
  normalizeConversationRetention,
  saveConversation,
  saveCustomProfile,
  deleteCustomProfile,
  saveSkill,
  resetStoredSettings,
  setCurrentConversationId,
  setSelectedModel,
  setSelectedProfileId,
  setSelectedReasoningEffort,
  setSelectedServiceTier,
  toConversationSummary,
  updateStoredSettings,
  deleteSkill,
} from "./storage.js";
import { resolveVisibleCurrentConversation } from "./conversation-history.js";
import { NativeBridgeClient } from "./native-bridge-client.js";
import {
  classifyMessageSender,
  contentScriptMaySend,
  validateRuntimeMessage,
} from "./message-guard.js";
import { getGatewayRuntime, resetGatewayRuntime, setAgentBadge, setGatewayServerRequestHandler } from "./gateway/runtime.js";
import { getNetworkInflightCount, installNetworkLog, listNetworkRequests, resetNetworkTab, setNetworkLogStore } from "./network-log.js";
import { createToolHostHandler, disposeBrowserToolTabState, toolHostSnapshotRegistry } from "./gateway/tool-host.js";
import { acquireCdp, releaseCdp, acquireCdpTarget, releaseCdpTarget, detachOrphanedDebuggerTargets } from "./cdp.js";
import { getFingerprintContext } from "./fingerprint-salt.js";
import { gatewayEventToLegacy } from "./gateway/legacy-events.js";
import { snapshotToMessages } from "./gateway/snapshot-messages.js";
import { assertApiKeyLoginExplicitlyConfirmed } from "./api-key-login-guard.js";
import { createUserProfileTemplate, updateUserProfileTemplate } from "../profile-templates.js";
import { inferActionCardsForOpenTab } from "./site-suggestions.js";
import {
  catalogCacheMatches,
  isCatalogCacheFresh,
  isRecoverableModelCatalogAuthError,
  mergeCustomCatalogModels,
  readCatalogCache,
  recoverModelCatalogAfterAuthError,
  normalizeCatalogWorkspaceRoot,
  resolveCatalogModelState,
  resolveSelectedCatalogModel,
  shouldRefreshCatalogAfterSettingsUpdate,
  shouldTriggerCatalogRefresh,
  writeCatalogCache,
} from "./catalog-refresh.js";
import {
  createDegradedReporter,
  createDegradedRuntimeConfigSnapshot,
  reportDegradedCatalogList,
} from "./degraded.js";
import {
  resolveUploadedImageReferenceInputs,
  resolveUploadedImageEditInput,
  type PromptImageWorkflowKind,
  shouldHandleAgenticImageEditWorkflow,
  shouldHandleAgenticImageGenerationWorkflow,
  shouldDeferPageContextCollectionForImageWorkflow,
  shouldSuppressDefaultCurrentPageContextForImageGeneration,
  shouldSuppressDefaultCurrentPageContextForImageWorkflow,
} from "./image-workflow-routing.js";
import {
  buildImageEditTimeoutMessage,
  buildImageGenerationWorkflowTimeoutMessage,
  IMAGE_EDIT_TIMEOUT_MS,
  IMAGE_GENERATION_WORKFLOW_TIMEOUT_MS,
} from "./image-edit-timeout.js";
import { isRecoverableTurnSteerError } from "./turn-steer-recovery.js";
import {
  createVisibleTabCaptureThrottle,
  DEFAULT_VISIBLE_TAB_CAPTURE_MIN_INTERVAL_MS,
  isCaptureVisibleTabQuotaError,
} from "./visible-tab-capture-throttle.js";
import { buildVoiceSessionStartParams, buildVoiceSessionStopParams } from "./voice-session-routing.js";
import { createVoiceSessionContextPrompt } from "./voice-context.js";
import { buildInfographicPrompt } from "../infographic-prompt.js";
import { buildSlideDeckImagePrompt } from "../slide-deck-image-prompt.js";
import {
  shouldLogBackgroundMessageError,
  toExpectedPermissionErrorResponse,
} from "./background-error-response.js";
import { createPopoutUrlPath, selectBrowserWindowIdForPopout } from "./popup-window-target.js";
import {
  createHistorySearchOptions,
  createHistoryContextSummary,
  extractSearchQueryFromHistoryUrl,
  limitHistoryContextItems,
  resolveHistoryContextQuery,
  type HistoryContextItem,
} from "./history-context.js";
import { resolveUiLocale } from "../ui-language.js";
import { getUiStrings } from "../sidepanel/i18n.js";
import { selectEditablePageImageCandidate, type EditablePageImageCandidate } from "../page-image-target.js";
import {
  createEffectivePromptRoutePlan,
  createRawCaptureForReadStrategy,
  ensureDefaultCurrentPageContextRequests,
  filterSuppressedPageContextRequests,
  shouldSuppressDefaultCurrentPageContextForHistory,
  shouldAttachVisualAssetsForReadStrategy,
} from "../page-context.js";
import type {
  ContentProbeResult,
  ExtensionSettings,
  PromptRequestPayload,
  RuntimeConfigSnapshot,
  SavedConversation,
  SelectedPageTextContext,
  UiInitPayload,
  UiSettingsSnapshotPayload,
} from "../types.js";
import type { SkillOption } from "../sidepanel/skills.js";
import type { PromptActivityPhase } from "../sidepanel/prompt-activity.js";
import { mergeStructuredInputsWithEnabledCodexSkills } from "../codex-skill-settings.js";
import { requiresPluginCompanionAppConnection } from "../plugin-connection-availability.js";
import {
  createAvailableRouteStructuredInputs,
  expandPluginStructuredInputsWithConnectedApps,
  mergeExplicitAndRouteStructuredInputs,
  resolveRouteStructuredInputs,
} from "./route-structured-inputs.js";
import { isRecoverableMissingCodexThreadError, shouldAutoCompactConversation } from "./auto-compact.js";
import { resolveBridgeEventConversationId } from "./bridge-event-routing.js";
import { ConversationRuntimeRegistry } from "./conversation-runtime.js";
import {
  buildDeferredBrowserActionMessage,
  extractDeferredBrowserActionText,
  shouldResumeDeferredBrowserDomAction,
} from "./deferred-browser-action.js";
import {
  createPaperPdfFallbackContext,
  createGenericSiteFallbackContext,
  fetchPaperPdfAttachment,
  isSameDocumentAttachment,
  resolvePaperPdfSourceUrl,
} from "./pdf-page-context.js";

const bridge = new NativeBridgeClient();

// chromex-ur7: sidecar/gateway method failures degrade to local fallback
// state; report each once so a dead sidecar is visible in SW logs without
// spamming on every catalog refresh or diagnostic write.
const degradedReport = createDegradedReporter();

// P1-09: answer gateway browser.tool.request envelopes. Registered
// unconditionally — the runtime only exists when gatewayMode is on.
// The runtime calls handler(method, payload); the tool host takes the
// payload only, so dispatch on the method here.
// Network log tails persist in session storage — an MV3 service-worker
// restart no longer silently empties page.network history or the
// responseUrl wait lookback. Dies with the browser session.
setNetworkLogStore({
  load: async () => {
    const got = await chrome.storage.session.get("chromex.netlog");
    const v = got?.["chromex.netlog"];
    return v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, import("./network-log.js").NetworkLogEntry[]>)
      : {};
  },
  save: async (snapshot) => {
    await chrome.storage.session.set({ "chromex.netlog": snapshot });
  },
});
installNetworkLog();

// Headless Chromium cannot tear down a window at all — chrome.windows.remove
// AND closing a window's last tab both crash the whole browser process
// (BUS_ADRALN, reproduced on CfT 158). Tool-host uses this to refuse those
// paths with proto.unsupported instead of killing the host.
const HEADLESS_CHROME = navigator.userAgent.includes("HeadlessChrome");

const toolHostHandler = createToolHostHandler({
    headlessChrome: HEADLESS_CHROME,
    sendToTab: async (tabId, message, options) => {
      const tab = await chrome.tabs.get(tabId);
      if (!tab.id || !tab.url) throw new Error(`tab ${tabId} has no url`);
      return sendMessageToTab(tab as chrome.tabs.Tab & { id: number; url: string }, message, options);
    },
    getTab: async (tabId) => chrome.tabs.get(tabId),
    listNetworkRequests: (tabId, query) => listNetworkRequests(tabId, query),
    networkInflightCount: (tabId) => getNetworkInflightCount(tabId),
    listFrames: async (tabId) => {
      const frames = await chrome.webNavigation.getAllFrames({ tabId });
      return (frames ?? []).map((f) => ({
        frameId: f.frameId,
        url: f.url ?? "",
        ...(typeof f.parentFrameId === "number" ? { parentFrameId: f.parentFrameId } : {}),
      }));
    },
    // Route rules persist in storage.session — survives an MV3
    // service-worker restart (session storage dies with the browser,
    // never leaks into the next session). Keyed per tab.
    routeRulesStore: {
      get: async (tabId) => {
        const key = `chromex.routeRules.${tabId}`;
        const got = await chrome.storage.session.get(key);
        const v = got?.[key];
        return Array.isArray(v) ? (v as Array<Record<string, unknown>>) : undefined;
      },
      set: async (tabId, rules) => {
        await chrome.storage.session.set({ [`chromex.routeRules.${tabId}`]: rules });
      },
      delete: async (tabId) => {
        await chrome.storage.session.remove(`chromex.routeRules.${tabId}`);
      },
    },
    // Emulation overrides persist the same way — the merged arg set is
    // re-applied by the next CDP acquire after an SW restart.
    emulationStore: {
      get: async (tabId) => {
        const key = `chromex.emulation.${tabId}`;
        const got = await chrome.storage.session.get(key);
        const v = got?.[key];
        return v && typeof v === "object" && !Array.isArray(v)
          ? (v as Record<string, unknown>)
          : undefined;
      },
      set: async (tabId, state) => {
        await chrome.storage.session.set({ [`chromex.emulation.${tabId}`]: state });
      },
      delete: async (tabId) => {
        await chrome.storage.session.remove(`chromex.emulation.${tabId}`);
      },
    },
    queryTabs: async () => chrome.tabs.query({}),
    recentTabCreations: () => [...recentTabCreations],
    activateTab: async (tabId) => {
      await chrome.tabs.update(tabId, { active: true });
      const tab = await chrome.tabs.get(tabId);
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
    },
    highlightTab: async (windowId, index) => {
      // chrome.tabs.highlight's `tabs` are window-relative indices, not ids
      await chrome.tabs.highlight({ windowId, tabs: [index] });
    },
    closeTab: async (tabId) => {
      await chrome.tabs.remove(tabId);
    },
    createTab: async ({ url, active, windowId, pinned, muted, autoDiscardable }) =>
      chrome.tabs.create({
        ...(url ? { url } : {}),
        ...(active !== undefined ? { active } : {}),
        ...(windowId !== undefined ? { windowId } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        ...(muted !== undefined ? { muted } : {}),
        ...(autoDiscardable !== undefined ? { autoDiscardable } : {}),
      }),
    updateTab: async (tabId, opts) =>
      chrome.tabs.update(tabId, {
        ...(opts.pinned !== undefined ? { pinned: opts.pinned } : {}),
        ...(opts.muted !== undefined ? { muted: opts.muted } : {}),
        ...(opts.autoDiscardable !== undefined ? { autoDiscardable: opts.autoDiscardable } : {}),
      }),
    discardTab: async (tabId) => chrome.tabs.discard(tabId),
    moveTab: async (tabId, index, windowId) =>
      chrome.tabs.move(tabId, {
        index,
        ...(windowId !== undefined ? { windowId } : {}),
      }),
    setTabZoom: async (tabId, zoomFactor) => chrome.tabs.setZoom(tabId, zoomFactor),
    duplicateTab: async (tabId) => {
      const tab = await chrome.tabs.duplicate(tabId);
      if (!tab) throw new Error(`chrome.tabs.duplicate(${tabId}) returned no tab`);
      return tab;
    },
    runInMainWorld: async (tabId, func, args, frameIds) => {
      const [res] = await chrome.scripting.executeScript({
        target: { tabId, ...(frameIds && frameIds.length > 0 ? { frameIds } : {}) },
        world: "MAIN",
        func: func as (...fnArgs: unknown[]) => unknown,
        args: args ?? [],
      });
      return res?.result;
    },
    navigateHistory: async (tabId, action, opts) => {
      if (action === "back") return chrome.tabs.goBack(tabId);
      if (action === "forward") return chrome.tabs.goForward(tabId);
      return opts?.bypassCache
        ? chrome.tabs.reload(tabId, { bypassCache: true })
        : chrome.tabs.reload(tabId);
    },
    searchHistory: async ({ text, url, startTime, endTime, limit }) => {
      const granted = await chrome.permissions.contains({ permissions: ["history"] });
      if (!granted || !chrome.history?.search) return null;
      // chrome.history timestamps are microseconds since epoch; callers
      // pass epoch ms — values already at µs scale pass through.
      const toUs = (ms: number | undefined) =>
        ms === undefined ? undefined : ms > 1e14 ? ms : ms * 1000;
      // HistoryQuery has no url field — filter client-side.
      const items = await chrome.history.search({
        text: text ?? "",
        ...(startTime !== undefined ? { startTime: toUs(startTime) } : {}),
        ...(endTime !== undefined ? { endTime: toUs(endTime) } : {}),
        maxResults: limit,
      });
      return items
        .filter((h): h is chrome.history.HistoryItem & { url: string } =>
          typeof h.url === "string" && h.url.length > 0)
        .filter((h) => !url || h.url.includes(url))
        .map((h) => ({
          url: h.url,
          ...(h.title ? { title: h.title } : {}),
          ...(typeof h.visitCount === "number" ? { visitCount: h.visitCount } : {}),
          ...(typeof h.lastVisitTime === "number" ? { lastVisitTime: h.lastVisitTime } : {}),
        }));
    },
    browsingDataClear: async ({ dataTypes, sinceMs, origins }) => {
      const granted = await chrome.permissions.contains({ permissions: ["browsingData"] });
      if (!granted || !chrome.browsingData?.remove) return null;
      const removalOptions: chrome.browsingData.RemovalOptions = {
        // chrome expects microseconds since epoch; 0/undefined = all time
        ...(sinceMs !== undefined && sinceMs > 0 ? { since: sinceMs * 1000 } : {}),
        ...(origins?.length ? { origins: origins as [string, ...string[]] } : {}),
      };
      const dataToRemove: Record<string, true> = {};
      for (const t of dataTypes) dataToRemove[t] = true;
      await chrome.browsingData.remove(removalOptions, dataToRemove);
      return {
        cleared: dataTypes,
        ...(sinceMs !== undefined && sinceMs > 0 ? { since: sinceMs } : {}),
        ...(origins?.length ? { origins } : {}),
      };
    },
    deleteHistory: async ({ url, startTime, endTime }) => {
      const granted = await chrome.permissions.contains({ permissions: ["history"] });
      if (!granted || !chrome.history) return null;
      const toUs = (ms: number | undefined) =>
        ms === undefined ? undefined : ms > 1e14 ? ms : ms * 1000;
      if (url) {
        await chrome.history.deleteUrl({ url });
        return { deleted: "url", url };
      }
      await chrome.history.deleteRange({
        startTime: toUs(startTime)!,
        endTime: toUs(endTime)!,
      });
      return { deleted: "range", startTime, endTime };
    },
    bookmarkOp: async (op) => {
      const granted = await chrome.permissions.contains({ permissions: ["bookmarks"] });
      if (!granted || !chrome.bookmarks) return null;
      const norm = (n: chrome.bookmarks.BookmarkTreeNode): Record<string, unknown> => ({
        id: n.id,
        parentId: n.parentId ?? "",
        title: n.title ?? "",
        ...(n.url ? { url: n.url } : {}),
        ...(typeof n.dateAdded === "number" ? { dateAdded: n.dateAdded } : {}),
        ...(Array.isArray(n.children)
          ? { children: n.children.slice(0, op.limit).map((c) => norm(c)) }
          : {}),
      });
      const listResult = (nodes: chrome.bookmarks.BookmarkTreeNode[]) => ({
        nodes: nodes.slice(0, op.limit).map((n) => norm(n)),
        count: Math.min(nodes.length, op.limit),
        truncated: nodes.length > op.limit,
      });
      switch (op.action) {
        case "list":
          return listResult(await chrome.bookmarks.getChildren(op.parentId ?? "0"));
        case "search":
          return listResult(await chrome.bookmarks.search({ query: op.query ?? "" }));
        case "get": {
          const nodes = await chrome.bookmarks.get(op.id ?? "");
          return { node: nodes[0] ? norm(nodes[0]) : null };
        }
        case "create": {
          const node = await chrome.bookmarks.create({
            ...(op.parentId ? { parentId: op.parentId } : {}),
            ...(op.title !== undefined ? { title: op.title } : {}),
            ...(op.url !== undefined ? { url: op.url } : {}),
          });
          return { node: norm(node) };
        }
        case "update": {
          const changes: chrome.bookmarks.UpdateChanges = {};
          if (op.title !== undefined) changes.title = op.title;
          if (op.url !== undefined) changes.url = op.url;
          const node = await chrome.bookmarks.update(op.id ?? "", changes);
          return { node: norm(node) };
        }
        case "remove":
          await chrome.bookmarks.remove(op.id ?? "");
          return { removed: op.id };
      }
    },
    listDownloads: async ({ state, limit, startTime }) => {
      const items = await chrome.downloads.search({
        ...(state ? { state: state as chrome.downloads.DownloadQuery["state"] } : {}),
        limit,
        ...(startTime !== undefined ? { startedAfter: new Date(startTime).toISOString() } : {}),
      });
      return items.map((d) => ({
        id: d.id,
        state: d.state,
        filename: d.filename,
        bytesReceived: d.bytesReceived,
        totalBytes: d.totalBytes,
        ...(d.mime ? { mime: d.mime } : {}),
        // internal match input for downloads.wait — never echoed raw
        url: d.url,
        // exists tells the agent the bytes are actually on disk —
        // filename alone can point at a file the user moved/deleted.
        ...(typeof d.exists === "boolean" ? { fileExists: d.exists } : {}),
        ...(d.error ? { error: d.error } : {}),
        startTime: d.startTime,
      }));
    },
    downloadFile: async ({ url, filename }) => {
      const id = await chrome.downloads.download({
        url,
        ...(filename ? { filename } : {}),
        saveAs: false,
      });
      return { id, ...(filename ? { filename } : {}) };
    },
    cancelDownload: async (downloadId) => {
      await chrome.downloads.cancel(downloadId);
    },
    openDownload: async (downloadId, opts) => {
      if (opts?.reveal === true) {
        await chrome.downloads.show(downloadId);
      } else {
        await chrome.downloads.open(downloadId);
      }
    },
    manageDownload: async (downloadId, op) => {
      // chrome.downloads.pause/resume/erase can silently no-op on
      // unknown ids — preflight existence so {paused,resumed,erased}:
      // true is never claimed for a download that was not there.
      const found = await chrome.downloads.search({ id: downloadId });
      if (!found.length) throw new Error(`download ${downloadId} not found`);
      if (op === "pause") await chrome.downloads.pause(downloadId);
      else if (op === "resume") await chrome.downloads.resume(downloadId);
      else await chrome.downloads.erase({ id: downloadId });
    },
    listWindows: async () => {
      // normal+popup+app: popup windows (window.open features, agent
      // pop-outs) are real browsing surface the agent must see to
      // manage; devtools/panel are chrome-internal and never returned.
      const wins = await chrome.windows.getAll({
        populate: true,
        windowTypes: ["normal", "popup", "app"],
      });
      return wins
        .filter((w) => typeof w.id === "number")
        .map((w) => ({
          id: w.id,
          focused: w.focused === true,
          type: w.type ?? "normal",
          state: w.state ?? "normal",
          incognito: w.incognito === true,
          ...(typeof w.left === "number" ? { left: w.left } : {}),
          ...(typeof w.top === "number" ? { top: w.top } : {}),
          ...(typeof w.width === "number" ? { width: w.width } : {}),
          ...(typeof w.height === "number" ? { height: w.height } : {}),
          tabCount: Array.isArray(w.tabs) ? w.tabs.length : 0,
        }));
    },
    getWindow: async (windowId) => {
      const w = await chrome.windows.get(windowId, { populate: true });
      return {
        id: w.id,
        focused: w.focused === true,
        type: w.type ?? "normal",
        state: w.state ?? "normal",
        incognito: w.incognito === true,
        ...(typeof w.left === "number" ? { left: w.left } : {}),
        ...(typeof w.top === "number" ? { top: w.top } : {}),
        ...(typeof w.width === "number" ? { width: w.width } : {}),
        ...(typeof w.height === "number" ? { height: w.height } : {}),
        tabCount: Array.isArray(w.tabs) ? w.tabs.length : 0,
      };
    },
    getLastFocusedWindow: async () => {
      const w = await chrome.windows.getLastFocused({ populate: true });
      return {
        id: w.id,
        focused: w.focused === true,
        type: w.type ?? "normal",
        state: w.state ?? "normal",
        incognito: w.incognito === true,
        ...(typeof w.left === "number" ? { left: w.left } : {}),
        ...(typeof w.top === "number" ? { top: w.top } : {}),
        ...(typeof w.width === "number" ? { width: w.width } : {}),
        ...(typeof w.height === "number" ? { height: w.height } : {}),
        tabCount: Array.isArray(w.tabs) ? w.tabs.length : 0,
      };
    },
    createWindow: async (opts) => {
      const win = await chrome.windows.create({
        ...(opts.url ? { url: opts.url } : {}),
        ...(opts.type ? { type: opts.type as NonNullable<chrome.windows.CreateData["type"]> } : {}),
        ...(opts.focused !== undefined ? { focused: opts.focused } : {}),
        ...(opts.width !== undefined ? { width: opts.width } : {}),
        ...(opts.height !== undefined ? { height: opts.height } : {}),
        ...(opts.left !== undefined ? { left: opts.left } : {}),
        ...(opts.top !== undefined ? { top: opts.top } : {}),
        ...(opts.state ? { state: opts.state as NonNullable<chrome.windows.CreateData["state"]> } : {}),
      });
      return {
        id: win?.id,
        focused: win?.focused === true,
        state: win?.state ?? opts.state,
        type: win?.type ?? opts.type ?? "normal",
        tabs: (win?.tabs ?? [])
          .filter((t) => typeof t.id === "number")
          .map((t) => ({
            id: t.id,
            url: t.url ?? "",
            title: t.title ?? "",
            active: t.active === true,
          })),
      };
    },
    updateWindow: async (windowId, opts) =>
      chrome.windows.update(windowId, {
        ...(opts.focused !== undefined ? { focused: opts.focused } : {}),
        ...(opts.state ? { state: opts.state as NonNullable<chrome.windows.UpdateInfo["state"]> } : {}),
        ...(opts.left !== undefined ? { left: opts.left } : {}),
        ...(opts.top !== undefined ? { top: opts.top } : {}),
        ...(opts.width !== undefined ? { width: opts.width } : {}),
        ...(opts.height !== undefined ? { height: opts.height } : {}),
        ...(opts.drawAttention !== undefined ? { drawAttention: opts.drawAttention } : {}),
      }),
    // Window destruction crashes headless Chromium outright — both
    // chrome.windows.remove AND last-tab-close (BUS_ADRALN, reproduced
    // on CfT 158). Omit the dep on headless so the tool refuses with
    // proto.unsupported instead of killing the browser.
    ...(HEADLESS_CHROME
      ? {}
      : {
          removeWindow: async (windowId: number) => {
            const tabs = await chrome.tabs.query({ windowId });
            const removedId = await chrome.windows.remove(windowId);
            return {
              windowId: removedId,
              removed: true,
              tabsClosed: tabs.filter((t) => typeof t.id === "number").length,
            };
          },
        }),
    ...(chrome.tabGroups
      ? {
          tabGroups: {
            list: async () =>
              (await chrome.tabGroups.query({})).map((g) => ({
                id: g.id,
                windowId: g.windowId,
                title: g.title,
                color: g.color,
                collapsed: g.collapsed,
              })),
            tabsInGroup: async (groupId: number) =>
              (await chrome.tabs.query({ groupId }))
                .map((t) => t.id)
                .filter((id): id is number => typeof id === "number"),
            create: async (tabIds: number[], groupId?: number) => {
              // chrome.tabs.group resolves to the group id (number)
              const id = await chrome.tabs.group({
                tabIds: tabIds as [number, ...number[]],
                ...(groupId !== undefined ? { groupId } : {}),
              });
              return { id };
            },
            ungroup: async (tabIds: number[]) =>
              chrome.tabs.ungroup(tabIds as [number, ...number[]]),
            update: async (
              groupId: number,
              opts: { title?: string; color?: string; collapsed?: boolean },
            ) =>
              chrome.tabGroups.update(groupId, {
                ...(opts.title !== undefined ? { title: opts.title } : {}),
                ...(opts.color ? { color: opts.color as chrome.tabGroups.Color } : {}),
                ...(opts.collapsed !== undefined ? { collapsed: opts.collapsed } : {}),
              }),
          },
        }
      : {}),
    siteSettings: {
      // chrome.contentSettings is a bag of per-type APIs — resolve
      // dynamically so every Chrome-version type works; unknown types
      // return null → proto.unsupported. The "contentSettings"
      // permission is OPTIONAL (install warning) — checked per call so
      // a runtime grant works without a service-worker restart; Chrome
      // also hides the namespace entirely while ungranted.
      get: async (type, primaryPattern, scope) => {
        const granted = await chrome.permissions.contains({ permissions: ["contentSettings"] });
        if (!granted) return "permission";
        const api = (chrome.contentSettings as unknown as Record<string, {
          get(d: { primaryPattern: string; scope?: string }): Promise<{ setting?: string; scope?: string }>;
        } | undefined>)[type];
        if (!api) return null;
        return api.get({
          primaryPattern,
          ...(scope ? { scope } : {}),
        });
      },
      set: async (type, primaryPattern, setting, scope) => {
        const granted = await chrome.permissions.contains({ permissions: ["contentSettings"] });
        if (!granted) return "permission";
        const api = (chrome.contentSettings as unknown as Record<string, {
          set(d: { primaryPattern: string; setting: string; scope?: string }): Promise<void>;
        } | undefined>)[type];
        if (!api) return null;
        await api.set({
          primaryPattern,
          setting,
          ...(scope ? { scope } : {}),
        });
        return {};
      },
      clear: async (type, primaryPattern) => {
        const granted = await chrome.permissions.contains({ permissions: ["contentSettings"] });
        if (!granted) return "permission";
        const api = (chrome.contentSettings as unknown as Record<string, {
          clear(d: { primaryPattern: string }): Promise<void>;
        } | undefined>)[type];
        if (!api) return null;
        await api.clear({ primaryPattern });
        return {};
      },
    },
    sessions: {
      // chrome.sessions recently-closed entries — optional "sessions"
      // permission checked per call (runtime grant works without SW
      // restart); Chrome hides the namespace while ungranted.
      list: async (maxResults) => {
        const granted = await chrome.permissions.contains({ permissions: ["sessions"] });
        if (!granted) return "permission";
        const api = chrome.sessions as unknown as {
          getRecentlyClosed?(f: { maxResults: number }): Promise<Array<{
            lastModified: number;
            tab?: { sessionId?: string; url?: string; title?: string };
            window?: { sessionId?: string; tabs?: Array<{ url?: string; title?: string }> };
          }>>;
        } | undefined;
        if (!api?.getRecentlyClosed) return null;
        const sessions = await api.getRecentlyClosed({ maxResults });
        return sessions.map((s) => s.tab
          ? {
              kind: "tab" as const,
              sessionId: s.tab.sessionId ?? "",
              lastModified: s.lastModified,
              url: s.tab.url ?? "",
              title: s.tab.title ?? "",
            }
          : {
              kind: "window" as const,
              sessionId: s.window?.sessionId ?? "",
              lastModified: s.lastModified,
              url: s.window?.tabs?.[0]?.url ?? "",
              title: s.window?.tabs?.[0]?.title ?? "",
              tabCount: s.window?.tabs?.length ?? 0,
            });
      },
      restore: async (sessionId) => {
        const granted = await chrome.permissions.contains({ permissions: ["sessions"] });
        if (!granted) return "permission";
        const api = chrome.sessions as unknown as {
          restore?(id?: string): Promise<{
            lastModified: number;
            tab?: { sessionId?: string; id?: number; url?: string; title?: string };
            window?: { sessionId?: string; id?: number; tabs?: Array<{ url?: string; title?: string }> };
          }>;
        } | undefined;
        if (!api?.restore) return null;
        const s = await api.restore(sessionId);
        return s.tab
          ? {
              kind: "tab",
              sessionId: s.tab.sessionId ?? "",
              tabId: s.tab.id ?? null,
              url: s.tab.url ?? "",
              title: s.tab.title ?? "",
              lastModified: s.lastModified,
            }
          : {
              kind: "window",
              sessionId: s.window?.sessionId ?? "",
              windowId: s.window?.id ?? null,
              url: s.window?.tabs?.[0]?.url ?? "",
              title: s.window?.tabs?.[0]?.title ?? "",
              tabCount: s.window?.tabs?.length ?? 0,
              lastModified: s.lastModified,
            };
      },
    },
    proxy: {
      // chrome.proxy.settings — optional "proxy" permission checked per
      // call (runtime grant works without SW restart); Chrome hides the
      // namespace while ungranted.
      get: async (scope) => {
        const granted = await chrome.permissions.contains({ permissions: ["proxy"] });
        if (!granted) return "permission";
        const api = chrome.proxy?.settings as unknown as {
          get(d: { scope?: string }): Promise<{ value?: unknown; levelOfControl?: string }>;
        } | undefined;
        if (!api?.get) return null;
        return api.get({ ...(scope ? { scope } : {}) });
      },
      set: async (value, scope) => {
        const granted = await chrome.permissions.contains({ permissions: ["proxy"] });
        if (!granted) return "permission";
        const api = chrome.proxy?.settings as unknown as {
          set(d: { value: unknown; scope?: string }): Promise<void>;
        } | undefined;
        if (!api?.set) return null;
        await api.set({ value, ...(scope ? { scope } : {}) });
        return { applied: true };
      },
      clear: async (scope) => {
        const granted = await chrome.permissions.contains({ permissions: ["proxy"] });
        if (!granted) return "permission";
        const api = chrome.proxy?.settings as unknown as {
          clear(d: { scope?: string }): Promise<void>;
        } | undefined;
        if (!api?.clear) return null;
        await api.clear({ ...(scope ? { scope } : {}) });
        return { cleared: true };
      },
    },
    privacy: {
      // chrome.privacy.services|network|websites — optional "privacy"
      // permission checked per call (runtime grant works without SW
      // restart); Chrome hides the namespace while ungranted.
      get: async (setting, scope) => {
        const granted = await chrome.permissions.contains({ permissions: ["privacy"] });
        if (!granted) return "permission";
        const privacy = chrome.privacy as unknown as Record<string, Record<string, unknown>> | undefined;
        if (!privacy) return null;
        const readOne = async (key: string) => {
          const s = privacy[key.split(".")[0] ?? ""]?.[key.split(".")[1] ?? ""] as
            | { get(d?: { scope?: string }): Promise<{ value?: unknown; levelOfControl?: string }> }
            | undefined;
          if (!s?.get) return null;
          const r = await s.get({ ...(scope ? { scope } : {}) });
          return { value: r?.value ?? null, ...(typeof r?.levelOfControl === "string" ? { levelOfControl: r.levelOfControl } : {}) };
        };
        if (setting !== undefined) {
          const res = await readOne(setting);
          return res === null ? null : { settings: { [setting]: res } };
        }
        const settings: Record<string, unknown> = {};
        const errors: Record<string, string> = {};
        const keys: string[] = [];
        for (const [section, entries] of Object.entries(privacy)) {
          if (typeof entries !== "object" || entries === null) continue;
          for (const key of Object.keys(entries)) {
            const candidate = entries[key] as { get?: unknown };
            if (typeof candidate?.get === "function") keys.push(`${section}.${key}`);
          }
        }
        await Promise.all(
          keys.map(async (key) => {
            try {
              const res = await readOne(key);
              if (res !== null) settings[key] = res;
            } catch (e) {
              errors[key] = e instanceof Error ? e.message : String(e);
            }
          }),
        );
        return { settings, ...(Object.keys(errors).length > 0 ? { errors } : {}) };
      },
      set: async (setting, value, scope) => {
        const granted = await chrome.permissions.contains({ permissions: ["privacy"] });
        if (!granted) return "permission";
        const [section, key] = setting.split(".");
        const s = (chrome.privacy as unknown as Record<string, Record<string, unknown>> | undefined)?.[section ?? ""]?.[key ?? ""] as
          | { set(d: { value: unknown; scope?: string }): Promise<void> }
          | undefined;
        if (!s?.set) return null;
        await s.set({ value, ...(scope ? { scope } : {}) });
        return { applied: true };
      },
      clear: async (setting, scope) => {
        const granted = await chrome.permissions.contains({ permissions: ["privacy"] });
        if (!granted) return "permission";
        const privacy = chrome.privacy as unknown as Record<string, Record<string, unknown>> | undefined;
        if (!privacy) return null;
        const clearOne = async (key: string) => {
          const [section, name] = key.split(".");
          const s = privacy[section ?? ""]?.[name ?? ""] as
            | { clear(d?: { scope?: string }): Promise<void> }
            | undefined;
          if (!s?.clear) return false;
          await s.clear({ ...(scope ? { scope } : {}) });
          return true;
        };
        if (setting !== undefined) {
          return (await clearOne(setting)) ? { cleared: true } : null;
        }
        const keys: string[] = [];
        for (const [section, entries] of Object.entries(privacy)) {
          if (typeof entries !== "object" || entries === null) continue;
          for (const key of Object.keys(entries)) {
            const candidate = entries[key] as { clear?: unknown };
            if (typeof candidate?.clear === "function") keys.push(`${section}.${key}`);
          }
        }
        let cleared = 0;
        for (const key of keys) {
          try {
            if (await clearOne(key)) cleared += 1;
          } catch {
            // Per-setting failures (e.g. disable-only settings rejecting
            // clear semantics) don't abort the rest — count honestly.
          }
        }
        return { cleared: true, clearedCount: cleared, totalCount: keys.length };
      },
    },
    management: {
      // chrome.management — optional "management" permission checked per
      // call (runtime grant works without SW restart). Entries are
      // sanitized to the fields the agent needs; 'self' marks this
      // extension so the agent can identify its own host.
      list: async (maxResults) => {
        const granted = await chrome.permissions.contains({ permissions: ["management"] });
        if (!granted) return "permission";
        const api = chrome.management as unknown as { getAll(): Promise<Array<Record<string, unknown>>> } | undefined;
        if (!api?.getAll) return null;
        const all = await api.getAll();
        const selfId = chrome.runtime.id;
        return all.slice(0, maxResults).map((e) => sanitizeExtensionInfo(e, selfId));
      },
      get: async (id) => {
        const granted = await chrome.permissions.contains({ permissions: ["management"] });
        if (!granted) return "permission";
        const api = chrome.management as unknown as { get(i: string): Promise<Record<string, unknown> | undefined> } | undefined;
        if (!api?.get) return null;
        const e = await api.get(id);
        if (!e) return null;
        return sanitizeExtensionInfo(e, chrome.runtime.id);
      },
      setEnabled: async (id, enabled) => {
        const granted = await chrome.permissions.contains({ permissions: ["management"] });
        if (!granted) return "permission";
        const api = chrome.management as unknown as { setEnabled(i: string, en: boolean): Promise<void> } | undefined;
        if (!api?.setEnabled) return null;
        await api.setEnabled(id, enabled);
        return { applied: true };
      },
      uninstall: async (id) => {
        const granted = await chrome.permissions.contains({ permissions: ["management"] });
        if (!granted) return "permission";
        const api = chrome.management as unknown as { uninstall(i: string): Promise<void> } | undefined;
        if (!api?.uninstall) return null;
        await api.uninstall(id);
        return { uninstalled: true };
      },
    },
    selfExtensionId: chrome.runtime.id,
    notifications: {
      // chrome.notifications — optional "notifications" permission
      // checked per call. iconUrl defaults to the bundled extension
      // icon (chrome.notifications requires one; Chrome only accepts
      // data: URLs or extension resources, never http(s)).
      permission: async () => {
        const granted = await chrome.permissions.contains({ permissions: ["notifications"] });
        if (!granted) return "permission";
        const api = chrome.notifications as unknown as { getPermissionLevel(): Promise<string> } | undefined;
        if (!api?.getPermissionLevel) return null;
        return api.getPermissionLevel();
      },
      send: async (options) => {
        const granted = await chrome.permissions.contains({ permissions: ["notifications"] });
        if (!granted) return "permission";
        const api = chrome.notifications as unknown as {
          create(o: Record<string, unknown>): Promise<string>;
          create(i: string, o: Record<string, unknown>): Promise<string>;
        } | undefined;
        if (!api?.create) return null;
        // notificationId (when supplied) is create()'s first arg — it
        // replaces an existing notification, it is NOT an option field.
        const { notificationId, ...rest } = options;
        const full = { iconUrl: chrome.runtime.getURL("icons/codex-128.png"), ...rest };
        const id = typeof notificationId === "string" && notificationId.length > 0
          ? await api.create(notificationId, full)
          : await api.create(full);
        return { id };
      },
      update: async (id, options) => {
        const granted = await chrome.permissions.contains({ permissions: ["notifications"] });
        if (!granted) return "permission";
        const api = chrome.notifications as unknown as { update(i: string, o: Record<string, unknown>): Promise<boolean> } | undefined;
        if (!api?.update) return null;
        const updated = await api.update(id, options);
        return { updated };
      },
      clear: async (id) => {
        const granted = await chrome.permissions.contains({ permissions: ["notifications"] });
        if (!granted) return "permission";
        const api = chrome.notifications as unknown as {
          clear(i: string): Promise<boolean>;
          getAll(): Promise<Record<string, true>>;
        } | undefined;
        if (!api?.clear || !api?.getAll) return null;
        if (id !== undefined) {
          const cleared = await api.clear(id);
          return { cleared, ...(cleared ? {} : { reason: "notification not found" }) };
        }
        const all = await api.getAll();
        const ids = Object.keys(all ?? {});
        let clearedCount = 0;
        for (const nid of ids) {
          try {
            if (await api.clear(nid)) clearedCount += 1;
          } catch {
            // per-id failures don't abort the sweep — count honestly
          }
        }
        return { cleared: true, clearedCount, totalCount: ids.length };
      },
      list: async () => {
        const granted = await chrome.permissions.contains({ permissions: ["notifications"] });
        if (!granted) return "permission";
        const api = chrome.notifications as unknown as { getAll(): Promise<Record<string, true>> } | undefined;
        if (!api?.getAll) return null;
        const all = await api.getAll();
        return { ids: Object.keys(all ?? {}).sort() };
      },
    },
    dnr: {
      // chrome.declarativeNetRequest session rules — optional
      // "declarativeNetRequest" permission checked per call (runtime
      // grant works without SW restart). Rules arrive pre-validated by
      // the tool host; this layer only marshals to the Chrome API.
      permission: async () => {
        const granted = await chrome.permissions.contains({ permissions: ["declarativeNetRequest"] });
        if (!granted) return "permission";
        return "granted";
      },
      list: async () => {
        const granted = await chrome.permissions.contains({ permissions: ["declarativeNetRequest"] });
        if (!granted) return "permission";
        const api = chrome.declarativeNetRequest as unknown as {
          getSessionRules(): Promise<Array<Record<string, unknown>>>;
        } | undefined;
        if (!api?.getSessionRules) return null;
        return api.getSessionRules();
      },
      update: async (options) => {
        const granted = await chrome.permissions.contains({ permissions: ["declarativeNetRequest"] });
        if (!granted) return "permission";
        const api = chrome.declarativeNetRequest as unknown as {
          updateSessionRules(o: Record<string, unknown>): Promise<void>;
        } | undefined;
        if (!api?.updateSessionRules) return null;
        await api.updateSessionRules(options);
        return { applied: true };
      },
      matched: async (filter) => {
        const granted = await chrome.permissions.contains({ permissions: ["declarativeNetRequest"] });
        if (!granted) return "permission";
        const api = chrome.declarativeNetRequest as unknown as {
          getMatchedRules(f?: Record<string, unknown>): Promise<{ rulesMatchedInfo?: Array<Record<string, unknown>> }>;
        } | undefined;
        if (!api?.getMatchedRules) return null;
        const details = await api.getMatchedRules(filter ?? {});
        return details?.rulesMatchedInfo ?? [];
      },
      test: async (request) => {
        const granted = await chrome.permissions.contains({ permissions: ["declarativeNetRequest"] });
        if (!granted) return "permission";
        const api = chrome.declarativeNetRequest as unknown as {
          testMatchOutcome(r: Record<string, unknown>): Promise<{ matchedRules?: Array<Record<string, unknown>> }>;
        } | undefined;
        if (!api?.testMatchOutcome) return null;
        const res = await api.testMatchOutcome(request);
        return res?.matchedRules ?? [];
      },
    },
    userScripts: {
      // chrome.userScripts — optional "userScripts" permission checked
      // per call (runtime grant works without SW restart). Scripts and
      // injections arrive pre-validated by the tool host; this layer
      // only marshals to the Chrome API and sanitizes results.
      permission: async () => {
        const granted = await chrome.permissions.contains({ permissions: ["userScripts"] });
        if (!granted) return "permission";
        return "granted";
      },
      list: async (ids) => {
        const granted = await chrome.permissions.contains({ permissions: ["userScripts"] });
        if (!granted) return "permission";
        const api = chrome.userScripts as unknown as {
          getScripts(f?: { ids?: string[] }): Promise<Array<Record<string, unknown>>>;
        } | undefined;
        if (!api?.getScripts) return null;
        const scripts = await api.getScripts(ids?.length ? { ids } : undefined);
        return (Array.isArray(scripts) ? scripts : []).map(sanitizeUserScript);
      },
      register: async (scripts) => {
        const granted = await chrome.permissions.contains({ permissions: ["userScripts"] });
        if (!granted) return "permission";
        const api = chrome.userScripts as unknown as {
          register(s: Array<Record<string, unknown>>): Promise<void>;
        } | undefined;
        if (!api?.register) return null;
        await api.register(scripts);
        return { registered: scripts.length };
      },
      unregister: async (ids) => {
        const granted = await chrome.permissions.contains({ permissions: ["userScripts"] });
        if (!granted) return "permission";
        const api = chrome.userScripts as unknown as {
          unregister(f?: { ids?: string[] }): Promise<void>;
        } | undefined;
        if (!api?.unregister) return null;
        await api.unregister(ids?.length ? { ids } : undefined);
        return { unregistered: ids?.length ?? "all" };
      },
      update: async (scripts) => {
        const granted = await chrome.permissions.contains({ permissions: ["userScripts"] });
        if (!granted) return "permission";
        const api = chrome.userScripts as unknown as {
          update(s: Array<Record<string, unknown>>): Promise<void>;
        } | undefined;
        if (!api?.update) return null;
        await api.update(scripts);
        return { updated: scripts.length };
      },
      execute: async (injection) => {
        const granted = await chrome.permissions.contains({ permissions: ["userScripts"] });
        if (!granted) return "permission";
        const api = chrome.userScripts as unknown as {
          execute<T = unknown>(i: Record<string, unknown>): Promise<Array<Record<string, unknown>>>;
        } | undefined;
        if (!api?.execute) return null;
        const results = await api.execute(injection);
        return (Array.isArray(results) ? results : []).map((r) => ({
          documentId: typeof r.documentId === "string" ? r.documentId : undefined,
          frameId: typeof r.frameId === "number" ? r.frameId : undefined,
          ...(typeof r.error === "string" ? { error: r.error.slice(0, 500) } : {}),
          ...(r.result !== undefined ? { result: r.result } : {}),
        }));
      },
      worlds: async () => {
        const granted = await chrome.permissions.contains({ permissions: ["userScripts"] });
        if (!granted) return "permission";
        const api = chrome.userScripts as unknown as {
          getWorldConfigurations(): Promise<Array<Record<string, unknown>>>;
        } | undefined;
        if (!api?.getWorldConfigurations) return null;
        return api.getWorldConfigurations();
      },
      configureWorld: async (properties) => {
        const granted = await chrome.permissions.contains({ permissions: ["userScripts"] });
        if (!granted) return "permission";
        const api = chrome.userScripts as unknown as {
          configureWorld(p: Record<string, unknown>): Promise<void>;
        } | undefined;
        if (!api?.configureWorld) return null;
        await api.configureWorld(properties);
        return { configured: true };
      },
      resetWorld: async (worldId) => {
        const granted = await chrome.permissions.contains({ permissions: ["userScripts"] });
        if (!granted) return "permission";
        const api = chrome.userScripts as unknown as {
          resetWorldConfiguration(w?: string): Promise<void>;
        } | undefined;
        if (!api?.resetWorldConfiguration) return null;
        await api.resetWorldConfiguration(worldId);
        return { reset: true };
      },
    },
    system: {
      // chrome.system.memory/cpu — separate optional permissions per
      // op, checked per call. Stats only; no page or profile data.
      memory: async () => {
        const granted = await chrome.permissions.contains({ permissions: ["system.memory"] });
        if (!granted) return "permission";
        const api = chrome.system?.memory as unknown as {
          getInfo(): Promise<{ capacity: number; availableCapacity: number }>;
        } | undefined;
        if (!api?.getInfo) return null;
        const info = await api.getInfo();
        const capacity = typeof info?.capacity === "number" ? info.capacity : 0;
        const available = typeof info?.availableCapacity === "number" ? info.availableCapacity : 0;
        return {
          capacity,
          availableCapacity: available,
          percentUsed: capacity > 0 ? Math.round((1 - available / capacity) * 1000) / 10 : null,
        };
      },
      cpu: async () => {
        const granted = await chrome.permissions.contains({ permissions: ["system.cpu"] });
        if (!granted) return "permission";
        const api = chrome.system?.cpu as unknown as {
          getInfo(): Promise<Record<string, unknown>>;
        } | undefined;
        if (!api?.getInfo) return null;
        const info = (await api.getInfo()) as {
          numOfProcessors?: number;
          archName?: string;
          modelName?: string;
          features?: string[];
          temperatures?: number[];
          processors?: Array<{ usage?: Record<string, number> }>;
        };
        return {
          numOfProcessors: info?.numOfProcessors ?? null,
          archName: info?.archName ?? null,
          modelName: info?.modelName ?? null,
          features: Array.isArray(info?.features) ? info.features.slice(0, 32) : [],
          temperatures: Array.isArray(info?.temperatures) ? info.temperatures.slice(0, 32) : [],
          processors: (Array.isArray(info?.processors) ? info.processors : [])
            .slice(0, 32)
            .map((p) => ({
              user: p?.usage?.user ?? null,
              kernel: p?.usage?.kernel ?? null,
              idle: p?.usage?.idle ?? null,
              total: p?.usage?.total ?? null,
            })),
        };
      },
      permissions: async () => ({
        memory: await chrome.permissions.contains({ permissions: ["system.memory"] }),
        cpu: await chrome.permissions.contains({ permissions: ["system.cpu"] }),
      }),
    },
    processes: {
      // chrome.processes — optional "processes" permission checked per
      // call. chrome.processes is untyped in @types/chrome; cast like
      // the other optional APIs. Results sanitized: tab titles/urls
      // bounded, workers included.
      permission: async () => {
        const granted = await chrome.permissions.contains({ permissions: ["processes"] });
        if (!granted) return "permission";
        return "granted";
      },
      list: async () => {
        const granted = await chrome.permissions.contains({ permissions: ["processes"] });
        if (!granted) return "permission";
        const api = (chrome as unknown as {
          processes?: {
            getProcessInfo(ids?: number[], includeWorkers?: boolean): Promise<Array<Record<string, unknown>>>;
          };
        }).processes;
        if (!api?.getProcessInfo) return null;
        const procs = await api.getProcessInfo(undefined, true);
        return (Array.isArray(procs) ? procs : []).slice(0, 200).map((p) => ({
          id: typeof p.id === "number" ? p.id : null,
          type: typeof p.type === "string" ? p.type.slice(0, 40) : "unknown",
          ...(typeof p.osProcessId === "number" ? { osProcessId: p.osProcessId } : {}),
          ...(typeof p.cpu === "number" ? { cpu: p.cpu } : {}),
          tabs: (Array.isArray(p.tabs) ? (p.tabs as Array<Record<string, unknown>>) : [])
            .slice(0, 50)
            .map((t) => ({
              tabId: typeof t.tabId === "number" ? t.tabId : null,
              title: typeof t.title === "string" ? t.title.slice(0, 200) : "",
              url: typeof t.url === "string" ? t.url.slice(0, 2048) : "",
            })),
        }));
      },
      info: async (processId: number) => {
        const granted = await chrome.permissions.contains({ permissions: ["processes"] });
        if (!granted) return "permission";
        const api = (chrome as unknown as {
          processes?: {
            getProcessInfo(ids?: number[], includeWorkers?: boolean): Promise<Array<Record<string, unknown>>>;
          };
        }).processes;
        if (!api?.getProcessInfo) return "unavailable";
        const procs = await api.getProcessInfo([processId], false);
        const p = Array.isArray(procs) ? procs[0] : undefined;
        if (!p) return null;
        return {
          id: typeof p.id === "number" ? p.id : null,
          type: typeof p.type === "string" ? p.type.slice(0, 40) : "unknown",
        };
      },
      terminate: async (processId: number) => {
        const granted = await chrome.permissions.contains({ permissions: ["processes"] });
        if (!granted) return "permission";
        const api = (chrome as unknown as {
          processes?: { terminate(processId: number): Promise<void> };
        }).processes;
        if (!api?.terminate) return "unavailable";
        await api.terminate(processId);
        return {};
      },
    },
    dns: {
      // chrome.dns — optional "dns" permission checked per call.
      // chrome.dns is untyped in @types/chrome; cast like the other
      // optional APIs. Resolution failures (NXDOMAIN etc.) are
      // legitimate results — returned in-band as resolved:false,
      // not thrown as protocol errors.
      permission: async () => {
        // "dns" postdates the @types/chrome ManifestPermission union.
        const granted = await chrome.permissions.contains({
          permissions: ["dns"] as unknown as chrome.runtime.ManifestPermission[],
        });
        return granted ? "granted" : "permission";
      },
      resolve: async (hostname: string) => {
        const granted = await chrome.permissions.contains({
          permissions: ["dns"] as unknown as chrome.runtime.ManifestPermission[],
        });
        if (!granted) return "permission";
        const api = (chrome as unknown as {
          dns?: { resolve(hostname: string): Promise<string[]> };
        }).dns;
        if (!api?.resolve) return null;
        try {
          const addresses = await api.resolve(hostname);
          return {
            hostname,
            addresses: (Array.isArray(addresses) ? addresses : []).slice(0, 32),
            resolved: true,
          };
        } catch (err) {
          return {
            hostname,
            addresses: [] as string[],
            resolved: false,
            error: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
          };
        }
      },
    },
    power: {
      // chrome.power — optional "power" permission checked per call.
      // requestKeepAwake/releaseKeepAwake are void sync calls; the
      // hold is per-extension and a new request replaces the old one.
      permission: async () => {
        const granted = await chrome.permissions.contains({ permissions: ["power"] });
        return granted ? "granted" : "permission";
      },
      request: async (level: "system" | "display") => {
        const granted = await chrome.permissions.contains({ permissions: ["power"] });
        if (!granted) return "permission";
        if (!chrome.power?.requestKeepAwake) return null;
        chrome.power.requestKeepAwake(level);
        return { ok: true, held: true, level };
      },
      release: async () => {
        const granted = await chrome.permissions.contains({ permissions: ["power"] });
        if (!granted) return "permission";
        if (!chrome.power?.releaseKeepAwake) return null;
        chrome.power.releaseKeepAwake();
        return { ok: true, held: false };
      },
    },
    runtime: {
      // chrome.runtime host introspection — no permission required,
      // always available on the extension backend. getBrowserInfo is
      // untyped in @types/chrome (Chrome 100+) — cast; absent → null.
      info: async () => {
        const browserInfoApi = (chrome.runtime as unknown as {
          getBrowserInfo?: () => Promise<{ brand?: string; version?: string; majorVersion?: string }>;
        }).getBrowserInfo;
        let browser = browserInfoApi
          ? await browserInfoApi.call(chrome.runtime).then(
              (b) => ({
                brand: typeof b?.brand === "string" ? b.brand.slice(0, 60) : null,
                version: typeof b?.version === "string" ? b.version.slice(0, 60) : null,
                ...(typeof b?.majorVersion === "string" || typeof b?.majorVersion === "number"
                  ? { majorVersion: b.majorVersion }
                  : {}),
              }),
              () => null,
            )
          : null;
        if (browser === null || typeof browser.version !== "string" || browser.version.length === 0) {
          // getBrowserInfo is absent on some builds (Chrome for Testing)
          // — fall back to the service worker's own user agent, which
          // always carries the Chrome version.
          const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
          const m = /(?:Chrome|Chromium)\/([0-9]+(?:\.[0-9]+){1,3})/.exec(ua);
          const version = m?.[1];
          const major = version?.split(".")[0];
          if (version) {
            browser = {
              brand: "Chromium",
              version,
              ...(major ? { majorVersion: major } : {}),
            };
          }
        }
        const platform = await chrome.runtime.getPlatformInfo().then(
          (p) => ({ os: p?.os ?? null, arch: p?.arch ?? null }),
          () => ({ os: null, arch: null }),
        );
        const manifest = chrome.runtime.getManifest() as { name?: string; version?: string; manifest_version?: number };
        return {
          browser,
          extension: {
            id: chrome.runtime.id,
            version: typeof manifest?.version === "string" ? manifest.version : null,
            ...(typeof manifest?.name === "string" ? { name: manifest.name.slice(0, 120) } : {}),
            manifestVersion: typeof manifest?.manifest_version === "number" ? manifest.manifest_version : null,
          },
          platform,
        };
      },
    },
    permissions: {
      // chrome.permissions — always available in MV3, no permission
      // needed for the API itself. optionalPermissions comes from the
      // manifest so request/remove validation matches exactly what
      // Chrome would accept.
      optionalPermissions: () => {
        const m = chrome.runtime.getManifest() as { optional_permissions?: unknown };
        return Array.isArray(m?.optional_permissions)
          ? m.optional_permissions.filter((p): p is string => typeof p === "string")
          : [];
      },
      getAll: async () => {
        const r = await chrome.permissions.getAll().catch(() => null);
        if (!r) return null;
        return {
          permissions: Array.isArray(r.permissions) ? r.permissions.slice(0, 200) : [],
          origins: Array.isArray(r.origins) ? r.origins.slice(0, 200) : [],
        };
      },
      contains: async (permissions: string[]) => {
        const r = await chrome.permissions
          .contains({ permissions: permissions as chrome.runtime.ManifestPermission[] })
          .catch(() => null);
        return typeof r === "boolean" ? r : null;
      },
      // request/remove let Chrome errors propagate — a gesture
      // rejection or dialog failure must surface its real message,
      // not collapse into "API unavailable".
      request: async (permissions: string[]) => {
        const r = await chrome.permissions.request({
          permissions: permissions as chrome.runtime.ManifestPermission[],
        });
        return typeof r === "boolean" ? r : null;
      },
      remove: async (permissions: string[]) => {
        const r = await chrome.permissions.remove({
          permissions: permissions as chrome.runtime.ManifestPermission[],
        });
        return typeof r === "boolean" ? r : null;
      },
    },
    actionBadge: {
      // Merged under the attention count in runtime.renderBadge —
      // a pending approval always outranks agent status text.
      get: async () => {
        const [text, title] = await Promise.all([
          chrome.action.getBadgeText({}),
          chrome.action.getTitle({}),
        ]);
        return { text: text ?? "", title: title ?? "" };
      },
      set: async (state, ownerTaskId) => {
        setAgentBadge(state, ownerTaskId);
      },
    },
    activeTabId: async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      return typeof tab?.id === "number" ? tab.id : null;
    },
    acquireCdp,
    releaseCdp,
    acquireCdpTarget,
    releaseCdpTarget,
    listCdpTargets: () =>
      new Promise((resolve, reject) => {
        chrome.debugger.getTargets((targets) => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve((targets ?? []).map((t) => ({ id: t.id, type: t.type, url: t.url })));
        });
      }),
    captureVisibleTab: async (windowId, opts) =>
      chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: opts?.quality ?? 70 }),
    uploadArtifact: async (input) => {
      const rt = await getGatewayRuntime();
      if (!rt) throw new Error("gateway runtime unavailable");
      return (await rt.request("artifact.upload", input)) as {
        artifactRef: string;
        sha256: string;
        bytes: number;
      };
    },
  });

setGatewayServerRequestHandler(async (method, payload) => {
  if (method !== "browser.tool.request") {
    const e = new Error(`no handler for ${method}`) as Error & { code?: string };
    e.code = "proto.unsupported";
    throw e;
  }
  return toolHostHandler(payload);
});

// P1-08: when gatewayMode is on, route agent-domain bridge.request calls
// through the Gateway runtime (compat layer returns legacy shapes).
// Events/delta streaming migration is P1-10 — request path only.
void getGatewayRuntime().then((rt) => {
  bridge.setGatewayDelegate(rt ? { request: (m, p) => rt.request(m, p) } : null);
  // P1-10 interim: translate gateway envelopes into legacy bridge.event
  // broadcasts so the existing sidepanel keeps rendering in gatewayMode.
  rt?.onSnapshotRebuilt?.((taskId, snapshot) => {
    // P1-10: durable events were pruned — rebuild the stored
    // conversation view from the self-sufficient snapshot, then tell
    // the panel to rehydrate if it is showing this thread.
    void (async () => {
      try {
        const conversations = await listConversations();
        const conv = conversations.find((c) => c.threadId === taskId);
        if (!conv) return;
        const next = { ...conv, messages: snapshotToMessages(snapshot) };
        await saveConversation(next);
        void chrome.runtime
          .sendMessage({ type: "ui.conversation.rebuilt", conversationId: conv.id })
          .catch(() => undefined);
      } catch {
        /* snapshot rebuild is best-effort; task.sync already has the data */
      }
    })();
  });
  rt?.onEvent((env) => {
    const legacy = gatewayEventToLegacy(env);
    if (legacy) {
      // Gateway events bypass bridge.subscribe — run the same
      // conversation runtime tracking so turn.started/completed keep
      // per-conversation activeTurn state (ui.init, queue reconcile).
      const eventConversationId = trackBridgeEventRuntime(legacy);
      broadcastBridgeEvent(annotateBridgeEventConversation(legacy, eventConversationId));
    }
    // P1-10: ack durable task events once handed to the panel —
    // broadcastBridgeEvent resolves only after runtime.sendMessage, so
    // this approximates "rendered" for the interim translation path.
    const e = env as { kind?: string; stream?: string; taskId?: string; seq?: number };
    if (e.kind === "event" && e.stream === "task" && typeof e.seq === "number" && e.taskId) {
      rt?.tasks.markRendered(e.taskId, e.seq);
    }
  });
});
const UI_BRIDGE_TIMEOUT_MS = 4000;
const UI_CONTEXT_TIMEOUT_MS = 2500;
const PLAYWRIGHT_RUNTIME_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const SELECTED_PAGE_TEXT_CONTEXT_MAX_CHARS = 12_000;
const throttleVisibleTabCapture = createVisibleTabCaptureThrottle();
const cancelledPromptClientRequestIds = new Set<string>();
const OFFSCREEN_DOCUMENT_PATH = "offscreen.html";
const OFFSCREEN_IMAGE_CROP_MESSAGE_TYPE = "offscreen.image.crop";
let offscreenDocumentPromise: Promise<void> | null = null;
const conversationRuntime = new ConversationRuntimeRegistry();
type ReadableBrowserTab = chrome.tabs.Tab & { id: number; url: string; windowId: number };
type PromptStatusEmitter = (phase: PromptActivityPhase, workflow?: PromptImageWorkflowKind) => void;
type CurrentPageContextResult = {
  envelope: PageContextEnvelope;
  readStrategy: ReadStrategy;
  actionCards: ActionCard[];
};
type PromptTurnResult = { threadId: string; turnId: string };
type CompletedAssistantMessageEvent = {
  type: "message.completed";
  text?: string;
  threadId?: string;
  turnId?: string;
};
type HarnessPermissionBlockedResponse = {
  error: string;
  requiresConfirmation?: boolean;
  confirmationOperation?: HarnessPermissionOperation;
};
type BrowserDomActionWorkflowResult =
  | { kind: "not-handled" }
  | { kind: "blocked"; response: HarnessPermissionBlockedResponse }
  | { kind: "handled"; response: { workflow: "browser-action"; assistantText: string; actionResult?: BrowserDomActionResult } };
type PendingImagePromptExtraction = {
  imageUrl: string;
  alt?: string;
  pageTitle?: string;
  pageUrl?: string;
  imageCandidate?: EditablePageImageCandidate;
  attachment?: UserFileAttachment;
  createdAt: number;
};
type PendingImageAttachment = {
  imageUrl: string;
  pageUrl?: string;
  attachment?: UserFileAttachment;
  createdAt: number;
};
type PendingContextMenuAction = "summarize-page" | "summarize-video";
type PendingContextMenuSelection = SelectedPageTextContext;
type PendingDictationShortcut = {
  requestId: string;
  createdAt: number;
};
let activeAiControlTab: ReadableBrowserTab | null = null;
const state = {
  selectedProfileId: "default",
  selectedModel: "",
  selectedReasoningEffort: "",
  selectedServiceTier: "",
  threadId: undefined as string | undefined,
  currentConversationId: undefined as string | undefined,
  currentDraftConversation: null as SavedConversation | null,
  browserWindowId: undefined as number | undefined,
  models: [] as CodexModelOption[],
  agentProviders: [] as UiInitPayload["agentProviders"],
  selectedProviderId: "codex",
  customProfiles: [] as ProfileTemplate[],
  deletedProfileIds: [] as string[],
  modelCatalogState: "loading" as UiInitPayload["modelCatalogState"],
  modelCatalogErrorMessage: "",
  appServerSkills: [] as CodexSkillOption[],
  connectedApps: [] as CodexAppOption[],
  appServerPlugins: [] as CodexPluginOption[],
  mcpServers: [] as CodexMcpServerOption[],
  serverThreads: [] as CodexThreadSummary[],
  rateLimits: null as CodexRateLimits | null,
  activeTurn: null as CodexActiveTurn | null,
  latestPlan: null as CodexTurnPlan | null,
  latestDiff: null as CodexTurnDiff | null,
  latestReroute: null as CodexModelReroute | null,
  accountStatus: null as UiInitPayload["accountStatus"] | null,
  workspaceHarness: null as WorkspaceHarnessSnapshot | null,
  playwrightRuntime: createFallbackPlaywrightRuntime(),
  imageAssetFolder: null as UiInitPayload["imageAssetFolder"] | null,
  diagnosticLogFolder: null as UiInitPayload["diagnosticLogFolder"] | null,
  catalogRefreshPromise: null as Promise<void> | null,
  lastRequestedCatalogWorkspaceRoot: null as string | null,
  initializationPromise: null as Promise<void> | null,
  initialized: false,
  lastAutoCompactThreadId: "" as string,
  lastAutoCompactBucket: null as number | null,
};

function sanitizeExtensionInfo(e: Record<string, unknown>, selfId: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    "id", "name", "shortName", "version", "versionName", "description",
    "enabled", "type", "installType", "mayDisable", "mayEnable",
    "disabledReason", "offlineEnabled", "homepageUrl", "updateUrl",
  ]) {
    if (e[key] !== undefined) out[key] = e[key];
  }
  if (Array.isArray(e.permissions)) out.permissions = e.permissions;
  if (Array.isArray(e.hostPermissions)) out.hostPermissions = e.hostPermissions;
  if (typeof e.id === "string" && e.id === selfId) out.self = true;
  return out;
}

/** chrome.userScripts.getScripts rows → bounded JSON-safe shape. js code
 *  can be large — truncate per-source at 64KiB so a registered script
 *  can't flood the tool result; matches/patterns pass through. */
function sanitizeUserScript(s: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of [
    "id", "matches", "excludeMatches", "includeGlobs", "excludeGlobs",
    "runAt", "world", "worldId", "allFrames",
  ]) {
    if (s[key] !== undefined) out[key] = s[key];
  }
  if (Array.isArray(s.js)) {
    out.js = s.js.slice(0, 20).map((src) => {
      const o = src as Record<string, unknown>;
      if (typeof o.code === "string") {
        return { code: o.code.length > 64 * 1024 ? `${o.code.slice(0, 64 * 1024)}…[truncated]` : o.code };
      }
      if (typeof o.file === "string") return { file: o.file.slice(0, 1024) };
      return {};
    });
  }
  return out;
}

function trackBridgeEventRuntime(event: unknown): string | null {
  const bridgeEvent = event as { type?: string };
  let eventConversationId: string | null = resolveBridgeEventConversationId(event, conversationRuntime);
  if (bridgeEvent.type === "turn.started") {
    const activeTurn = (event as { activeTurn: CodexActiveTurn }).activeTurn;
    if (eventConversationId) {
      conversationRuntime.setActiveTurn(eventConversationId, activeTurn);
      syncCurrentRuntimeState(eventConversationId);
    } else {
      state.activeTurn = activeTurn;
    }
  } else if (bridgeEvent.type === "turn.completed") {
    const completed = event as { threadId: string; turnId: string };
    eventConversationId = conversationRuntime.completeTurn(completed.threadId, completed.turnId) ?? eventConversationId;
    if (eventConversationId) {
      syncCurrentRuntimeState(eventConversationId);
    } else if (state.activeTurn?.turnId === completed.turnId) {
      state.activeTurn = null;
    }
  } else if (bridgeEvent.type === "turn.failed") {
    const failed = event as { threadId: string; turnId: string };
    eventConversationId = conversationRuntime.completeTurn(failed.threadId, failed.turnId) ?? eventConversationId;
    if (eventConversationId) {
      syncCurrentRuntimeState(eventConversationId);
    } else if (state.activeTurn?.turnId === failed.turnId) {
      state.activeTurn = null;
    }
  } else if (bridgeEvent.type === "turn.plan.updated") {
    const plan = (event as { plan: CodexTurnPlan }).plan;
    state.latestPlan = plan;
  } else if (bridgeEvent.type === "turn.diff.updated") {
    const diff = (event as { diff: CodexTurnDiff }).diff;
    state.latestDiff = diff;
  } else if (bridgeEvent.type === "account.rate_limits.updated") {
    state.rateLimits = (event as { rateLimits: CodexRateLimits | null }).rateLimits;
  } else if (bridgeEvent.type === "model.rerouted") {
    state.latestReroute = (event as { reroute: CodexModelReroute }).reroute;
  } else if (bridgeEvent.type === "catalog.updated") {
    const kind = (bridgeEvent as { kind?: string }).kind;
    if (kind === "skills" || kind === "apps" || kind === "mcp") {
      void refreshCatalogKind(kind);
    } else {
      void triggerCatalogRefresh(state.workspaceHarness?.workspaceRoot || undefined);
    }
  }
  return eventConversationId;
}

bridge.subscribe((event) => {
  const eventConversationId = trackBridgeEventRuntime(event);
  broadcastBridgeEvent(annotateBridgeEventConversation(event, eventConversationId));
});

const CONTEXT_MENU_ITEMS: chrome.contextMenus.CreateProperties[] = [
  {
    id: "ask-codex-page",
    title: getContextMenuMessage("contextAskPage", "Ask Chromex about this page"),
    contexts: ["page"],
  },
  {
    id: "ask-codex-selection",
    title: getContextMenuMessage("contextAskSelection", "Ask AI about selection"),
    contexts: ["selection"],
  },
  {
    id: "edit-codex-image",
    title: getContextMenuMessage("contextEditImage", "Edit this image with Chromex"),
    contexts: ["image"],
  },
  {
    id: "summarize-codex-youtube",
    title: getContextMenuMessage("contextSummarizeYoutube", "Summarize this YouTube video"),
    contexts: ["page"],
    documentUrlPatterns: ["*://*.youtube.com/*", "*://youtu.be/*"],
  },
];

function getContextMenuMessage(key: string, fallback: string): string {
  return chrome.i18n.getMessage(key) || fallback;
}

function consumeContextMenuRuntimeError(action: string): void {
  const message = chrome.runtime.lastError?.message;
  if (message) {
    console.warn(`Chromex context menu ${action} failed: ${message}`);
  }
}

function safeCreateContextMenu(properties: chrome.contextMenus.CreateProperties): void {
  const id = typeof properties.id === "string" ? properties.id : "";
  const createMenuItem = () => {
    chrome.contextMenus.create(properties, () => {
      consumeContextMenuRuntimeError(`create ${properties.id ?? ""}`.trim());
    });
  };
  if (!id) {
    createMenuItem();
    return;
  }
  chrome.contextMenus.remove(id, () => {
    // Removing an absent item is the normal first-install path — only
    // surface real failures, not "Cannot find menu item".
    const message = chrome.runtime.lastError?.message;
    if (message && !/cannot find menu item/i.test(message)) {
      consumeContextMenuRuntimeError(`remove ${id}`);
    }
    createMenuItem();
  });
}

function registerContextMenus(): void {
  chrome.contextMenus.removeAll(() => {
    consumeContextMenuRuntimeError("reset");
    for (const item of CONTEXT_MENU_ITEMS) {
      safeCreateContextMenu(item);
    }
  });
}

chrome.runtime.onInstalled.addListener(() => {
  registerContextMenus();
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

// chromex-w2h: prewarm the provider/model catalog at service-worker start
// so the first ui.init doesn't pay catalog latency. The gateway serves
// its persisted snapshot instantly (agents/catalog-cache.ts); a
// workspace-scoped refresh still runs from ensureStateLoaded when the
// root differs, and catalog.updated keeps it fresh afterwards.
void triggerCatalogRefresh();

// A previous SW incarnation may have left chrome.debugger attachments
// behind (route interception / emulation holds are module state and die
// with the worker while the debugger session persists). Sweep them so
// no orphaned Fetch.enable can pause requests with no handler.
void detachOrphanedDebuggerTargets().catch(() => undefined);

chrome.commands.onCommand.addListener((command) => {
  void handleCommand(command);
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab.windowId) {
    return;
  }
  state.browserWindowId = tab.windowId;
  await chrome.sidePanel.open({ windowId: tab.windowId });
  void broadcastActiveTabSnapshot();
});


function recordDomSnapshotMeta(tabId: number, snapshot: BrowserDomSnapshot): void {
  const registry = toolHostSnapshotRegistry();
  if (
    snapshot.snapshotId &&
    snapshot.structuralFingerprint &&
    snapshot.stateFingerprint &&
    typeof snapshot.saltEpoch === "number"
  ) {
    const prior = registry.latestForTab(tabId);
    if (prior && prior.structuralFingerprint !== snapshot.structuralFingerprint) {
      registry.invalidateTab(tabId);
    }
    registry.put({
      snapshotId: snapshot.snapshotId,
      tabId,
      structuralFingerprint: snapshot.structuralFingerprint,
      stateFingerprint: snapshot.stateFingerprint,
      saltEpoch: snapshot.saltEpoch,
      ...(typeof snapshot.metadata?.url === "string"
        ? {
            urlOriginPath: (() => {
              const u = new URL(snapshot.metadata.url as string);
              return `${u.origin}${u.pathname}`;
            })(),
          }
        : {}),
      capturedAt: Date.now(),
    });
  }
}

function isStaleSnapshotPlan(tabId: number, plan: BrowserDomActionPlan): boolean {
  if (!plan.snapshotId) return false;
  const meta = toolHostSnapshotRegistry().get(plan.snapshotId);
  return !meta || meta.tabId !== tabId;
}

chrome.tabs.onActivated.addListener((activeInfo) => {
  state.browserWindowId = activeInfo.windowId;
  void broadcastActiveTabSnapshot();
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    toolHostSnapshotRegistry().invalidateTab(tabId);
  }
  if (!tab.active) {
    return;
  }
  if (typeof state.browserWindowId === "number" && tab.windowId !== state.browserWindowId) {
    return;
  }
  if (!changeInfo.title && !changeInfo.url && !changeInfo.favIconUrl && changeInfo.status !== "complete") {
    return;
  }

  state.browserWindowId = tab.windowId;
  void broadcastActiveTabSnapshot();
});

// Ring buffer of recent tab creations — the tool host polls it after
// click/submit dispatch to report popups the action opened (target=
// _blank / window.open) so the gateway can acquire them into the
// task's tab scope. openerTabId is often absent (noopener implied).
const RECENT_TAB_CREATIONS_MAX = 100;
const recentTabCreations: Array<{
  tabId: number;
  openerTabId?: number;
  url?: string;
  title?: string;
  at: number;
}> = [];

chrome.tabs.onCreated.addListener((tab) => {
  if (typeof tab.id !== "number") return;
  recentTabCreations.push({
    tabId: tab.id,
    ...(typeof tab.openerTabId === "number" ? { openerTabId: tab.openerTabId } : {}),
    ...(tab.url ? { url: tab.url } : {}),
    ...(tab.title ? { title: tab.title } : {}),
    at: Date.now(),
  });
  if (recentTabCreations.length > RECENT_TAB_CREATIONS_MAX) {
    recentTabCreations.splice(0, recentTabCreations.length - RECENT_TAB_CREATIONS_MAX);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  toolHostSnapshotRegistry().invalidateTab(tabId);
  resetNetworkTab(tabId);
  // Persisted route rules + emulation state are keyed by tabId — drop
  // them so a reused tab id can never inherit another tab's mocks or
  // viewport overrides.
  void chrome.storage.session.remove(`chromex.routeRules.${tabId}`).catch(() => {});
  void chrome.storage.session.remove(`chromex.emulation.${tabId}`).catch(() => {});
  void disposeBrowserToolTabState(tabId);
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (typeof tab?.windowId === "number") {
    state.browserWindowId = tab.windowId;
  }

  const sidePanelOpenPromise = openSidePanelForContextMenu(tab).catch((error) => {
    console.warn("Failed to open the Chromex side panel from a context menu action.", error);
  });

  if (info.menuItemId === "ask-codex-selection") {
    const selectionContext = await createPendingSelectionContextWithPageSnapshot(info, tab);
    if (selectionContext) {
      await chrome.storage.session.set({
        pendingSelectionContext: selectionContext,
      });
      await chrome.storage.session.remove(["pendingAction", "pendingImageAttachment"]);
    }
    await sidePanelOpenPromise;
    void broadcastActiveTabSnapshot();
    void chrome.runtime.sendMessage({ type: "ui.context-menu-action.pending" }).catch(() => undefined);
    return;
  }

  if (info.menuItemId === "edit-codex-image" && info.srcUrl) {
    await chrome.storage.session.set({
      pendingImageAttachment: {
        imageUrl: info.srcUrl,
        ...(info.pageUrl || tab?.url ? { pageUrl: info.pageUrl ?? tab?.url } : {}),
        createdAt: Date.now(),
      },
    });
    await chrome.storage.session.remove(["pendingAction", "pendingSelectionContext"]);
    await sidePanelOpenPromise;
    void broadcastActiveTabSnapshot();
    void chrome.runtime.sendMessage({ type: "ui.image-attachment.pending" }).catch(() => undefined);
    return;
  }

  const pendingAction = resolvePendingContextMenuAction(info.menuItemId);
  if (!pendingAction) {
    await sidePanelOpenPromise;
    void broadcastActiveTabSnapshot();
    return;
  }

  await chrome.storage.session.set({
    pendingAction: pendingAction,
  });
  await chrome.storage.session.remove(["pendingImageAttachment", "pendingSelectionContext"]);
  await sidePanelOpenPromise;
  void broadcastActiveTabSnapshot();
  void chrome.runtime.sendMessage({ type: "ui.context-menu-action.pending" }).catch(() => undefined);
});

async function openSidePanelForContextMenu(tab?: chrome.tabs.Tab): Promise<void> {
  const windowId = typeof tab?.windowId === "number" ? tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
  try {
    await chrome.sidePanel.open({ windowId });
    return;
  } catch (error) {
    if (typeof tab?.id === "number") {
      await chrome.sidePanel.open({ tabId: tab.id });
      return;
    }
    throw error;
  }
}

function resolvePendingContextMenuAction(menuItemId: unknown): PendingContextMenuAction | null {
  if (menuItemId === "summarize-codex-youtube") {
    return "summarize-video";
  }
  if (menuItemId === "ask-codex-page") {
    return "summarize-page";
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") {
    return false;
  }

  // Phase 5 security pass: classify sender + boundary-validate before any
  // handler runs. Content scripts get a narrow allowlist; anything that
  // isn't an extension page or a known content-script type is rejected.
  const guard = validateRuntimeMessage(message);
  const senderClass = classifyMessageSender(sender, chrome.runtime.id);
  if (
    !guard.ok ||
    senderClass === "untrusted" ||
    (senderClass === "content-script" && !contentScriptMaySend(guard.type))
  ) {
    sendResponse({ error: "message rejected" });
    return false;
  }

  if (message.type === "page.fingerprint.context") {
    void getFingerprintContext()
      .then(sendResponse)
      .catch(() => sendResponse({ error: "fingerprint context unavailable" }));
    return true;
  }

  if (message.type === "page.image-prompt.extract") {
    void handlePageImagePromptExtraction(message, sender.tab)
      .then(sendResponse)
      .catch((error) => {
        const expectedPermissionResponse = toExpectedPermissionErrorResponse(error);
        if (expectedPermissionResponse) {
          sendResponse(expectedPermissionResponse);
          return;
        }
        if (shouldLogBackgroundMessageError(error)) {
          console.error("background message handling failed", message?.type, error);
        }
        sendResponse({
          error: error instanceof Error ? error.message : "Unknown background failure",
        });
      });
    return true;
  }

  if (message.type === "ui.settings.snapshot") {
    void loadStoredUiSettingsSnapshot()
      .then(sendResponse)
      .catch((error) => {
        if (shouldLogBackgroundMessageError(error)) {
          console.error("background message handling failed", message?.type, error);
        }
        sendResponse({
          error: error instanceof Error ? error.message : "Unknown background failure",
        });
      });
    return true;
  }

  void (async () => {
    try {
      await ensureStateLoaded();

      switch (message.type) {
        case "ui.init":
          sendResponse(await buildUiInitPayload(message.windowId, { forceCatalog: Boolean(message.forceCatalog) }));
          return;
        case "ui.popout":
          sendResponse(await popOutChat());
          return;
        case "ui.dock":
          sendResponse(await dockChat(message.targetWindowId, message.popupWindowId));
          return;
        case "profile.list":
          sendResponse({ profiles: listAvailableProfiles(), selectedProfileId: state.selectedProfileId });
          return;
        case "profile.select":
          state.selectedProfileId = getAvailableProfileTemplate(String(message.profileId ?? "")).id;
          await setSelectedProfileId(state.selectedProfileId);
          sendResponse({ ok: true, selectedProfileId: state.selectedProfileId });
          return;
        case "profile.create": {
          const profile = createUserProfileTemplate({
            name: String(message.name ?? ""),
            systemPrompt: typeof message.systemPrompt === "string" ? message.systemPrompt : "",
            visual: typeof message.visual === "object" && message.visual ? message.visual as ProfileTemplate["visual"] : undefined,
            suggestedPrompts: Array.isArray(message.suggestedPrompts) ? message.suggestedPrompts.map(String) : [],
            existingIds: listAvailableProfiles().map((item) => item.id),
          });
          state.customProfiles = await saveCustomProfile(profile);
          state.selectedProfileId = profile.id;
          await setSelectedProfileId(profile.id);
          sendResponse({
            ok: true,
            profile,
            profiles: listAvailableProfiles(),
            selectedProfileId: state.selectedProfileId,
          });
          return;
        }
        case "profile.update": {
          const profileId = String(message.profileId ?? "");
          const current = getAvailableProfileTemplate(profileId);
          const profile = updateUserProfileTemplate(current, {
            name: String(message.name ?? current.name),
            systemPrompt: typeof message.systemPrompt === "string" ? message.systemPrompt : current.systemPrompt,
            visual: typeof message.visual === "object" && message.visual ? message.visual as ProfileTemplate["visual"] : current.visual,
            suggestedPrompts: Array.isArray(message.suggestedPrompts)
              ? message.suggestedPrompts.map(String)
              : (current.suggestedPrompts ?? []),
          });
          state.customProfiles = await saveCustomProfile(profile);
          state.selectedProfileId = profile.id;
          await setSelectedProfileId(profile.id);
          sendResponse({
            ok: true,
            profile,
            profiles: listAvailableProfiles(),
            selectedProfileId: state.selectedProfileId,
          });
          return;
        }
        case "profile.delete": {
          const profileId = String(message.profileId ?? "");
          if (profileId === "default") {
            sendResponse({ error: "The default profile cannot be deleted." });
            return;
          }
          const builtinIds = new Set(listProfileTemplates().map((profile) => profile.id));
          state.customProfiles = await deleteCustomProfile(profileId, { hideBuiltin: builtinIds.has(profileId) });
          state.deletedProfileIds = await listDeletedProfileIds();
          if (state.selectedProfileId === profileId) {
            state.selectedProfileId = normalizeSelectedProfileId("default");
            await setSelectedProfileId(state.selectedProfileId);
          }
          sendResponse({
            ok: true,
            profiles: listAvailableProfiles(),
            selectedProfileId: state.selectedProfileId,
          });
          return;
        }
        case "model.select":
          await persistSelectedModelControls({
            model: typeof message.model === "string" ? message.model : state.selectedModel,
            reasoningEffort: typeof message.reasoningEffort === "string" ? message.reasoningEffort : undefined,
            serviceTier: typeof message.serviceTier === "string" ? message.serviceTier : undefined,
          });
          sendResponse({
            ok: true,
            selectedModel: state.selectedModel,
            selectedReasoningEffort: state.selectedReasoningEffort,
            selectedServiceTier: state.selectedServiceTier,
          });
          return;
        case "gateway.tasks": {
          const rt = await getGatewayRuntime();
          // cold SW: don't report an empty list before hello seeds views
          if (rt) await Promise.race([rt.ready?.() ?? Promise.resolve(), sleepMs(10_000)]);
          sendResponse({
            enabled: Boolean(rt),
            state: rt?.state() ?? "disabled",
            tasks: rt?.tasks.listTasks() ?? [],
          });
          return;
        }
        case "settings.update":
          sendResponse(await handleSettingsUpdate(message.settings ?? {}));
          return;
        case "settings.reset": {
          const settings = await resetStoredSettings();
          state.selectedProfileId = normalizeSelectedProfileId("default");
          state.selectedModel = "";
          state.selectedReasoningEffort = "";
          state.selectedServiceTier = "";
          state.deletedProfileIds = await listDeletedProfileIds();
          await setSelectedProfileId(state.selectedProfileId);
          await setSelectedModel("");
          await setSelectedReasoningEffort("");
          await setSelectedServiceTier("");
          sendResponse({
            ok: true,
            settings,
            profiles: listAvailableProfiles(),
            selectedProfileId: state.selectedProfileId,
            selectedModel: state.selectedModel,
            selectedReasoningEffort: state.selectedReasoningEffort,
            selectedServiceTier: state.selectedServiceTier,
          });
          return;
        }
        case "conversation.new":
          sendResponse(await startNewConversation(message.profileId, message.model));
          return;
        case "conversation.resume":
          sendResponse(await resumeConversation(message.conversationId));
          return;
        case "conversation.resume.server":
          sendResponse(await resumeServerConversation(message.threadId));
          return;
        case "conversation.save":
          sendResponse(await persistConversation(message.conversation));
          return;
        case "conversation.delete":
          sendResponse(await handleConversationDelete(String(message.conversationId ?? "")));
          return;
        case "conversation.clear":
          sendResponse(await handleConversationClear());
          return;
        case "conversation.compact":
          sendResponse(await handleConversationCompact(Boolean(message.waitForCompletion)));
          return;
        case "skills.list":
          sendResponse({ skills: await listMergedSkills() });
          return;
        case "skills.archive.install":
          sendResponse(await handleSkillArchiveInstall(message.filename, message.base64));
          return;
        case "runtime.playwright.status":
          sendResponse({ playwrightRuntime: await refreshPlaywrightRuntime() });
          return;
        case "runtime.playwright.install":
          sendResponse({ playwrightRuntime: await installPlaywrightRuntime() });
          return;
        case "skill.save":
          sendResponse({
            skills: mergeSkillOptions(
              await saveSkill({
                id: message.skill.id || `custom-skill-${Date.now()}`,
                name: message.skill.name,
                prompt: message.skill.prompt,
                description: message.skill.description ?? "Saved prompt",
              }),
              await getWorkspaceHarness(),
            ),
          });
          return;
        case "skill.delete":
          sendResponse({
            skills: mergeSkillOptions(await deleteSkill(message.skillId), await getWorkspaceHarness()),
          });
          return;
        case "mcp.servers.list": {
          const mcpServers = await bridge.request<CodexMcpServerOption[]>("mcp.servers.list", {
            detail: message.detail === "full" ? "full" : "toolsAndAuthOnly",
            limit: Number.isFinite(message.limit) ? Number(message.limit) : 100,
          });
          state.mcpServers = mcpServers;
          sendResponse({ mcpServers });
          return;
        }
        case "mcp.oauth.login.start":
          sendResponse(
            await bridge.request("mcp.oauth.login.start", {
              name: String(message.name ?? ""),
              scopes: Array.isArray(message.scopes) ? message.scopes.map(String) : undefined,
              timeoutSecs: Number.isFinite(message.timeoutSecs) ? Number(message.timeoutSecs) : undefined,
            }),
          );
          return;
        case "mcp.servers.reload":
          sendResponse(await bridge.request("mcp.servers.reload"));
          void triggerCatalogRefresh(undefined, { force: true });
          return;
        case "app.install.open":
          sendResponse(await openAppInstallUrl(String(message.url ?? "")));
          return;
        case "account.login.start":
          sendResponse(await handleAccountLogin(message.loginType, message.apiKey, Boolean(message.confirmed)));
          return;
        case "account.logout":
          sendResponse(await bridge.request("account.logout"));
          return;
        case "context.tabs.list":
          sendResponse(await guardAndRun("context.tabs.read", Boolean(message.confirmed), () => listOpenTabsResult()));
          return;
        case "context.history.search":
          sendResponse(
            await guardAndRun("context.history.read", Boolean(message.confirmed), () => searchHistory(message.query)),
          );
          return;
        case "image.prompt.pending.take":
          sendResponse(await takePendingImagePromptExtraction());
          return;
        case "image.prompt.error.pending.take":
          sendResponse(await takePendingImagePromptError());
          return;
        case "image.attachment.pending.take":
          sendResponse(await takePendingImageAttachment());
          return;
        case "context.menu.selection.pending.take":
          sendResponse(await takePendingContextMenuSelection());
          return;
        case "context.menu.pending.take":
          sendResponse(await takePendingContextMenuAction());
          return;
        case "dictation.shortcut.pending.take":
          sendResponse(await takePendingDictationShortcut());
          return;
        case "prompt.send":
          sendResponse(await handlePromptSend(message.payload));
          return;
        case "prompt.route.preview":
          sendResponse(await handlePromptRoutePreview(message.payload));
          return;
        case "prompt.cancel":
          sendResponse(await handlePromptCancel(message.clientRequestId, message.threadId, message.turnId));
          return;
        case "turn.steer":
          sendResponse(await handleTurnSteer(message.payload));
          return;
        case "plan.user_input.respond":
          sendResponse(await bridge.request("plan.user_input.respond", message.payload ?? {}));
          return;
        case "permission.respond":
          // approval card answers — gateway resolves the approvals row /
          // provider session and emits permission.resolved durably.
          sendResponse(await bridge.request("permission.respond", message.payload ?? {}));
          return;
        case "turn.interrupt":
          sendResponse(await handleTurnInterrupt(message.threadId, message.turnId));
          return;
        case "image.edit.start":
          sendResponse(await handleImageEdit(message.prompt, Boolean(message.confirmed)));
          return;
        case "image.infographic.start":
          sendResponse(
            await handleInfographicGenerate(
              Boolean(message.confirmed),
              message.conversationContext,
              message.clientRequestId,
              message.conversationId,
            ),
          );
          return;
        case "image.slides.start":
          sendResponse(
            await handleSlideDeckImageGenerate(
              typeof message.prompt === "string" ? message.prompt : "",
              Boolean(message.confirmed),
              message.conversationContext,
              message.clientRequestId,
              message.conversationId,
            ),
          );
          return;
        case "image.edit.preview":
          sendResponse(await bridge.request("image.edit.preview", { jobId: message.jobId }));
          return;
        case "image.asset.read":
          sendResponse(
            await bridge.request("image.asset.read", {
              previewRef: message.previewRef,
              offset: message.offset,
              length: message.length,
            }),
          );
          return;
        case "image.asset.delete":
          sendResponse(await bridge.request("image.asset.delete", { previewRef: message.previewRef }));
          return;
        case "image.asset.folder":
          sendResponse(await bridge.request("image.asset.folder"));
          return;
        case "image.asset.folder.open":
          sendResponse(await bridge.request("image.asset.folder.open", { folder: message.folder }));
          return;
        case "local.file.reveal":
          sendResponse(await bridge.request("local.file.reveal", { path: message.path }));
          return;
        case "diagnostics.log.folder":
          sendResponse(await bridge.request("diagnostics.log.folder"));
          return;
        case "diagnostics.log.folder.open":
          sendResponse(await bridge.request("diagnostics.log.folder.open", { folder: message.folder }));
          return;
        case "diagnostics.log.write":
          sendResponse(await bridge.request("diagnostics.log.write", { event: message.event, details: message.details ?? {} }));
          return;
        case "voice.session.start":
          sendResponse(
            await guardAndRun("voice.session.start", Boolean(message.confirmed), async () => {
              return bridge.request<{ threadId?: string }>(
                "voice.session.start",
                await buildVoiceSessionStartParamsWithContext(message),
              );
            }),
          );
          return;
        case "dictation.transcription.start":
          sendResponse(
            await bridge.request<{ threadId?: string }>(
              "dictation.transcription.start",
              buildVoiceSessionStartParams(message, undefined),
            ),
          );
          return;
        case "voice.session.stop":
          sendResponse(
            await bridge.request("voice.session.stop", buildVoiceSessionStopParams(message, state.threadId)),
          );
          return;
        case "dictation.transcription.stop":
          sendResponse(
            await bridge.request("dictation.transcription.stop", buildVoiceSessionStopParams(message, undefined)),
          );
          return;
        case "translation.api_key.save":
          assertApiKeyLoginExplicitlyConfirmed({
            loginType: "apiKey",
            apiKey: message.apiKey,
            confirmed: message.confirmed,
          });
          sendResponse(
            await bridge.request("translation.api_key.save", {
              apiKey: typeof message.apiKey === "string" ? message.apiKey : "",
            }),
          );
          return;
        case "translation.api_key.clear":
          sendResponse(await bridge.request("translation.api_key.clear"));
          if (state.accountStatus) {
            state.accountStatus = {
              ...state.accountStatus,
              openAiApiKeyConfigured: false,
            };
          }
          return;
        case "translation.client_secret.create":
          sendResponse(
            await bridge.request("translation.client_secret.create", {
              targetLanguage: typeof message.targetLanguage === "string" ? message.targetLanguage : undefined,
              ttlSeconds: typeof message.ttlSeconds === "number" ? message.ttlSeconds : undefined,
            }),
          );
          return;
        case "voice.context.snapshot":
          sendResponse({ prompt: await collectVoiceSessionContextPrompt() });
          return;
        case "voice.session.append_text":
          sendResponse(
            await bridge.request("voice.session.append_text", {
              threadId: typeof message.threadId === "string" ? message.threadId : undefined,
              text: typeof message.text === "string" ? message.text : "",
            }),
          );
          return;
        case "voice.session.append_audio":
          sendResponse(
            await bridge.request("voice.session.append_audio", {
              threadId: typeof message.threadId === "string" ? message.threadId : undefined,
              audio: message.audio,
            }),
          );
          return;
        case "dictation.transcription.append_audio":
          sendResponse(
            await bridge.request("dictation.transcription.append_audio", {
              threadId: typeof message.threadId === "string" ? message.threadId : undefined,
              audio: message.audio,
            }),
          );
          return;
        case "voice.microphone.permission.result":
          sendResponse({ ok: true });
          return;
        case "youtube.current-moment.prompt":
          sendResponse(await handleYouTubeCurrentMomentPrompt());
          return;
        case "youtube.seek":
          sendResponse(
            await guardAndRun("page.navigate", Boolean(message.confirmed), async () => {
              await sendMessageToActiveTab({ type: "youtube.seek", seconds: message.seconds });
              return { ok: true };
            }),
          );
          return;
        case "page.apply-image-overlay":
          sendResponse(
            await guardAndRun("page.image.overlay", Boolean(message.confirmed), async () => {
              await sendMessageToActiveTab({ type: "page.apply-image-overlay", previewRef: message.previewRef });
              return { ok: true };
            }),
          );
          return;
        case "page.clear-image-overlay":
          await sendMessageToActiveTab({ type: "page.clear-image-overlay" });
          sendResponse({ ok: true });
          return;
        case "page.image-prompt-hover.install":
          sendResponse(await installImagePromptHoverForTab(await getActiveTab().catch(() => null)));
          return;
        case "page.image-attachment.add":
          sendResponse(await handlePageImageAttachmentAdd(message, sender.tab));
          return;
        case "page.image-prompt.extract":
          sendResponse(await handlePageImagePromptExtraction(message, sender.tab));
          return;
        case "page.navigate":
          sendResponse(
            await guardAndRun("page.navigate", Boolean(message.confirmed), () =>
              sendMessageToActiveTab({ type: "page.navigate", command: message.command }),
            ),
          );
          return;
        case "page.dom.perform":
          sendResponse(
            await guardAndRun("page.dom.perform", Boolean(message.confirmed), () =>
              sendPageDomPerformWithIndicator(message.steps),
            ),
          );
          return;
        case "page.dictation.insert":
          sendResponse(
            await guardAndRun("page.dom.perform", Boolean(message.confirmed), () =>
              sendMessageToActiveTab({ type: "page.dictation.insert", text: String(message.text ?? "") }),
            ),
          );
          return;
        case "ui.page-selection.changed":
          sendResponse({ ok: true });
          return;
        default:
          sendResponse({ error: `Unknown message type: ${message.type as string}` });
      }
    } catch (error) {
      const expectedPermissionResponse = toExpectedPermissionErrorResponse(error);
      if (expectedPermissionResponse) {
        sendResponse(expectedPermissionResponse);
        return;
      }
      if (shouldLogBackgroundMessageError(error)) {
        console.error("background message handling failed", message?.type, error);
      }
      sendResponse({
        error: error instanceof Error ? error.message : "Unknown background failure",
      });
    }
  })();

  return true;
});

async function handleCommand(command: string): Promise<void> {
  const activeTab = await getActiveTab().catch(() => null);
  if (activeTab?.windowId) {
    state.browserWindowId = activeTab.windowId;
  }

  if (command === "open-side-panel" && activeTab?.windowId) {
    await chrome.sidePanel.open({ windowId: activeTab.windowId });
    return;
  }

  if (command === "open-popup-chat") {
    await popOutChat();
    return;
  }

  if (command === "start-dictation") {
    await startDictationFromCommand(activeTab);
  }
}

async function startDictationFromCommand(activeTab: chrome.tabs.Tab | null): Promise<void> {
  const request = createPendingDictationShortcut();
  let sidePanelOpenPromise: Promise<void> = Promise.resolve();
  if (activeTab?.windowId) {
    state.browserWindowId = activeTab.windowId;
    sidePanelOpenPromise = chrome.sidePanel.open({ windowId: activeTab.windowId }).catch(() => undefined);
  }

  await chrome.storage.session.set({ pendingDictationShortcut: request });
  await sidePanelOpenPromise;
  void chrome.runtime
    .sendMessage({
      type: "ui.dictation.shortcut",
      requestId: request.requestId,
    })
    .catch(() => undefined);
}

function createPendingDictationShortcut(): PendingDictationShortcut {
  return {
    requestId: `dictation-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    createdAt: Date.now(),
  };
}

function listAvailableProfiles(): ProfileTemplate[] {
  const deleted = new Set(state.deletedProfileIds);
  const overrides = new Map(state.customProfiles.map((profile) => [profile.id, profile]));
  const builtinIds = new Set(listProfileTemplates().map((profile) => profile.id));
  const builtins = listProfileTemplates()
    .filter((profile) => !deleted.has(profile.id))
    .map((profile) => overrides.get(profile.id) ?? profile);
  const customOnly = state.customProfiles
    .filter((profile) => !builtinIds.has(profile.id) && !deleted.has(profile.id))
    .sort((left, right) => left.name.localeCompare(right.name));
  return [...builtins, ...customOnly];
}

function getAvailableProfileTemplate(profileId: string): ProfileTemplate {
  const profile = listAvailableProfiles().find((item) => item.id === profileId);
  if (!profile) {
    throw new Error(`Unknown profile template: ${profileId}`);
  }
  return profile;
}

function normalizeSelectedProfileId(profileId: string | null | undefined): string {
  const availableProfiles = listAvailableProfiles();
  const requested = profileId?.trim();
  if (requested && availableProfiles.some((profile) => profile.id === requested)) {
    return requested;
  }
  return availableProfiles.some((profile) => profile.id === "default")
    ? "default"
    : (availableProfiles[0]?.id ?? "default");
}

async function loadStoredUiSettingsSnapshot(): Promise<UiSettingsSnapshotPayload> {
  const [
    settings,
    customProfiles,
    deletedProfileIds,
    selectedProfileId,
    selectedModel,
    selectedReasoningEffort,
    selectedServiceTier,
  ] = await Promise.all([
    getStoredSettings(),
    listCustomProfiles(),
    listDeletedProfileIds(),
    getSelectedProfileId(),
    getSelectedModel(),
    getSelectedReasoningEffort(),
    getSelectedServiceTier(),
  ]);

  state.customProfiles = customProfiles;
  state.deletedProfileIds = deletedProfileIds;
  state.selectedProfileId = normalizeSelectedProfileId(selectedProfileId);
  state.selectedModel = selectedModel;
  state.selectedReasoningEffort = selectedReasoningEffort;
  state.selectedServiceTier = selectedServiceTier;

  return {
    settings,
    profiles: listAvailableProfiles(),
    selectedProfileId: state.selectedProfileId,
    selectedModel: state.selectedModel,
    selectedReasoningEffort: state.selectedReasoningEffort,
    selectedServiceTier: state.selectedServiceTier,
  };
}

async function ensurePromptConversationRuntime(payload: PromptRequestPayload) {
  const requestedConversationId = payload.conversationId?.trim();
  let conversationId = requestedConversationId || state.currentConversationId || "";
  if (!conversationId) {
    const conversation = await createConversation(payload.profileId, payload.model ?? state.selectedModel);
    conversationId = conversation.id;
    state.currentConversationId = conversation.id;
    state.currentDraftConversation = conversation;
    await setCurrentConversationId(conversation.id);
  }

  await seedConversationRuntime(conversationId);
  return conversationRuntime.get(conversationId);
}

async function seedConversationRuntime(conversationId: string): Promise<void> {
  const runtime = conversationRuntime.get(conversationId);
  if (runtime.threadId) {
    return;
  }
  const conversation = (await listConversations()).find((item) => item.id === conversationId);
  if (conversation?.threadId) {
    conversationRuntime.setThreadId(conversationId, conversation.threadId);
  }
}

async function gatewayActiveTurnForThread(threadId: string | null): Promise<CodexActiveTurn | null> {
  if (!threadId) return null;
  try {
    const rt = await getGatewayRuntime();
    if (!rt) return null;
    // Cold SW: task views are seeded by hello+syncAll — wait for them or
    // activeTurnId reads as missing and the panel thinks the turn ended.
    await Promise.race([rt.ready?.() ?? Promise.resolve(), sleepMs(10_000)]);
    const activeTurnId = rt.tasks.getTask(threadId)?.activeTurnId;
    return activeTurnId ? { threadId, turnId: activeTurnId } : null;
  } catch {
    return null;
  }
}

function syncCurrentRuntimeState(conversationId: string): void {
  if (state.currentConversationId !== conversationId) {
    return;
  }
  const runtime = conversationRuntime.get(conversationId);
  state.threadId = runtime.threadId;
  state.activeTurn = runtime.activeTurn;
  state.lastAutoCompactThreadId = runtime.lastAutoCompactThreadId;
  state.lastAutoCompactBucket = runtime.lastAutoCompactBucket;
}

function annotateBridgeEventConversation(event: unknown, conversationId: string | null): unknown {
  if (!conversationId || typeof event !== "object" || event === null) {
    return event;
  }
  return {
    ...event,
    conversationId,
  };
}

async function ensureStateLoaded(): Promise<void> {
  if (state.initialized) {
    return;
  }

  if (!state.initializationPromise) {
    state.initializationPromise = (async () => {
      await normalizeConversationRetention();
      const { settings } = await syncRuntimeConfigAndNormalizeSettings();
      const [customProfiles, deletedProfileIds] = await Promise.all([listCustomProfiles(), listDeletedProfileIds()]);
      state.customProfiles = customProfiles;
      state.deletedProfileIds = deletedProfileIds;
      state.selectedProfileId = normalizeSelectedProfileId(await getSelectedProfileId());
      state.selectedModel = await getSelectedModel();
      state.selectedReasoningEffort = await getSelectedReasoningEffort();
      state.selectedServiceTier = await getSelectedServiceTier();
      const workspaceHarness = await softTimeout(
        getWorkspaceHarness(),
        UI_BRIDGE_TIMEOUT_MS,
        state.workspaceHarness ?? createFallbackWorkspaceHarness(settings.workspaceRoot),
        "workspace.harness.read(startup)",
      );
      state.workspaceHarness = workspaceHarness;
      const currentConversation = await getCurrentConversation();
      if (currentConversation) {
        state.currentConversationId = currentConversation.id;
        conversationRuntime.setThreadId(currentConversation.id, currentConversation.threadId);
        syncCurrentRuntimeState(currentConversation.id);
      }

      state.initialized = true;
      void triggerCatalogRefresh(workspaceHarness.workspaceRoot || undefined);
    })().finally(() => {
      state.initializationPromise = null;
    });
  }

  await state.initializationPromise;
}

async function buildUiInitPayload(
  windowId?: number,
  options: { forceCatalog?: boolean } = {},
): Promise<UiInitPayload> {
  if (typeof windowId === "number") {
    state.browserWindowId = windowId;
  }

  const { settings, runtimeConfig } = await syncRuntimeConfigAndNormalizeSettings();

  const [accountStatus, conversations, workspaceHarness, playwrightRuntime, imageAssetFolder, diagnosticLogFolder] = await Promise.all([
    softTimeout(
      bridge.request<UiInitPayload["accountStatus"]>("account.status"),
      UI_BRIDGE_TIMEOUT_MS,
      state.accountStatus ?? createFallbackAccountStatus(),
      "account.status",
    ),
    listConversations(),
    softTimeout(
      getWorkspaceHarness(),
      UI_BRIDGE_TIMEOUT_MS,
      state.workspaceHarness ?? createFallbackWorkspaceHarness(settings.workspaceRoot),
      "workspace.harness.read",
    ),
    softTimeout(
      bridge.request<UiInitPayload["playwrightRuntime"]>("runtime.playwright.status"),
      UI_BRIDGE_TIMEOUT_MS,
      state.playwrightRuntime,
      "runtime.playwright.status",
    ),
    softTimeout(
      bridge.request<UiInitPayload["imageAssetFolder"]>("image.asset.folder"),
      UI_BRIDGE_TIMEOUT_MS,
      state.imageAssetFolder ?? createFallbackImageAssetFolder(),
      "image.asset.folder",
    ),
    softTimeout(
      bridge.request<UiInitPayload["diagnosticLogFolder"]>("diagnostics.log.folder"),
      UI_BRIDGE_TIMEOUT_MS,
      state.diagnosticLogFolder ?? createFallbackDiagnosticLogFolder(),
      "diagnostics.log.folder",
    ),
  ]);
  state.accountStatus = accountStatus;
  state.workspaceHarness = workspaceHarness;
  state.playwrightRuntime = playwrightRuntime;
  state.imageAssetFolder = imageAssetFolder;
  state.diagnosticLogFolder = diagnosticLogFolder;

  void triggerCatalogRefresh(workspaceHarness.workspaceRoot || undefined, {
    force: Boolean(options.forceCatalog),
  });

  const activeTab = await getActiveTab().catch(() => null);
  const currentPageSupport = getCurrentPageSupport(activeTab?.url);

  const [customProfiles, deletedProfileIds, currentContext] = await Promise.all([
    listCustomProfiles(),
    listDeletedProfileIds(),
    currentPageSupport.available
      ? softTimeout(collectCurrentPageContext("auto"), UI_CONTEXT_TIMEOUT_MS, null, "context.collect")
      : Promise.resolve(null),
  ]);
  const currentConversation = resolveVisibleCurrentConversation({
    conversations,
    currentConversationId: state.currentConversationId,
    draftConversation: state.currentDraftConversation,
  });

  state.customProfiles = customProfiles;
  state.deletedProfileIds = deletedProfileIds;
  state.selectedProfileId = normalizeSelectedProfileId(state.selectedProfileId);
  if (currentConversation) {
    state.currentConversationId = currentConversation.id;
    conversationRuntime.setThreadId(currentConversation.id, currentConversation.threadId);
    syncCurrentRuntimeState(currentConversation.id);
  }

  const uiLocale = resolveSettingsUiLocale(settings);
  const activeTabActionCards = activeTab ? inferActionCardsForOpenTab(tabToOpenTabContext(activeTab), uiLocale) : [];

  return {
    accountStatus,
    currentPageSupport,
    currentTab: activeTab ? tabToOpenTabContext(activeTab) : null,
    models: state.models,
    agentProviders: state.agentProviders,
    selectedProviderId: state.selectedProviderId,
    profiles: listAvailableProfiles(),
    selectedProfileId: state.selectedProfileId,
    selectedModel: state.selectedModel,
    selectedReasoningEffort: state.selectedReasoningEffort,
    selectedServiceTier: state.selectedServiceTier,
    modelCatalogState: state.modelCatalogState,
    modelCatalogErrorMessage: state.modelCatalogErrorMessage,
    currentContext: currentContext
      ? {
          envelope: currentContext.envelope,
          readStrategy: currentContext.readStrategy,
        }
      : null,
    actionCards: currentContext?.actionCards?.length ? currentContext.actionCards : activeTabActionCards,
    settings,
    runtimeConfig,
    playwrightRuntime,
    browserBackends: [
      {
        id: "chrome-extension",
        available: true,
        capabilities: DEFAULT_BACKEND_CAPABILITIES["chrome-extension"],
      },
      {
        id: "playwright-isolated",
        available: playwrightRuntime.available && settings.playwrightBrowserControlEnabled,
        capabilities: DEFAULT_BACKEND_CAPABILITIES["playwright-isolated"],
      },
    ],
    skills: [],
    appServerSkills: state.appServerSkills,
    connectedApps: state.connectedApps,
    appServerPlugins: state.appServerPlugins,
    mcpServers: state.mcpServers,
    recentChats: conversations.map(toConversationSummary),
    serverThreads: state.serverThreads,
    currentConversation,
    rateLimits: state.rateLimits,
    // Gateway mode: after an SW restart the in-memory runtime lost
    // activeTurn, but the gateway still reports it via hello/task view.
    activeTurn:
      state.activeTurn ??
      (await gatewayActiveTurnForThread(currentConversation?.threadId ?? null)),
    latestPlan: state.latestPlan,
    latestDiff: state.latestDiff,
    latestReroute: state.latestReroute,
    workspaceHarness,
    imageAssetFolder,
    diagnosticLogFolder,
  };
}

async function handleAccountLogin(
  loginType: "chatgpt" | "apiKey",
  apiKey?: string,
  confirmed = false,
): Promise<unknown> {
  if (loginType === "apiKey") {
    assertApiKeyLoginExplicitlyConfirmed({ loginType, apiKey, confirmed });
    return bridge.request("account.login.start", {
      type: "apiKey",
      ...(apiKey ? { apiKey } : {}),
    });
  }

  const result = await bridge.request<{ authUrl?: string }>("account.login.start", {
    type: "chatgpt",
  });
  if (result.authUrl) {
    await chrome.tabs.create({ url: result.authUrl });
  }
  return result;
}

async function openAppInstallUrl(url: string): Promise<{ ok: true }> {
  const parsed = parseExternalInstallUrl(url);
  if (!parsed) {
    throw new Error(getUiStrings(await getActiveUiLocale()).errors.invalidAppConnectionUrl);
  }
  await chrome.tabs.create({ url: parsed.toString() });
  return { ok: true };
}

function parseExternalInstallUrl(value: string): URL | null {
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed : null;
  } catch {
    return null;
  }
}

async function handlePromptRoutePreview(payload: PromptRequestPayload): Promise<{ plan: AgenticRoutePlan }> {
  const settings = await getStoredSettings();
  const activeTab = await getActiveTab().catch(() => null);
  const routeInput = createAgenticRouteInput(payload, activeTab, settings);
  return {
    plan: await planAgenticRouteForPayload(payload, routeInput),
  };
}

async function handlePromptSend(payload: PromptRequestPayload) {
  const runtime = await ensurePromptConversationRuntime(payload);
  const conversationId = runtime.conversationId;
  payload.conversationId = conversationId;
  void recordDiagnostic("extension.prompt.send", {
    clientRequestId: payload.clientRequestId ?? null,
    conversationId,
    messageLength: payload.message.length,
    attachments: payload.attachments,
    fileAttachmentCount: payload.fileAttachments?.length ?? 0,
  });
  emitPromptStatus(payload, "routing");
  const promptGate = await ensureOperationAllowed(
    "prompt.send",
    payload.confirmedOperations?.includes("prompt.send") ?? false,
  );
  if (!promptGate.ok) {
    return promptGate.response;
  }
  const cancellationAfterGate = await getPromptCancellationResponse(payload);
  if (cancellationAfterGate) {
    return cancellationAfterGate;
  }

  const settings = await getStoredSettings();
  const prepared = await buildPromptRequest(payload, settings, (phase, workflow) => emitPromptStatus(payload, phase, workflow));
  if (!prepared.ok) {
    return prepared.response;
  }
  const cancellationAfterBuild = await getPromptCancellationResponse(payload);
  if (cancellationAfterBuild) {
    return cancellationAfterBuild;
  }
  const routeIntent = prepared.agenticRoutePlan.intent;
  const planClarificationQuestion =
    payload.planMode && routeIntent?.needsClarification
      ? routeIntent.clarificationQuestion?.trim()
      : "";
  if (planClarificationQuestion) {
    void recordDiagnostic("extension.plan_mode.local_clarification", {
      clientRequestId: payload.clientRequestId ?? null,
      conversationId,
      question: planClarificationQuestion,
      summary: routeIntent?.summary,
    });
    return {
      planClarification: {
        question: planClarificationQuestion,
        summary: routeIntent?.summary,
      },
      actionCards: prepared.actionCards,
      settings,
      currentConversationId: conversationId,
    };
  }

  if (payload.resetThread) {
    conversationRuntime.resetConversation(conversationId);
    syncCurrentRuntimeState(conversationId);
  }

  const imageWorkflow = await maybeHandleAgenticImageWorkflow(
    payload,
    prepared.agenticRoutePlan,
    (phase, workflow) => emitPromptStatus(payload, phase, workflow),
  );
  if (imageWorkflow.kind === "blocked") {
    return imageWorkflow.response;
  }
  if (imageWorkflow.kind === "handled") {
    return {
      ...imageWorkflow.response,
      actionCards: prepared.actionCards,
      settings,
      currentConversationId: conversationId,
    };
  }
  const imageGenerationWorkflow = await maybeHandleAgenticImageGenerationWorkflow(
    payload,
    prepared.agenticRoutePlan,
    prepared.contexts,
    prepared.fileAttachments,
    (phase, workflow) => emitPromptStatus(payload, phase, workflow),
  );
  if (imageGenerationWorkflow.kind === "blocked") {
    return imageGenerationWorkflow.response;
  }
  if (imageGenerationWorkflow.kind === "handled") {
    return {
      ...imageGenerationWorkflow.response,
      actionCards: prepared.actionCards,
      settings,
      currentConversationId: conversationId,
    };
  }
  const cancellationAfterImageWorkflow = await getPromptCancellationResponse(payload);
  if (cancellationAfterImageWorkflow) {
    return cancellationAfterImageWorkflow;
  }
  const browserActionWorkflow = await maybeHandleBrowserDomActionWorkflow(
    payload,
    prepared.agenticRoutePlan,
    (phase, workflow) => emitPromptStatus(payload, phase, workflow),
  );
  if (browserActionWorkflow.kind === "blocked") {
    return browserActionWorkflow.response;
  }
  if (browserActionWorkflow.kind === "handled") {
    return {
      ...browserActionWorkflow.response,
      actionCards: prepared.actionCards,
      settings,
      currentConversationId: conversationId,
    };
  }
  const deferredBrowserActionGate = await maybeEnsureDeferredBrowserDomActionAllowed(payload, prepared.agenticRoutePlan);
  if (deferredBrowserActionGate.kind === "blocked") {
    return deferredBrowserActionGate.response;
  }
  const cancellationAfterBrowserWorkflow = await getPromptCancellationResponse(payload);
  if (cancellationAfterBrowserWorkflow) {
    return cancellationAfterBrowserWorkflow;
  }

  await maybeAutoCompactBeforePrompt(payload, settings, conversationId);
  const cancellationAfterCompact = await getPromptCancellationResponse(payload);
  if (cancellationAfterCompact) {
    return cancellationAfterCompact;
  }

  emitPromptStatus(payload, "waiting-for-codex");
  const cwd = normalizeConfiguredPath(settings.workspaceRoot);
  let threadId = conversationRuntime.get(conversationId).threadId;
  if (!threadId) {
    const opened = await bridge.request<{ threadId: string }>("session.open", {
      ...(cwd ? { cwd } : {}),
      ...(prepared.selectedModel ? { model: prepared.selectedModel } : {}),
      providerId: settings.agentProviderId || "codex",
    });
    threadId = opened.threadId;
    conversationRuntime.setThreadId(conversationId, threadId);
    syncCurrentRuntimeState(conversationId);
  }
  const structuredInputs = mergeStructuredInputsWithEnabledCodexSkills(
    prepared.structuredInputs,
    state.appServerSkills,
    settings.enabledCodexSkillIds,
    createCodexSkillRuntimeAvailability(settings),
    state.connectedApps,
  );
  const activeTurnBeforePrompt = conversationRuntime.get(conversationId).activeTurn;
  const promptTurn = await requestPromptSendWithAssistantCapture({
    clientRequestId: payload.clientRequestId,
    profile: prepared.profile,
    message: payload.message,
    conversationContext: payload.conversationContext ?? payload.contextHint ?? "",
    contexts: prepared.contexts,
    fileAttachments: prepared.fileAttachments,
    routePlan: prepared.routePlan,
    structuredInputs,
    threadId,
    ...(payload.planMode ? { planMode: true } : {}),
    ...(cwd ? { cwd } : {}),
    ...(prepared.selectedModel ? { model: prepared.selectedModel } : {}),
    ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
    ...(payload.serviceTier ? { serviceTier: payload.serviceTier } : {}),
    ...(payload.useGoal ? { useGoal: true } : {}),
    ...(payload.goalObjective?.trim() ? { goalObjective: payload.goalObjective.trim() } : {}),
  });
  const result = promptTurn.result;
  const cancellationAfterPrompt = await getPromptCancellationResponse(payload);
  if (cancellationAfterPrompt) {
    return cancellationAfterPrompt;
  }
  conversationRuntime.setThreadId(conversationId, result.threadId);
  // A turn.started may already have been recorded while prompt.send was
  // in flight (gateway mode starts the turn before the RPC returns).
  // Only clear the slot when no NEW active turn arrived during this
  // prompt — otherwise a sidepanel reload would resurrect with
  // activeTurn=null and the composer queue would flush mid-turn.
  if (conversationRuntime.get(conversationId).activeTurn === activeTurnBeforePrompt) {
    conversationRuntime.setActiveTurn(conversationId, null);
  }
  syncCurrentRuntimeState(conversationId);

  const deferredBrowserActionWorkflow = await maybeHandleDeferredBrowserDomActionWorkflow(
    payload,
    prepared.agenticRoutePlan,
    promptTurn.assistantText,
    (phase, workflow) => emitPromptStatus(payload, phase, workflow),
  );
  if (deferredBrowserActionWorkflow.kind === "blocked") {
    return deferredBrowserActionWorkflow.response;
  }
  if (deferredBrowserActionWorkflow.kind === "handled") {
    return {
      ...result,
      ...deferredBrowserActionWorkflow.response,
      actionCards: prepared.actionCards,
      settings,
      currentConversationId: conversationId,
    };
  }

  return {
    ...result,
    assistantText: promptTurn.assistantText,
    actionCards: prepared.actionCards,
    settings,
    currentConversationId: conversationId,
  };
}

async function maybeAutoCompactBeforePrompt(
  payload: PromptRequestPayload,
  settings: ExtensionSettings,
  conversationId: string,
): Promise<void> {
  const runtime = conversationRuntime.get(conversationId);
  const decision = shouldAutoCompactConversation({
    enabled: settings.autoCompactConversations,
    messageCount: payload.conversationMessageCount ?? 0,
    lastCompactedThreadId: runtime.lastAutoCompactThreadId,
    turnActive: Boolean(runtime.activeTurn),
    ...(runtime.threadId ? { threadId: runtime.threadId } : {}),
    ...(runtime.lastAutoCompactBucket !== null ? { lastCompactedBucket: runtime.lastAutoCompactBucket } : {}),
  });
  if (!decision.shouldCompact || decision.bucket === null || !runtime.threadId) {
    return;
  }

  emitPromptStatus(payload, "compacting");
  try {
    await bridge.request("thread.compact.start", {
      threadId: runtime.threadId,
      waitForCompletion: true,
    });
  } catch (error) {
    if (!isRecoverableMissingCodexThreadError(error)) {
      throw error;
    }
    void recordDiagnostic("extension.auto_compact.stale_thread", {
      threadId: runtime.threadId,
      error: toErrorMessage(error),
    });
    conversationRuntime.resetConversation(conversationId);
    syncCurrentRuntimeState(conversationId);
    return;
  }
  runtime.lastAutoCompactThreadId = runtime.threadId;
  runtime.lastAutoCompactBucket = decision.bucket;
}

async function handleTurnSteer(payload: PromptRequestPayload) {
  const runtime = await ensurePromptConversationRuntime(payload);
  const conversationId = runtime.conversationId;
  payload.conversationId = conversationId;
  if (!runtime.threadId || !runtime.activeTurn?.turnId) {
    return {
      error: "No active turn to steer.",
      currentConversationId: conversationId,
    };
  }

  emitPromptStatus(payload, "routing");
  const promptGate = await ensureOperationAllowed(
    "prompt.send",
    payload.confirmedOperations?.includes("prompt.send") ?? false,
  );
  if (!promptGate.ok) {
    return promptGate.response;
  }
  const cancellationAfterGate = await getPromptCancellationResponse(payload);
  if (cancellationAfterGate) {
    return cancellationAfterGate;
  }

  const settings = await getStoredSettings();
  const prepared = await buildPromptRequest(payload, settings, (phase, workflow) => emitPromptStatus(payload, phase, workflow));
  if (!prepared.ok) {
    return prepared.response;
  }
  const cancellationAfterBuild = await getPromptCancellationResponse(payload);
  if (cancellationAfterBuild) {
    return cancellationAfterBuild;
  }
  let result: { threadId: string; turnId: string };
  try {
    emitPromptStatus(payload, "waiting-for-codex");
    const structuredInputs = mergeStructuredInputsWithEnabledCodexSkills(
      prepared.structuredInputs,
      state.appServerSkills,
      settings.enabledCodexSkillIds,
      createCodexSkillRuntimeAvailability(settings),
      state.connectedApps,
    );
    const cancellationBeforeSteer = await getPromptCancellationResponse(payload);
    if (cancellationBeforeSteer) {
      return cancellationBeforeSteer;
    }
    result = await bridge.request<{ threadId: string; turnId: string }>("turn.steer", {
      clientRequestId: payload.clientRequestId,
      profile: prepared.profile,
      message: payload.message,
      conversationContext: payload.conversationContext ?? payload.contextHint ?? "",
      contexts: prepared.contexts,
      fileAttachments: prepared.fileAttachments,
      routePlan: prepared.routePlan,
      structuredInputs,
      threadId: runtime.threadId,
      expectedTurnId: runtime.activeTurn.turnId,
      ...(normalizeConfiguredPath(settings.workspaceRoot) ? { cwd: normalizeConfiguredPath(settings.workspaceRoot) } : {}),
      ...(prepared.selectedModel ? { model: prepared.selectedModel } : {}),
      ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
      ...(payload.serviceTier ? { serviceTier: payload.serviceTier } : {}),
    });
    const cancellationAfterSteer = await getPromptCancellationResponse(payload);
    if (cancellationAfterSteer) {
      return cancellationAfterSteer;
    }
  } catch (error) {
    if (!isRecoverableTurnSteerError(error)) {
      throw error;
    }
    conversationRuntime.setActiveTurn(conversationId, null);
    syncCurrentRuntimeState(conversationId);
    return {
      error: toErrorMessage(error) || "No active turn to steer.",
      currentConversationId: conversationId,
    };
  }
  conversationRuntime.setActiveTurn(conversationId, {
    threadId: result.threadId,
    turnId: result.turnId,
  });
  syncCurrentRuntimeState(conversationId);
  return {
    ...result,
    actionCards: prepared.actionCards,
    currentConversationId: conversationId,
  };
}

async function handlePromptCancel(clientRequestId?: unknown, threadId?: unknown, turnId?: unknown) {
  if (typeof clientRequestId === "string" && clientRequestId) {
    cancelledPromptClientRequestIds.add(clientRequestId);
  }

  await stopCurrentAiControlIndicator(0);

  let interrupt: unknown = { skipped: true };
  if (typeof threadId === "string" && threadId) {
    // turnId is optional gateway-side — the session manager falls back
    // to the task's active turn, so a desynced UI still interrupts.
    interrupt = await handleTurnInterrupt(threadId, typeof turnId === "string" ? turnId : undefined).catch(
      (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
    );
  }

  return { cancelled: true, interrupt };
}

async function handleTurnInterrupt(threadId?: string, turnId?: string) {
  await stopCurrentAiControlIndicator(0);
  if (!threadId) {
    return { cancelled: true };
  }

  const resolvedTurnId =
    turnId ?? (state.activeTurn?.threadId === threadId ? state.activeTurn.turnId : undefined);
  const result = await bridge.request<{ threadId: string; turnId: string }>("turn.interrupt", {
    threadId,
    ...(resolvedTurnId ? { turnId: resolvedTurnId } : {}),
  });
  const conversationId = conversationRuntime.completeTurn(threadId, resolvedTurnId);
  if (conversationId) {
    syncCurrentRuntimeState(conversationId);
  } else if (resolvedTurnId && state.activeTurn?.turnId === resolvedTurnId) {
    state.activeTurn = null;
  }
  return result;
}

function isPromptClientRequestCancelled(clientRequestId?: string): boolean {
  return Boolean(clientRequestId && cancelledPromptClientRequestIds.has(clientRequestId));
}

function consumePromptClientRequestCancellation(clientRequestId?: string): boolean {
  if (!isPromptClientRequestCancelled(clientRequestId)) {
    return false;
  }
  cancelledPromptClientRequestIds.delete(clientRequestId as string);
  return true;
}

async function getPromptCancellationResponse(payload: PromptRequestPayload): Promise<{ cancelled: true } | null> {
  if (!consumePromptClientRequestCancellation(payload.clientRequestId)) {
    return null;
  }
  await stopCurrentAiControlIndicator(0);
  return { cancelled: true };
}

async function buildPromptRequest(
  payload: PromptRequestPayload,
  settings: ExtensionSettings,
  emitStatus: PromptStatusEmitter = () => undefined,
): Promise<{
  ok: true;
  profile: ProfileTemplate;
  contexts: PageContextEnvelope[];
  actionCards: ActionCard[];
  selectedModel: string;
  fileAttachments: UserFileAttachment[];
  structuredInputs: CodexStructuredInput[];
  routePlan: PromptRoutingPlan;
  agenticRoutePlan: AgenticRoutePlan;
} | {
  ok: false;
  response: {
    error: string;
    requiresConfirmation?: boolean;
    confirmationOperation?: HarnessPermissionOperation;
    appConnection?: {
      kind: "plugin";
      id: string;
    };
  };
}> {
  const activeTab = await getActiveTab().catch(() => null);
  const routeInput = createAgenticRouteInput(payload, activeTab, settings);
  const agenticRoutePlan = await planAgenticRouteForPayload(payload, routeInput);
  let structuredInputs = expandPluginStructuredInputsWithConnectedApps(
    mergeExplicitAndRouteStructuredInputs(
      payload.structuredInputs ?? [],
      resolveRouteStructuredInputs(agenticRoutePlan, routeInput),
    ),
    state.connectedApps,
  );
  let blockedPluginInput = structuredInputs.find((input) =>
    requiresPluginCompanionAppConnection(input, state.connectedApps),
  );
  if (blockedPluginInput) {
    await triggerCatalogRefresh(undefined, { force: true }).catch((error) => {
      console.warn("catalog refresh before plugin connection check failed", error);
    });
    structuredInputs = expandPluginStructuredInputsWithConnectedApps(structuredInputs, state.connectedApps);
    blockedPluginInput = structuredInputs.find((input) =>
      requiresPluginCompanionAppConnection(input, state.connectedApps),
    );
  }
  if (blockedPluginInput) {
    const strings = getUiStrings(resolveSettingsUiLocale(settings));
    return {
      ok: false,
      response: {
        error: strings.errors.appConnectionRequired(blockedPluginInput.name),
        appConnection: {
          kind: "plugin",
          id: blockedPluginInput.id,
        },
      },
    };
  }
  const routePlan = routePlanToPromptRoutingPlan(agenticRoutePlan, routeInput);
  const currentPageSupport = getCurrentPageSupport(activeTab?.url);
  const selectedTextContext = normalizeSelectedPageTextContext(payload.selectedTextContext, activeTab);
  const hasExplicitSelectionContext = payload.attachments.includes("selection") && Boolean(selectedTextContext);
  const selectionOnlyContextRequested =
    hasExplicitSelectionContext &&
    !payload.attachments.includes("current-page") &&
    !payload.attachments.includes("image");
  const routeContextRequests = payload.suppressPageContext
    ? filterSuppressedPageContextRequests(agenticRoutePlan.contextRequests, payload.attachments)
    : agenticRoutePlan.contextRequests;
  const requestedContextRequests = selectionOnlyContextRequested
    ? routeContextRequests.filter((request) => request.source !== "current-page" && request.source !== "image")
    : routeContextRequests;
  const effectiveContextRequests = ensureDefaultCurrentPageContextRequests(
    requestedContextRequests,
    currentPageSupport,
    {
      suppressDefault:
        payload.suppressPageContext ||
        selectionOnlyContextRequested ||
        shouldSuppressDefaultCurrentPageContextForImageWorkflow(agenticRoutePlan) ||
        shouldSuppressDefaultCurrentPageContextForImageGeneration(agenticRoutePlan) ||
        shouldSuppressDefaultCurrentPageContextForHistory(routePlan, requestedContextRequests),
    },
  );
  const effectiveRoutePlan = createEffectivePromptRoutePlan(
    routePlan,
    effectiveContextRequests,
    Boolean(payload.fileAttachments?.length),
  );
  const effectiveAttachments = effectiveContextRequests.map((request) => request.source);
  const requestedPageAttachments = effectiveAttachments.filter(
    (attachment): attachment is "current-page" | "selection" | "image" =>
      attachment === "current-page" || attachment === "selection" || attachment === "image",
  );
  const pageAttachments = currentPageSupport.available
    ? requestedPageAttachments
    : [];
  const profile = getAvailableProfileTemplate(routePlan.selectedProfileId);
  const contexts: PageContextEnvelope[] = [];
  const actionCards: ActionCard[] = [];
  const needsCurrentContext = pageAttachments.some((attachment) => attachment !== "selection" || !selectedTextContext);
  const deferPageContextForImageWorkflow = shouldDeferPageContextCollectionForImageWorkflow(agenticRoutePlan);
  if (needsCurrentContext && !deferPageContextForImageWorkflow) {
    emitStatus("collecting-context");
  }
  const currentContext =
    needsCurrentContext && !deferPageContextForImageWorkflow
      ? await collectCurrentPageContext(routePlan.pageReadStrategy)
      : null;
  const fileAttachments = await collectAutomaticDocumentAttachments(
    activeTab,
    effectiveAttachments,
    payload.fileAttachments ?? [],
  );

  if (effectiveAttachments.includes("current-page") && currentContext) {
    contexts.push(currentContext.envelope);
    actionCards.push(...currentContext.actionCards);
  }

  if (effectiveAttachments.includes("selection") && currentContext?.envelope.selectionText) {
    contexts.push({
      ...currentContext.envelope,
      domSummary: createSelectionFocusedDomSummary(
        currentContext.envelope.selectionText,
        currentContext.envelope.domSummary,
      ),
      visionAssets: [],
    });
  } else if (effectiveAttachments.includes("selection") && selectedTextContext) {
    contexts.push(createSelectionContextEnvelope(selectedTextContext));
  }

  if (effectiveAttachments.includes("image") && currentContext?.envelope.visionAssets.length) {
    contexts.push({
      ...currentContext.envelope,
      domSummary: "Focus on the attached visual context and preserve the main subject unless the user asks otherwise.",
    });
  }

  if (effectiveAttachments.includes("open-tabs")) {
    const tabGate = await ensureOperationAllowed(
      "context.tabs.read",
      payload.confirmedOperations?.includes("context.tabs.read") ?? false,
    );
    if (!tabGate.ok) {
      return { ok: false, response: tabGate.response };
    }
    const allTabs = await listOpenTabs();
    const limitedTabIds = payload.selectedTabIds?.length
      ? payload.selectedTabIds.slice(0, 10)
      : allTabs.slice(0, 5).map((tab) => tab.tabId);
    const selectedTabs = allTabs.filter((tab) => limitedTabIds.includes(tab.tabId));
    contexts.push(...selectedTabs.map(tabToEnvelope));
  }

  if (effectiveAttachments.includes("history")) {
    const historyGate = await ensureOperationAllowed(
      "context.history.read",
      payload.confirmedOperations?.includes("context.history.read") ?? false,
    );
    if (!historyGate.ok) {
      return { ok: false, response: historyGate.response };
    }
    const requestedHistoryQuery = resolveHistoryContextQuery(payload.historyQuery, agenticRoutePlan.historyQuery);
    let history = await searchHistory(requestedHistoryQuery);
    if (requestedHistoryQuery && history.items.length === 0) {
      history = await searchHistory("");
    }
    contexts.push({
      metadata: {
        url: "chrome://history-search",
        title: requestedHistoryQuery ? `History search: ${requestedHistoryQuery}` : "Recent history",
        domain: "history",
      },
      selectionText: "",
      domSummary: createHistoryContextSummary(history.items),
      visionAssets: [],
      adapterPayload: null,
      privacyFlags: {
        containsSensitiveFormData: false,
        userConsentedToHistory: true,
      },
    });
  }

  return {
    ok: true,
    profile,
    contexts,
    actionCards,
    selectedModel: routePlan.selectedModel,
    fileAttachments,
    structuredInputs,
    routePlan: effectiveRoutePlan,
    agenticRoutePlan,
  };
}

async function planAgenticRouteForPayload(
  payload: PromptRequestPayload,
  routeInput: AgenticRouteInput,
): Promise<AgenticRoutePlan> {
  const input = routeInput;
  try {
    const plan = await bridge.request<unknown>("route.plan", { ...input });
    const normalized = normalizeAgenticRoutePlan(plan, input);
    void recordDiagnostic("extension.route.plan.ready", {
      clientRequestId: payload.clientRequestId ?? null,
      task: normalized.task,
      selectedProfileId: normalized.selectedProfileId,
      selectedModel: normalized.selectedModel,
      contextSources: normalized.contextRequests.map((request) => request.source),
      structuredInputIds: normalized.structuredInputIds,
      historyQuery: normalized.historyQuery,
      imageEdit: normalized.imageEdit,
    });
    return normalized;
  } catch (error) {
    void recordDiagnostic("extension.route.plan.failed", {
      clientRequestId: payload.clientRequestId ?? null,
      error: toErrorMessage(error),
    });
    return createFallbackAgenticRoutePlan(input, toErrorMessage(error));
  }
}

function createAgenticRouteInput(
  payload: PromptRequestPayload,
  activeTab: chrome.tabs.Tab | null,
  settings: ExtensionSettings,
): AgenticRouteInput {
  const explicitAttachments = payload.attachments.filter(isAgenticRouteContextSource);
  const activeTabSupport = getCurrentPageSupport(activeTab?.url);
  return {
    message: payload.message,
    ...(payload.contextHint ? { contextHint: payload.contextHint } : {}),
    selectedProfileId: payload.profileId,
    availableProfileIds: listAvailableProfiles().map((profile) => profile.id),
    selectedModel: payload.model ?? state.selectedModel,
    models: state.models,
    readStrategyOverride: payload.readStrategyOverride ?? "auto",
    explicitAttachments,
    fileAttachments: payload.fileAttachments ?? [],
    ...(payload.selectedTabIds?.length ? { selectedTabIds: payload.selectedTabIds } : {}),
    ...(payload.historyQuery ? { historyQuery: payload.historyQuery } : {}),
    locale: resolveSettingsUiLocale(settings),
    availableStructuredInputs: createAvailableRouteStructuredInputs({
      apps: state.connectedApps,
      plugins: state.appServerPlugins,
      mcpServers: state.mcpServers,
    }),
    browserAutomationCapabilities: {
      dom: true,
      playwright: state.playwrightRuntime.available && settings.playwrightBrowserControlEnabled,
      "computer-use": false,
    },
    browserPolicyV2: settings.browserPolicyV2,
    activeTab: activeTab
      ? {
          ...(activeTab.title ? { title: activeTab.title } : {}),
          ...(activeTab.url ? { url: activeTab.url } : {}),
          restricted: !activeTabSupport.available,
        }
      : {
          restricted: true,
        },
  };
}

function isAgenticRouteContextSource(value: string): value is AgenticRouteContextSource {
  return (
    value === "current-page" ||
    value === "open-tabs" ||
    value === "history" ||
    value === "selection" ||
    value === "image"
  );
}

async function maybeHandleAgenticImageWorkflow(
  payload: PromptRequestPayload,
  agenticRoutePlan: AgenticRoutePlan,
  emitStatus: PromptStatusEmitter = () => undefined,
): Promise<
  | { kind: "skip" }
  | {
      kind: "blocked";
      response: {
        error: string;
        requiresConfirmation?: boolean;
        confirmationOperation?: HarnessPermissionOperation;
      };
    }
  | {
      kind: "handled";
      response: {
        workflow: "image-edit";
        assistantText: string;
        previewRef: string;
      };
    }
> {
  if (!shouldHandleAgenticImageEditWorkflow(agenticRoutePlan)) {
    void recordDiagnostic("extension.image.workflow.skip", {
      reason: "route-not-actionable-image-edit",
      task: agenticRoutePlan.task,
      intent: agenticRoutePlan.intent,
      imageEdit: agenticRoutePlan.imageEdit,
    });
    return { kind: "skip" };
  }

  const workflowPlan = agenticRoutePlan.imageEdit;
  if (workflowPlan.target === "none" || workflowPlan.target === "ambiguous") {
    void recordDiagnostic("extension.image.workflow.skip", {
      reason: "target-not-actionable",
      imageEdit: workflowPlan,
    });
    return { kind: "skip" };
  }

  const imageGate = await ensureOperationAllowed(
    "image.edit",
    payload.confirmedOperations?.includes("image.edit") ?? false,
  );
  if (!imageGate.ok) {
    void recordDiagnostic("extension.image.workflow.blocked", {
      target: workflowPlan.target,
      error: imageGate.response.error,
    });
    return { kind: "blocked", response: imageGate.response };
  }

  emitStatus("preparing-image", "image-edit");
  void recordDiagnostic("extension.image.workflow.prepare", {
    target: workflowPlan.target,
    targetFileId: workflowPlan.targetFileId ?? null,
  });
  const image = await resolveWorkflowImageInput(payload, workflowPlan.target, workflowPlan.targetFileId);
  const references = await resolveWorkflowReferenceImages(
    { ...payload, attachments: agenticRoutePlan.contextRequests.map((request) => request.source) },
    workflowPlan.target,
    workflowPlan.targetFileId,
  );
  emitStatus("editing-image", "image-edit");
  void recordDiagnostic("extension.image.workflow.bridge.start", {
    target: workflowPlan.target,
    mimeType: image.mimeType,
    filename: image.filename ?? null,
    referenceCount: references.length,
  });
  const result = await bridge.request<{ jobId: string; previewRef: string }>(
    "image.edit.start",
    {
      prompt: workflowPlan.prompt ?? payload.message,
      image,
      referenceImages: references,
    },
    {
      timeoutMs: IMAGE_EDIT_TIMEOUT_MS,
      timeoutMessage: await buildLocalizedImageEditTimeoutMessage(),
    },
  );
  void recordDiagnostic("extension.image.workflow.bridge.completed", {
    target: workflowPlan.target,
    jobId: result.jobId,
    previewRef: result.previewRef,
  });
  emitStatus("rendering-image-preview", "image-edit");

  return {
    kind: "handled",
    response: {
      workflow: "image-edit",
      previewRef: result.previewRef,
      assistantText: buildImageWorkflowAssistantText(await getActiveUiLocale(), workflowPlan.target, image.filename),
    },
  };
}

async function maybeHandleAgenticImageGenerationWorkflow(
  payload: PromptRequestPayload,
  agenticRoutePlan: AgenticRoutePlan,
  contexts: PageContextEnvelope[],
  fileAttachments: UserFileAttachment[],
  emitStatus: PromptStatusEmitter = () => undefined,
): Promise<
  | { kind: "skip" }
  | {
      kind: "blocked";
      response: {
        error: string;
        requiresConfirmation?: boolean;
        confirmationOperation?: HarnessPermissionOperation;
      };
    }
  | {
      kind: "handled";
      response: {
        workflow: "generated-image";
        previewRef: string;
        previewRefs: string[];
      };
    }
> {
  if (!shouldHandleAgenticImageGenerationWorkflow(agenticRoutePlan)) {
    return { kind: "skip" };
  }

  const imageGate = await ensureOperationAllowed(
    "image.edit",
    payload.confirmedOperations?.includes("image.edit") ?? false,
  );
  if (!imageGate.ok) {
    return { kind: "blocked", response: imageGate.response };
  }

  emitStatus("preparing-image", "generated-image");
  void recordDiagnostic("extension.image.generate.workflow.prepare", {
    clientRequestId: payload.clientRequestId ?? null,
    contextCount: contexts.length,
    fileAttachmentCount: fileAttachments.length,
  });
  emitStatus("editing-image", "generated-image");
  const result = await bridge.request<{ jobId: string; previewRef: string; previewRefs?: string[] }>(
    "image.generate.start",
    {
      prompt: payload.message,
      contexts,
      fileAttachments,
      conversationContext: payload.contextHint ?? "",
      clientRequestId: payload.clientRequestId,
      conversationId: payload.conversationId,
      workflow: "generated-image",
      model: "gpt-image-2",
    },
    {
      timeoutMs: IMAGE_GENERATION_WORKFLOW_TIMEOUT_MS,
      timeoutMessage: await buildLocalizedImageGenerationWorkflowTimeoutMessage(),
    },
  );
  emitStatus("rendering-image-preview", "generated-image");
  const previewRefs = normalizeImageGeneratePreviewRefs(result.previewRefs, result.previewRef);
  if (!previewRefs.length) {
    throw new Error("Codex completed image generation without returning a generated image preview.");
  }
  return {
    kind: "handled",
    response: {
      workflow: "generated-image",
      previewRef: previewRefs[0] ?? result.previewRef,
      previewRefs,
    },
  };
}

async function resolveWorkflowImageInput(
  payload: PromptRequestPayload,
  target: "page-image" | "uploaded-image",
  targetFileId?: string,
) {
  if (target === "uploaded-image") {
    const uploadedInput = await resolveUploadedImageEditInput(payload.fileAttachments ?? [], targetFileId);
    if (!uploadedInput) {
      throw new Error("No uploaded image is available for this edit request.");
    }
    return uploadedInput;
  }

  return getEditableImageInput();
}

async function resolveWorkflowReferenceImages(
  payload: PromptRequestPayload,
  target: "page-image" | "uploaded-image",
  targetFileId?: string,
): Promise<Array<{ base64: string; mimeType: string; filename?: string }>> {
  const references: Array<{ base64: string; mimeType: string; filename?: string }> = [];

  if (target === "page-image") {
    return resolveUploadedImageReferenceInputs(payload.fileAttachments ?? [], targetFileId);
  }

  const wantsPageReference = payload.attachments.includes("image") || payload.attachments.includes("current-page");
  if (!wantsPageReference) {
    return references;
  }

  try {
    references.push(await getEditableImageInput());
  } catch {
    return references;
  }

  return references;
}

function buildImageWorkflowAssistantText(locale: string, target: "page-image" | "uploaded-image", filename: string | undefined): string {
  const strings = getUiStrings(locale);
  if (target === "page-image") {
    return strings.images.editPreview;
  }

  return filename ? `${strings.images.editPreview} (${filename})` : strings.images.editPreview;
}

async function buildLocalizedImageEditTimeoutMessage(): Promise<string> {
  return buildImageEditTimeoutMessage(getUiStrings(await getActiveUiLocale()).errors.imageEditTimeout);
}

async function buildLocalizedImageGenerationWorkflowTimeoutMessage(): Promise<string> {
  return buildImageGenerationWorkflowTimeoutMessage(await getActiveUiLocale());
}

async function requestPromptSendWithAssistantCapture(
  params: Record<string, unknown>,
): Promise<{ result: PromptTurnResult; assistantText: string }> {
  const completedMessages: CompletedAssistantMessageEvent[] = [];
  const unsubscribe = bridge.subscribe((event) => {
    if (isCompletedAssistantMessageEvent(event)) {
      completedMessages.push(event);
    }
  });

  try {
    const result = await bridge.request<PromptTurnResult>("prompt.send", params);
    return {
      result,
      assistantText: collectCompletedAssistantText(completedMessages, result),
    };
  } finally {
    unsubscribe();
  }
}

function isCompletedAssistantMessageEvent(event: unknown): event is CompletedAssistantMessageEvent {
  return typeof event === "object" && event !== null && (event as { type?: unknown }).type === "message.completed";
}

function collectCompletedAssistantText(
  events: CompletedAssistantMessageEvent[],
  result: PromptTurnResult,
): string {
  return events
    .filter((event) => event.threadId === result.threadId && event.turnId === result.turnId)
    .map((event) => event.text?.trim() ?? "")
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

async function maybeEnsureDeferredBrowserDomActionAllowed(
  payload: PromptRequestPayload,
  agenticRoutePlan: AgenticRoutePlan,
): Promise<{ kind: "not-handled" | "allowed" } | { kind: "blocked"; response: HarnessPermissionBlockedResponse }> {
  if (!shouldResumeDeferredBrowserDomAction(agenticRoutePlan)) {
    return { kind: "not-handled" };
  }

  const gate = await ensureOperationAllowed(
    "page.dom.perform",
    payload.confirmedOperations?.includes("page.dom.perform") ?? false,
  );
  if (!gate.ok) {
    return { kind: "blocked", response: gate.response };
  }
  return { kind: "allowed" };
}

/**
 * Second policy layer after the operation-level gate: plans that can send,
 * post, delete, submit forms, or enter credentials require explicit user
 * confirmation even when `browserActionPermissionMode` is "auto-review".
 * "full" mode and an already-confirmed operation stay allowed — the user made
 * an explicit choice for both.
 */
async function maybeRequireSensitiveBrowserActionConfirmation(
  plan: BrowserDomActionPlan,
  snapshot: BrowserDomSnapshot,
  payload: PromptRequestPayload,
): Promise<HarnessPermissionBlockedResponse | null> {
  const assessment = assessBrowserDomActionPlan(plan, snapshot);
  const settings = await getStoredSettings();
  const needsConfirmation = browserActionNeedsConfirmation(assessment, {
    operationConfirmed: payload.confirmedOperations?.includes("page.dom.perform") ?? false,
    permissionMode: settings.browserActionPermissionMode ?? "ask",
  });
  if (!needsConfirmation) {
    return null;
  }

  return {
    error:
      "This browser action can send, post, delete, submit a form, or enter credentials and requires confirmation.",
    requiresConfirmation: true,
    confirmationOperation: "page.dom.perform",
  };
}

async function maybeHandleBrowserDomActionWorkflow(
  payload: PromptRequestPayload,
  agenticRoutePlan: AgenticRoutePlan,
  emitStatus: PromptStatusEmitter,
): Promise<BrowserDomActionWorkflowResult> {
  if (!shouldHandleBrowserDomAction(agenticRoutePlan)) {
    return { kind: "not-handled" };
  }

  const gate = await ensureOperationAllowed(
    "page.dom.perform",
    payload.confirmedOperations?.includes("page.dom.perform") ?? false,
  );
  if (!gate.ok) {
    return { kind: "blocked", response: gate.response };
  }

  const controlTab = await getActiveTab();
  assertPageReadable(controlTab.url);
  const locale = await getActiveUiLocale();
  const strings = getUiStrings(locale);
  await startTabAiControlIndicator(controlTab, "dom", "Codex is controlling this page");
  try {
    if (consumePromptClientRequestCancellation(payload.clientRequestId)) {
      return {
        kind: "handled",
        response: {
          workflow: "browser-action",
          assistantText: strings.status.browserActionStopped,
        },
      };
    }
    emitStatus("collecting-context");
    const snapshot = (await sendMessageToTab(controlTab, { type: "page.dom.snapshot" })) as BrowserDomSnapshot;
    recordDomSnapshotMeta(controlTab.id, snapshot);
    if (consumePromptClientRequestCancellation(payload.clientRequestId)) {
      return {
        kind: "handled",
        response: {
          workflow: "browser-action",
          assistantText: strings.status.browserActionStopped,
        },
      };
    }
    if (!snapshot.elements.length) {
      return {
        kind: "handled",
        response: {
          workflow: "browser-action",
          assistantText: strings.status.browserActionNoElements,
        },
      };
    }

    emitStatus("waiting-for-codex");
    const plan = await bridge.request<BrowserDomActionPlan>("browser.action.plan", {
      message: payload.message,
      snapshot,
      locale,
    });
    if (consumePromptClientRequestCancellation(payload.clientRequestId)) {
      return {
        kind: "handled",
        response: {
          workflow: "browser-action",
          assistantText: strings.status.browserActionStopped,
        },
      };
    }

    if (!plan.shouldAct || plan.steps.length === 0) {
      return {
        kind: "handled",
        response: {
          workflow: "browser-action",
          assistantText: plan.summary || strings.status.browserActionSkipped,
        },
      };
    }

    const sensitiveGate = await maybeRequireSensitiveBrowserActionConfirmation(plan, snapshot, payload);
    if (sensitiveGate) {
      return { kind: "blocked", response: sensitiveGate };
    }

    if (isStaleSnapshotPlan(controlTab.id, plan)) {
      return {
        kind: "handled",
        response: {
          workflow: "browser-action",
          assistantText: strings.status.browserActionStale,
        },
      };
    }

    const actionResult = (await sendMessageToTab(controlTab, {
      type: "page.dom.perform",
      steps: plan.steps,
    })) as BrowserDomActionResult;

    return {
      kind: "handled",
      response: {
        workflow: "browser-action",
        assistantText: buildBrowserDomActionAssistantText(locale, plan, actionResult),
        actionResult,
      },
    };
  } finally {
    await stopTabAiControlIndicator(controlTab, 0);
  }
}

async function maybeHandleDeferredBrowserDomActionWorkflow(
  payload: PromptRequestPayload,
  agenticRoutePlan: AgenticRoutePlan,
  assistantText: string,
  emitStatus: PromptStatusEmitter,
): Promise<BrowserDomActionWorkflowResult> {
  if (!shouldResumeDeferredBrowserDomAction(agenticRoutePlan)) {
    return { kind: "not-handled" };
  }

  const locale = await getActiveUiLocale();
  const strings = getUiStrings(locale);
  const generatedText = extractDeferredBrowserActionText(assistantText);
  if (!generatedText) {
    return {
      kind: "handled",
      response: {
        workflow: "browser-action",
        assistantText: strings.status.browserActionSkipped,
      },
    };
  }

  const controlTab = await getActiveTab();
  assertPageReadable(controlTab.url);
  await startTabAiControlIndicator(controlTab, "dom", "Codex is controlling this page");
  try {
    if (consumePromptClientRequestCancellation(payload.clientRequestId)) {
      return {
        kind: "handled",
        response: {
          workflow: "browser-action",
          assistantText: strings.status.browserActionStopped,
        },
      };
    }

    emitStatus("collecting-context");
    const snapshot = (await sendMessageToTab(controlTab, { type: "page.dom.snapshot" })) as BrowserDomSnapshot;
    recordDomSnapshotMeta(controlTab.id, snapshot);
    if (consumePromptClientRequestCancellation(payload.clientRequestId)) {
      return {
        kind: "handled",
        response: {
          workflow: "browser-action",
          assistantText: strings.status.browserActionStopped,
        },
      };
    }
    if (!snapshot.elements.length) {
      return {
        kind: "handled",
        response: {
          workflow: "browser-action",
          assistantText: strings.status.browserActionNoElements,
        },
      };
    }

    emitStatus("waiting-for-codex");
    const plan = await bridge.request<BrowserDomActionPlan>("browser.action.plan", {
      message: buildDeferredBrowserActionMessage({
        originalMessage: payload.message,
        generatedText,
      }),
      generatedText,
      snapshot,
      locale,
    });
    if (consumePromptClientRequestCancellation(payload.clientRequestId)) {
      return {
        kind: "handled",
        response: {
          workflow: "browser-action",
          assistantText: strings.status.browserActionStopped,
        },
      };
    }

    if (!plan.shouldAct || plan.steps.length === 0) {
      return {
        kind: "handled",
        response: {
          workflow: "browser-action",
          assistantText: plan.summary || strings.status.browserActionSkipped,
        },
      };
    }

    const deferredSensitiveGate = await maybeRequireSensitiveBrowserActionConfirmation(plan, snapshot, payload);
    if (deferredSensitiveGate) {
      return { kind: "blocked", response: deferredSensitiveGate };
    }

    if (isStaleSnapshotPlan(controlTab.id, plan)) {
      return {
        kind: "handled",
        response: {
          workflow: "browser-action",
          assistantText: strings.status.browserActionStale,
        },
      };
    }

    const actionResult = (await sendMessageToTab(controlTab, {
      type: "page.dom.perform",
      steps: plan.steps,
    })) as BrowserDomActionResult;

    return {
      kind: "handled",
      response: {
        workflow: "browser-action",
        assistantText: buildBrowserDomActionAssistantText(locale, plan, actionResult),
        actionResult,
      },
    };
  } finally {
    await stopTabAiControlIndicator(controlTab, 0);
  }
}

function shouldHandleBrowserDomAction(agenticRoutePlan: AgenticRoutePlan): boolean {
  if (agenticRoutePlan.intent.needsClarification || !agenticRoutePlan.browserControl.shouldControl) {
    return false;
  }
  if (agenticRoutePlan.browserControl.preconditions?.length) {
    return false;
  }
  if (agenticRoutePlan.browserControl.mode !== "dom") {
    return false;
  }
  if (agenticRoutePlan.browserControl.surface !== "active-tab") {
    return false;
  }
  return agenticRoutePlan.intent.action === "navigate" && agenticRoutePlan.intent.target === "current-page";
}

function buildBrowserDomActionAssistantText(locale: string, plan: BrowserDomActionPlan, result: BrowserDomActionResult): string {
  const strings = getUiStrings(locale);
  if (result.cancelled) {
    return strings.status.browserActionStopped;
  }
  if (result.ok) {
    return plan.summary || strings.status.browserActionCompleted;
  }
  const failed = result.results.find((item) => !item.ok);
  return failed?.message
    ? strings.status.browserActionFailedWithReason(failed.message)
    : strings.status.browserActionFailed;
}

async function handleImageEdit(prompt: string, confirmed: boolean) {
  const gate = await ensureOperationAllowed("image.edit", confirmed);
  if (!gate.ok) {
    return gate.response;
  }
  const image = await getEditableImageInput();
  return bridge.request(
    "image.edit.start",
    {
      prompt,
      image,
    },
    {
      timeoutMs: IMAGE_EDIT_TIMEOUT_MS,
      timeoutMessage: await buildLocalizedImageEditTimeoutMessage(),
    },
  );
}

async function handleInfographicGenerate(
  confirmed: boolean,
  conversationContextInput?: unknown,
  clientRequestIdInput?: unknown,
  conversationIdInput?: unknown,
) {
  const gate = await ensureOperationAllowed("image.edit", confirmed);
  if (!gate.ok) {
    return gate.response;
  }

  const context = await collectInfographicPageContext();
  const activeTab = await getActiveTab().catch(() => null);
  const fileAttachments = await collectAutomaticDocumentAttachments(activeTab, ["current-page"], []);
  const prompt = buildInfographicPrompt({
    locale: await getActiveUiLocale(),
    pageTitle: context.envelope.metadata.title,
    pageUrl: context.envelope.metadata.url,
    adapterPayload: context.envelope.adapterPayload,
  });

  const result = await bridge.request<{ jobId: string; previewRef: string; previewRefs?: string[] }>(
    "image.generate.start",
    {
      prompt,
      contexts: [context.envelope],
      fileAttachments,
      conversationContext: normalizeInfographicConversationContext(conversationContextInput),
      clientRequestId: normalizeOptionalClientRequestId(clientRequestIdInput),
      conversationId: normalizeOptionalConversationId(conversationIdInput),
      workflow: "infographic",
      model: "gpt-image-2",
    },
    {
      timeoutMs: IMAGE_GENERATION_WORKFLOW_TIMEOUT_MS,
      timeoutMessage: await buildLocalizedImageGenerationWorkflowTimeoutMessage(),
    },
  );

  return {
    workflow: "infographic",
    ...result,
    currentConversationId: normalizeOptionalConversationId(conversationIdInput),
    previewRefs: normalizeImageGeneratePreviewRefs(result.previewRefs, result.previewRef),
    actionCards: context.actionCards,
  };
}

async function handleSlideDeckImageGenerate(
  userPrompt: string,
  confirmed: boolean,
  conversationContextInput?: unknown,
  clientRequestIdInput?: unknown,
  conversationIdInput?: unknown,
) {
  const gate = await ensureOperationAllowed("image.edit", confirmed);
  if (!gate.ok) {
    return gate.response;
  }

  const context = await collectInfographicPageContext();
  const activeTab = await getActiveTab().catch(() => null);
  const fileAttachments = await collectAutomaticDocumentAttachments(activeTab, ["current-page"], []);
  const prompt = buildSlideDeckImagePrompt({
    locale: await getActiveUiLocale(),
    pageTitle: context.envelope.metadata.title,
    pageUrl: context.envelope.metadata.url,
    userPrompt,
  });

  const result = await bridge.request<{ jobId: string; previewRef: string; previewRefs?: string[] }>(
    "image.generate.start",
    {
      prompt,
      contexts: [context.envelope],
      fileAttachments,
      conversationContext: normalizeInfographicConversationContext(conversationContextInput),
      clientRequestId: normalizeOptionalClientRequestId(clientRequestIdInput),
      conversationId: normalizeOptionalConversationId(conversationIdInput),
      workflow: "slide-images",
      model: "gpt-image-2",
    },
    {
      timeoutMs: IMAGE_GENERATION_WORKFLOW_TIMEOUT_MS,
      timeoutMessage: await buildLocalizedImageGenerationWorkflowTimeoutMessage(),
    },
  );

  return {
    workflow: "slide-images",
    ...result,
    currentConversationId: normalizeOptionalConversationId(conversationIdInput),
    previewRefs: normalizeImageGeneratePreviewRefs(result.previewRefs, result.previewRef),
    actionCards: context.actionCards,
  };
}

function normalizeImageGeneratePreviewRefs(previewRefs: string[] | undefined, previewRef: string | undefined): string[] {
  const refs = [...(previewRefs ?? []), ...(previewRef ? [previewRef] : [])]
    .map((ref) => ref.trim())
    .filter(Boolean);
  return Array.from(new Set(refs));
}

async function collectInfographicPageContext() {
  let domContext: CurrentPageContextResult;
  try {
    domContext = await collectCurrentPageContext("dom");
  } catch (error) {
    void recordDiagnostic("extension.infographic_context.dom_failed", {
      error: toErrorMessage(error),
    });
    return collectVisibleScreenOnlyInfographicContext(null);
  }

  if (!shouldFallbackToVisionForInfographic(domContext.envelope)) {
    return domContext;
  }

  try {
    const hybridContext = await collectCurrentPageContext("hybrid");
    const mergedContext = mergeInfographicContextFallback(domContext, hybridContext);
    if (mergedContext.envelope.visionAssets.length > 0) {
      return mergedContext;
    }
    return await collectVisibleScreenOnlyInfographicContext(mergedContext);
  } catch (error) {
    void recordDiagnostic("extension.infographic_context.hybrid_fallback_failed", {
      url: domContext.envelope.metadata.url,
      error: toErrorMessage(error),
    });
    return collectVisibleScreenOnlyInfographicContext(domContext).catch(() => domContext);
  }
}

function shouldFallbackToVisionForInfographic(envelope: PageContextEnvelope): boolean {
  if (envelope.visionAssets.length > 0) {
    return false;
  }

  const textLength = `${envelope.selectionText}\n${envelope.domSummary}`.replace(/\s+/gu, "").length;
  return textLength < 280;
}

function mergeInfographicContextFallback(
  domContext: CurrentPageContextResult,
  hybridContext: CurrentPageContextResult,
) {
  return {
    envelope: {
      ...hybridContext.envelope,
      selectionText: domContext.envelope.selectionText || hybridContext.envelope.selectionText,
      domSummary: domContext.envelope.domSummary || hybridContext.envelope.domSummary,
      adapterPayload: domContext.envelope.adapterPayload ?? hybridContext.envelope.adapterPayload,
      privacyFlags: {
        containsSensitiveFormData:
          domContext.envelope.privacyFlags.containsSensitiveFormData ||
          hybridContext.envelope.privacyFlags.containsSensitiveFormData,
        userConsentedToHistory:
          domContext.envelope.privacyFlags.userConsentedToHistory ||
          hybridContext.envelope.privacyFlags.userConsentedToHistory,
      },
    },
    readStrategy: hybridContext.readStrategy,
    actionCards: hybridContext.actionCards.length ? hybridContext.actionCards : domContext.actionCards,
  };
}

async function collectVisibleScreenOnlyInfographicContext(
  baseContext: CurrentPageContextResult | null,
) {
  const activeTab = await getActiveTab();
  assertPageReadable(activeTab.url);
  const locale = await getActiveUiLocale();
  const screenshotRef = await captureVisibleTab(activeTab);
  const fallbackContext =
    baseContext ??
    createPaperPdfFallbackContext(activeTab, locale) ??
    createGenericSiteFallbackContext(activeTab, locale) ??
    createMinimalVisibleScreenContext(activeTab, locale);
  const adapterPayload = fallbackContext.envelope.adapterPayload;

  return {
    envelope: {
      ...fallbackContext.envelope,
      domSummary:
        fallbackContext.envelope.domSummary ||
        "DOM text was not available. Use the attached visible-screen screenshot as the primary source context.",
      visionAssets: [
        {
          ref: screenshotRef,
          kind: "screenshot" as const,
        },
        ...fallbackContext.envelope.visionAssets,
      ],
    },
    readStrategy: "vision" as const,
    actionCards: fallbackContext.actionCards.length
      ? fallbackContext.actionCards
      : inferActionCards({
          readStrategy: "vision",
          adapterActions: [],
          availableSources: ["current-page"],
          adapterPayload,
          locale,
        }),
  };
}

function createMinimalVisibleScreenContext(
  activeTab: chrome.tabs.Tab & { url: string },
  locale = "",
): CurrentPageContextResult {
  return {
    envelope: {
      metadata: {
        url: activeTab.url,
        title: activeTab.title?.trim() || "Current page",
        domain: parseTabDomain(activeTab.url),
      },
      selectionText: "",
      domSummary: "DOM text was not available. Use the attached visible-screen screenshot as the primary source context.",
      visionAssets: [],
      adapterPayload: null,
      privacyFlags: {
        containsSensitiveFormData: false,
        userConsentedToHistory: false,
      },
    },
    readStrategy: "vision",
    actionCards: inferActionCards({
      readStrategy: "vision",
      adapterActions: [],
      availableSources: ["current-page"],
      adapterPayload: null,
      locale,
    }),
  };
}

function parseTabDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function normalizeInfographicConversationContext(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, 8_000) : "";
}

function normalizeOptionalClientRequestId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
}

function normalizeOptionalConversationId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 160) : undefined;
}

async function buildVoiceSessionStartParamsWithContext(message: Record<string, unknown>): Promise<Record<string, unknown>> {
  const params = buildVoiceSessionStartParams(message, state.threadId);
  if (typeof params.prompt === "string" && params.prompt.trim()) {
    return params;
  }

  const contextPrompt = await collectVoiceSessionContextPrompt();
  return contextPrompt ? { ...params, prompt: contextPrompt } : params;
}

async function collectVoiceSessionContextPrompt(): Promise<string> {
  try {
    const context = await collectCurrentPageContext("hybrid");
    return createVoiceSessionContextPrompt({
      envelope: context.envelope,
      readStrategy: context.readStrategy,
    });
  } catch (error) {
    if (isSitePermissionRequiredError(error) || isBrowserPermissionRequiredError(error)) {
      throw error;
    }

    try {
      const context = await collectCurrentPageContext("dom");
      return createVoiceSessionContextPrompt({
        envelope: context.envelope,
        readStrategy: context.readStrategy,
      });
    } catch (fallbackError) {
      if (isSitePermissionRequiredError(fallbackError) || isBrowserPermissionRequiredError(fallbackError)) {
        throw fallbackError;
      }
      void recordDiagnostic("voice.context.collect.failed", {
        message: toErrorMessage(fallbackError),
      });
      return "";
    }
  }
}

async function handleYouTubeCurrentMomentPrompt() {
  const playbackState = (await sendMessageToActiveTab({
    type: "youtube.current-state",
  })) as Record<string, unknown> | null;
  return createYouTubeCurrentMomentPromptResult({
    adapterPayload: playbackState,
    locale: await getActiveUiLocale(),
  });
}

async function collectCurrentPageContext(readOverride: ReadStrategy | "auto"): Promise<CurrentPageContextResult> {
  const activeTab = await getActiveTab();
  const locale = await getActiveUiLocale();

  assertPageReadable(activeTab.url);
  let probe: ContentProbeResult;
  try {
    probe = (await sendMessageToTab(activeTab, {
      type: "page.collect",
    })) as ContentProbeResult;
  } catch (error) {
    void recordDiagnostic("extension.page_context.dom_failed", {
      url: activeTab.url,
      error: toErrorMessage(error),
    });
    return collectVisibleScreenFallbackContext(activeTab, locale, error);
  }

  const adapterMatched = Boolean(probe.rawCapture.adapterPayload);
  let readStrategy =
    readOverride === "auto"
      ? determineReadStrategy({
          url: activeTab.url,
          textLength: probe.features.textLength,
          imageCount: probe.features.imageCount,
          hasCanvas: probe.features.hasCanvas,
          hasVideo: probe.features.hasVideo,
          hasDenseInteractiveUi: probe.features.hasDenseInteractiveUi,
          adapterMatched,
        })
      : readOverride;
  let screenshotRef: string | undefined;
  if (shouldAttachVisualAssetsForReadStrategy(readStrategy)) {
    try {
      screenshotRef = await captureVisibleTab(activeTab);
    } catch (error) {
      if (readOverride === "auto") {
        console.warn("Falling back to DOM-only page context because screen capture is unavailable.", error);
        readStrategy = "dom";
      } else {
        throw error;
      }
    }
  }
  const envelope = normalizePageContext(createRawCaptureForReadStrategy(probe.rawCapture, readStrategy, screenshotRef));
  const actionCards = inferActionCards({
    readStrategy,
    adapterActions: probe.adapterActions,
    availableSources: ["current-page", ...(probe.rawCapture.images.length ? ["image" as const] : [])],
    adapterPayload: probe.rawCapture.adapterPayload,
    locale,
  });

  return { envelope, readStrategy, actionCards };
}

async function collectVisibleScreenFallbackContext(
  activeTab: chrome.tabs.Tab & { id: number; url: string; windowId: number },
  locale: string,
  sourceError: unknown,
): Promise<CurrentPageContextResult> {
  const fallbackContext =
    createPaperPdfFallbackContext(activeTab, locale) ??
    createGenericSiteFallbackContext(activeTab, locale) ??
    createMinimalVisibleScreenContext(activeTab, locale);
  try {
    const screenshotRef = await captureVisibleTab(activeTab);
    const adapterPayload = fallbackContext.envelope.adapterPayload;
    return {
      envelope: {
        ...fallbackContext.envelope,
        domSummary:
          fallbackContext.envelope.domSummary ||
          "DOM text was not available. Use the attached visible-screen screenshot as the primary source context.",
        visionAssets: [
          {
            ref: screenshotRef,
            kind: "screenshot" as const,
          },
          ...fallbackContext.envelope.visionAssets,
        ],
      },
      readStrategy: "vision" as const,
      actionCards: fallbackContext.actionCards.length
        ? fallbackContext.actionCards
        : inferActionCards({
            readStrategy: "vision",
            adapterActions: [],
            availableSources: ["current-page"],
            adapterPayload,
            locale,
          }),
    };
  } catch (captureError) {
    void recordDiagnostic("extension.page_context.vision_fallback_failed", {
      url: activeTab.url,
      sourceError: toErrorMessage(sourceError),
      captureError: toErrorMessage(captureError),
    });
    return fallbackContext;
  }
}

async function collectAutomaticDocumentAttachments(
  activeTab: chrome.tabs.Tab | null,
  effectiveAttachments: Array<PromptRequestPayload["attachments"][number]>,
  existingAttachments: UserFileAttachment[],
): Promise<UserFileAttachment[]> {
  const baseAttachments = [...existingAttachments];
  if (!activeTab?.url || !effectiveAttachments.includes("current-page")) {
    return baseAttachments;
  }

  const sourceUrl = resolvePaperPdfSourceUrl(activeTab);
  if (!sourceUrl || baseAttachments.some((attachment) => isSameDocumentAttachment(attachment, sourceUrl))) {
    return baseAttachments;
  }

  try {
    const attachment = await fetchPaperPdfAttachment(activeTab);
    return attachment ? [...baseAttachments, attachment] : baseAttachments;
  } catch (error) {
    void recordDiagnostic("extension.pdf_page_context.attachment.failed", {
      url: sourceUrl,
      error: toErrorMessage(error),
    });
    return baseAttachments;
  }
}

// Concurrent sendMessageToTab calls during page load all ping before the
// content script registers its listener, see "no script", and each inject
// another copy. Every injection leaves a delivery record behind, so Chrome
// then fires each page.* message once per record — the agent's click ran
// three times. Serialize injections per tab+frame and wait for the ping
// to come alive before releasing the slot.
const contentScriptInjectionInFlight = new Map<string, Promise<void>>();

async function ensureContentScript(tabId: number, url?: string, frameId = 0): Promise<void> {
  if (await hasActiveContentScript(tabId, frameId)) {
    return;
  }
  const key = `${tabId}:${frameId}`;
  const inFlight = contentScriptInjectionInFlight.get(key);
  if (inFlight) {
    await inFlight;
    return;
  }
  const injection = injectContentScript(tabId, url, frameId).finally(() => {
    contentScriptInjectionInFlight.delete(key);
  });
  contentScriptInjectionInFlight.set(key, injection);
  await injection;
}

async function injectContentScript(tabId: number, url: string | undefined, frameId: number): Promise<void> {
  // The manifest content script registers at document_idle — callers that
  // arrive during load ping before it exists and would inject a duplicate
  // delivery record. Give it a grace window before paying for an injection.
  const graceDeadline = Date.now() + 800;
  while (Date.now() < graceDeadline) {
    if (await hasActiveContentScript(tabId, frameId)) return;
    await sleepMs(100);
  }
  // frameId 0 → top frame only (existing behavior). frameId > 0 → inject
  // just that frame: a subframe added before an extension reload has no
  // content script and would otherwise fail every frame-scoped call.
  const target =
    frameId > 0 ? { tabId, frameIds: [frameId] } : { tabId };
  const doInject = () =>
    chrome.scripting.executeScript({
      target,
      files: ["content.js"],
    });
  try {
    await doInject();
  } catch (error) {
    if (shouldAttemptTabOriginRecovery(url, error) && (await hasTabOriginPermission(url))) {
      try {
        await doInject();
      } catch (retryError) {
        throw toFriendlyPageAccessError(url, retryError);
      }
    } else {
      throw toFriendlyPageAccessError(url, error);
    }
  }
  // executeScript resolves before the script finishes registering its
  // onMessage listener — without this wait the next caller pings too
  // early, sees "no script", and injects a duplicate.
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (await hasActiveContentScript(tabId, frameId)) return;
    await sleepMs(50);
  }
}

async function hasActiveContentScript(tabId: number, frameId = 0): Promise<boolean> {
  try {
    const response = await chrome.tabs.sendMessage(tabId, { type: "page.ping" }, { frameId });
    return typeof response === "object" && response !== null && (response as { ok?: unknown }).ok === true;
  } catch {
    return false;
  }
}

async function getActiveTab() {
  const query =
    typeof state.browserWindowId === "number"
      ? { active: true, windowId: state.browserWindowId }
      : { active: true, currentWindow: true };
  const [tab] = await chrome.tabs.query(query);
  if (!tab?.id || !tab.url || !tab.windowId) {
    throw new Error("No active browser tab is available.");
  }
  return tab as chrome.tabs.Tab & { id: number; url: string; windowId: number };
}

function tabToOpenTabContext(tab: chrome.tabs.Tab & { id: number; url: string }): OpenTabContext {
  const context: OpenTabContext = {
    tabId: tab.id,
    title: tab.title ?? "",
    url: tab.url,
    pinned: Boolean(tab.pinned),
    audible: Boolean(tab.audible),
  };
  if (tab.favIconUrl) {
    context.favIconUrl = tab.favIconUrl;
  }
  return context;
}

async function broadcastActiveTabSnapshot(): Promise<void> {
  const activeTab = await getActiveTab().catch(() => null);
  if (!activeTab) {
    return;
  }
  void installImagePromptHoverForTab(activeTab).catch(() => undefined);
  const currentTab = tabToOpenTabContext(activeTab);
  await chrome.runtime
    .sendMessage({
      type: "ui.active-tab.updated",
      currentPageSupport: getCurrentPageSupport(activeTab.url),
      currentTab,
      actionCards: inferActionCardsForOpenTab(currentTab, await getActiveUiLocale()),
    })
    .catch(() => undefined);
}

const RESTRICTED_CONTENT_SCRIPT_PROTOCOLS = new Set([
  "chrome:",
  "chrome-search:",
  "chrome-extension:",
  "devtools:",
  "edge:",
  "about:",
  "view-source:",
]);

function isRestrictedContentScriptUrl(url: string): boolean {
  try {
    return RESTRICTED_CONTENT_SCRIPT_PROTOCOLS.has(new URL(url).protocol);
  } catch {
    return true;
  }
}

async function installImagePromptHoverForTab(
  tab: chrome.tabs.Tab | undefined | null,
): Promise<{ ok: true; installed: boolean }> {
  if (!tab?.id || !tab.url || !getCurrentPageSupport(tab.url).available || isRestrictedContentScriptUrl(tab.url)) {
    return { ok: true, installed: false };
  }
  const settings = await getStoredSettings();
  if (!settings.imagePromptHoverButtonEnabled) {
    return { ok: true, installed: false };
  }
  try {
    await sendMessageToTab(tab as chrome.tabs.Tab & { id: number; url: string }, {
      type: "page.image-prompt-hover.install",
    });
  } catch (error) {
    if (isRecoverableTabMessagingError(error)) {
      void recordDiagnostic("extension.image_prompt.hover_install.transient_disconnect", {
        tabId: tab.id,
        url: tab.url,
        error: toErrorMessage(error),
      });
      return { ok: true, installed: false };
    }
    throw error;
  }
  return { ok: true, installed: true };
}

function normalizePendingImagePromptExtraction(message: Record<string, unknown>): PendingImagePromptExtraction | null {
  const imageUrl = typeof message.imageUrl === "string" ? message.imageUrl.trim() : "";
  const imageCandidate = normalizePromptImageCandidate(message.imageCandidate, imageUrl);
  const attachment = normalizePromptImageAttachment(message.attachment);
  if (!isSupportedImagePromptSource(imageUrl) || !(attachment || imageCandidate || isFetchableImagePromptSource(imageUrl))) {
    return null;
  }
  return {
    imageUrl,
    createdAt: Date.now(),
    ...(imageCandidate ? { imageCandidate } : {}),
    ...(attachment ? { attachment } : {}),
    ...(typeof message.alt === "string" && message.alt.trim() ? { alt: message.alt.trim().slice(0, 240) } : {}),
    ...(typeof message.pageTitle === "string" && message.pageTitle.trim()
      ? { pageTitle: message.pageTitle.trim().slice(0, 240) }
      : {}),
    ...(typeof message.pageUrl === "string" && message.pageUrl.trim() ? { pageUrl: message.pageUrl.trim() } : {}),
  };
}

function normalizePromptImageCandidate(value: unknown, fallbackUrl: string): EditablePageImageCandidate | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const input = value as Record<string, unknown>;
  const sourceUrl = typeof input.url === "string" && isHttpUrl(input.url.trim()) ? input.url.trim() : fallbackUrl;
  const viewportRect = normalizePromptImageViewportRect(input.viewportRect);
  const viewportWidth = normalizePositiveNumber(input.viewportWidth);
  const viewportHeight = normalizePositiveNumber(input.viewportHeight);
  if (!viewportRect || !viewportWidth || !viewportHeight) {
    return null;
  }

  const candidate: EditablePageImageCandidate = {
    url: sourceUrl,
    viewportRect,
    viewportWidth,
    viewportHeight,
  };
  assignPositiveImageCandidateNumber(candidate, "width", input.width);
  assignPositiveImageCandidateNumber(candidate, "height", input.height);
  assignPositiveImageCandidateNumber(candidate, "naturalWidth", input.naturalWidth);
  assignPositiveImageCandidateNumber(candidate, "naturalHeight", input.naturalHeight);
  assignPositiveImageCandidateNumber(candidate, "renderedWidth", input.renderedWidth);
  assignPositiveImageCandidateNumber(candidate, "renderedHeight", input.renderedHeight);
  assignPositiveImageCandidateNumber(candidate, "visibleArea", input.visibleArea);
  assignPositiveImageCandidateNumber(candidate, "devicePixelRatio", input.devicePixelRatio);
  const distanceFromViewportCenter = normalizeFiniteNumber(input.distanceFromViewportCenter);
  if (distanceFromViewportCenter !== null) {
    candidate.distanceFromViewportCenter = distanceFromViewportCenter;
  }
  return candidate;
}

function assignPositiveImageCandidateNumber(
  candidate: EditablePageImageCandidate,
  key: keyof Pick<
    EditablePageImageCandidate,
    "width" | "height" | "naturalWidth" | "naturalHeight" | "renderedWidth" | "renderedHeight" | "visibleArea" | "devicePixelRatio"
  >,
  value: unknown,
): void {
  const number = normalizePositiveNumber(value);
  if (number !== null) {
    candidate[key] = number;
  }
}

function normalizePromptImageViewportRect(value: unknown): EditablePageImageCandidate["viewportRect"] | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const input = value as Record<string, unknown>;
  const left = normalizeFiniteNumber(input.left);
  const top = normalizeFiniteNumber(input.top);
  const width = normalizePositiveNumber(input.width);
  const height = normalizePositiveNumber(input.height);
  if (left === null || top === null || !width || !height) {
    return null;
  }
  return { left, top, width, height };
}

function normalizePromptImageAttachment(value: unknown): UserFileAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const input = value as Record<string, unknown>;
  const id = typeof input.id === "string" ? input.id.trim().slice(0, 160) : "";
  const name = typeof input.name === "string" ? input.name.trim().slice(0, 180) : "";
  const mimeType = typeof input.mimeType === "string" ? input.mimeType.trim().slice(0, 120) : "image/png";
  const base64 = typeof input.base64 === "string" ? input.base64.trim() : "";
  if (!id || !name || !base64 || input.kind !== "image") {
    return null;
  }
  return {
    id,
    name,
    mimeType: mimeType.startsWith("image/") ? mimeType : "image/png",
    sizeBytes: Math.max(0, Number(input.sizeBytes) || estimateBase64ByteLength(base64)),
    lastModified: Math.max(0, Number(input.lastModified) || Date.now()),
    base64,
    kind: "image",
    ...(typeof input.sourceUrl === "string" && isHttpUrl(input.sourceUrl.trim()) ? { sourceUrl: input.sourceUrl.trim() } : {}),
  };
}

function normalizePositiveNumber(value: unknown): number | null {
  const number = normalizeFiniteNumber(value);
  return number !== null && number > 0 ? number : null;
}

function normalizeFiniteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isSupportedImagePromptSource(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return isHttpUrl(value) || normalized.startsWith("blob:") || normalized.startsWith("data:image/");
}

function isFetchableImagePromptSource(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return isHttpUrl(value) || normalized.startsWith("data:image/");
}

async function handlePageImagePromptExtraction(
  message: Record<string, unknown>,
  tab: chrome.tabs.Tab | undefined,
): Promise<{ ok: true } | { error: string }> {
  const extraction = normalizePendingImagePromptExtraction(message);
  if (!extraction) {
    return { error: "No online image URL was provided." };
  }

  let sidePanelOpenPromise: Promise<void> | null = null;
  if (tab?.windowId) {
    state.browserWindowId = tab.windowId;
    sidePanelOpenPromise = chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  }
  const attachmentPromise = createOnlineImagePromptAttachment(extraction, tab);
  const attachment = await attachmentPromise;
  if (!attachment && !isHttpUrl(extraction.imageUrl)) {
    const error = buildOnlineImagePromptAttachmentError(extraction);
    await chrome.storage.session.set({ pendingImagePromptError: error });
    await sidePanelOpenPromise;
    await chrome.runtime
      .sendMessage({
        type: "ui.image-prompt.error",
        error,
      })
      .catch(() => undefined);
    return { error: "Chromex could not read this page image for prompt extraction." };
  }
  const pendingExtraction = attachment ? { ...extraction, attachment } : extraction;
  await chrome.storage.session.set({ pendingImagePromptExtraction: pendingExtraction });
  await sidePanelOpenPromise;
  await chrome.runtime
    .sendMessage({
      type: "ui.image-prompt.extract",
      extraction: pendingExtraction,
    })
    .catch(() => undefined);
  return { ok: true };
}

async function handlePageImageAttachmentAdd(
  message: Record<string, unknown>,
  tab: chrome.tabs.Tab | undefined,
): Promise<{ ok: true } | { error: string }> {
  const extraction = normalizePendingImagePromptExtraction(message);
  if (!extraction) {
    return { error: "No online image URL was provided." };
  }

  let sidePanelOpenPromise: Promise<void> | null = null;
  if (tab?.windowId) {
    state.browserWindowId = tab.windowId;
    sidePanelOpenPromise = chrome.sidePanel.open({ windowId: tab.windowId }).catch(() => undefined);
  }

  const attachment = await createOnlineImagePromptAttachment(extraction, tab);
  if (!attachment) {
    const error = buildOnlineImagePromptAttachmentError(extraction);
    await chrome.storage.session.set({ pendingImagePromptError: error });
    await sidePanelOpenPromise;
    await chrome.runtime
      .sendMessage({
        type: "ui.image-prompt.error",
        error,
      })
      .catch(() => undefined);
    return { error: "Chromex could not read this page image for attachment." };
  }

  await chrome.storage.session.set({
    pendingImageAttachment: {
      imageUrl: extraction.imageUrl,
      ...(tab?.url || extraction.pageUrl ? { pageUrl: extraction.pageUrl ?? tab?.url } : {}),
      attachment,
      createdAt: Date.now(),
    },
  });
  await chrome.storage.session.remove(["pendingAction", "pendingSelectionContext"]);
  await sidePanelOpenPromise;
  await chrome.runtime.sendMessage({ type: "ui.image-attachment.pending" }).catch(() => undefined);
  return { ok: true };
}

function buildOnlineImagePromptAttachmentError(
  extraction: PendingImagePromptExtraction,
): { code: "attachment-unavailable"; imageUrl: string } {
  return {
    code: "attachment-unavailable",
    imageUrl: extraction.imageUrl,
  };
}

async function createOnlineImagePromptAttachment(
  extraction: PendingImagePromptExtraction,
  tab: chrome.tabs.Tab | undefined,
): Promise<UserFileAttachment | null> {
  if (extraction.attachment) {
    return extraction.attachment;
  }

  const visibleCapture = capturePromptVisibleImage(tab, extraction.imageCandidate);
  const visibleInput = visibleCapture && extraction.imageCandidate
    ? await visibleCapture
        .then((dataUrl) => (dataUrl ? cropVisibleTabDataUrlToImageCandidate(dataUrl, extraction.imageCandidate!) : null))
        .catch((error) => {
          void recordDiagnostic("extension.image_prompt.visible_capture.failed", {
            error: toErrorMessage(error),
          });
          return null;
        })
    : null;
  const input = visibleInput ?? (isFetchableImagePromptSource(extraction.imageUrl)
    ? await fetchImageUrlAsEditableInput(extraction.imageUrl, filenameFromImageUrl(extraction.imageUrl))
        .catch((error) => {
          void recordDiagnostic("extension.image_prompt.remote_fetch.failed", {
            url: extraction.imageUrl,
            error: toErrorMessage(error),
          });
          return null;
        })
    : null);

  if (!input?.base64) {
    return null;
  }

  return {
    id: `online-image-prompt-${Date.now()}`,
    name: input.filename ?? filenameFromImageUrl(extraction.imageUrl),
    mimeType: input.mimeType || "image/png",
    sizeBytes: estimateBase64ByteLength(input.base64),
    lastModified: Date.now(),
    base64: input.base64,
    kind: "image",
    ...(isHttpUrl(extraction.imageUrl) ? { sourceUrl: extraction.imageUrl } : {}),
  };
}

function capturePromptVisibleImage(
  tab: chrome.tabs.Tab | undefined,
  candidate: EditablePageImageCandidate | undefined,
): Promise<string | null> | null {
  if (!tab?.windowId || !candidate?.viewportRect || !candidate.viewportWidth || !candidate.viewportHeight) {
    return null;
  }
  return chrome.tabs.captureVisibleTab(tab.windowId).catch(async (error) => {
    if (!isCaptureVisibleTabQuotaError(error)) {
      throw error;
    }
    await sleepMs(DEFAULT_VISIBLE_TAB_CAPTURE_MIN_INTERVAL_MS);
    return chrome.tabs.captureVisibleTab(tab.windowId);
  });
}

async function takePendingImagePromptExtraction(): Promise<{ extraction?: PendingImagePromptExtraction }> {
  const stored = await chrome.storage.session.get("pendingImagePromptExtraction");
  await chrome.storage.session.remove("pendingImagePromptExtraction");
  const value = stored.pendingImagePromptExtraction;
  if (!value || typeof value !== "object") {
    return {};
  }
  const extraction = normalizePendingImagePromptExtraction(value as Record<string, unknown>);
  return extraction ? { extraction } : {};
}

async function takePendingImagePromptError(): Promise<{ error?: { code: "attachment-unavailable"; imageUrl: string } }> {
  const stored = await chrome.storage.session.get("pendingImagePromptError");
  await chrome.storage.session.remove("pendingImagePromptError");
  const error = normalizePendingImagePromptError(stored.pendingImagePromptError);
  return error ? { error } : {};
}

function normalizePendingImagePromptError(
  value: unknown,
): { code: "attachment-unavailable"; imageUrl: string } | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const input = value as Record<string, unknown>;
  if (input.code !== "attachment-unavailable") {
    return null;
  }
  const imageUrl = typeof input.imageUrl === "string" ? input.imageUrl.trim() : "";
  if (!imageUrl) {
    return null;
  }
  return {
    code: "attachment-unavailable",
    imageUrl,
  };
}

async function takePendingImageAttachment(): Promise<{ attachment?: PendingImageAttachment }> {
  const stored = await chrome.storage.session.get("pendingImageAttachment");
  await chrome.storage.session.remove("pendingImageAttachment");
  const attachment = normalizePendingImageAttachment(stored.pendingImageAttachment);
  return attachment ? { attachment } : {};
}

async function takePendingContextMenuSelection(): Promise<{ selection?: PendingContextMenuSelection }> {
  const stored = await chrome.storage.session.get("pendingSelectionContext");
  await chrome.storage.session.remove("pendingSelectionContext");
  const selection = normalizePendingContextMenuSelection(stored.pendingSelectionContext);
  return selection ? { selection } : {};
}

async function takePendingContextMenuAction(): Promise<{ action?: PendingContextMenuAction }> {
  const stored = await chrome.storage.session.get("pendingAction");
  await chrome.storage.session.remove("pendingAction");
  const action = normalizePendingContextMenuAction(stored.pendingAction);
  return action ? { action } : {};
}

async function takePendingDictationShortcut(): Promise<{ shortcut?: PendingDictationShortcut }> {
  const stored = await chrome.storage.session.get("pendingDictationShortcut");
  await chrome.storage.session.remove("pendingDictationShortcut");
  const shortcut = normalizePendingDictationShortcut(stored.pendingDictationShortcut);
  return shortcut ? { shortcut } : {};
}

function normalizePendingContextMenuAction(value: unknown): PendingContextMenuAction | null {
  return value === "summarize-page" || value === "summarize-video" ? value : null;
}

function createPendingSelectionContext(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
): PendingContextMenuSelection | null {
  const text = normalizePendingSelectionText(info.selectionText);
  const url = normalizePendingSelectionUrl(info.pageUrl) || normalizePendingSelectionUrl(tab?.url);
  if (!text || !url) {
    return null;
  }
  const domain = getPendingSelectionDomain(url);
  const title = normalizePendingSelectionLabel(tab?.title) || domain || "Selected page text";
  const favIconUrl = normalizePendingSelectionLabel(tab?.favIconUrl);
  return {
    text,
    url,
    title,
    domain,
    ...(typeof tab?.id === "number" ? { tabId: tab.id } : {}),
    ...(favIconUrl ? { favIconUrl } : {}),
  };
}

async function createPendingSelectionContextWithPageSnapshot(
  info: chrome.contextMenus.OnClickData,
  tab?: chrome.tabs.Tab,
): Promise<PendingContextMenuSelection | null> {
  const context = createPendingSelectionContext(info, tab);
  const readableTab = getReadableSelectionSnapshotTab(tab);
  if (!context || !readableTab) {
    return context;
  }

  const snapshot = await sendMessageToTab(readableTab, { type: "page.selection.snapshot" }).catch(() => null);
  if (!snapshot || typeof snapshot !== "object") {
    return context;
  }
  return mergePendingSelectionSnapshotContext(context, snapshot as Record<string, unknown>);
}

function normalizePendingContextMenuSelection(value: unknown): PendingContextMenuSelection | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  const text = normalizePendingSelectionText(record.text);
  const url = normalizePendingSelectionUrl(record.url);
  if (!text || !url) {
    return null;
  }
  const domain = normalizePendingSelectionLabel(record.domain) || getPendingSelectionDomain(url);
  const title = normalizePendingSelectionLabel(record.title) || domain || "Selected page text";
  const tabId = Number(record.tabId);
  const favIconUrl = normalizePendingSelectionLabel(record.favIconUrl);
  const contextText = normalizePendingSelectionContextText(record.contextText);
  return {
    text,
    ...(contextText ? { contextText } : {}),
    url,
    title,
    domain,
    ...(Number.isFinite(tabId) ? { tabId } : {}),
    ...(favIconUrl ? { favIconUrl } : {}),
  };
}

function normalizePendingSelectionText(value: unknown): string {
  return typeof value === "string"
    ? value.replace(/\s+/gu, " ").trim().slice(0, SELECTED_PAGE_TEXT_CONTEXT_MAX_CHARS)
    : "";
}

function normalizePendingSelectionContextText(value: unknown): string {
  return normalizeSelectedTextContext(value, SELECTED_PAGE_TEXT_CONTEXT_MAX_CHARS);
}

function getReadableSelectionSnapshotTab(
  tab?: chrome.tabs.Tab,
): (chrome.tabs.Tab & { id: number; url: string }) | null {
  return typeof tab?.id === "number" && typeof tab.url === "string" && tab.url.trim()
    ? (tab as chrome.tabs.Tab & { id: number; url: string })
    : null;
}

function mergePendingSelectionSnapshotContext(
  context: PendingContextMenuSelection,
  snapshot: Record<string, unknown>,
): PendingContextMenuSelection {
  const snapshotText = normalizePendingSelectionText(snapshot.text);
  const contextText = normalizePendingSelectionContextText(snapshot.contextText);
  if (!contextText || !doesSelectionSnapshotMatchContext(context.text, snapshotText, contextText)) {
    return context;
  }
  return {
    ...context,
    contextText,
  };
}

function doesSelectionSnapshotMatchContext(
  contextText: string,
  snapshotText: string,
  snapshotContextText: string,
): boolean {
  if (!snapshotText) {
    return false;
  }
  return (
    snapshotText === contextText ||
    snapshotText.includes(contextText) ||
    contextText.includes(snapshotText) ||
    snapshotContextText.includes(contextText)
  );
}

function normalizePendingSelectionUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    return "";
  }
}

function normalizePendingSelectionLabel(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, 240) : "";
}

function getPendingSelectionDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function normalizePendingDictationShortcut(value: unknown): PendingDictationShortcut | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const input = value as Record<string, unknown>;
  const requestId = typeof input.requestId === "string" ? input.requestId.trim() : "";
  if (!requestId) {
    return null;
  }
  return {
    requestId,
    createdAt: Math.max(0, Number(input.createdAt) || Date.now()),
  };
}

function normalizePendingImageAttachment(value: unknown): PendingImageAttachment | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const input = value as Record<string, unknown>;
  const imageUrl = typeof input.imageUrl === "string" ? input.imageUrl.trim() : "";
  const attachment = normalizePromptImageAttachment(input.attachment);
  if (!attachment && !isFetchableImagePromptSource(imageUrl)) {
    return null;
  }
  return {
    imageUrl: imageUrl || attachment?.sourceUrl || "",
    createdAt: Math.max(0, Number(input.createdAt) || Date.now()),
    ...(attachment ? { attachment } : {}),
    ...(typeof input.pageUrl === "string" && input.pageUrl.trim() ? { pageUrl: input.pageUrl.trim() } : {}),
  };
}

async function sendMessageToActiveTab(message: Record<string, unknown>) {
  const activeTab = await getActiveTab();
  assertPageReadable(activeTab.url);
  return sendMessageToTab(activeTab, message);
}

async function sendPageDomPerformWithIndicator(steps: unknown): Promise<unknown> {
  const controlTab = await getActiveTab();
  assertPageReadable(controlTab.url);
  await startTabAiControlIndicator(controlTab, "dom", "Codex is controlling this page");
  try {
    return await sendMessageToTab(controlTab, { type: "page.dom.perform", steps });
  } finally {
    await stopTabAiControlIndicator(controlTab, 0);
  }
}

async function startActiveTabAiControlIndicator(mode: BrowserAutomationMode, label: string): Promise<void> {
  const controlTab = await getActiveTab();
  assertPageReadable(controlTab.url);
  await startTabAiControlIndicator(controlTab, mode, label);
}

async function startTabAiControlIndicator(controlTab: ReadableBrowserTab, mode: BrowserAutomationMode, label: string): Promise<void> {
  activeAiControlTab = controlTab;
  await sendMessageToTab(controlTab, {
    type: "page.ai-control.start",
    mode,
    label,
  }).catch(() => undefined);
}

async function stopActiveTabAiControlIndicator(delayMs: number): Promise<void> {
  const controlTab = await getActiveTab();
  assertPageReadable(controlTab.url);
  await stopTabAiControlIndicator(controlTab, delayMs);
}

async function stopCurrentAiControlIndicator(delayMs: number): Promise<void> {
  if (activeAiControlTab) {
    await stopTabAiControlIndicator(activeAiControlTab, delayMs);
    return;
  }
  await stopActiveTabAiControlIndicator(delayMs).catch(() => undefined);
}

async function stopTabAiControlIndicator(controlTab: ReadableBrowserTab, delayMs: number): Promise<void> {
  try {
    await sendMessageToTab(controlTab, {
      type: "page.ai-control.stop",
      delayMs,
    }).catch(() => undefined);
  } finally {
    if (activeAiControlTab?.id === controlTab.id) {
      activeAiControlTab = null;
    }
  }
}

async function listOpenTabs(): Promise<OpenTabContext[]> {
  const granted = await ensureTabsPermission();
  if (!granted) {
    throw new Error("Open-tab access permission is required to list your tabs.");
  }

  const tabs = await chrome.tabs.query({});
  return tabs
    .filter((tab): tab is chrome.tabs.Tab & { id: number; url: string; title: string } => Boolean(tab.id && tab.url && tab.title))
    .map((tab) => {
      const context: OpenTabContext = {
        tabId: tab.id,
        title: tab.title,
        url: tab.url,
        pinned: tab.pinned,
        audible: Boolean(tab.audible),
      };
      if (tab.favIconUrl) {
        context.favIconUrl = tab.favIconUrl;
      }
      return context;
    });
}

function listOpenTabsResult(): Promise<{ tabs: OpenTabContext[] }> {
  return listOpenTabs().then((tabs) => ({ tabs }));
}

async function searchHistory(query: string) {
  const granted = await ensureHistoryPermission();
  if (!granted) {
    return { items: [] };
  }

  const items = await chrome.history.search(createHistorySearchOptions(query));
  return {
    items: limitHistoryContextItems(
      items
        .map((item): HistoryContextItem => ({
          title: item.title ?? item.url ?? "Untitled",
          url: item.url ?? "",
          ...(typeof item.lastVisitTime === "number" ? { lastVisitTime: item.lastVisitTime } : {}),
          ...(typeof item.visitCount === "number" ? { visitCount: item.visitCount } : {}),
        }))
        .filter((item) => item.url)
        .sort((left, right) => {
          const leftSearch = extractSearchQueryFromHistoryUrl(left.url);
          const rightSearch = extractSearchQueryFromHistoryUrl(right.url);
          if (leftSearch && !rightSearch) {
            return -1;
          }
          if (!leftSearch && rightSearch) {
            return 1;
          }
          return (right.lastVisitTime ?? 0) - (left.lastVisitTime ?? 0);
        }),
    ),
  };
}

function tabToEnvelope(tab: OpenTabContext): PageContextEnvelope {
  return {
    metadata: {
      url: tab.url,
      title: tab.title,
      domain: new URL(tab.url).hostname,
    },
    selectionText: "",
    domSummary: `Open tab: ${tab.title}\n${tab.url}`,
    visionAssets: [],
    adapterPayload: null,
    privacyFlags: {
      containsSensitiveFormData: false,
      userConsentedToHistory: false,
    },
  };
}

function normalizeSelectedPageTextContext(
  context: PromptRequestPayload["selectedTextContext"],
  activeTab: chrome.tabs.Tab | null,
): SelectedPageTextContext | null {
  if (!context || typeof context !== "object") {
    return null;
  }
  const text = normalizeSelectedContextText(context.text);
  if (!text) {
    return null;
  }
  const url = normalizeSelectedContextUrl(context.url) || normalizeSelectedContextUrl(activeTab?.url);
  if (!url) {
    return null;
  }
  const activeTabUrl = normalizeSelectedContextUrl(activeTab?.url);
  if (activeTabUrl && activeTabUrl !== url) {
    return null;
  }
  const domain = context.domain?.trim() || parseTabDomain(url);
  const title = context.title?.trim() || activeTab?.title?.trim() || domain || "Selected page text";
  const tabId = Number(context.tabId);
  const activeTabId = Number(activeTab?.id);
  if (Number.isFinite(tabId) && Number.isFinite(activeTabId) && tabId !== activeTabId) {
    return null;
  }
  const favIconUrl = context.favIconUrl?.trim() || activeTab?.favIconUrl?.trim() || "";
  const contextText = normalizeSelectedContextFullText(context.contextText);
  return {
    text,
    ...(contextText ? { contextText } : {}),
    url,
    title,
    domain,
    ...(Number.isFinite(tabId) ? { tabId } : Number.isFinite(activeTabId) ? { tabId: activeTabId } : {}),
    ...(favIconUrl ? { favIconUrl } : {}),
  };
}

function createSelectionContextEnvelope(context: SelectedPageTextContext): PageContextEnvelope {
  return {
    metadata: {
      url: context.url,
      title: context.title,
      domain: context.domain || parseTabDomain(context.url),
    },
    selectionText: context.text,
    domSummary: context.contextText || createSelectionFocusedDomSummary(context.text),
    visionAssets: [],
    adapterPayload: null,
    privacyFlags: {
      containsSensitiveFormData: false,
      userConsentedToHistory: false,
    },
  };
}

function normalizeSelectedContextText(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/gu, " ").trim().slice(0, 12_000) : "";
}

function normalizeSelectedContextFullText(value: unknown): string {
  return normalizeSelectedTextContext(value, 12_000);
}

function createSelectionFocusedDomSummary(selectedText: string, pageContextText = ""): string {
  const normalizedContext = normalizeSelectedContextFullText(pageContextText);
  if (!normalizedContext) {
    return `Selected text focus: ${selectedText}`;
  }
  return [
    "Selected text in page context:",
    `Selected text:\n${selectedText}`,
    "Page context:",
    normalizedContext,
  ].join("\n\n");
}

function normalizeSelectedContextUrl(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  try {
    return new URL(trimmed).toString();
  } catch {
    return "";
  }
}

async function getEditableImageInput() {
  const activeTab = await getActiveTab();
  void recordDiagnostic("extension.image.input.resolve.start", {
    tabId: activeTab.id,
    url: activeTab.url,
  });
  const visiblePageImage = await getVisiblePageImageInput(activeTab).catch(() => null);
  if (visiblePageImage) {
    void recordDiagnostic("extension.image.input.visible-page.ready", {
      mimeType: visiblePageImage.mimeType,
      filename: visiblePageImage.filename ?? null,
    });
    return visiblePageImage;
  }

  const dataUrl = await captureVisibleTab(activeTab);
  const input = await dataUrlToEditableJpegInput(dataUrl, "visible-tab.jpg");
  void recordDiagnostic("extension.image.input.visible-tab.ready", {
    mimeType: input.mimeType,
    filename: input.filename ?? null,
  });
  return input;
}

async function getVisiblePageImageInput(activeTab: chrome.tabs.Tab & { id: number; url: string; windowId: number }) {
  assertPageReadable(activeTab.url);
  const probe = (await sendMessageToTab(activeTab, {
    type: "page.collect",
  })) as ContentProbeResult;
  const candidate = selectEditablePageImageCandidate(probe.rawCapture.images);
  if (!candidate) {
    void recordDiagnostic("extension.image.input.visible-page.missing", {
      candidateCount: probe.rawCapture.images.length,
    });
    return null;
  }
  void recordDiagnostic("extension.image.input.visible-page.candidate", {
    url: candidate.url,
    renderedWidth: candidate.renderedWidth ?? candidate.viewportRect?.width ?? null,
    renderedHeight: candidate.renderedHeight ?? candidate.viewportRect?.height ?? null,
    visibleArea: candidate.visibleArea ?? null,
  });

  try {
    return await fetchImageUrlAsEditableInput(candidate.url, filenameFromImageUrl(candidate.url));
  } catch (error) {
    void recordDiagnostic("extension.image.input.visible-page.fetch.failed", {
      url: candidate.url,
      error: toErrorMessage(error),
    });
    return cropVisibleTabToImageCandidate(activeTab, candidate);
  }
}

async function fetchImageUrlAsEditableInput(url: string | undefined, fallbackFilename: string) {
  if (!url) {
    throw new Error("No page image URL is available.");
  }

  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Image request failed with HTTP ${response.status}.`);
  }

  const blob = await response.blob();
  if (blob.type && !blob.type.startsWith("image/")) {
    throw new Error(`Expected an image response, received ${blob.type}.`);
  }

  return imageBlobToEditableJpegInput(blob, fallbackFilename, blob.type || mimeTypeFromImageUrl(url));
}

async function cropVisibleTabToImageCandidate(
  activeTab: chrome.tabs.Tab & { url: string; windowId: number },
  candidate: EditablePageImageCandidate,
) {
  if (!candidate.viewportRect || !candidate.viewportWidth || !candidate.viewportHeight) {
    return null;
  }
  const dataUrl = await captureVisibleTab(activeTab);
  return cropVisibleTabDataUrlToImageCandidate(dataUrl, candidate);
}

async function cropVisibleTabDataUrlToImageCandidate(
  dataUrl: string,
  candidate: EditablePageImageCandidate,
) {
  if (!candidate.viewportRect || !candidate.viewportWidth || !candidate.viewportHeight) {
    return null;
  }
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    return cropVisibleTabDataUrlToImageCandidateViaOffscreenDocument(dataUrl, candidate);
  }

  const sourceBlob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(sourceBlob);
  const crop = getVisibleImageCropRect(candidate, bitmap.width, bitmap.height);
  if (!crop) {
    return null;
  }

  const canvas = new OffscreenCanvas(crop.width, crop.height);
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }

  context.drawImage(bitmap, crop.left, crop.top, crop.width, crop.height, 0, 0, crop.width, crop.height);
  const outputBlob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
  void recordDiagnostic("extension.image.input.visible-page.crop.ready", {
    width: crop.width,
    height: crop.height,
  });
  return {
    base64: await blobToBase64(outputBlob),
    mimeType: "image/jpeg",
    filename: "visible-page-image.jpg",
  };
}

async function cropVisibleTabDataUrlToImageCandidateViaOffscreenDocument(
  dataUrl: string,
  candidate: EditablePageImageCandidate,
): Promise<{ base64: string; mimeType: string; filename: string } | null> {
  const ensured = await ensureOffscreenDocumentForImageProcessing();
  if (!ensured) {
    return null;
  }
  const response = await chrome.runtime.sendMessage({
    target: "offscreen",
    type: OFFSCREEN_IMAGE_CROP_MESSAGE_TYPE,
    dataUrl,
    candidate,
  });
  if (!response || typeof response !== "object") {
    return null;
  }
  const output = response as Record<string, unknown>;
  const base64 = typeof output.base64 === "string" ? output.base64.trim() : "";
  const mimeType = typeof output.mimeType === "string" ? output.mimeType.trim() : "";
  const filename = typeof output.filename === "string" ? output.filename.trim() : "";
  if (!base64 || !mimeType || !filename) {
    return null;
  }
  return {
    base64,
    mimeType,
    filename,
  };
}

async function ensureOffscreenDocumentForImageProcessing(): Promise<boolean> {
  if (!chrome.offscreen?.createDocument) {
    return false;
  }
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);
  const runtimeWithContexts = chrome.runtime as typeof chrome.runtime & {
    getContexts?: (filter: {
      contextTypes?: string[];
      documentUrls?: string[];
    }) => Promise<Array<Record<string, unknown>>>;
  };
  if (typeof runtimeWithContexts.getContexts === "function") {
    const contexts = await runtimeWithContexts
      .getContexts({
        contextTypes: ["OFFSCREEN_DOCUMENT"],
        documentUrls: [offscreenUrl],
      })
      .catch(() => []);
    if (contexts.length) {
      return true;
    }
  }
  if (offscreenDocumentPromise) {
    await offscreenDocumentPromise;
    return true;
  }
  offscreenDocumentPromise = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_DOCUMENT_PATH,
      reasons: [chrome.offscreen.Reason.BLOBS],
      justification: "Crop captured tab images for prompt extraction compatibility.",
    })
    .catch((error) => {
      if (!isOffscreenDocumentAlreadyExistsError(error)) {
        throw error;
      }
    })
    .finally(() => {
      offscreenDocumentPromise = null;
    });
  await offscreenDocumentPromise;
  return true;
}

function isOffscreenDocumentAlreadyExistsError(error: unknown): boolean {
  return toErrorMessage(error).toLowerCase().includes("single offscreen document");
}

async function recordDiagnostic(event: string, details: Record<string, unknown> = {}): Promise<void> {
  await bridge
    .request("diagnostics.log.write", {
      event,
      details,
    })
    .catch((error) =>
      degradedReport("diagnostics.log.write", "diagnostics.log.write failed; diagnostic event dropped", error),
    );
}

async function dataUrlToEditableJpegInput(dataUrl: string, fallbackFilename: string) {
  const blob = await (await fetch(dataUrl)).blob();
  return imageBlobToEditableJpegInput(blob, fallbackFilename, blob.type || "image/png");
}

async function imageBlobToEditableJpegInput(blob: Blob, fallbackFilename: string, originalMimeType: string) {
  const jpegBlob = await convertImageBlobToJpeg(blob).catch(() => null);
  const outputBlob = jpegBlob ?? blob;
  const outputMimeType = jpegBlob ? "image/jpeg" : originalMimeType || outputBlob.type || "image/png";
  return {
    base64: await blobToBase64(outputBlob),
    mimeType: outputMimeType,
    filename: filenameWithMimeExtension(fallbackFilename, outputMimeType),
  };
}

async function convertImageBlobToJpeg(blob: Blob): Promise<Blob | null> {
  if (typeof createImageBitmap !== "function" || typeof OffscreenCanvas === "undefined") {
    return null;
  }
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  if (!context) {
    return null;
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, bitmap.width, bitmap.height);
  context.drawImage(bitmap, 0, 0);
  return canvas.convertToBlob({ type: "image/jpeg", quality: 0.92 });
}

function filenameWithMimeExtension(filename: string, mimeType: string): string {
  const extension =
    mimeType === "image/jpeg"
      ? "jpg"
      : mimeType === "image/webp"
        ? "webp"
        : mimeType === "image/gif"
          ? "gif"
          : "png";
  return filename.replace(/\.[a-z0-9]+$/iu, "") + `.${extension}`;
}

function getVisibleImageCropRect(
  candidate: EditablePageImageCandidate,
  bitmapWidth: number,
  bitmapHeight: number,
): { left: number; top: number; width: number; height: number } | null {
  const rect = candidate.viewportRect;
  const viewportWidth = candidate.viewportWidth ?? 0;
  const viewportHeight = candidate.viewportHeight ?? 0;
  if (!rect || viewportWidth <= 0 || viewportHeight <= 0) {
    return null;
  }

  const cssLeft = clampNumber(rect.left, 0, viewportWidth);
  const cssTop = clampNumber(rect.top, 0, viewportHeight);
  const cssRight = clampNumber(rect.left + rect.width, 0, viewportWidth);
  const cssBottom = clampNumber(rect.top + rect.height, 0, viewportHeight);
  if (cssRight - cssLeft < 24 || cssBottom - cssTop < 24) {
    return null;
  }

  const scaleX = bitmapWidth / viewportWidth;
  const scaleY = bitmapHeight / viewportHeight;
  const left = Math.max(0, Math.floor(cssLeft * scaleX));
  const top = Math.max(0, Math.floor(cssTop * scaleY));
  const right = Math.min(bitmapWidth, Math.ceil(cssRight * scaleX));
  const bottom = Math.min(bitmapHeight, Math.ceil(cssBottom * scaleY));
  const width = right - left;
  const height = bottom - top;
  return width > 0 && height > 0 ? { left, top, width, height } : null;
}

function filenameFromImageUrl(url: string): string {
  if (url.startsWith("data:") || url.startsWith("blob:")) {
    return "page-image.png";
  }

  try {
    const pathname = new URL(url).pathname;
    const filename = pathname.split("/").filter(Boolean).at(-1)?.trim();
    return filename || "page-image.png";
  } catch {
    return "page-image.png";
  }
}

function mimeTypeFromImageUrl(url: string): string {
  const extension = filenameFromImageUrl(url).split(".").at(-1)?.toLowerCase();
  switch (extension) {
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "webp":
      return "image/webp";
    case "gif":
      return "image/gif";
    case "svg":
      return "image/svg+xml";
    case "png":
    default:
      return "image/png";
  }
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
  return dataUrl.split(",", 2)[1] ?? "";
}

function estimateBase64ByteLength(base64: string): number {
  const clean = base64.replace(/\s+/gu, "");
  if (!clean) {
    return 0;
  }
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

async function refreshAppServerCatalog(
  workspaceRoot?: string,
  options: { force?: boolean } = {},
): Promise<void> {
  state.modelCatalogState = "loading";
  state.modelCatalogErrorMessage = "";
  const normalizedWorkspaceRoot = normalizeCatalogWorkspaceRoot(workspaceRoot ?? (await getWorkspaceHarness()).workspaceRoot);
  const cwd = normalizedWorkspaceRoot || undefined;
  let modelRequestFailed = false;
  let modelRequestErrorMessage = "";
  const previousModels = state.models;
  const catalogSettings = await getStoredSettings().catch(() => null);
  state.selectedProviderId = catalogSettings?.agentProviderId || "codex";
  // SWR: paint the last known catalog instantly on cold service-worker
  // start; the fetches below revalidate and overwrite it.
  const cachedCatalog = await readCatalogCache();
  if (
    cachedCatalog &&
    isCatalogCacheFresh(cachedCatalog) &&
    catalogCacheMatches(cachedCatalog, {
      workspaceRoot: normalizedWorkspaceRoot,
      providerId: state.selectedProviderId,
      customModels: catalogSettings?.customModels ?? [],
    })
  ) {
    state.models = cachedCatalog.models;
    state.agentProviders = cachedCatalog.agentProviders;
    state.appServerSkills = cachedCatalog.appServerSkills;
    state.connectedApps = cachedCatalog.connectedApps;
    state.appServerPlugins = cachedCatalog.appServerPlugins;
    state.mcpServers = cachedCatalog.mcpServers;
    state.serverThreads = cachedCatalog.serverThreads;
    state.rateLimits = cachedCatalog.rateLimits;
    state.modelCatalogState = cachedCatalog.models.length ? "ready" : "empty";
    state.modelCatalogErrorMessage = "";
  }
  if (catalogSettings?.gatewayMode) {
    const catalogs = await bridge
      .request<{ catalogs?: Array<{ providerId: string; displayName?: string }> }>(
        "provider.catalog",
        {},
      )
      .then((r) => r.catalogs ?? [])
      .catch((error) => {
        degradedReport("provider.catalog", "provider.catalog failed; falling back to built-in providers", error);
        return [] as Array<{ providerId: string; displayName?: string }>;
      });
    const providers = catalogs.map((c) => ({
      id: c.providerId,
      label: c.displayName ?? c.providerId,
    }));
    state.agentProviders = providers.length
      ? providers
      : [{ id: "codex", label: "Codex" }];
  } else {
    state.agentProviders = [{ id: "codex", label: "Codex" }];
  }
  const [models, serverThreads, appServerSkills, connectedApps, appServerPlugins, mcpServers, rateLimits] = await Promise.all([
    bridge.request<CodexModelOption[]>("model.list", {
      providerId: state.selectedProviderId,
    }).catch((error) => {
      modelRequestFailed = true;
      modelRequestErrorMessage = toErrorMessage(error);
      console.warn("model.list failed", error);
      return isRecoverableModelCatalogAuthError(modelRequestErrorMessage)
        ? recoverModelCatalogAfterAuthError({
            previousModels,
            selectedModel: state.selectedModel,
          })
        : [];
    }),
    bridge.request<CodexThreadSummary[]>("thread.list", {
      ...(cwd ? { cwd } : {}),
      limit: 12,
    }).catch((error) => reportDegradedCatalogList(state.serverThreads, "thread.list", error, degradedReport)),
    bridge.request<CodexSkillOption[]>("skills.list", {
      ...(cwd ? { cwd } : {}),
      forceReload: true,
    }).catch((error) => reportDegradedCatalogList(state.appServerSkills, "skills.list", error, degradedReport)),
    bridge.request<CodexAppOption[]>("apps.list", {
      ...(options.force ? { forceRefetch: true } : {}),
    }).catch((error) => reportDegradedCatalogList(state.connectedApps, "apps.list", error, degradedReport)),
    bridge.request<CodexPluginOption[]>("plugins.list", {
      ...(cwd ? { cwd } : {}),
    }).catch((error) => reportDegradedCatalogList(state.appServerPlugins, "plugins.list", error, degradedReport)),
    bridge.request<CodexMcpServerOption[]>("mcp.servers.list", {
      detail: "toolsAndAuthOnly",
      limit: 100,
    }).catch((error) => reportDegradedCatalogList(state.mcpServers, "mcp.servers.list", error, degradedReport)),
    bridge.request<CodexRateLimits | null>("account.rate_limits.read").catch((error) => {
      degradedReport("account.rate_limits.read", "account.rate_limits.read failed; keeping previous rate limits", error);
      return state.rateLimits;
    }),
  ]);

  // customModels applies to providers that accept free-form model ids
  // (codex app-server model, claude --model via SDK options).
  state.models =
    state.selectedProviderId === "codex" || state.selectedProviderId === "claude"
      ? mergeCustomCatalogModels(models, catalogSettings?.customModels ?? [])
      : models;
  state.serverThreads = serverThreads;
  state.appServerSkills = appServerSkills;
  state.connectedApps = connectedApps;
  state.appServerPlugins = appServerPlugins;
  state.mcpServers = mcpServers;
  state.rateLimits = rateLimits;
  state.modelCatalogState = resolveCatalogModelState({
    modelRequestFailed: modelRequestFailed && !isRecoverableModelCatalogAuthError(modelRequestErrorMessage),
    models,
  });
  state.modelCatalogErrorMessage =
    modelRequestFailed && !isRecoverableModelCatalogAuthError(modelRequestErrorMessage) ? modelRequestErrorMessage : "";
  void writeCatalogCache({
    savedAt: Date.now(),
    workspaceRoot: normalizedWorkspaceRoot,
    providerId: state.selectedProviderId,
    customModels: [...(catalogSettings?.customModels ?? [])],
    models: state.models,
    agentProviders: state.agentProviders,
    appServerSkills: state.appServerSkills,
    connectedApps: state.connectedApps,
    appServerPlugins: state.appServerPlugins,
    mcpServers: state.mcpServers,
    serverThreads: state.serverThreads,
    rateLimits: state.rateLimits,
  });
  await reconcileSelectedModelWithCatalog(state.selectedModel);
}

async function reconcileSelectedModelWithCatalog(requestedModel: string | null | undefined): Promise<string> {
  const nextModel = state.models.length
    ? resolveSelectedCatalogModel({
        selectedModel: requestedModel,
        models: state.models,
      })
    : (requestedModel?.trim() ?? "");
  state.selectedModel = nextModel;
  await setSelectedModel(nextModel);
  return nextModel;
}

async function persistSelectedModelControls(input: {
  model: string | null | undefined;
  reasoningEffort?: string;
  serviceTier?: string;
}): Promise<void> {
  await reconcileSelectedModelWithCatalog(input.model ?? state.selectedModel);
  if (typeof input.reasoningEffort === "string") {
    state.selectedReasoningEffort = input.reasoningEffort.trim();
    await setSelectedReasoningEffort(state.selectedReasoningEffort);
  }
  if (typeof input.serviceTier === "string") {
    state.selectedServiceTier = input.serviceTier.trim();
    await setSelectedServiceTier(state.selectedServiceTier);
  }
}

async function handleSkillArchiveInstall(
  filename: string | undefined,
  base64: string | undefined,
): Promise<SkillArchiveInstallResult> {
  const workspaceRoot = normalizeCatalogWorkspaceRoot((await getWorkspaceHarness()).workspaceRoot);
  const result = await bridge.request<SkillArchiveInstallResult>("skills.archive.install", {
    filename: filename ?? "skills.zip",
    base64: base64 ?? "",
    ...(workspaceRoot ? { cwd: workspaceRoot } : {}),
  });
  state.appServerSkills = mergeCodexSkills(state.appServerSkills, result.skills);
  await triggerCatalogRefresh(workspaceRoot || undefined, { force: true });
  state.appServerSkills = mergeCodexSkills(state.appServerSkills, result.skills);
  return result;
}

async function refreshPlaywrightRuntime(): Promise<UiInitPayload["playwrightRuntime"]> {
  const runtime = await bridge.request<UiInitPayload["playwrightRuntime"]>("runtime.playwright.status");
  state.playwrightRuntime = runtime;
  return runtime;
}

async function installPlaywrightRuntime(): Promise<UiInitPayload["playwrightRuntime"]> {
  const runtime = await bridge.request<UiInitPayload["playwrightRuntime"]>(
    "runtime.playwright.install",
    {},
    {
      timeoutMs: PLAYWRIGHT_RUNTIME_INSTALL_TIMEOUT_MS,
      timeoutMessage: "Playwright Chromium install timed out.",
    },
  );
  state.playwrightRuntime = runtime;
  return runtime;
}

function mergeCodexSkills(left: CodexSkillOption[], right: CodexSkillOption[]): CodexSkillOption[] {
  const byId = new Map<string, CodexSkillOption>();
  for (const skill of [...left, ...right]) {
    byId.set(skill.id, skill);
  }
  return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name));
}

async function refreshCatalogKind(kind: "skills" | "apps" | "mcp"): Promise<void> {
  const cwd = normalizeCatalogWorkspaceRoot(state.workspaceHarness?.workspaceRoot) || undefined;
  if (kind === "skills") {
    state.appServerSkills = await bridge
      .request<CodexSkillOption[]>("skills.list", { ...(cwd ? { cwd } : {}), forceReload: true })
      .catch((error) => reportDegradedCatalogList(state.appServerSkills, "skills.list", error, degradedReport));
  } else if (kind === "apps") {
    state.connectedApps = await bridge
      .request<CodexAppOption[]>("apps.list", { forceRefetch: true })
      .catch((error) => reportDegradedCatalogList(state.connectedApps, "apps.list", error, degradedReport));
  } else {
    state.mcpServers = await bridge
      .request<CodexMcpServerOption[]>("mcp.servers.list", { detail: "toolsAndAuthOnly", limit: 100 })
      .catch((error) => reportDegradedCatalogList(state.mcpServers, "mcp.servers.list", error, degradedReport));
  }
  broadcastBridgeEvent({ type: "catalog.updated" });
}

function triggerCatalogRefresh(
  workspaceRoot?: string,
  options: {
    force?: boolean;
  } = {},
): Promise<void> {
  if (
    !shouldTriggerCatalogRefresh({
      inFlight: Boolean(state.catalogRefreshPromise),
      lastRequestedWorkspaceRoot: state.lastRequestedCatalogWorkspaceRoot,
      workspaceRoot,
      force: options.force,
    })
  ) {
    return state.catalogRefreshPromise ?? Promise.resolve();
  }

  if (state.catalogRefreshPromise) {
    return state.catalogRefreshPromise;
  }

  state.lastRequestedCatalogWorkspaceRoot = normalizeCatalogWorkspaceRoot(workspaceRoot);
  state.catalogRefreshPromise = refreshAppServerCatalog(workspaceRoot, options.force ? { force: true } : {})
    .catch((error) => {
      state.modelCatalogState = "error";
      state.modelCatalogErrorMessage = toErrorMessage(error);
      console.warn("catalog refresh failed", error);
    })
    .finally(() => {
      broadcastBridgeEvent({ type: "catalog.updated" });
      state.catalogRefreshPromise = null;
    });

  return state.catalogRefreshPromise;
}

async function startNewConversation(profileId?: string, model?: string) {
  state.threadId = undefined;
  state.activeTurn = null;
  state.latestPlan = null;
  state.latestDiff = null;
  state.latestReroute = null;
  state.lastAutoCompactThreadId = "";
  state.lastAutoCompactBucket = null;
  const nextProfileId = normalizeSelectedProfileId(profileId ?? state.selectedProfileId);
  const nextModel = state.models.length
    ? resolveSelectedCatalogModel({ selectedModel: model ?? state.selectedModel, models: state.models })
    : (model ?? state.selectedModel);
  const conversation = await createConversation(nextProfileId, nextModel);
  conversationRuntime.resetConversation(conversation.id);
  state.currentConversationId = conversation.id;
  state.currentDraftConversation = conversation;
  state.selectedProfileId = nextProfileId;
  state.selectedModel = nextModel;
  await setCurrentConversationId(conversation.id);
  await setSelectedProfileId(nextProfileId);
  await setSelectedModel(nextModel);
  return { conversation };
}

async function resumeServerConversation(threadId: string) {
  const transcript = await bridge.request<CodexThreadTranscript>("thread.read", { threadId });
  await bridge.request("session.resume", { threadId });
  state.latestPlan = null;
  state.latestDiff = null;
  state.latestReroute = null;
  state.lastAutoCompactThreadId = "";
  state.lastAutoCompactBucket = null;
  const conversation = await saveConversation({
    id: crypto.randomUUID(),
    title: transcript.title,
    profileId: normalizeSelectedProfileId(state.selectedProfileId),
    ...(state.selectedModel ? { model: state.selectedModel } : {}),
    threadId,
    messages: transcript.messages.map((message) => ({ ...message })),
    attachments: [],
    structuredInputs: [],
    selectedTabIds: [],
    historyQuery: "",
    readStrategyOverride: "auto",
    updatedAt: transcript.updatedAt,
  });
  state.currentConversationId = conversation.id;
  state.currentDraftConversation = null;
  conversationRuntime.setThreadId(conversation.id, threadId);
  conversationRuntime.setActiveTurn(conversation.id, null);
  syncCurrentRuntimeState(conversation.id);
  await setCurrentConversationId(conversation.id);
  return { conversation };
}

async function resumeConversation(conversationId: string) {
  const conversations = await listConversations();
  const conversation = conversations.find((item) => item.id === conversationId);
  if (!conversation) {
    throw new Error(`Conversation not found: ${conversationId}`);
  }

  state.currentConversationId = conversation.id;
  state.currentDraftConversation = null;
  conversationRuntime.setThreadId(conversation.id, conversation.threadId);
  state.latestPlan = null;
  state.latestDiff = null;
  state.latestReroute = null;
  syncCurrentRuntimeState(conversation.id);
  state.selectedProfileId = normalizeSelectedProfileId(conversation.profileId);
  state.selectedModel = await reconcileSelectedModelWithCatalog(conversation.model ?? state.selectedModel);
  await setCurrentConversationId(conversation.id);
  await setSelectedProfileId(state.selectedProfileId);

  if (conversation.threadId) {
    try {
      await bridge.request("session.resume", { threadId: conversation.threadId });
    } catch {
      conversationRuntime.setThreadId(conversation.id, undefined);
      syncCurrentRuntimeState(conversation.id);
    }
  }

  return { conversation };
}

async function persistConversation(conversation: SavedConversation) {
  const saved = await saveConversation(conversation);
  if (state.currentDraftConversation?.id === saved.id) {
    state.currentDraftConversation = null;
  }
  conversationRuntime.setThreadId(saved.id, saved.threadId);
  if (!state.currentConversationId || state.currentConversationId === saved.id) {
    state.currentConversationId = saved.id;
    syncCurrentRuntimeState(saved.id);
    await setCurrentConversationId(saved.id);
  }
  return { conversation: saved };
}

async function handleConversationDelete(conversationId: string) {
  if (!conversationId) {
    throw new Error("Missing conversation id.");
  }

  const wasCurrent = state.currentConversationId === conversationId;
  const conversations = await deleteConversation(conversationId);
  conversationRuntime.deleteConversation(conversationId);
  if (state.currentDraftConversation?.id === conversationId) {
    state.currentDraftConversation = null;
  }
  const currentConversation = resolveVisibleCurrentConversation({
    conversations,
    currentConversationId: state.currentConversationId,
    draftConversation: state.currentDraftConversation,
  });
  state.currentConversationId = currentConversation?.id ?? "";
  if (currentConversation) {
    conversationRuntime.setThreadId(currentConversation.id, currentConversation.threadId);
    syncCurrentRuntimeState(currentConversation.id);
  } else {
    state.threadId = undefined;
  }
  if (wasCurrent && !currentConversation) {
    state.activeTurn = null;
    state.latestPlan = null;
    state.latestDiff = null;
    state.latestReroute = null;
    state.lastAutoCompactThreadId = "";
    state.lastAutoCompactBucket = null;
  }
  return {
    recentChats: conversations.map(toConversationSummary),
    currentConversation,
  };
}

async function handleConversationClear() {
  const conversations = await listConversations();
  const deletedCount = conversations.length;
  await clearConversations();
  conversationRuntime.clear();
  state.currentConversationId = "";
  state.currentDraftConversation = null;
  state.threadId = undefined;
  state.activeTurn = null;
  state.latestPlan = null;
  state.latestDiff = null;
  state.latestReroute = null;
  state.lastAutoCompactThreadId = "";
  state.lastAutoCompactBucket = null;
  return {
    recentChats: [],
    currentConversation: null,
    deletedCount,
  };
}

async function handleConversationCompact(waitForCompletion: boolean) {
  if (!state.threadId) {
    return { skipped: true, reason: "no-thread" };
  }
  if (state.activeTurn) {
    return { error: "Cannot compact while Codex is responding." };
  }

  let result: {
    threadId: string;
    status: "started" | "completed";
    turnId?: string;
  };
  try {
    result = await bridge.request("thread.compact.start", {
      threadId: state.threadId,
      waitForCompletion,
    });
  } catch (error) {
    if (!isRecoverableMissingCodexThreadError(error)) {
      throw error;
    }
    void recordDiagnostic("extension.compact.stale_thread", {
      threadId: state.threadId,
      error: toErrorMessage(error),
    });
    state.threadId = undefined;
    state.activeTurn = null;
    state.lastAutoCompactThreadId = "";
    state.lastAutoCompactBucket = null;
    return { skipped: true, reason: "stale-thread" };
  }
  state.threadId = result.threadId;
  if (result.status === "completed") {
    state.activeTurn = null;
    state.lastAutoCompactThreadId = result.threadId;
    state.lastAutoCompactBucket = null;
  }
  return result;
}

async function popOutChat() {
  const activeTab = await getActiveTab().catch(() => null);
  const focusedWindow = await chrome.windows.getLastFocused({ windowTypes: ["normal"] }).catch(() => null);
  const normalWindows = await chrome.windows.getAll({ windowTypes: ["normal"] }).catch(() => []);
  const targetWindowId = selectBrowserWindowIdForPopout({
    activeTabWindowId: activeTab?.windowId,
    rememberedWindowId: state.browserWindowId,
    focusedWindowId: focusedWindow?.id,
    normalWindowIds: normalWindows
      .map((window) => window.id)
      .filter((windowId): windowId is number => typeof windowId === "number"),
  });
  if (typeof targetWindowId === "number") {
    state.browserWindowId = targetWindowId;
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL(createPopoutUrlPath(targetWindowId)),
    type: "popup",
    width: 460,
    height: 860,
  });
  return { ok: true, targetWindowId: targetWindowId ?? null };
}

async function dockChat(targetWindowId?: number, popupWindowId?: number) {
  const activeWindowId = targetWindowId ?? state.browserWindowId;
  if (typeof activeWindowId === "number") {
    state.browserWindowId = activeWindowId;
    await chrome.sidePanel.open({ windowId: activeWindowId });
  }
  if (typeof popupWindowId === "number" && !HEADLESS_CHROME) {
    // chrome.windows.remove crashes headless Chromium (window teardown)
    // — and popout windows can't exist headless anyway.
    await chrome.windows.remove(popupWindowId).catch(() => undefined);
  }
  return { ok: true };
}

async function getWorkspaceHarness(): Promise<WorkspaceHarnessSnapshot> {
  try {
    const harness = await bridge.request<WorkspaceHarnessSnapshot>("workspace.harness.read");
    state.workspaceHarness = harness;
    return harness;
  } catch (error) {
    // Gateway mode routes workspace.harness.read to the bridge sidecar;
    // when the sidecar is down the snapshot is a degraded fallback —
    // workspace deny/ask rules are unknown and ensureOperationAllowed
    // escalates sensitive operations to "ask" via withDegradedHarnessAsks.
    degradedReport("workspace.harness.read", "workspace.harness.read failed; using degraded harness fallback", error);
    const fallback = createFallbackWorkspaceHarness(
      (await getStoredSettings().catch(() => null))?.workspaceRoot,
    );
    state.workspaceHarness = fallback;
    return fallback;
  }
}

function refreshCatalogAfterProviderChange(settings: ExtensionSettings): void {
  void triggerCatalogRefresh(normalizeConfiguredPath(settings.workspaceRoot) || undefined, {
    force: true,
  });
}

async function handleSettingsUpdate(patch: Partial<ExtensionSettings>): Promise<ExtensionSettings> {
  const previousSettings = await getStoredSettings();
  const settings = await updateStoredSettings(patch);
  if (patch.gatewayMode !== undefined && patch.gatewayMode !== previousSettings.gatewayMode) {
    resetGatewayRuntime();
    void getGatewayRuntime().then((rt) => {
      bridge.setGatewayDelegate(rt ? { request: (m, p) => rt.request(m, p) } : null);
    });
  }
  if (patch.agentProviderId !== undefined && patch.agentProviderId !== previousSettings.agentProviderId) {
    void refreshCatalogAfterProviderChange(settings);
    return settings;
  }
  if (
    !shouldRefreshCatalogAfterSettingsUpdate({
      previousWorkspaceRoot: previousSettings.workspaceRoot,
      nextWorkspaceRoot: settings.workspaceRoot,
      previousCodexBinPath: previousSettings.codexBinPath,
      nextCodexBinPath: settings.codexBinPath,
      previousCustomModels: previousSettings.customModels,
      nextCustomModels: settings.customModels,
    })
  ) {
    return settings;
  }

  await softTimeout(syncBridgeRuntimeConfig(settings), UI_BRIDGE_TIMEOUT_MS, undefined, "runtime.config.update(settings)");
  state.workspaceHarness = await softTimeout(
    getWorkspaceHarness(),
    UI_BRIDGE_TIMEOUT_MS,
    createFallbackWorkspaceHarness(settings.workspaceRoot),
    "workspace.harness.read(settings)",
  );
  void triggerCatalogRefresh(normalizeConfiguredPath(settings.workspaceRoot) || undefined, {
    force: true,
  });
  return settings;
}

async function syncBridgeRuntimeConfig(settings: ExtensionSettings): Promise<void> {
  await bridge.request("runtime.config.update", {
    workspaceRoot: normalizeConfiguredPath(settings.workspaceRoot),
    codexBinPath: normalizeConfiguredPath(settings.codexBinPath),
  });
}

async function syncRuntimeConfigAndNormalizeSettings(): Promise<{
  settings: ExtensionSettings;
  runtimeConfig: RuntimeConfigSnapshot;
}> {
  let settings = await getStoredSettings();
  await softTimeout(syncBridgeRuntimeConfig(settings), UI_BRIDGE_TIMEOUT_MS, undefined, "runtime.config.update");

  let runtimeConfig = await softTimeout(
    bridge.request<RuntimeConfigSnapshot>("runtime.config.read"),
    UI_BRIDGE_TIMEOUT_MS,
    createFallbackRuntimeConfig(settings),
    "runtime.config.read",
  );

  if (runtimeConfig.configuredCodexBinPathInvalid && settings.codexBinPath) {
    settings = await updateStoredSettings({ codexBinPath: "" });
    await softTimeout(
      syncBridgeRuntimeConfig(settings),
      UI_BRIDGE_TIMEOUT_MS,
      undefined,
      "runtime.config.update(reset-invalid-codex-bin)",
    );
    runtimeConfig = await softTimeout(
      bridge.request<RuntimeConfigSnapshot>("runtime.config.read"),
      UI_BRIDGE_TIMEOUT_MS,
      createFallbackRuntimeConfig(settings),
      "runtime.config.read(reset-invalid-codex-bin)",
    );
  }

  return { settings, runtimeConfig };
}

async function ensureHistoryPermission(): Promise<boolean> {
  const alreadyGranted = await chrome.permissions.contains({ permissions: ["history"] });
  if (alreadyGranted) {
    return true;
  }

  throw new BrowserPermissionRequiredError(
    { permissions: ["history"] },
    "Allow Codex to search your browser history only when you ask for it.",
  );
}

async function ensureTabsPermission(): Promise<boolean> {
  const alreadyGranted = await chrome.permissions.contains({ permissions: ["tabs"] }).catch(() => false);
  if (alreadyGranted) {
    return true;
  }

  throw new Error("Open-tab access is unavailable. Reload Chromex after accepting the required Tabs permission.");
}

function assertPageReadable(url: string): void {
  const support = getCurrentPageSupport(url);
  if (!support.available) {
    throw new Error(support.blockedReason);
  }
}

async function hasTabOriginPermission(url: string | undefined): Promise<boolean> {
  const permission = buildTabOriginPermission(url);
  if (!permission) {
    return false;
  }

  return chrome.permissions.contains(permission).catch(() => false);
}

async function sendMessageToTab(
  activeTab: chrome.tabs.Tab & { id: number; url: string },
  message: Record<string, unknown>,
  options: { frameId?: number } = {},
): Promise<unknown> {
  // frameId defaults to 0 (top frame). With all_frames content scripts a
  // frameId-less sendMessage would race every frame's listener — the first
  // responder wins and subframes would act on the wrong DOM.
  const frameId = options.frameId ?? 0;
  const sendOptions = { frameId };
  try {
    await ensureContentScript(activeTab.id, activeTab.url, frameId);
    return await chrome.tabs.sendMessage(activeTab.id, message, sendOptions);
  } catch (error) {
    if (shouldAttemptTabOriginRecovery(activeTab.url, error) && (await hasTabOriginPermission(activeTab.url))) {
      await ensureContentScript(activeTab.id, activeTab.url, frameId);
      try {
        return await chrome.tabs.sendMessage(activeTab.id, message, sendOptions);
      } catch (retryError) {
        throw toFriendlyPageAccessError(activeTab.url, retryError);
      }
    }
    if (isRetryableRuntimeMessageError(error)) {
      await sleepMs(120);
      await ensureContentScript(activeTab.id, activeTab.url, frameId);
      try {
        return await chrome.tabs.sendMessage(activeTab.id, message, sendOptions);
      } catch (retryError) {
        throw toFriendlyPageAccessError(activeTab.url, retryError);
      }
    }
    throw toFriendlyPageAccessError(activeTab.url, error);
  }
}

async function captureVisibleTab(activeTab: chrome.tabs.Tab & { url: string; windowId: number }): Promise<string> {
  try {
    return await captureVisibleTabWithQuotaProtection(activeTab.windowId);
  } catch (error) {
    if (isCaptureVisibleTabQuotaError(error)) {
      throw new Error("Screen capture is busy. Codex is waiting briefly before reading the visible tab again.");
    }
    if (shouldAttemptTabOriginRecovery(activeTab.url, error) && (await hasTabOriginPermission(activeTab.url))) {
      try {
        return await captureVisibleTabWithQuotaProtection(activeTab.windowId);
      } catch (retryError) {
        if (isCaptureVisibleTabQuotaError(retryError)) {
          throw new Error("Screen capture is busy. Codex is waiting briefly before reading the visible tab again.");
        }
        throw toFriendlyPageAccessError(activeTab.url, retryError, { captureOnly: true });
      }
    }
    throw toFriendlyPageAccessError(activeTab.url, error, { captureOnly: true });
  }
}

async function captureVisibleTabWithQuotaProtection(windowId: number): Promise<string> {
  return throttleVisibleTabCapture(async () => {
    try {
      return await chrome.tabs.captureVisibleTab(windowId);
    } catch (error) {
      if (!isCaptureVisibleTabQuotaError(error)) {
        throw error;
      }
      await sleepMs(DEFAULT_VISIBLE_TAB_CAPTURE_MIN_INTERVAL_MS);
      return chrome.tabs.captureVisibleTab(windowId);
    }
  });
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toFriendlyPageAccessError(
  url: string | undefined,
  error: unknown,
  options: { captureOnly?: boolean } = {},
): Error {
  if (url && isFileUrl(url)) {
    return new Error(getFileUrlAccessHelpMessage());
  }

  if (url && !options.captureOnly) {
    const support = getCurrentPageSupport(url);
    if (!support.available) {
      return new Error(support.blockedReason);
    }
  }

  const kind = classifyRuntimeMessageError(error);
  if (kind === "host-access") {
    if (buildTabOriginPermission(url)) {
      return new SitePermissionRequiredError(url, options);
    }
    return new Error(
      options.captureOnly
        ? "Codex needs screen capture access before it can capture the current screen. Reopen Codex from this tab, then try again."
        : "Codex needs access to this site before it can read this tab. Reopen Codex from this tab, then try again.",
    );
  }

  const message = toErrorMessage(error);
  if (isRetryableRuntimeMessageError(error)) {
    return new Error("Codex temporarily lost its connection to this tab. Try the action once more.");
  }

  return error instanceof Error ? error : new Error(message);
}

async function listMergedSkills(harness?: WorkspaceHarnessSnapshot): Promise<SkillOption[]> {
  return mergeSkillOptions(await listSkills(), harness ?? (await getWorkspaceHarness()));
}

function mergeSkillOptions(skills: SkillOption[], harness: WorkspaceHarnessSnapshot): SkillOption[] {
  const workspaceSkills = harness.shortcuts.map<SkillOption>((shortcut: WorkspaceHarnessSnapshot["shortcuts"][number]) => ({
    id: shortcut.id,
    name: shortcut.name,
    prompt: shortcut.prompt,
    description: shortcut.description,
    source: shortcut.source,
    readonly: true,
    path: shortcut.path,
  }));
  const byId = new Map<string, SkillOption>();

  for (const skill of [...skills, ...workspaceSkills]) {
    byId.set(skill.id, skill);
  }

  return Array.from(byId.values()).sort((left, right) => left.name.localeCompare(right.name));
}

async function ensureOperationAllowed(operation: HarnessPermissionOperation, confirmed: boolean) {
  const [settings, harness] = await Promise.all([
    getStoredSettings(),
    state.workspaceHarness
      ? Promise.resolve(state.workspaceHarness)
      : softTimeout(
          getWorkspaceHarness(),
          UI_BRIDGE_TIMEOUT_MS,
          createFallbackWorkspaceHarness(),
          "workspace.harness.read(permission)",
        ),
  ]);
  const result = resolveHarnessPermission(
    harness.degraded ? withDegradedHarnessAsks(harness.permissions) : harness.permissions,
    operation,
    {
      browserActionsEnabled: settings.allowBrowserActions,
      browserActionPermissionMode: settings.browserActionPermissionMode,
      confirmedOperations: confirmed ? [operation] : [],
    },
  );

  if (result.decision === "allow") {
    return { ok: true as const };
  }

  return {
    ok: false as const,
    response: {
      error: result.reason,
      requiresConfirmation: result.decision === "ask",
      confirmationOperation: operation,
    },
  };
}

function createFallbackAccountStatus(): UiInitPayload["accountStatus"] {
  return {
    authMode: null,
    codexAuthenticated: false,
    multimodalAvailable: false,
    openAiApiKeyConfigured: false,
    planType: null,
  };
}

function createFallbackWorkspaceHarness(workspaceRoot = ""): WorkspaceHarnessSnapshot {
  return {
    workspaceRoot: normalizeConfiguredPath(workspaceRoot),
    configSources: [],
    instructionSources: [],
    permissions: DEFAULT_HARNESS_PERMISSIONS,
    hooks: {
      enabled: false,
      eventCount: 0,
    },
    shortcuts: [],
    degraded: true,
  };
}

function createFallbackImageAssetFolder(): UiInitPayload["imageAssetFolder"] {
  return {
    rootDir: "",
    latestFolder: "",
    folders: [],
    assetCount: 0,
  };
}

function createFallbackDiagnosticLogFolder(): UiInitPayload["diagnosticLogFolder"] {
  return {
    rootDir: "",
    latestLogPath: "",
    files: [],
  };
}

function createFallbackPlaywrightRuntime(): UiInitPayload["playwrightRuntime"] {
  return {
    available: false,
    packageName: null,
    packageVersion: "",
    browserInstalled: false,
    browserExecutablePath: "",
    installable: false,
    installCommand: "",
    message: "Playwright runtime is not connected.",
  };
}

function createCodexSkillRuntimeAvailability(settings: ExtensionSettings) {
  return {
    playwrightAvailable: state.playwrightRuntime.available && settings.playwrightBrowserControlEnabled,
  };
}

function createFallbackRuntimeConfig(settings: ExtensionSettings): RuntimeConfigSnapshot {
  return createDegradedRuntimeConfigSnapshot({
    workspaceRoot: settings.workspaceRoot,
    codexBinPath: settings.codexBinPath,
  });
}

function normalizeConfiguredPath(value: string | undefined): string {
  return stripConfiguredPathQuotes(value?.trim() ?? "");
}

function stripConfiguredPathQuotes(value: string): string {
  let normalized = value.trim();
  while (
    normalized.length >= 2 &&
    ((normalized.startsWith("\"") && normalized.endsWith("\"")) ||
      (normalized.startsWith("'") && normalized.endsWith("'")))
  ) {
    normalized = normalized.slice(1, -1).trim();
  }
  return normalized;
}

function resolveSettingsUiLocale(settings: Pick<ExtensionSettings, "uiLanguage">): string {
  return resolveUiLocale(settings.uiLanguage, getBrowserLocale());
}

async function getActiveUiLocale(): Promise<string> {
  return resolveSettingsUiLocale(await getStoredSettings());
}

function getBrowserLocale(): string {
  try {
    return chrome.i18n?.getUILanguage?.() || "en";
  } catch {
    return "en";
  }
}

function broadcastBridgeEvent(event: unknown): void {
  chrome.runtime.sendMessage({ type: "bridge.event", event }).catch(() => undefined);
}

function emitPromptStatus(payload: PromptRequestPayload, phase: PromptActivityPhase, workflow?: PromptImageWorkflowKind): void {
  broadcastBridgeEvent({
    type: "prompt.status",
    clientRequestId: payload.clientRequestId ?? "",
    ...(payload.conversationId ? { conversationId: payload.conversationId } : {}),
    phase,
    ...(workflow ? { workflow } : {}),
  });
}

function softTimeout<TResult>(
  task: Promise<TResult>,
  timeoutMs: number,
  fallback: TResult,
  label: string,
): Promise<TResult> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      console.warn(`${label} timed out after ${timeoutMs}ms`);
      resolve(fallback);
    }, timeoutMs);

    task
      .then((value) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        console.warn(`${label} failed`, error);
        resolve(fallback);
      });
  });
}

async function guardAndRun<TResult>(
  operation: HarnessPermissionOperation,
  confirmed: boolean,
  action: () => Promise<TResult>,
) {
  const gate = await ensureOperationAllowed(operation, confirmed);
  if (!gate.ok) {
    return gate.response;
  }

  return action();
}
