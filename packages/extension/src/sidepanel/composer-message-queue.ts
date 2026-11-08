import type { UserFileAttachment } from "@codex-sidepanel/shared";

export interface QueuedComposerMessage {
  id: string;
  text: string;
  fileAttachments: UserFileAttachment[];
  profileId: string | undefined;
  /** Gateway thread the message was queued under — survives reloads so a
   *  post-reload flush can still verify turn state against gateway truth
   *  even before conversation/thread bindings re-hydrate. */
  threadId?: string | undefined;
}

const queuesByConversationId = new Map<string, QueuedComposerMessage[]>();

export function queuedComposerMessagesFor(conversationId: string | undefined): QueuedComposerMessage[] {
  if (!conversationId) return [];
  return queuesByConversationId.get(conversationId) ?? [];
}

export function enqueueQueuedComposerMessage(
  conversationId: string,
  message: QueuedComposerMessage,
): void {
  const queue = queuesByConversationId.get(conversationId) ?? [];
  queue.push(message);
  queuesByConversationId.set(conversationId, queue);
}

export function removeQueuedComposerMessage(conversationId: string, id: string): void {
  const queue = queuesByConversationId.get(conversationId);
  if (!queue) return;
  const next = queue.filter((item) => item.id !== id);
  if (next.length > 0) {
    queuesByConversationId.set(conversationId, next);
  } else {
    queuesByConversationId.delete(conversationId);
  }
}

/** Remove and return the head of the queue (FIFO). */
export function dequeueQueuedComposerMessage(
  conversationId: string,
): QueuedComposerMessage | undefined {
  const queue = queuesByConversationId.get(conversationId);
  const next = queue?.shift();
  if (!queue || queue.length === 0) {
    queuesByConversationId.delete(conversationId);
  }
  return next;
}

/** Put a message back at the head after dequeue (e.g. a turn started mid-flush). */
export function requeueQueuedComposerMessage(
  conversationId: string,
  message: QueuedComposerMessage,
): void {
  const queue = queuesByConversationId.get(conversationId) ?? [];
  queue.unshift(message);
  queuesByConversationId.set(conversationId, queue);
}

export function serializeQueuedComposerMessages(): Record<string, QueuedComposerMessage[]> {
  const out: Record<string, QueuedComposerMessage[]> = {};
  for (const [conversationId, queue] of queuesByConversationId) {
    if (queue.length > 0) out[conversationId] = queue;
  }
  return out;
}

export function restoreQueuedComposerMessages(
  entries: Record<string, QueuedComposerMessage[]>,
): void {
  queuesByConversationId.clear();
  for (const [conversationId, queue] of Object.entries(entries)) {
    if (Array.isArray(queue) && queue.length > 0) {
      queuesByConversationId.set(conversationId, queue);
    }
  }
}

/** Merge persisted entries into the live queues without clobbering
 *  in-memory state. Used by the delayed re-hydrate: a storage.local.set
 *  issued before a reload can commit after the fresh page's first get,
 *  so the first hydrate may see nothing while the write lands later.
 *  excludeIds filters messages already consumed by a flush this page
 *  life so a stale pre-flush snapshot cannot resurrect them. */
export function mergeQueuedComposerMessages(
  entries: Record<string, QueuedComposerMessage[]>,
  excludeIds?: ReadonlySet<string>,
): void {
  for (const [conversationId, queue] of Object.entries(entries)) {
    if (!Array.isArray(queue) || queue.length === 0) continue;
    const candidates = excludeIds ? queue.filter((m) => !excludeIds.has(m.id)) : queue;
    if (candidates.length === 0) continue;
    const existing = queuesByConversationId.get(conversationId) ?? [];
    const ids = new Set(existing.map((m) => m.id));
    const merged = [...existing, ...candidates.filter((m) => !ids.has(m.id))];
    if (merged.length > 0) {
      queuesByConversationId.set(conversationId, merged);
    }
  }
}

export function resetQueuedComposerMessagesForTests(): void {
  queuesByConversationId.clear();
}
