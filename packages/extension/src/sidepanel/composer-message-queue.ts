import type { UserFileAttachment } from "@codex-sidepanel/shared";

export interface QueuedComposerMessage {
  id: string;
  text: string;
  fileAttachments: UserFileAttachment[];
  profileId: string | undefined;
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

export function resetQueuedComposerMessagesForTests(): void {
  queuesByConversationId.clear();
}
