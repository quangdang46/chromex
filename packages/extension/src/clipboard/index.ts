/**
 * clipboard.html — runs inside a focused popup window created by
 * browser.clipboard.get's fallback path. Unlike the offscreen document
 * (never focused) or a service worker (no DOM), a real extension page
 * in a focused window satisfies navigator.clipboard's focus
 * requirement, so readText() works once the optional clipboardRead
 * permission is granted.
 *
 * Reports the result back over a runtime.connect port (not a broadcast
 * message — the offscreen document may also be alive and would race a
 * sendMessage response). A "ready" post precedes the read so the
 * background can distinguish "page never loaded" from "read failed".
 */
const port = chrome.runtime.connect({ name: "chromex.clipboard.read" });
port.postMessage({ type: "ready" });
navigator.clipboard
  .readText()
  .then((text) => port.postMessage({ type: "result", text }))
  .catch((error) =>
    port.postMessage({
      type: "result",
      error: error instanceof Error ? error.message : String(error),
    }),
  );
