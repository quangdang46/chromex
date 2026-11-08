/**
 * background/cdp.ts — chrome.debugger (CDP) tier client.
 *
 * Lazy per-tab sessions: attach on first use, refcounted, idempotent
 * re-attach ("already attached" is success). Sessions belong to the
 * extension, not the service worker — an SW restart does not drop them;
 * if Chrome does detach (tab close, chrome://detach), onDetach clears
 * state and the next call re-attaches. chrome.debugger.onEvent listeners
 * are extension-scoped and survive detach/reattach, so `on()` needs no
 * re-registration.
 *
 * Used only for what the DOM tier cannot do (docs/adr/debugger-tier.md):
 * trusted input, JS dialogs, file inputs, response bodies, AX tree.
 */

export interface CdpSession {
  send<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** Subscribe to a CDP event; returns unsubscribe. */
  on(method: string, cb: (params: Record<string, unknown>) => void): () => void;
}

interface TabState {
  refs: number;
  attached: boolean;
  pageEnabled: boolean;
}

const CDP_VERSION = "1.3";
const states = new Map<number, TabState>();
let lifecycleListenerInstalled = false;

function stateFor(tabId: number): TabState {
  let s = states.get(tabId);
  if (!s) {
    s = { refs: 0, attached: false, pageEnabled: false };
    states.set(tabId, s);
  }
  return s;
}

function ensureLifecycleListener(): void {
  if (lifecycleListenerInstalled || typeof chrome === "undefined" || !chrome.debugger?.onDetach) return;
  lifecycleListenerInstalled = true;
  chrome.debugger.onDetach.addListener((src) => {
    if (typeof src.tabId !== "number") return;
    const s = states.get(src.tabId);
    if (s) {
      s.attached = false;
      s.pageEnabled = false;
    }
  });
  chrome.tabs?.onRemoved?.addListener((tabId) => {
    states.delete(tabId);
  });
}

async function rawAttach(tabId: number): Promise<void> {
  try {
    await chrome.debugger.attach({ tabId }, CDP_VERSION);
  } catch (e) {
    // already attached (by us after SW restart, or another client) —
    // only that specific failure is safe to treat as success.
    const msg = String((e as Error)?.message ?? e);
    if (!/already attached|another debugger/i.test(msg)) throw e;
  }
}

/** Acquire a CDP session for a tab. Caller must releaseCdp() when done. */
export async function acquireCdp(tabId: number): Promise<CdpSession> {
  ensureLifecycleListener();
  const s = stateFor(tabId);
  s.refs += 1;
  if (!s.attached) {
    await rawAttach(tabId);
    s.attached = true;
    // Enable the Page domain eagerly, once per attach. Page agents only
    // track javascriptDialogOpening / serve handleJavaScriptDialog after
    // Page.enable — and Page.enable itself hangs behind an already-open
    // modal dialog, so it must complete BEFORE any dialog can appear.
    // Fire-and-forget: a dialog already open at first contact leaves
    // this pending; the dialog tool then fails honestly (no_dialog)
    // instead of deadlocking the 15s host timeout.
    if (!s.pageEnabled) {
      s.pageEnabled = true;
      void chrome.debugger
        .sendCommand({ tabId }, "Page.enable", {})
        .catch(() => {
          s.pageEnabled = false;
        });
    }
  }
  return {
    send: <T>(method: string, params?: Record<string, unknown>) =>
      chrome.debugger.sendCommand({ tabId }, method, params ?? {}) as Promise<T>,
    on: (method, cb) => {
      const wrapped = (src: chrome.debugger.Debuggee, m: string, p?: object) => {
        if (src.tabId === tabId && m === method) cb((p ?? {}) as Record<string, unknown>);
      };
      chrome.debugger.onEvent.addListener(wrapped);
      return () => chrome.debugger.onEvent.removeListener(wrapped);
    },
  };
}

/** Release a session acquired via acquireCdp. Detaches at refcount 0. */
export async function releaseCdp(tabId: number): Promise<void> {
  const s = states.get(tabId);
  if (!s) return;
  s.refs = Math.max(0, s.refs - 1);
  if (s.refs === 0 && s.attached) {
    s.attached = false;
    try {
      await chrome.debugger.detach({ tabId });
    } catch {
      /* already detached */
    }
  }
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
