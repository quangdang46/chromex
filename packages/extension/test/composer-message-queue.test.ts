import { beforeEach, describe, expect, it } from "vitest";

import {
  dequeueQueuedComposerMessage,
  enqueueQueuedComposerMessage,
  queuedComposerMessagesFor,
  requeueQueuedComposerMessage,
  removeQueuedComposerMessage,
  resetQueuedComposerMessagesForTests,
  type QueuedComposerMessage,
} from "../src/sidepanel/composer-message-queue.js";

function msg(id: string, text = id): QueuedComposerMessage {
  return { id, text, fileAttachments: [], profileId: undefined };
}

describe("composer-message-queue", () => {
  beforeEach(() => {
    resetQueuedComposerMessagesForTests();
  });

  it("returns FIFO order per conversation", () => {
    enqueueQueuedComposerMessage("conv-a", msg("a1"));
    enqueueQueuedComposerMessage("conv-a", msg("a2"));
    enqueueQueuedComposerMessage("conv-a", msg("a3"));

    expect(dequeueQueuedComposerMessage("conv-a")?.id).toBe("a1");
    expect(dequeueQueuedComposerMessage("conv-a")?.id).toBe("a2");
    expect(dequeueQueuedComposerMessage("conv-a")?.id).toBe("a3");
    expect(dequeueQueuedComposerMessage("conv-a")).toBeUndefined();
  });

  it("keeps queues isolated per conversation", () => {
    enqueueQueuedComposerMessage("conv-a", msg("a1"));
    enqueueQueuedComposerMessage("conv-b", msg("b1"));
    enqueueQueuedComposerMessage("conv-b", msg("b2"));

    expect(queuedComposerMessagesFor("conv-a").map((m) => m.id)).toEqual(["a1"]);
    expect(queuedComposerMessagesFor("conv-b").map((m) => m.id)).toEqual(["b1", "b2"]);
    expect(dequeueQueuedComposerMessage("conv-b")?.id).toBe("b1");
    expect(queuedComposerMessagesFor("conv-a").map((m) => m.id)).toEqual(["a1"]);
  });

  it("returns empty for unknown or missing conversation", () => {
    expect(queuedComposerMessagesFor("nope")).toEqual([]);
    expect(queuedComposerMessagesFor(undefined)).toEqual([]);
  });

  it("removes a queued message by id and deletes empty queues", () => {
    enqueueQueuedComposerMessage("conv-a", msg("a1"));
    enqueueQueuedComposerMessage("conv-a", msg("a2"));

    removeQueuedComposerMessage("conv-a", "a1");
    expect(queuedComposerMessagesFor("conv-a").map((m) => m.id)).toEqual(["a2"]);

    removeQueuedComposerMessage("conv-a", "a2");
    expect(queuedComposerMessagesFor("conv-a")).toEqual([]);
    expect(dequeueQueuedComposerMessage("conv-a")).toBeUndefined();
  });

  it("remove is a no-op for unknown conversation or id", () => {
    removeQueuedComposerMessage("missing", "x");
    enqueueQueuedComposerMessage("conv-a", msg("a1"));
    removeQueuedComposerMessage("conv-a", "other");
    expect(queuedComposerMessagesFor("conv-a").map((m) => m.id)).toEqual(["a1"]);
  });

  it("requeue restores a dequeued message at the head", () => {
    enqueueQueuedComposerMessage("conv-a", msg("a1"));
    enqueueQueuedComposerMessage("conv-a", msg("a2"));

    const head = dequeueQueuedComposerMessage("conv-a");
    expect(head?.id).toBe("a1");
    requeueQueuedComposerMessage("conv-a", head!);

    expect(queuedComposerMessagesFor("conv-a").map((m) => m.id)).toEqual(["a1", "a2"]);
  });

  it("requeue works even when the queue was emptied by dequeue", () => {
    enqueueQueuedComposerMessage("conv-a", msg("a1"));
    const head = dequeueQueuedComposerMessage("conv-a");
    expect(head?.id).toBe("a1");
    requeueQueuedComposerMessage("conv-a", head!);
    expect(queuedComposerMessagesFor("conv-a").map((m) => m.id)).toEqual(["a1"]);
  });
});
