// Cross-frame geometry for trusted pointer dispatch.
//
// CDP Input.dispatchMouseEvent takes viewport coordinates of the whole
// page, but an element located inside an iframe reports frame-relative
// rects. Chrome gives extensions no API that maps a webNavigation
// frameId to on-screen geometry, so frames measure themselves: every
// frame's content script installs a responder that answers
// "where is the iframe hosting you?" with the iframe's rect plus its
// own cumulative offset — one postMessage hop resolves any depth.
//
// postMessage is used instead of window.name or DOM scraping because
// it works across origins and out-of-process iframes, and it never
// mutates page state. e.source is matched against iframe.contentWindow,
// which is the one cross-origin-safe window identity check.

const GEOM_REQ = "chromex:geom-offset-req";
const GEOM_RESP = "chromex:geom-offset-resp";
const ASK_TIMEOUT_MS = 2000;

interface GeomOffset {
  left: number;
  top: number;
}

function findHostingIframe(child: Window): Element | null {
  for (const el of Array.from(document.querySelectorAll("iframe,frame"))) {
    const win = (el as HTMLIFrameElement).contentWindow;
    if (win !== null && win === child) {
      return el;
    }
  }
  return null;
}

/** Offset of this frame's viewport origin within the top viewport.
 *  Returns {0,0} in the top frame, null when an ancestor cannot be
 *  reached (timeout or denied) — callers must fail honestly rather
 *  than click frame-relative coordinates. */
export function askFrameOffset(): Promise<GeomOffset | null> {
  if (window.parent === window) {
    return Promise.resolve({ left: 0, top: 0 });
  }
  return new Promise((resolve) => {
    const reqId = `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
    const finish = (value: GeomOffset | null) => {
      window.clearTimeout(timer);
      window.removeEventListener("message", onMsg);
      resolve(value);
    };
    const timer = window.setTimeout(() => finish(null), ASK_TIMEOUT_MS);
    function onMsg(e: MessageEvent): void {
      const d = e.data as { type?: unknown; reqId?: unknown; left?: unknown; top?: unknown } | null;
      if (e.source !== window.parent || !d || d.type !== GEOM_RESP || d.reqId !== reqId) {
        return;
      }
      finish(
        typeof d.left === "number" && typeof d.top === "number"
          ? { left: d.left, top: d.top }
          : null,
      );
    }
    window.addEventListener("message", onMsg);
    try {
      window.parent.postMessage({ type: GEOM_REQ, reqId }, "*");
    } catch {
      finish(null);
    }
  });
}

/** Install the responder half: answer offset requests from direct
 *  child frames. Must run in every frame — the reply carries this
 *  frame's own cumulative offset, so nested iframes resolve through
 *  recursion without the asker knowing the depth. */
export function installFrameGeometryResponder(): void {
  window.addEventListener("message", (e: MessageEvent) => {
    const d = e.data as { type?: unknown; reqId?: unknown } | null;
    if (!d || d.type !== GEOM_REQ || typeof d.reqId !== "string") {
      return;
    }
    const src = e.source as Window | null;
    if (src === null) {
      return;
    }
    const iframe = findHostingIframe(src);
    if (iframe === null) {
      return;
    }
    const r = iframe.getBoundingClientRect();
    // clientLeft/clientTop are the iframe border widths — the child
    // viewport starts inside them.
    const left = r.left + iframe.clientLeft;
    const top = r.top + iframe.clientTop;
    void (async () => {
      const self = await askFrameOffset();
      if (self === null) {
        return; // child times out and reports honestly
      }
      try {
        src.postMessage(
          { type: GEOM_RESP, reqId: d.reqId, left: left + self.left, top: top + self.top },
          "*",
        );
      } catch {
        // child navigated away mid-ask — nothing to do
      }
    })();
  });
}
