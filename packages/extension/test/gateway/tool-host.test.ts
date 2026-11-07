import { describe, expect, test, vi } from "vitest";

import { createToolHostHandler, type ToolHostDeps } from "../../src/background/gateway/tool-host.js";

function deps(over: Partial<ToolHostDeps> = {}): ToolHostDeps & { sent: Array<{ tabId: number; message: Record<string, unknown> }> } {
  const sent: Array<{ tabId: number; message: Record<string, unknown> }> = [];
  return {
    sent,
    sendToTab: vi.fn(async (tabId: number, message: Record<string, unknown>) => {
      sent.push({ tabId, message });
      if (message.type === "page.dom.snapshot") {
        return { metadata: { url: "https://x" }, elements: [{ ref: "e1", role: "button", label: "Go" }] };
      }
      return { ok: true, summary: "done", results: [{ step: message.steps?.[0], ok: true, message: "ok" }] };
    }),
    getTab: vi.fn(async () => ({ id: 7, url: "https://x", title: "X", active: true })),
    queryTabs: vi.fn(async () => [{ id: 7, url: "https://x", title: "X", active: true, windowId: 1 }]),
    activateTab: vi.fn(async () => {}),
    closeTab: vi.fn(async () => {}),
    activeTabId: vi.fn(async () => 7),
    ...over,
  };
}

const req = (tool: string, args: Record<string, unknown> = {}) => ({
  toolCallId: "tc1",
  taskId: "t1",
  tool,
  args,
});

