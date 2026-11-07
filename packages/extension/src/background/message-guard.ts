/**
 * message-guard.ts — sender classification + boundary validation for
 * chrome.runtime.onMessage (plan Phase 5 security pass).
 *
 * chrome.runtime.onMessage only receives messages from this extension's
 * own contexts (content scripts, sidepanel, offscreen, popup) — web pages
 * cannot reach it without externally_connectable (not declared). The
 * remaining risk is a compromised content script calling powerful
 * UI/agent message types, so we classify the sender and allowlist.
 */

export type MessageSenderClass = "extension-page" | "content-script" | "untrusted";

export interface RuntimeSenderLike {
  id?: string;
  url?: string;
  tab?: unknown;
}

/** Message types a content script may legitimately send to background. */
export const CONTENT_SCRIPT_ALLOWED_TYPES: ReadonlySet<string> = new Set([
  "page.fingerprint.context",
  "page.image-prompt.extract",
  "page.image-attachment.add",
  "ui.page-selection.changed",
  "image.asset.read",
]);

const EXTENSION_SCHEME = "chrome-extension://";

export function classifyMessageSender(
  sender: RuntimeSenderLike | undefined,
  runtimeId: string,
): MessageSenderClass {
  if (!sender || sender.id !== runtimeId) return "untrusted";
  // Content scripts always carry sender.tab; extension pages do not.
  if (sender.tab) return "content-script";
  if (typeof sender.url === "string" && sender.url.startsWith(`${EXTENSION_SCHEME}${runtimeId}/`)) {
    return "extension-page";
  }
  // No tab and no extension-page URL — could be the offscreen document or
  // another extension context; treat as untrusted for allowlist purposes.
  return "untrusted";
}

export function contentScriptMaySend(type: string): boolean {
  return CONTENT_SCRIPT_ALLOWED_TYPES.has(type);
}

const MAX_TYPE_LENGTH = 128;
const MAX_PAYLOAD_KEYS = 64;

/**
 * Boundary shape check: message must be a plain object with a bounded
 * string `type`. Deeper per-type validation happens at the handlers and,
 * for agent RPCs, at the Gateway's Zod layer.
 */
export function validateRuntimeMessage(message: unknown): { ok: true; type: string } | { ok: false } {
  if (!message || typeof message !== "object" || Array.isArray(message)) return { ok: false };
  const type = (message as { type?: unknown }).type;
  if (typeof type !== "string" || type.length === 0 || type.length > MAX_TYPE_LENGTH) {
    return { ok: false };
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(type) || type.startsWith("__")) return { ok: false };
  const keys = Object.keys(message as Record<string, unknown>);
  if (keys.length > MAX_PAYLOAD_KEYS) return { ok: false };
  return { ok: true, type };
}
