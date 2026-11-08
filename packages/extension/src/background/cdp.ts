/**
 * background/cdp.ts — chrome.debugger (CDP) tier client.
 *
 * Lazy per-target sessions: attach on first use, refcounted, idempotent
 * re-attach ("already attached" is success). Sessions belong to the
 * extension, not the service worker — an SW restart does not drop them;
 * if Chrome does detach (tab close, chrome://detach), onDetach clears
 * state and the next call re-attaches. chrome.debugger.onEvent listeners
 * are extension-scoped and survive detach/reattach, so `on()` needs no
 * re-registration.
 *
 * Two debuggee kinds share the same session machinery:
 *  - tab targets ({tabId}) — the page plus same-process frames
 *  - frame targets ({targetId}) — out-of-process iframes, which appear
 *    as separate chrome.debugger targets (see docs/adr/debugger-tier.md)
 *
 * Used only for what the DOM tier cannot do (docs/adr/debugger-tier.md):
 * trusted input, JS dialogs, file inputs, response bodies, AX tree.
 */

export interface CdpSession {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribe to a CDP event; returns unsubscribe. */
  on(method: string, cb: (params: Record<string, unknown>) => void): () => void;
}

interface TargetState {
  refs: number;
  attached: boolean;
  debuggee: chrome.debugger.Debuggee;
}

const CDP_VERSION = "1.3";
const states = new Map<string, TargetState>();
let lifecycleListenerInstalled = false;

function stateFor(key: string, debuggee: chrome.debugger.Debuggee): TargetState {
  let s = states.get(key);
  if (!s) {
    s = { refs: 0, attached: false, debuggee };
    states.set(key, s);
  }
  return s;
}

function ensureLifecycleListener(): void {
  if (lifecycleListenerInstalled || typeof chrome === "undefined" || !chrome.debugger?.onDetach) return;
  lifecycleListenerInstalled = true;
  chrome.debugger.onDetach.addListener((src) => {
    // Debuggee echoes back whichever id kind we attached with.
    const key =
      typeof src.tabId === "number" ? `tab:${src.tabId}`
      : typeof src.targetId === "string" ? `tgt:${src.targetId}`
      : null;
    if (key === null) return;
    const s = states.get(key);
    if (s) s.attached = false;
  });
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    states.delete(`tab:${tabId}`);
  });
}

async function rawAttach(debuggee: chrome.debugger.Debuggee): Promise<void> {
  try {
    await chrome.debugger.attach(debuggee, CDP_VERSION);
  } catch (e) {
    // already attached (by us after SW restart, or another client) —
    // only that specific failure is safe to treat as success.
    const msg = String((e as Error)?.message ?? e);
    if (!/already attached|another debugger/i.test(msg)) throw e;
  }
}

function makeSession(key: string, debuggee: chrome.debugger.Debuggee): CdpSession {
  const matches = (src: chrome.debugger.Debuggee) =>
    typeof debuggee.tabId === "number"
      ? src.tabId === debuggee.tabId
      : src.targetId === debuggee.targetId;
  return {
    send: <T>(method: string, params?: Record<string, unknown>) =>
      chrome.debugger.sendCommand(debuggee, method, params ?? {}) as Promise<T>,
    on: (method, cb) => {
      const wrapped = (src: chrome.debugger.Debuggee, m: string, p?: object) => {
        if (matches(src) && m === method) cb((p ?? {}) as Record<string, unknown>);
      };
      chrome.debugger.onEvent.addListener(wrapped);
      return () => chrome.debugger.onEvent.removeListener(wrapped);
    },
  };
  void key;
}

async function acquire(key: string, debuggee: chrome.debugger.Debuggee): Promise<CdpSession> {
  ensureLifecycleListener();
  const s = stateFor(key, debuggee);
  s.refs += 1;
  if (!s.attached) {
    await rawAttach(debuggee);
    s.attached = true;
    // Enable the Page domain eagerly, once per attach. Page agents only
    // track javascriptDialogOpening / serve handleJavaScriptDialog after
    // Page.enable — and Page.enable itself hangs behind an already-open
    // modal dialog, so it must complete BEFORE any dialog can appear.
    // Fire-and-forget: a dialog already open at first contact leaves
    // this pending; the dialog tool then fails honestly (no_dialog)
    // instead of deadlocking the 15s host timeout.
    void chrome.debugger
      .sendCommand(debuggee, "Page.enable", {})
      .catch(() => {
        // Page.enable can hang behind an open modal — the dialog tool
        // probes handleJavaScriptDialog first and reports no_dialog.
      });
  }
  return makeSession(key, debuggee);
}

async function release(key: string): Promise<void> {
  const s = states.get(key);
  if (!s) return;
  s.refs = Math.max(0, s.refs - 1);
  if (s.refs === 0 && s.attached) {
    s.attached = false;
    try {
      await chrome.debugger.detach(s.debuggee);
    } catch {
      /* already detached */
    }
  }
}

/** Acquire a CDP session for a tab. Caller must releaseCdp() when done. */
export async function acquireCdp(tabId: number): Promise<CdpSession> {
  return acquire(`tab:${tabId}`, { tabId });
}

/** Release a session acquired via acquireCdp/acquireCdpTarget. */
export async function releaseCdp(tabId: number): Promise<void> {
  return release(`tab:${tabId}`);
}

/** Acquire a CDP session for an out-of-process iframe target
 *  (chrome.debugger.getTargets() type "iframe"). Its DOM/Runtime domains
 *  see only that frame's document — no piercing needed. */
export async function acquireCdpTarget(targetId: string): Promise<CdpSession> {
  return acquire(`tgt:${targetId}`, { targetId });
}

export async function releaseCdpTarget(targetId: string): Promise<void> {
  return release(`tgt:${targetId}`);
}

/** One-shot helper: attach → fn(session) → release. */
export async function withCdp<T>(tabId: number, fn: (s: CdpSession) => Promise<T>): Promise<T> {
  const session = await acquireCdp(tabId);
  try {
    return await fn(session);
  } finally {
    await releaseCdp(tabId);
  }
}

/** SW restart orphans every held session: route/emulate holds live in
 *  module state and die with the worker, but chrome.debugger
 *  attachments — including any Fetch.enable'd interception — persist.
 *  Paused requests would then hang forever with no handler. Detach all
 *  targets once at startup; the next acquire() re-attaches cleanly and
 *  all CDP state (Fetch patterns, emulation overrides, taps) resets.
 *  Detach only removes THIS extension's attachment — DevTools and
 *  other debuggers are unaffected; unattached targets error and are
 *  ignored. */
export async function detachOrphanedDebuggerTargets(): Promise<void> {
  if (typeof chrome === "undefined" || !chrome.debugger?.getTargets) return;
  const targets = await new Promise<chrome.debugger.TargetInfo[]>((resolve) => {
    try {
      chrome.debugger.getTargets((t) => resolve(t ?? []));
    } catch {
      resolve([]);
    }
  });
  await Promise.all(
    targets.map((t) =>
      chrome.debugger.detach({ targetId: t.id }).catch(() => {}),
    ),
  );
}