describe("tool host (P1-09)", () => {
  test("browser.tabs.list returns tab summaries", async () => {
    const h = createToolHostHandler(deps());
    const res = (await h(req("browser.tabs.list"))) as { tabs: Array<{ id: number; url: string }> };
    expect(res.tabs[0].id).toBe(7);
  });

  test("tabs.list excludes internal pages and strips query/hash (§6.1.1)", async () => {
    const d = deps({
      queryTabs: vi.fn(async () => [
        { id: 1, url: "https://app.example.com/inbox?token=secret#frag", title: "Inbox", active: true, windowId: 1 },
        { id: 2, url: "chrome://settings", title: "Settings", active: false, windowId: 1 },
        { id: 3, url: "about:blank", title: "", active: false, windowId: 1 },
        { id: 4, url: "chrome-extension://abc/page.html", title: "Ext", active: false, windowId: 1 },
      ]),
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.tabs.list"))) as {
      tabs: Array<{ id: number; url: string; origin: string }>;
    };
    expect(res.tabs).toHaveLength(1);
    expect(res.tabs[0].url).toBe("https://app.example.com/inbox");
    expect(res.tabs[0].origin).toBe("https://app.example.com");
  });

  test("page.snapshot forwards to content script", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.page.snapshot"))) as { elements: unknown[] };
    expect(res.elements).toHaveLength(1);
    expect(d.sent[0].message.type).toBe("page.dom.snapshot");
    expect(d.sent[0].tabId).toBe(7); // active tab default
  });

  test("page.click maps to dom.perform step with targetRef", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await h(req("browser.page.click", { ref: "e1" }));
    const msg = d.sent[0].message as { type: string; steps: Array<Record<string, unknown>> };
    expect(msg.type).toBe("page.dom.perform");
    expect(msg.steps[0]).toMatchObject({ action: "click", targetRef: "e1" });
  });

  test("page.fill passes text value; page.navigate passes url", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await h(req("browser.page.fill", { ref: "e2", text: "hello" }));
    await h(req("browser.page.navigate", { url: "https://example.com" }));
    const steps = d.sent.map((s) => (s.message as { steps: Array<Record<string, unknown>> }).steps[0]);
    expect(steps[0]).toMatchObject({ action: "fill", value: "hello" });
    expect(steps[1]).toMatchObject({ action: "navigate", url: "https://example.com" });
  });

  test("explicit tabId wins over active tab", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await h(req("browser.page.snapshot", { tabId: 42 }));
    expect(d.sent[0].tabId).toBe(42);
  });

  test("unimplemented tools reject proto.unsupported — never fake", async () => {
    const h = createToolHostHandler(deps());
    for (const tool of ["browser.page.evaluate", "browser.page.cookies", "browser.page.localStorage", "browser.page.download"]) {
      await expect(h(req(tool))).rejects.toMatchObject({ code: "proto.unsupported" });
    }
  });

  test("navigate without url → proto.invalid", async () => {
    const h = createToolHostHandler(deps());
    await expect(h(req("browser.page.navigate", {}))).rejects.toMatchObject({ code: "proto.invalid" });
  });

  test("no active tab → browser.no_tab", async () => {
    const h = createToolHostHandler(deps({ activeTabId: vi.fn(async () => null) }));
    await expect(h(req("browser.page.snapshot"))).rejects.toMatchObject({ code: "browser.no_tab" });
  });

  test("snapshotId arg validates against registry; unknown/expired → browser.stale_snapshot", async () => {
    const d = deps({
      sendToTab: vi.fn(async (tabId: number, message: Record<string, unknown>) => {
        if (message.type === "page.dom.snapshot") {
          return {
            snapshotId: "snap:test-1",
            structuralFingerprint: "sfp1:aaa",
            stateFingerprint: "tfp1:bbb",
            saltEpoch: 1,
            elements: [{ ref: "e1" }],
          };
        }
        return { ok: true, results: [] };
      }),
    });
    const h = createToolHostHandler(d);
    await h(req("browser.page.snapshot"));
    // known snapshotId on same tab → proceeds
    await h(req("browser.page.click", { ref: "e1", snapshotId: "snap:test-1" }));
    // unknown snapshotId → stale
    await expect(
      h(req("browser.page.click", { ref: "e1", snapshotId: "snap:nope" })),
    ).rejects.toMatchObject({ code: "browser.stale_snapshot" });
  });

  test("structural fingerprint change on re-snapshot stales earlier refs", async () => {
    let sfp = "sfp1:first";
    const d = deps({
      sendToTab: vi.fn(async (tabId: number, message: Record<string, unknown>) => {
        if (message.type === "page.dom.snapshot") {
          return {
            snapshotId: `snap:${sfp}`,
            structuralFingerprint: sfp,
            stateFingerprint: "tfp1:x",
            saltEpoch: 1,
            elements: [{ ref: "e1" }],
          };
        }
        return { ok: true, results: [] };
      }),
    });
    const h = createToolHostHandler(d);
    await h(req("browser.page.snapshot"));
    sfp = "sfp1:changed"; // DOM structure changed
    await h(req("browser.page.snapshot"));
    await expect(
      h(req("browser.page.click", { ref: "e1", snapshotId: "snap:sfp1:first" })),
    ).rejects.toMatchObject({ code: "browser.stale_snapshot" });
    // newest snapshot still valid
    await h(req("browser.page.click", { ref: "e1", snapshotId: "snap:sfp1:changed" }));
  });

  test("page.extract forwards bounded maxChars to content", async () => {
    const d = deps({
      sendToTab: vi.fn(async () => ({ text: "hello", truncated: false, url: "https://x", title: "X" })),
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.page.extract", { maxChars: 100 }))) as { text: string };
    expect(res.text).toBe("hello");
    expect((d.sendToTab as ReturnType<typeof vi.fn>).mock.calls[0][1]).toMatchObject({
      type: "page.extract",
      maxChars: 100,
    });
  });

  test("page.upload → browser.gesture_required, never faked", async () => {
    const h = createToolHostHandler(deps());
    await expect(h(req("browser.page.upload", { ref: "e1" }))).rejects.toMatchObject({
      code: "browser.gesture_required",
    });
  });

  test("page.screenshot captures + uploads artifact", async () => {
    const uploads: unknown[] = [];
    const d = deps({
      getTab: vi.fn(async () => ({ id: 7, url: "https://x", windowId: 3, active: true })),
      captureVisibleTab: vi.fn(async () => "data:image/jpeg;base64,QUJD"),
      uploadArtifact: vi.fn(async (input: unknown) => {
        uploads.push(input);
        return { artifactRef: "artifact:art-1", sha256: "abc", bytes: 3 };
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.page.screenshot"))) as { artifactRef: string; mimeType: string };
    expect(res.artifactRef).toBe("artifact:art-1");
    expect(res.mimeType).toBe("image/jpeg");
    expect(uploads[0]).toMatchObject({ kind: "screenshot", mimeType: "image/jpeg", dataBase64: "QUJD" });
  });

  test("page.screenshot without artifact channel → proto.unsupported (no inline leak)", async () => {
    const d = deps({
      getTab: vi.fn(async () => ({ id: 7, url: "https://x", windowId: 3, active: true })),
      captureVisibleTab: vi.fn(async () => "data:image/jpeg;base64,QUJD"),
    });
    const h = createToolHostHandler(d);
    await expect(h(req("browser.page.screenshot"))).rejects.toMatchObject({ code: "proto.unsupported" });
  });

  test("tab.create opens a tab, returns scope ids, strips query/hash (chromex-he2)", async () => {
    const created: Array<{ url?: string; active?: boolean }> = [];
    const d = deps({
      createTab: vi.fn(async (opts: { url?: string; active?: boolean }) => {
        created.push(opts);
        return { id: 55, url: opts.url ?? "about:blank", title: "New", active: opts.active ?? true } as chrome.tabs.Tab;
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.tab.create", { url: "https://example.com/path?q=1#frag" }))) as {
      openedTabId: number;
      resolvedTabId: number;
      tabId: number;
      url: string;
      origin: string;
    };
    expect(res.openedTabId).toBe(55);
    expect(res.resolvedTabId).toBe(55);
    expect(res.tabId).toBe(55);
    expect(res.url).toBe("https://example.com/path");
    expect(res.origin).toBe("https://example.com");
    expect(created[0]).toMatchObject({ url: "https://example.com/path?q=1#frag", active: true });
  });

  test("tab.create blank url → no url passed; active:false honored", async () => {
    const created: Array<{ url?: string; active?: boolean }> = [];
    const d = deps({
      createTab: vi.fn(async (opts: { url?: string; active?: boolean }) => {
        created.push(opts);
        return { id: 56, url: "about:blank", title: "", active: false } as chrome.tabs.Tab;
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.tab.create", { active: false }))) as { resolvedTabId: number };
    expect(res.resolvedTabId).toBe(56);
    expect(created[0]).toEqual({ active: false });
  });

  test("tab.create rejects non-http(s)/invalid urls and missing dep — never faked", async () => {
    const h = createToolHostHandler(deps());
    await expect(h(req("browser.tab.create", {}))).rejects.toMatchObject({ code: "proto.unsupported" });
    const d = deps({
      createTab: vi.fn(async () => ({ id: 1 }) as chrome.tabs.Tab),
    });
    const h2 = createToolHostHandler(d);
    await expect(h2(req("browser.tab.create", { url: "javascript:alert(1)" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    await expect(h2(req("browser.tab.create", { url: "not a url" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    expect(d.createTab).not.toHaveBeenCalled();
  });

  test("page.console runs the MAIN-world collector on the scoped tab (chromex-nr8)", async () => {
    const calls: Array<{ tabId: number; funcName: string; args: unknown[] | undefined }> = [];
    const d = deps({
      runInMainWorld: vi.fn(async (tabId: number, func: (...a: unknown[]) => unknown, args?: unknown[]) => {
        calls.push({ tabId, funcName: func.name, args });
        return { installed: true, entries: [{ level: "error", text: "boom", ts: 1 }] };
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.page.console", { limit: 5, level: "error" }))) as {
      entries: unknown[];
      captured: boolean;
      resolvedTabId: number;
    };
    expect(res.captured).toBe(true);
    expect(res.entries).toHaveLength(1);
    expect(res.resolvedTabId).toBe(7);
    expect(calls[0]).toMatchObject({ tabId: 7, funcName: "chromexConsoleCollect", args: [5, "error"] });
  });

  test("page.console without runInMainWorld dep → proto.unsupported", async () => {
    const h = createToolHostHandler(deps());
    await expect(h(req("browser.page.console"))).rejects.toMatchObject({ code: "proto.unsupported" });
  });

  test("page.hover/page.press map to dom.perform steps (chromex-cly)", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await h(req("browser.page.hover", { ref: "e1" }));
    await h(req("browser.page.press", { key: "Enter", modifiers: ["Control"] }));
    const steps = d.sent.map((s) => (s.message as { steps: Array<Record<string, unknown>> }).steps[0]);
    expect(steps[0]).toMatchObject({ action: "hover", targetRef: "e1" });
    expect(steps[1]).toMatchObject({ action: "press", key: "Enter", modifiers: ["Control"] });
  });

  test("page.press without key → proto.invalid; press without target still dispatches (focused element)", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await expect(h(req("browser.page.press", { ref: "e1" }))).rejects.toMatchObject({ code: "proto.invalid" });
    await h(req("browser.page.press", { key: "Tab" }));
    const step = (d.sent[0].message as { steps: Array<Record<string, unknown>> }).steps[0];
    expect(step).toMatchObject({ action: "press", key: "Tab" });
    expect(step.targetRef).toBeUndefined();
  });
});

describe("tool host tab scope (chromex-9e3)", () => {
  const scopedReq = (
    tool: string,
    args: Record<string, unknown> = {},
    tabScope: Record<string, unknown>,
    taskId = "t1",
  ) => ({ toolCallId: "tc1", taskId, tool, args, tabScope });

  test("in-scope tab allowed; tab outside allowed set → browser.not_in_scope", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    const scope = { boundTabId: 7, allowedTabIds: [7], foreignTabIds: [8] };
    const res = (await h(scopedReq("browser.page.get", { tabId: 7 }, scope))) as { resolvedTabId: number };
    expect(res.resolvedTabId).toBe(7);
    await expect(h(scopedReq("browser.page.get", { tabId: 8 }, scope))).rejects.toMatchObject({
      code: "browser.not_in_scope",
    });
    await expect(h(scopedReq("browser.page.get", { tabId: 9 }, scope))).rejects.toMatchObject({
      code: "browser.not_in_scope",
    });
  });

  test("unbound task cannot bind a foreign-owned tab, but may bind a free one", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    const scope = { boundTabId: null, allowedTabIds: [], foreignTabIds: [7] };
    await expect(h(scopedReq("browser.page.get", { tabId: 7 }, scope))).rejects.toMatchObject({
      code: "browser.not_in_scope",
    });
    const res = (await h(scopedReq("browser.page.get", { tabId: 9 }, scope))) as { resolvedTabId: number };
    expect(res.resolvedTabId).toBe(9);
    expect(d.sent).toHaveLength(0); // page.get uses getTab, not sendToTab
  });

  test("bound task defaults to its bound tab, not the active tab", async () => {
    const d = deps({ activeTabId: vi.fn(async () => 7) });
    const h = createToolHostHandler(d);
    const scope = { boundTabId: 9, allowedTabIds: [9], foreignTabIds: [] };
    const res = (await h(scopedReq("browser.page.snapshot", {}, scope))) as { resolvedTabId: number };
    expect(res.resolvedTabId).toBe(9);
    expect(d.sent[0].tabId).toBe(9);
  });

  test("unbound task falls back to active tab and reports resolvedTabId for binding", async () => {
    const d = deps({ activeTabId: vi.fn(async () => 7) });
    const h = createToolHostHandler(d);
    const scope = { boundTabId: null, allowedTabIds: [], foreignTabIds: [] };
    const res = (await h(scopedReq("browser.page.snapshot", {}, scope))) as { resolvedTabId: number };
    expect(res.resolvedTabId).toBe(7);
    expect(d.sent[0].tabId).toBe(7);
  });

  test("snapshot is bound to (taskId, tabId): cross-task snapshotId → browser.not_in_scope", async () => {
    const d = deps({
      sendToTab: vi.fn(async (tabId: number, message: Record<string, unknown>) => {
        if (message.type === "page.dom.snapshot") {
          return {
            snapshotId: "snap:cross-task",
            structuralFingerprint: "sfp1:ct",
            stateFingerprint: "tfp1:ct",
            saltEpoch: 1,
            elements: [{ ref: "e1" }],
          };
        }
        return { ok: true, results: [] };
      }),
    });
    const h = createToolHostHandler(d);
    const scope = { boundTabId: 7, allowedTabIds: [7], foreignTabIds: [] };
    await h(scopedReq("browser.page.snapshot", {}, scope, "task-a"));
    // same tab, different task → snapshot must not resolve
    await expect(
      h(scopedReq("browser.page.click", { ref: "e1", snapshotId: "snap:cross-task" }, scope, "task-b")),
    ).rejects.toMatchObject({ code: "browser.not_in_scope" });
    // owning task still resolves it
    await h(scopedReq("browser.page.click", { ref: "e1", snapshotId: "snap:cross-task" }, scope, "task-a"));
  });

  test("tabs.list hides tabs owned by other tasks", async () => {
    const d = deps({
      queryTabs: vi.fn(async () => [
        { id: 7, url: "https://a.example", title: "A", active: true, windowId: 1 },
        { id: 8, url: "https://b.example", title: "B", active: false, windowId: 1 },
      ]),
    });
    const h = createToolHostHandler(d);
    const scope = { boundTabId: 7, allowedTabIds: [7], foreignTabIds: [8] };
    const res = (await h(scopedReq("browser.tabs.list", {}, scope))) as { tabs: Array<{ id: number }> };
    expect(res.tabs.map((t) => t.id)).toEqual([7]);
  });

  test("requests without tabScope keep legacy behavior (no scope enforcement)", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.page.snapshot", { tabId: 42 }))) as { resolvedTabId: number };
    expect(res.resolvedTabId).toBe(42);
    expect(d.sent[0].tabId).toBe(42);
  });

  test("implicit target with multiple in-scope tabs and no bound tab → browser.ambiguous_target (chromex-ykj)", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    const scope = { boundTabId: null, allowedTabIds: [7, 9], foreignTabIds: [] };
    await expect(h(scopedReq("browser.page.snapshot", {}, scope))).rejects.toMatchObject({
      code: "browser.ambiguous_target",
    });
    expect(d.sent).toHaveLength(0); // never dispatched
    // explicit tabId still disambiguates
    const res = (await h(scopedReq("browser.page.snapshot", { tabId: 9 }, scope))) as {
      resolvedTabId: number;
    };
    expect(res.resolvedTabId).toBe(9);
  });

  test("single in-scope tab with no bound tab still falls back to active (unambiguous)", async () => {
    const d = deps({ activeTabId: vi.fn(async () => 7) });
    const h = createToolHostHandler(d);
    const scope = { boundTabId: null, allowedTabIds: [7], foreignTabIds: [] };
    const res = (await h(scopedReq("browser.page.snapshot", {}, scope))) as { resolvedTabId: number };
    expect(res.resolvedTabId).toBe(7);
  });
});

describe("tool host error surfacing (§7.3 residual)", () => {
  test("content-reported browser.* failure codes reach the caller unchanged", async () => {
    // browser.ambiguous_target now has producers (content element
    // resolution + scoped tab fallback); this locks the passthrough.
    const d = deps({
      sendToTab: vi.fn(async () => ({
        ok: false,
        summary: "failed",
        results: [
          {
            step: { action: "click" },
            ok: false,
            code: "browser.ambiguous_target",
            message: "2 elements match the selector",
          },
        ],
      })),
    });
    const h = createToolHostHandler(d);
    await expect(h(req("browser.page.click", { selector: ".btn" }))).rejects.toMatchObject({
      code: "browser.ambiguous_target",
    });
  });
});
