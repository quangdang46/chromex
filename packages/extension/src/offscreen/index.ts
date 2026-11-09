import type { EditablePageImageCandidate } from "../page-image-target.js";
import { offscreenMayHandleMessage } from "../message-sender-guard.js";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen") {
    return false;
  }
  // Sender guard: only the background worker may drive this document —
  // a content script shares the extension id but always carries sender.tab.
  if (!offscreenMayHandleMessage(message, sender, chrome.runtime.id)) {
    sendResponse({ error: "message rejected" });
    return true;
  }
  if (message.type === "offscreen.clipboard.read") {
    void readClipboardText()
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ error: error instanceof Error ? error.message : "clipboard read failed" });
      });
    return true;
  }
  if (message.type === "offscreen.clipboard.write") {
    void writeClipboardText(message.text)
      .then(sendResponse)
      .catch((error) => {
        sendResponse({ error: error instanceof Error ? error.message : "clipboard write failed" });
      });
    return true;
  }
  void cropVisibleTabDataUrlToImageCandidate(message.dataUrl, message.candidate)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({
        error: error instanceof Error ? error.message : "Unknown offscreen crop failure",
      });
    });
  return true;
});

/** navigator.clipboard is the only clipboard API reachable from an
 *  offscreen document (service workers have no clipboard, pages need
 *  focus + permission). Requires the extension's clipboardRead /
 *  clipboardWrite permission AND the document's CLIPBOARD reason —
 *  both declared up front in ensureOffscreenDocument. */
async function readClipboardText(): Promise<{ text: string } | { error: string }> {
  try {
    const text = await navigator.clipboard.readText();
    return { text };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "clipboard read failed" };
  }
}

async function writeClipboardText(text: unknown): Promise<{ ok: true } | { error: string }> {
  if (typeof text !== "string" || text.length === 0 || text.length > 256 * 1024) {
    return { error: "clipboard write requires a non-empty text string (≤256KiB)" };
  }
  try {
    await navigator.clipboard.writeText(text);
    return { ok: true };
  } catch {
    // Offscreen documents are never focused — writeText can reject on
    // transient-activation grounds even with clipboardWrite granted.
    // execCommand("copy") is the documented fallback for this context.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } finally {
      ta.remove();
    }
    return ok ? { ok: true } : { error: "clipboard write failed (writeText and execCommand both refused)" };
  }
}

async function cropVisibleTabDataUrlToImageCandidate(
  dataUrl: unknown,
  candidate: unknown,
): Promise<{ base64: string; mimeType: string; filename: string } | { error: string }> {
  const normalizedDataUrl = typeof dataUrl === "string" ? dataUrl.trim() : "";
  const normalizedCandidate = normalizeEditablePageImageCandidate(candidate);
  if (!normalizedDataUrl || !normalizedCandidate?.viewportRect) {
    return { error: "Missing image crop inputs." };
  }

  const image = await loadImage(normalizedDataUrl);
  const crop = getVisibleImageCropRect(normalizedCandidate, image.naturalWidth || image.width, image.naturalHeight || image.height);
  if (!crop) {
    return { error: "Could not resolve a visible crop rectangle." };
  }

  const canvas = document.createElement("canvas");
  canvas.width = crop.width;
  canvas.height = crop.height;
  const context = canvas.getContext("2d");
  if (!context) {
    return { error: "Could not create an offscreen 2D context." };
  }
  context.drawImage(image, crop.left, crop.top, crop.width, crop.height, 0, 0, crop.width, crop.height);
  const blob = await canvasToBlob(canvas, "image/jpeg", 0.92);
  if (!blob) {
    return { error: "Could not encode the cropped image." };
  }
  return {
    base64: await blobToBase64(blob),
    mimeType: "image/jpeg",
    filename: "visible-page-image.jpg",
  };
}

function normalizeEditablePageImageCandidate(value: unknown): EditablePageImageCandidate | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const input = value as EditablePageImageCandidate;
  if (!input.viewportRect || !input.viewportWidth || !input.viewportHeight) {
    return null;
  }
  return input;
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

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadImage(dataUrl: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Failed to load captured tab image."));
    image.src = dataUrl;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob((blob) => resolve(blob), type, quality);
  });
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read the cropped image blob."));
    reader.onload = () => {
      const dataUrl = typeof reader.result === "string" ? reader.result : "";
      resolve(dataUrl.split(",", 2)[1] ?? "");
    };
    reader.readAsDataURL(blob);
  });
}
