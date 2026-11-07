import { describe, expect, it } from "vitest";
import {
  classifyMessageSender,
  contentScriptMaySend,
  validateRuntimeMessage,
} from "../src/background/message-guard.js";

const RID = "test-extension-id";

describe("classifyMessageSender", () => {
  it("extension page: own id + extension URL + no tab", () => {
    expect(
      classifyMessageSender(
        { id: RID, url: `chrome-extension://${RID}/sidepanel.html` },
        RID,
      ),
    ).toBe("extension-page");
  });

  it("content script: own id + tab present", () => {
    expect(
      classifyMessageSender(
        { id: RID, url: `chrome-extension://${RID}/content.js`, tab: { id: 1 } },
        RID,
      ),
    ).toBe("content-script");
  });

  it("untrusted: wrong sender id", () => {
    expect(
      classifyMessageSender({ id: "other", url: `chrome-extension://${RID}/x.html` }, RID),
    ).toBe("untrusted");
  });

  it("untrusted: no tab and no extension-page URL", () => {
    expect(classifyMessageSender({ id: RID }, RID)).toBe("untrusted");
    expect(
      classifyMessageSender({ id: RID, url: "https://evil.example/x" }, RID),
    ).toBe("untrusted");
  });

  it("untrusted: missing sender", () => {
    expect(classifyMessageSender(undefined, RID)).toBe("untrusted");
  });
});

describe("contentScriptMaySend", () => {
  it("allows the real content-script vocabulary", () => {
    for (const t of [
      "page.fingerprint.context",
      "page.image-prompt.extract",
      "page.image-attachment.add",
      "ui.page-selection.changed",
      "image.asset.read",
    ]) {
      expect(contentScriptMaySend(t)).toBe(true);
    }
  });

  it("rejects powerful UI/agent types from content scripts", () => {
    for (const t of [
      "prompt.send",
      "settings.update",
      "profile.select",
      "conversation.delete",
      "turn.interrupt",
      "account.logout",
      "ui.init",
    ]) {
      expect(contentScriptMaySend(t)).toBe(false);
    }
  });
});

describe("validateRuntimeMessage", () => {
  it("accepts a normal message", () => {
    expect(validateRuntimeMessage({ type: "ui.init", windowId: 1 })).toEqual({
      ok: true,
      type: "ui.init",
    });
  });

  it("rejects non-objects, arrays, missing/oversized/bad type", () => {
    expect(validateRuntimeMessage(null).ok).toBe(false);
    expect(validateRuntimeMessage("x").ok).toBe(false);
    expect(validateRuntimeMessage([]).ok).toBe(false);
    expect(validateRuntimeMessage({}).ok).toBe(false);
    expect(validateRuntimeMessage({ type: 42 }).ok).toBe(false);
    expect(validateRuntimeMessage({ type: "a".repeat(200) }).ok).toBe(false);
    expect(validateRuntimeMessage({ type: "bad type!" }).ok).toBe(false);
    expect(validateRuntimeMessage({ type: "__proto__" }).ok).toBe(false);
  });

  it("rejects payloads with too many keys", () => {
    const m: Record<string, number> = { type: 0 } as never;
    m.type = "x" as never;
    for (let i = 0; i < 70; i++) m[`k${i}`] = i;
    expect(validateRuntimeMessage(m).ok).toBe(false);
  });
});
