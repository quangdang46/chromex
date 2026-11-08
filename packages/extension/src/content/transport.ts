/**
 * content/transport.ts — message types for the content-script bridge
 * (plan §6.4 split). Single source for the page.* vocabulary shared
 * by the listener in index.ts and the background senders.
 */

export const PAGE_MESSAGE = {
  domSnapshot: "page.dom.snapshot",
  domPerform: "page.dom.perform",
  domFind: "page.dom.find",
  domWait: "page.dom.wait",
  domLocate: "page.dom.locate",
  aiControlStart: "page.ai-control.start",
  aiControlStop: "page.ai-control.stop",
  fingerprintContext: "page.fingerprint.context",
  dictationInsert: "page.dictation.insert",
  selectionSnapshot: "page.selection.snapshot",
} as const;

export type PageMessageType = (typeof PAGE_MESSAGE)[keyof typeof PAGE_MESSAGE];
