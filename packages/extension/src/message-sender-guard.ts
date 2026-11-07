/**
 * message-sender-guard.ts — sender validation for chrome.runtime.onMessage
 * listeners in extension pages (sidepanel, offscreen document).
 *
 * Companion to background/message-guard.ts, which guards the service
 * worker's listener. chrome.runtime.onMessage only receives messages from
 * this extension's own contexts — but a compromised content script shares
 * the extension id and can forge UI events (permission decisions,
 * mic-permission results, bridge events). Content-script senders always
 * carry sender.tab; the background worker and extension pages do not, so
 * tab presence is the discriminator.
 */

export interface ExtensionMessageSenderLike {
  id?: string;
  url?: string;
  tab?: unknown;
}

/**
 * Message types a content script may legitimately deliver to the sidepanel.
 * Content scripts also emit page.* / image.asset.read types, but those are
 * handled by the background listener — the sidepanel only consumes page
 * selection updates directly.
 */
export const SIDEPANEL_CONTENT_SCRIPT_TYPES: ReadonlySet<string> = new Set([
  "ui.page-selection.changed",
]);

export function isOwnExtensionSender(
  sender: ExtensionMessageSenderLike | undefined,
  runtimeId: string,
): boolean {
  return (
    typeof runtimeId === "string" &&
    runtimeId.length > 0 &&
    Boolean(sender) &&
    sender?.id === runtimeId
  );
}

/**
 * True when the sender is an extension-internal context — the background
 * service worker or an extension page (sidepanel, offscreen document,
 * mic-permission window). Content scripts always carry sender.tab, so a
 * forged message from a compromised content script fails this check.
 */
export function isExtensionContextSender(
  sender: ExtensionMessageSenderLike | undefined,
  runtimeId: string,
): boolean {
  return isOwnExtensionSender(sender, runtimeId) && sender?.tab == null;
}

function messageTypeOf(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const type = (message as { type?: unknown }).type;
  return typeof type === "string" ? type : null;
}

/**
 * Sidepanel gate: accept messages from extension-internal contexts, and
 * from content scripts only for the narrow allowlist above.
 */
export function sidepanelMayHandleMessage(
  message: unknown,
  sender: ExtensionMessageSenderLike | undefined,
  runtimeId: string,
): boolean {
  const type = messageTypeOf(message);
  if (type === null || !isOwnExtensionSender(sender, runtimeId)) {
    return false;
  }
  if (isExtensionContextSender(sender, runtimeId)) {
    return true;
  }
  return SIDEPANEL_CONTENT_SCRIPT_TYPES.has(type);
}

/**
 * Offscreen gate: the document only serves the background worker's image
 * crop requests, so content-script senders are always rejected.
 */
export function offscreenMayHandleMessage(
  message: unknown,
  sender: ExtensionMessageSenderLike | undefined,
  runtimeId: string,
): boolean {
  if (!isExtensionContextSender(sender, runtimeId)) {
    return false;
  }
  const type = messageTypeOf(message);
  return type === "offscreen.image.crop";
}
