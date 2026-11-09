import { describe, expect, it } from "vitest";
import {
  isExtensionContextSender,
  isOwnExtensionSender,
  offscreenMayHandleMessage,
  sidepanelMayHandleMessage,
} from "../src/message-sender-guard.js";

const RID = "test-extension-id";

const backgroundSender = { id: RID };
const extensionPageSender = { id: RID, url: `chrome-extension://${RID}/mic-permission.html` };
const contentScriptSender = {
  id: RID,
  url: "https://example.com/page",
  tab: { id: 1 },
};
const foreignSender = { id: "other-extension", url: `chrome-extension://${RID}/x.html` };

describe("isOwnExtensionSender / isExtensionContextSender", () => {
  it("accepts the background worker and extension pages", () => {
    expect(isOwnExtensionSender(backgroundSender, RID)).toBe(true);
    expect(isExtensionContextSender(backgroundSender, RID)).toBe(true);
    expect(isExtensionContextSender(extensionPageSender, RID)).toBe(true);
  });

  it("rejects foreign sender ids", () => {
    expect(isOwnExtensionSender(foreignSender, RID)).toBe(false);
    expect(isExtensionContextSender(foreignSender, RID)).toBe(false);
    expect(isExtensionContextSender(undefined, RID)).toBe(false);
  });

  it("treats tab-bearing senders as content scripts, not extension contexts", () => {
    expect(isOwnExtensionSender(contentScriptSender, RID)).toBe(true);
    expect(isExtensionContextSender(contentScriptSender, RID)).toBe(false);
  });
});

describe("sidepanelMayHandleMessage", () => {
  it("accepts extension-internal senders for any handled type", () => {
    expect(
      sidepanelMayHandleMessage({ type: "ui.active-tab.updated" }, backgroundSender, RID),
    ).toBe(true);
    expect(
      sidepanelMayHandleMessage({ type: "bridge.event", event: {} }, extensionPageSender, RID),
    ).toBe(true);
    expect(
      sidepanelMayHandleMessage(
        { type: "voice.microphone.permission.result", result: "granted" },
        extensionPageSender,
        RID,
      ),
    ).toBe(true);
  });

  it("accepts the legit content-script type", () => {
    expect(
      sidepanelMayHandleMessage(
        { type: "ui.page-selection.changed", selection: { text: "hi" } },
        contentScriptSender,
        RID,
      ),
    ).toBe(true);
  });

  it("rejects forged UI events from content scripts", () => {
    for (const type of [
      "ui.active-tab.updated",
      "ui.image-prompt.extract",
      "ui.dictation.shortcut",
      "gateway.state.changed",
      "bridge.event",
      "voice.microphone.permission.result",
      "ui.conversation.rebuilt",
    ]) {
      expect(sidepanelMayHandleMessage({ type }, contentScriptSender, RID)).toBe(false);
    }
  });

  it("rejects foreign sender ids and malformed messages", () => {
    expect(
      sidepanelMayHandleMessage({ type: "ui.page-selection.changed" }, foreignSender, RID),
    ).toBe(false);
    expect(sidepanelMayHandleMessage(null, backgroundSender, RID)).toBe(false);
    expect(sidepanelMayHandleMessage("ui.init", backgroundSender, RID)).toBe(false);
    expect(sidepanelMayHandleMessage({}, contentScriptSender, RID)).toBe(false);
    expect(sidepanelMayHandleMessage(undefined, undefined, RID)).toBe(false);
  });
});

describe("offscreenMayHandleMessage", () => {
  it("accepts the background worker's crop request", () => {
    expect(
      offscreenMayHandleMessage(
        { target: "offscreen", type: "offscreen.image.crop", dataUrl: "data:", candidate: {} },
        backgroundSender,
        RID,
      ),
    ).toBe(true);
  });

  it("rejects content-script senders even with the right shape", () => {
    expect(
      offscreenMayHandleMessage(
        { target: "offscreen", type: "offscreen.image.crop" },
        contentScriptSender,
        RID,
      ),
    ).toBe(false);
    expect(
      offscreenMayHandleMessage(
        { target: "offscreen", type: "offscreen.image.crop" },
        foreignSender,
        RID,
      ),
    ).toBe(false);
  });

  it("accepts the clipboard ops from the background worker only", () => {
    for (const type of ["offscreen.clipboard.read", "offscreen.clipboard.write"]) {
      expect(
        offscreenMayHandleMessage({ target: "offscreen", type }, backgroundSender, RID),
      ).toBe(true);
      expect(
        offscreenMayHandleMessage({ target: "offscreen", type }, contentScriptSender, RID),
      ).toBe(false);
    }
  });

  it("rejects unexpected types and malformed messages", () => {
    expect(
      offscreenMayHandleMessage({ target: "offscreen", type: "ui.init" }, backgroundSender, RID),
    ).toBe(false);
    expect(offscreenMayHandleMessage(null, backgroundSender, RID)).toBe(false);
    expect(offscreenMayHandleMessage(42, backgroundSender, RID)).toBe(false);
  });
});
