import { describe, expect, test, vi } from "vitest";

import { createToolHostHandler, type ToolHostDeps } from "../../src/background/gateway/tool-host.js";

function deps(over: Partial<ToolHostDeps> = {}): ToolHostDeps & {
  sent: Array<{ tabId: number; message: Record<string, unknown>; options?: { frameId?: number } }>;
} {
  const sent: Array<{ tabId: number; message: Record<string, unknown>; options?: { frameId?: number } }> = [];
  return {
    sent,
    sendToTab: vi.fn(async (tabId: number, message: Record<string, unknown>, options?: { frameId?: number }) => {
      sent.push({ tabId, message, options });
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

  test("page.click coordinate args map to x/y step; mixing with target rejected", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await h(req("browser.page.click", { x: 120, y: 340, button: "right", clickCount: 2 }));
    const msg = d.sent[0].message as { type: string; steps: Array<Record<string, unknown>> };
    expect(msg.steps[0]).toMatchObject({ action: "click", x: 120, y: 340, button: "right", clickCount: 2 });
    expect(msg.steps[0].targetRef).toBeUndefined();
    await expect(h(req("browser.page.click", { x: 10 }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.click", { x: -1, y: 5 }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.click", { x: 1, y: 2, selector: ".a" }))).rejects.toMatchObject({ code: "proto.invalid" });
  });

  test("page.drag coordinate form maps x/y/dropX/dropY; partial or mixed rejected", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await h(req("browser.page.drag", { x: 10, y: 20, dropX: 110, dropY: 220 }));
    const msg = d.sent[0].message as { steps: Array<Record<string, unknown>> };
    expect(msg.steps[0]).toMatchObject({ action: "drag", x: 10, y: 20, dropX: 110, dropY: 220 });
    await expect(h(req("browser.page.drag", { x: 1, y: 2, dropX: 3 }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.drag", { x: 1, y: 2, dropX: 3, dropY: 4, toRef: "e2" }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.drag", { x: 1, y: 2, dropX: -3, dropY: 4 }))).rejects.toMatchObject({ code: "proto.invalid" });
  });

  test("page.select values[] maps to multi-select step; value+values and empty values rejected", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await h(req("browser.page.select", { selector: "#plans", values: ["pro", "team"] }));
    const msg = d.sent[0].message as { steps: Array<Record<string, unknown>> };
    expect(msg.steps[0]).toMatchObject({ action: "select", values: ["pro", "team"] });
    await expect(
      h(req("browser.page.select", { selector: "#p", value: "a", values: ["b"] })),
    ).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(
      h(req("browser.page.select", { selector: "#p", values: [] })),
    ).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(
      h(req("browser.page.select", { selector: "#p", values: ["a", 42] })),
    ).resolves.toBeDefined();
  });

  test("tab.update/discard resolve scoped tab and validate args", async () => {
    const d = deps();
    const updCalls: Array<[number, Record<string, unknown>]> = [];
    const discarded: number[] = [];
    d.updateTab = async (id, opts) => { updCalls.push([id, opts as Record<string, unknown>]); };
    d.discardTab = async (id) => { discarded.push(id); };
    const h = createToolHostHandler(d);
    const scope = { boundTabId: 7, allowedTabIds: [7], foreignTabIds: [] };
    const sreq = (tool: string, args: Record<string, unknown> = {}) =>
      ({ toolCallId: "tc1", taskId: "t1", tool, args, tabScope: scope });
    await h(sreq("browser.tab.update", { pinned: true, muted: true }));
    expect(updCalls).toEqual([[7, { pinned: true, muted: true }]]);
    await h(sreq("browser.tab.discard"));
    expect(discarded).toEqual([7]);
    await expect(h(sreq("browser.tab.update"))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(sreq("browser.tab.update", { pinned: "yes" }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(sreq("browser.tab.discard", { tabId: 99 }))).rejects.toMatchObject({ code: "browser.not_in_scope" });
  });

  test("tab.update zoomFactor dispatches setTabZoom with bounds check", async () => {
    const d = deps();
    const zooms: Array<[number, number]> = [];
    d.setTabZoom = async (id, z) => { zooms.push([id, z]); };
    const h = createToolHostHandler(d);
    const scope = { boundTabId: 7, allowedTabIds: [7], foreignTabIds: [] };
    const sreq = (args: Record<string, unknown>) =>
      ({ toolCallId: "tc1", taskId: "t1", tool: "browser.tab.update", args, tabScope: scope });
    const res = (await h(sreq({ zoomFactor: 0.8 }))) as { zoomFactor: number };
    expect(zooms).toEqual([[7, 0.8]]);
    expect(res.zoomFactor).toBe(0.8);
    await expect(h(sreq({ zoomFactor: 9 }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(sreq({ zoomFactor: "big" }))).rejects.toMatchObject({ code: "proto.invalid" });
    expect(zooms).toHaveLength(1); // rejected calls never dispatched
  });

  test("page.wait forwards visibleSelector as a wait condition", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await h(req("browser.page.wait", { visibleSelector: ".toast.show", timeoutMs: 3000 }));
    const msg = d.sent[d.sent.length - 1]!.message as Record<string, unknown>;
    expect(msg).toMatchObject({ type: "page.dom.wait", visibleSelector: ".toast.show", timeoutMs: 3000 });
  });

  test("page.hover coordinate args map to x/y step; mixing rejected", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await h(req("browser.page.hover", { x: 50, y: 60 }));
    const msg = d.sent[0].message as { steps: Array<Record<string, unknown>> };
    expect(msg.steps[0]).toMatchObject({ action: "hover", x: 50, y: 60 });
    await expect(h(req("browser.page.hover", { x: 5 }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.hover", { x: 1, y: 2, ref: "e1" }))).rejects.toMatchObject({ code: "proto.invalid" });
  });

  test("tab.create forwards pinned/muted to chrome.tabs.create", async () => {
    const d = deps();
    let created: Record<string, unknown> | undefined;
    d.createTab = async (opts) => {
      created = opts as Record<string, unknown>;
      return { id: 9, url: "https://a.example/", title: "", active: true } as chrome.tabs.Tab;
    };
    const h = createToolHostHandler(d);
    await h(req("browser.tab.create", { url: "https://a.example/", pinned: true, muted: true, active: false }));
    expect(created).toMatchObject({ pinned: true, muted: true, active: false });
  });

  test("windows.list maps chrome.windows entries", async () => {
    const d = deps();
    d.listWindows = async () => [
      { id: 1, focused: true, type: "normal", state: "normal", tabCount: 3, incognito: false },
      { id: 2, focused: false, state: "minimized", width: 800, height: 600 },
    ];
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.windows.list", {}))) as { windows: Array<Record<string, unknown>> };
    expect(res.windows).toHaveLength(2);
    expect(res.windows[0]).toMatchObject({ id: 1, focused: true, tabCount: 3 });
    expect(res.windows[1]).toMatchObject({ id: 2, focused: false, state: "minimized", width: 800 });
  });

  test("windows.create validates url/state and surfaces first tab into scope", async () => {
    const d = deps();
    let created: Record<string, unknown> | undefined;
    d.createWindow = async (opts) => {
      created = opts as Record<string, unknown>;
      return {
        id: 7,
        focused: true,
        state: "normal",
        tabs: [{ id: 42, url: "https://app.example/path?q=secret", title: "App", active: true }],
      };
    };
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.windows.create", { url: "https://app.example/path?q=secret", width: 1024 }))) as {
      windowId: number; openedTabId: number; tabs: Array<{ url: string }>;
    };
    expect(created).toMatchObject({ url: "https://app.example/path?q=secret", width: 1024 });
    expect(res.windowId).toBe(7);
    expect(res.openedTabId).toBe(42);
    expect(res.tabs[0]!.url).toBe("https://app.example/path"); // query stripped
    await expect(h(req("browser.windows.create", { url: "file:///etc/passwd" }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.windows.create", { state: "bogus" }))).rejects.toMatchObject({ code: "proto.invalid" });
  });

  test("windows.update requires windowId + focused|state", async () => {
    const d = deps();
    const calls: Array<[number, Record<string, unknown>]> = [];
    d.updateWindow = async (id, opts) => { calls.push([id, opts as Record<string, unknown>]); };
    const h = createToolHostHandler(d);
    await h(req("browser.windows.update", { windowId: 3, focused: true, state: "maximized" }));
    expect(calls).toEqual([[3, { focused: true, state: "maximized" }]]);
    await expect(h(req("browser.windows.update", { windowId: 3 }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.windows.update", { state: "maximized" }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.windows.update", { windowId: 3, state: "bogus" }))).rejects.toMatchObject({ code: "proto.invalid" });
  });

  test("page.drag maps source + drop target onto a dom.perform step", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await h(req("browser.page.drag", { ref: "e1", toRef: "e9" }));
    const msg = d.sent[0].message as { type: string; steps: Array<Record<string, unknown>> };
    expect(msg.type).toBe("page.dom.perform");
    expect(msg.steps[0]).toMatchObject({
      action: "drag",
      targetRef: "e1",
      dropTargetRef: "e9",
    });
    await expect(h(req("browser.page.drag", { ref: "e1" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    await h(req("browser.page.drag", { selector: ".card", toSelector: ".lane" }));
    expect(d.sent[1].message.steps[0]).toMatchObject({
      action: "drag",
      selector: ".card",
      dropSelector: ".lane",
    });
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

  test("page.upload bytes path maps to dom.perform upload step with files", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    const res = (await h(
      req("browser.page.upload", {
        ref: "e1",
        files: [{ name: "a.txt", mimeType: "text/plain", base64: "aGk=" }],
      }),
    )) as { ok: boolean; resolvedTabId: number };
    expect(res.ok).toBe(true);
    const step = (d.sent[0].message as { steps: Array<Record<string, unknown>> }).steps[0];
    expect(step).toMatchObject({
      action: "upload",
      targetRef: "e1",
      files: [{ name: "a.txt", mimeType: "text/plain", base64: "aGk=" }],
    });
  });

  test("page.upload local paths / missing files → gesture_required / proto.invalid, never dispatched", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await expect(
      h(req("browser.page.upload", { ref: "e1", files: ["/tmp/secret.txt"] })),
    ).rejects.toMatchObject({ code: "browser.gesture_required" });
    await expect(
      h(req("browser.page.upload", { ref: "e1", files: [{ path: "/tmp/x" }] })),
    ).rejects.toMatchObject({ code: "browser.gesture_required" });
    await expect(h(req("browser.page.upload", { ref: "e1" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    await expect(
      h(req("browser.page.upload", { ref: "e1", files: [{ name: "x" }] })),
    ).rejects.toMatchObject({ code: "proto.invalid" });
    expect(d.sent).toHaveLength(0);
  });

  test("page.wait conditional args forward to page.dom.wait on the scoped tab", async () => {
    const sentMsgs: Array<Record<string, unknown>> = [];
    const d = deps({
      sendToTab: vi.fn(async (_tabId: number, message: Record<string, unknown>) => {
        sentMsgs.push(message);
        return { ok: true, matched: "conditions", elapsedMs: 12 };
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(
      req("browser.page.wait", { selector: ".done", timeoutMs: 5000, tabId: 7 }),
    )) as { ok: boolean; elapsedMs: number; resolvedTabId: number };
    expect(res).toMatchObject({ ok: true, elapsedMs: 12, resolvedTabId: 7 });
    expect(sentMsgs[0]).toMatchObject({
      type: "page.dom.wait",
      selector: ".done",
      timeoutMs: 5000,
    });
  });

  test("page.wait content timeout → browser.timeout; bare ms stays a sleep", async () => {
    const d = deps({
      sendToTab: vi.fn(async () => ({ ok: false, timedOut: true, elapsedMs: 10000 })),
    });
    const h = createToolHostHandler(d);
    await expect(h(req("browser.page.wait", { text: "never", timeoutMs: 10 }))).rejects.toMatchObject({
      code: "browser.timeout",
    });
    const res = (await h(req("browser.page.wait", { ms: 1 }))) as { waitedMs: number };
    expect(res.waitedMs).toBe(1);
  });

  test("page.wait networkIdle drains in-flight requests then resolves", async () => {
    let inflight = 2;
    const d = deps({
      networkInflightCount: vi.fn(() => {
        inflight = Math.max(0, inflight - 1);
        return inflight;
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(
      req("browser.page.wait", { networkIdle: true, timeoutMs: 5000, tabId: 7 }),
    )) as { ok: boolean; matched: string };
    expect(res).toMatchObject({ ok: true, matched: "networkIdle" });
  });

  test("page.wait networkIdle times out while requests stay in flight", async () => {
    const d = deps({ networkInflightCount: vi.fn(() => 3) });
    const h = createToolHostHandler(d);
    await expect(
      h(req("browser.page.wait", { networkIdle: true, timeoutMs: 50, tabId: 7 })),
    ).rejects.toMatchObject({ code: "browser.timeout" });
  });

  test("page.wait networkIdle without dep → proto.unsupported", async () => {
    const h = createToolHostHandler(deps());
    await expect(
      h(req("browser.page.wait", { networkIdle: true, tabId: 7 })),
    ).rejects.toMatchObject({ code: "proto.unsupported" });
  });

  test("page.find forwards text/regex/scope to page.dom.find and returns matches", async () => {
    const sentMsgs: Array<Record<string, unknown>> = [];
    const d = deps({
      sendToTab: vi.fn(async (_tabId: number, message: Record<string, unknown>) => {
        sentMsgs.push(message);
        return {
          ok: true,
          scanned: 10,
          truncated: false,
          matches: [{ ref: "find-1", selector: "p", tagName: "p", role: "", text: "hello" }],
        };
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(
      req("browser.page.find", { text: "hello", limit: 5, scopeSelector: "main", caseSensitive: true }),
    )) as { ok: boolean; matches: unknown[]; resolvedTabId: number };
    expect(res.ok).toBe(true);
    expect(res.matches).toHaveLength(1);
    expect(res.resolvedTabId).toBe(7);
    expect(sentMsgs[0]).toMatchObject({
      type: "page.dom.find",
      text: "hello",
      limit: 5,
      scopeSelector: "main",
      caseSensitive: true,
    });
  });

  test("page.find without text/regex or with bad regex → proto.invalid", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await expect(h(req("browser.page.find", {}))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.find", { regex: "([" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    expect(d.sent).toHaveLength(0);
  });

  test("page.history maps action to navigateHistory on the scoped tab", async () => {
    const calls: Array<{ tabId: number; action: string }> = [];
    const d = deps({
      navigateHistory: vi.fn(async (tabId: number, action: "back" | "forward" | "reload") => {
        calls.push({ tabId, action });
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.page.history", { action: "back" }))) as {
      navigated: string;
      resolvedTabId: number;
    };
    expect(res).toMatchObject({ navigated: "back", resolvedTabId: 7 });
    expect(calls).toEqual([{ tabId: 7, action: "back" }]);
    await expect(h(req("browser.page.history", { action: "sideways" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
  });

  test("page.history without dep → proto.unsupported", async () => {
    const h = createToolHostHandler(deps());
    await expect(h(req("browser.page.history", { action: "reload" }))).rejects.toMatchObject({
      code: "proto.unsupported",
    });
  });

  test("downloads.list maps chrome.downloads items; filters validated", async () => {
    const queries: unknown[] = [];
    const d = deps({
      listDownloads: vi.fn(async (q: { state?: string; limit: number; startTime?: number }) => {
        queries.push(q);
        return [
          {
            id: 3,
            state: "complete",
            filename: "/Users/x/Downloads/a.pdf",
            bytesReceived: 100,
            totalBytes: 100,
            mime: "application/pdf",
            fileExists: true,
            startTime: "2026-01-01T00:00:00Z",
          },
        ];
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(
      req("browser.downloads.list", { state: "complete", limit: 10, since: "2026-01-01T00:00:00Z" }),
    )) as {
      downloads: Array<{ id?: number; filename: string; state: string; mime?: string; fileExists?: boolean }>;
    };
    expect(res.downloads[0]).toMatchObject({
      id: 3,
      filename: "/Users/x/Downloads/a.pdf",
      state: "complete",
      mime: "application/pdf",
      fileExists: true,
    });
    expect(queries[0]).toMatchObject({ state: "complete", limit: 10 });
    await expect(h(req("browser.downloads.list", { state: "bogus" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    await expect(h(req("browser.downloads.list", { since: "not-a-date" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
  });

  test("downloads.save validates url/filename and maps the download id", async () => {
    const calls: Array<{ url: string; filename?: string }> = [];
    const d = deps({
      downloadFile: vi.fn(async (input: { url: string; filename?: string }) => {
        calls.push(input);
        return { id: 7, filename: input.filename ?? "report.csv" };
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(
      req("browser.downloads.save", { url: "https://example.com/a.csv", filename: "exports/a.csv" }),
    )) as { downloadId?: number; filename?: string };
    expect(res.downloadId).toBe(7);
    expect(calls[0]).toEqual({ url: "https://example.com/a.csv", filename: "exports/a.csv" });

    await expect(h(req("browser.downloads.save", {}))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.downloads.save", { url: "not a url" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    await expect(h(req("browser.downloads.save", { url: "file:///etc/passwd" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    for (const bad of ["../escape.txt", "/abs/path.txt", "a\\b.txt", "x".repeat(201)]) {
      await expect(
        h(req("browser.downloads.save", { url: "https://example.com/f", filename: bad })),
      ).rejects.toMatchObject({ code: "proto.invalid" });
    }
    // frameId is meaningless on a profile-level tool
    await expect(
      h(req("browser.downloads.save", { url: "https://example.com/f", frameId: 3 })),
    ).rejects.toMatchObject({ code: "proto.invalid" });
  });

  test("downloads.cancel validates the id and delegates to chrome.downloads.cancel", async () => {
    const cancelled: number[] = [];
    const d = deps({
      cancelDownload: vi.fn(async (id: number) => {
        cancelled.push(id);
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.downloads.cancel", { downloadId: 42 }))) as { cancelled?: boolean };
    expect(res.cancelled).toBe(true);
    expect(cancelled).toEqual([42]);

    await expect(h(req("browser.downloads.cancel", {}))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.downloads.cancel", { downloadId: "42" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    await expect(h(req("browser.downloads.cancel", { downloadId: -1 }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    await expect(h(req("browser.downloads.cancel", { downloadId: 1.5 }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    // dep absent → honest unsupported, never a fake cancel
    const h2 = createToolHostHandler(deps({}));
    await expect(h2(req("browser.downloads.cancel", { downloadId: 1 }))).rejects.toMatchObject({
      code: "proto.unsupported",
    });
    // frameId meaningless on a profile-level tool
    await expect(h(req("browser.downloads.cancel", { downloadId: 1, frameId: 2 }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
  });

  test("page.network maps the webRequest log; filters validated", async () => {
    const queries: unknown[] = [];
    const d = deps({
      listNetworkRequests: vi.fn((tabId: number, q: { limit: number; status?: string }) => {
        queries.push({ tabId, ...q });
        return [
          { method: "GET", url: "https://api.example.com/v1/items", type: "xhr", status: 500, mimeType: "application/json", ts: 1 },
          { method: "POST", url: "https://api.example.com/v1/pay", type: "fetch", error: "net::ERR_FAILED", ts: 2 },
        ];
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.page.network", { limit: 10, status: "error" }))) as {
      requests: Array<{ method: string; status?: number; error?: string }>;
    };
    expect(res.requests).toHaveLength(2);
    expect(res.requests[0]).toMatchObject({ method: "GET", status: 500 });
    expect(res.requests[1]).toMatchObject({ method: "POST", error: "net::ERR_FAILED" });
    expect(queries[0]).toMatchObject({ limit: 10, status: "error" });
    await expect(h(req("browser.page.network", { status: "bogus" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
  });

  test("page.network frameId filters requests to that frame", async () => {
    const queries: Array<{ frameId?: number }> = [];
    const d = deps({
      listNetworkRequests: vi.fn((_tabId: number, q: { frameId?: number }) => {
        queries.push(q);
        return [{ method: "GET", url: "https://a.example/x", type: "fetch", frameId: 3, ts: 1 }];
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.page.network", { frameId: 3 }))) as {
      requests: Array<{ frameId?: number }>;
    };
    expect(queries[0]).toMatchObject({ frameId: 3 });
    expect(res.requests[0]).toMatchObject({ frameId: 3 });
    // invalid frameId still rejected
    await expect(h(req("browser.page.network", { frameId: -1 }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
  });

  test("page.network without dep → proto.unsupported", async () => {
    const h = createToolHostHandler(deps());
    await expect(h(req("browser.page.network"))).rejects.toMatchObject({ code: "proto.unsupported" });
  });

  test("downloads.save waitForCompletion polls to terminal state", async () => {
    let state = "in_progress";
    const d = deps({
      downloadFile: vi.fn(async () => ({ id: 42, filename: "a.zip" })),
      listDownloads: vi.fn(async () => {
        state = state === "in_progress" ? "complete" : state;
        return [{ id: 42, state, filename: "/dl/a.zip", fileExists: true }];
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(
      req("browser.downloads.save", { url: "https://example.com/a.zip", waitForCompletion: true, timeoutMs: 5000 }),
    )) as { downloadId?: number; state?: string; filename?: string; fileExists?: boolean };
    expect(res).toMatchObject({ downloadId: 42, state: "complete", filename: "/dl/a.zip", fileExists: true });
  });

  test("downloads.save waitForCompletion times out honestly", async () => {
    const d = deps({
      downloadFile: vi.fn(async () => ({ id: 43 })),
      listDownloads: vi.fn(async () => [{ id: 43, state: "in_progress", filename: "/dl/b.bin" }]),
    });
    const h = createToolHostHandler(d);
    await expect(
      h(req("browser.downloads.save", { url: "https://example.com/b.bin", waitForCompletion: true, timeoutMs: 50 })),
    ).rejects.toMatchObject({ code: "browser.timeout" });
  });

  test("downloads.save waitForCompletion without listDownloads dep → proto.unsupported", async () => {
    const d = deps({ downloadFile: vi.fn(async () => ({ id: 44 })) });
    const h = createToolHostHandler(d);
    await expect(
      h(req("browser.downloads.save", { url: "https://example.com/c", waitForCompletion: true })),
    ).rejects.toMatchObject({ code: "proto.unsupported" });
  });

  test("downloads.save without dep → proto.unsupported", async () => {
    const h = createToolHostHandler(deps());
    await expect(h(req("browser.downloads.save", { url: "https://example.com/f" }))).rejects.toMatchObject({
      code: "proto.unsupported",
    });
  });

  test("downloads.list without dep → proto.unsupported", async () => {
    const h = createToolHostHandler(deps());
    await expect(h(req("browser.downloads.list"))).rejects.toMatchObject({ code: "proto.unsupported" });
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

  test("tab.create forwards windowId; rejects non-integer windowId", async () => {
    const created: Array<{ windowId?: number }> = [];
    const d = deps({
      createTab: vi.fn(async (opts: { url?: string; active?: boolean; windowId?: number }) => {
        created.push(opts);
        return { id: 57, url: "about:blank", title: "", active: true } as chrome.tabs.Tab;
      }),
    });
    const h = createToolHostHandler(d);
    await h(req("browser.tab.create", { windowId: 42 }));
    expect(created[0]).toMatchObject({ windowId: 42 });
    await expect(h(req("browser.tab.create", { windowId: -1 }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    await expect(h(req("browser.tab.create", { windowId: 1.5 }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
  });

  test("tab.duplicate clones a scoped tab, returns scope ids, strips query/hash", async () => {
    const duped: number[] = [];
    const d = deps({
      duplicateTab: vi.fn(async (tabId: number) => {
        duped.push(tabId);
        return {
          id: 88,
          url: "https://example.com/app?session=abc#frag",
          title: "Cloned",
          active: false,
        } as chrome.tabs.Tab;
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.tab.duplicate", { tabId: 9 }))) as {
      openedTabId: number;
      resolvedTabId: number;
      duplicatedFromTabId: number;
      url: string;
      origin: string;
    };
    expect(duped).toEqual([9]);
    expect(res.openedTabId).toBe(88);
    expect(res.resolvedTabId).toBe(88);
    expect(res.duplicatedFromTabId).toBe(9);
    expect(res.url).toBe("https://example.com/app");
    expect(res.origin).toBe("https://example.com");
  });

  test("tab.duplicate without dep → proto.unsupported; foreign tab rejected", async () => {
    const h = createToolHostHandler(deps());
    await expect(h(req("browser.tab.duplicate", { tabId: 9 }))).rejects.toMatchObject({
      code: "proto.unsupported",
    });
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

describe("tool host screenshot payload (chromex-22wi)", () => {
  const shotDeps = (captureImpl?: (windowId: number, opts?: { quality?: number }) => Promise<string>) =>
    deps({
      getTab: vi.fn(async () => ({ id: 7, url: "https://x", windowId: 3, active: true })),
      captureVisibleTab: vi.fn(
        captureImpl ?? (async () => "data:image/jpeg;base64,QUJD"),
      ),
      uploadArtifact: vi.fn(async () => ({ artifactRef: "artifact:art-1", sha256: "abc", bytes: 3 })),
    });

  test("returns artifactRef AND bounded inline dataBase64 for the provider", async () => {
    const d = shotDeps();
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.page.screenshot"))) as {
      artifactRef: string;
      dataBase64: string;
      mimeType: string;
    };
    expect(res.artifactRef).toBe("artifact:art-1");
    expect(res.dataBase64).toBe("QUJD");
    expect(res.mimeType).toBe("image/jpeg");
  });

  test("oversized capture retries at lower jpeg quality until under the 512KiB artifact cap", async () => {
    const big = `data:image/jpeg;base64,${"A".repeat(700_000)}`; // ~525KiB decoded > cap
    const small = "data:image/jpeg;base64,QUJD";
    const qualities: Array<number | undefined> = [];
    const d = shotDeps(async (_w, opts) => {
      qualities.push(opts?.quality);
      return opts?.quality === undefined ? big : small;
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.page.screenshot"))) as { dataBase64: string };
    expect(res.dataBase64).toBe("QUJD");
    expect(qualities).toEqual([undefined, 45]);
  });

  test("still oversized at lowest quality → artifact.too_large, never uploads", async () => {
    const big = `data:image/jpeg;base64,${"A".repeat(700_000)}`;
    const d = shotDeps(async () => big);
    const h = createToolHostHandler(d);
    await expect(h(req("browser.page.screenshot"))).rejects.toMatchObject({
      code: "artifact.too_large",
    });
    expect(d.uploadArtifact).not.toHaveBeenCalled();
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
    // page.get resolves via getTab; the only sendToTab is the read-only
    // scrollpos probe — never a DOM mutation.
    expect(d.sent).toHaveLength(1);
    expect((d.sent[0].message as { type: string }).type).toBe("page.scrollpos");
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

describe("tool host expect verification (chromex-0fza)", () => {
  const performDeps = (waitResult: Record<string, unknown>, stepVerified?: boolean | "unknown") => {
    const sentMsgs: Array<Record<string, unknown>> = [];
    const d = deps({
      sendToTab: vi.fn(async (_tabId: number, message: Record<string, unknown>) => {
        sentMsgs.push(message);
        if (message.type === "page.dom.wait") return waitResult;
        return {
          ok: true,
          summary: "done",
          results: [
            {
              step: message.steps?.[0],
              ok: true,
              message: "ok",
              ...(stepVerified !== undefined ? { verified: stepVerified } : {}),
            },
          ],
        };
      }),
    });
    return Object.assign(d, { sentMsgs });
  };

  test("expect met → verified true; conditions forward to page.dom.wait", async () => {
    const d = performDeps({ ok: true, matched: "conditions", elapsedMs: 30 });
    const h = createToolHostHandler(d);
    const res = (await h(
      req("browser.page.click", {
        selector: ".go",
        expect: { selector: ".done", text: "Saved", goneSelector: ".spin", urlContains: "/saved", timeoutMs: 900 },
      }),
    )) as { verified: boolean; expect: { met: boolean; elapsedMs: number } };
    expect(res.verified).toBe(true);
    expect(res.expect).toMatchObject({ met: true, elapsedMs: 30 });
    const waitMsg = d.sentMsgs.find((m) => m.type === "page.dom.wait");
    expect(waitMsg).toMatchObject({
      type: "page.dom.wait",
      selector: ".done",
      text: "Saved",
      selectorGone: ".spin",
      urlContains: "/saved",
      timeoutMs: 900,
    });
  });

  test("expect timed out → verified false (declared postcondition absent)", async () => {
    const d = performDeps({ ok: false, timedOut: true, elapsedMs: 2000 });
    const h = createToolHostHandler(d);
    const res = (await h(
      req("browser.page.submit", { selector: "form", expect: { text: "never appears" } }),
    )) as { verified: boolean; expect: { met: boolean } };
    expect(res.verified).toBe(false);
    expect(res.expect.met).toBe(false);
  });

  test("expect poll unreachable → verified falls back to step verdict", async () => {
    const d = performDeps({}, "unknown");
    // make page.dom.wait reject
    (d.sendToTab as ReturnType<typeof vi.fn>).mockImplementation(async (_t: number, m: Record<string, unknown>) => {
      if (m.type === "page.dom.wait") throw new Error("no receiver");
      return { ok: true, summary: "done", results: [{ step: m.steps?.[0], ok: true, message: "ok", verified: "unknown" }] };
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.page.click", { selector: ".x", expect: { selector: ".y" } }))) as {
      verified: string;
      expect: { met: string };
    };
    expect(res.verified).toBe("unknown");
    expect(res.expect.met).toBe("unknown");
  });

  test("malformed expect → proto.invalid BEFORE the action dispatches", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await expect(h(req("browser.page.click", { selector: ".x", expect: "soon" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    expect(d.sent).toHaveLength(0);
  });

  test("args.frameId routes page.* calls to the targeted frame", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await h(req("browser.page.snapshot", { frameId: 3 }));
    expect(d.sent[0].options).toEqual({ frameId: 3 });
    await h(req("browser.page.click", { selector: ".x", frameId: 3 }));
    expect(d.sent[1].options).toEqual({ frameId: 3 });
    // absent → top frame (0)
    await h(req("browser.page.snapshot"));
    expect(d.sent[2].options).toEqual({ frameId: 0 });
  });

  test("frameId on a tab-level tool → proto.invalid, nothing dispatched", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await expect(h(req("browser.page.get", { frameId: 2 }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.screenshot", { frameId: 2 }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.history", { action: "back", frameId: 2 }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
    expect(d.sent).toHaveLength(0);
  });

  test("non-integer/negative frameId → proto.invalid", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    await expect(h(req("browser.page.snapshot", { frameId: "3" }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.snapshot", { frameId: -1 }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.snapshot", { frameId: 1.5 }))).rejects.toMatchObject({ code: "proto.invalid" });
    expect(d.sent).toHaveLength(0);
  });

  test("snapshotIds are per-frame: cross-frame snapshotId → stale_snapshot", async () => {
    const d = deps({
      sendToTab: vi.fn(async (tabId: number, message: Record<string, unknown>) => {
        if (message.type === "page.dom.snapshot") {
          return {
            snapshotId: "snap:frame3",
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
    await h(req("browser.page.snapshot", { frameId: 3 }));
    // same frame → ok
    await h(req("browser.page.click", { ref: "e1", snapshotId: "snap:frame3", frameId: 3 }));
    // different frame → stale
    await expect(
      h(req("browser.page.click", { ref: "e1", snapshotId: "snap:frame3", frameId: 0 })),
    ).rejects.toMatchObject({ code: "browser.stale_snapshot" });
    await expect(
      h(req("browser.page.click", { ref: "e1", snapshotId: "snap:frame3" })),
    ).rejects.toMatchObject({ code: "browser.stale_snapshot" });
  });

  test("frame snapshot navigated-check compares the FRAME url, not the tab url", async () => {
    let frameUrl = "https://cdn.example.com/widget";
    const d = deps({
      listFrames: vi.fn(async () => [
        { frameId: 0, url: "https://app.example.com/top?token=1" },
        { frameId: 3, url: frameUrl },
      ]),
      sendToTab: vi.fn(async (tabId: number, message: Record<string, unknown>) => {
        if (message.type === "page.dom.snapshot") {
          return {
            snapshotId: "snap:f3-nav",
            structuralFingerprint: "sfp1:aaa",
            stateFingerprint: "tfp1:bbb",
            saltEpoch: 1,
            metadata: { url: frameUrl },
            elements: [{ ref: "e1" }],
          };
        }
        return { ok: true, results: [] };
      }),
    });
    const h = createToolHostHandler(d);
    await h(req("browser.page.snapshot", { frameId: 3 }));
    // frame url unchanged → action proceeds even though it differs from tab url
    await h(req("browser.page.click", { ref: "e1", snapshotId: "snap:f3-nav", frameId: 3 }));
    // frame navigated → honest browser.navigated
    frameUrl = "https://cdn.example.com/widget/v2";
    await expect(
      h(req("browser.page.click", { ref: "e1", snapshotId: "snap:f3-nav", frameId: 3 })),
    ).rejects.toMatchObject({ code: "browser.navigated" });
  });

  test("page.get lists frames with query/hash stripped", async () => {
    const d = deps({
      listFrames: vi.fn(async () => [
        { frameId: 0, url: "https://app.example.com/page?token=secret" },
        { frameId: 7, url: "https://cdn.example.com/widget.js?x=1#f", parentFrameId: 0 },
      ]),
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.page.get"))) as {
      frames?: Array<{ frameId: number; url: string; parentFrameId?: number }>;
    };
    expect(res.frames).toEqual([
      { frameId: 0, url: "https://app.example.com/page" },
      { frameId: 7, url: "https://cdn.example.com/widget.js", parentFrameId: 0 },
    ]);
  });

  test("page.get key=text returns value via page.extract; invalid key rejected", async () => {
    const d = deps({
      sendToTab: vi.fn(async (_tabId: number, msg: { type: string }) => {
        if (msg.type === "page.scrollpos") return { scrollY: 0 };
        if (msg.type === "page.extract") return { text: "hello page", url: "https://x.test/p?a=1", title: "T" };
        return {};
      }),
    });
    const h = createToolHostHandler(d);
    const res = (await h(req("browser.page.get", { key: "text" }))) as { value?: string };
    expect(res.value).toBe("hello page");
    const resUrl = (await h(req("browser.page.get", { key: "url" }))) as { value?: string };
    expect(resUrl.value).toBe("https://x.test/p");
    await expect(h(req("browser.page.get", { key: "bogus" }))).rejects.toMatchObject({
      code: "proto.invalid",
    });
  });
});


describe("CDP tier tools (docs/adr/debugger-tier.md)", () => {
  interface FakeCdp {
    session: {
      send: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
    };
    sent: Array<{ method: string; params?: Record<string, unknown> }>;
    fire: (method: string, params: Record<string, unknown>) => void;
    releases: () => number;
  }

  function fakeCdp(handlers: Record<string, (params?: Record<string, unknown>) => unknown> = {}): FakeCdp {
    const sent: Array<{ method: string; params?: Record<string, unknown> }> = [];
    const listeners = new Map<string, Array<(p: Record<string, unknown>) => void>>();
    let releaseCount = 0;
    const session = {
      send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
        sent.push({ method, params });
        const h = handlers[method];
        return h ? h(params) : {};
      }),
      on: vi.fn((method: string, cb: (p: Record<string, unknown>) => void) => {
        const arr = listeners.get(method) ?? [];
        arr.push(cb);
        listeners.set(method, arr);
        return () => {
          listeners.set(method, (listeners.get(method) ?? []).filter((f) => f !== cb));
        };
      }),
    };
    return {
      session,
      sent,
      fire: (method, params) => {
        for (const cb of listeners.get(method) ?? []) cb(params);
      },
      releases: () => releaseCount,
    };
  }

  function cdpDeps(tabId: number, cdp: FakeCdp, over: Partial<ToolHostDeps> = {}) {
    return deps({
      getTab: vi.fn(async () => ({ id: tabId, url: "https://x", title: "X", active: true })),
      acquireCdp: vi.fn(async () => cdp.session as never),
      releaseCdp: vi.fn(async () => {}),
      sendToTab: vi.fn(async (_t: number, message: Record<string, unknown>) => {
        if (message.type === "page.dom.locate") {
          return { found: true, x: 10, y: 20, width: 30, height: 40, selector: "#btn", tagName: "button", visible: true };
        }
        return { ok: true };
      }),
      ...over,
    });
  }

  test("CDP tools → proto.unsupported when acquireCdp dep is absent", async () => {
    const h = createToolHostHandler(deps());
    await expect(h(req("browser.page.dialog", { tabId: 501 }))).rejects.toMatchObject({ code: "proto.unsupported" });
    await expect(h(req("browser.page.setInputFiles", { tabId: 501, selector: "input", files: ["/tmp/a"] }))).rejects.toMatchObject({ code: "proto.unsupported" });
    await expect(h(req("browser.page.responseBody", { tabId: 501 }))).rejects.toMatchObject({ code: "proto.unsupported" });
    await expect(h(req("browser.page.snapshot", { tabId: 501, mode: "aria" }))).rejects.toMatchObject({ code: "proto.unsupported" });
    await expect(h(req("browser.page.click", { tabId: 501, selector: "#b", trusted: true }))).rejects.toMatchObject({ code: "proto.unsupported" });
    await expect(h(req("browser.page.press", { tabId: 501, key: "Enter", trusted: true }))).rejects.toMatchObject({ code: "proto.unsupported" });
    await expect(h(req("browser.page.fill", { tabId: 501, selector: "#i", text: "x", trusted: true }))).rejects.toMatchObject({ code: "proto.unsupported" });
  });

  test("snapshot mode:aria returns a formatted AX tree", async () => {
    const cdp = fakeCdp({
      "Accessibility.getFullAXTree": () => ({
        nodes: [
          { nodeId: "1", role: { value: "RootWebArea" }, name: { value: "X" }, childIds: ["2"] },
          { nodeId: "2", role: { value: "button" }, name: { value: "Go" }, childIds: [] },
        ],
      }),
    });
    const h = createToolHostHandler(cdpDeps(502, cdp));
    const res = (await h(req("browser.page.snapshot", { tabId: 502, mode: "aria" }))) as {
      mode: string; tree: string; nodeCount: number;
    };
    expect(res.mode).toBe("aria");
    expect(res.nodeCount).toBe(2);
    expect(res.tree).toContain('- button "Go"');
    expect(cdp.sent.map((s) => s.method)).toContain("Accessibility.getFullAXTree");
  });

  test("snapshot mode:aria rejects a non-zero frameId", async () => {
    const cdp = fakeCdp();
    const h = createToolHostHandler(cdpDeps(503, cdp));
    await expect(h(req("browser.page.snapshot", { tabId: 503, mode: "aria", frameId: 4 }))).rejects.toMatchObject({ code: "proto.invalid" });
  });

  test("page.dialog handles an opening dialog and defaults to dismiss", async () => {
    let handleCalls = 0;
    const cdp = fakeCdp({
      "Page.handleJavaScriptDialog": () => {
        handleCalls += 1;
        // first probe finds no dialog; the event-driven second call does
        if (handleCalls === 1) throw new Error("No dialog is showing");
        return {};
      },
    });
    // fire the event as soon as the tool subscribes
    cdp.session.on.mockImplementation((method: string, cb: (p: Record<string, unknown>) => void) => {
      if (method === "Page.javascriptDialogOpening") {
        setTimeout(() => cb({ type: "confirm", message: "Sure?" }), 0);
      }
      return () => {};
    });
    const h = createToolHostHandler(cdpDeps(504, cdp));
    const res = (await h(req("browser.page.dialog", { tabId: 504, timeoutMs: 2000 }))) as {
      handled: boolean; accept: boolean; dialog?: { type?: string };
    };
    expect(res.handled).toBe(true);
    expect(res.accept).toBe(false);
    expect(res.dialog?.type).toBe("confirm");
    const handle = cdp.sent.filter((s) => s.method === "Page.handleJavaScriptDialog");
    expect(handle.length).toBe(2);
    expect(handle[1]?.params?.accept).toBe(false);
  });

  test("page.dialog handles an already-open dialog without waiting", async () => {
    const cdp = fakeCdp({
      "Page.handleJavaScriptDialog": () => ({}),
    });
    const h = createToolHostHandler(cdpDeps(5041, cdp));
    const res = (await h(req("browser.page.dialog", { tabId: 5041, accept: true, timeoutMs: 5000 }))) as {
      handled: boolean; accept: boolean;
    };
    expect(res.handled).toBe(true);
    expect(res.accept).toBe(true);
    // handled on the first probe — no Page.enable / event wait needed
    expect(cdp.sent.filter((s) => s.method === "Page.handleJavaScriptDialog")).toHaveLength(1);
    expect(cdp.sent.filter((s) => s.method === "Page.enable")).toHaveLength(0);
  });

  test("page.dialog reports no_dialog honestly", async () => {
    const cdp = fakeCdp({
      "Page.handleJavaScriptDialog": () => {
        throw new Error("No dialog is showing");
      },
    });
    const h = createToolHostHandler(cdpDeps(505, cdp));
    const res = (await h(req("browser.page.dialog", { tabId: 505, timeoutMs: 60 }))) as {
      handled: boolean; reason?: string;
    };
    expect(res.handled).toBe(false);
    expect(res.reason).toBe("no_dialog");
  });

  test("page.setInputFiles rejects relative paths and missing targets", async () => {
    const cdp = fakeCdp();
    const h = createToolHostHandler(cdpDeps(506, cdp));
    await expect(h(req("browser.page.setInputFiles", { tabId: 506, selector: "input", files: ["rel/a.png"] }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.setInputFiles", { tabId: 506, files: ["/tmp/a.png"] }))).rejects.toMatchObject({ code: "proto.invalid" });
  });

  test("page.setInputFiles sets files via DOM.setFileInputFiles", async () => {
    const cdp = fakeCdp({
      "DOM.getDocument": () => ({ root: { nodeId: 1 } }),
      "DOM.querySelector": () => ({ nodeId: 42 }),
      "DOM.setFileInputFiles": () => ({}),
    });
    const h = createToolHostHandler(cdpDeps(507, cdp));
    const res = (await h(req("browser.page.setInputFiles", {
      tabId: 507,
      selector: "input[type=file]",
      files: ["/tmp/report.pdf"],
    }))) as { ok: boolean; fileNames: string[] };
    expect(res.ok).toBe(true);
    expect(res.fileNames).toEqual(["report.pdf"]);
    const set = cdp.sent.find((s) => s.method === "DOM.setFileInputFiles");
    expect(set?.params).toMatchObject({ nodeId: 42, files: ["/tmp/report.pdf"] });
  });

  test("page.responseBody lists captured requests then returns a body", async () => {
    const cdp = fakeCdp({
      "Network.getResponseBody": () => ({ body: "hello-body", base64Encoded: false }),
    });
    const h = createToolHostHandler(cdpDeps(508, cdp));
    // prime the tap and feed it one finished request
    await h(req("browser.page.responseBody", { tabId: 508 }));
    cdp.fire("Network.requestWillBeSent", {
      requestId: "r1",
      request: { method: "GET", url: "https://x/api/data?token=1" },
      type: "XHR",
    });
    cdp.fire("Network.responseReceived", {
      requestId: "r1",
      response: { url: "https://x/api/data?token=1", status: 200, mimeType: "application/json" },
    });
    cdp.fire("Network.loadingFinished", { requestId: "r1" });
    const list = (await h(req("browser.page.responseBody", { tabId: 508 }))) as {
      requests: Array<{ requestId: string; url: string; finished: boolean }>;
    };
    expect(list.requests).toHaveLength(1);
    expect(list.requests[0].requestId).toBe("r1");
    expect(list.requests[0].url).toBe("https://x/api/data"); // query stripped
    expect(list.requests[0].finished).toBe(true);
    const body = (await h(req("browser.page.responseBody", { tabId: 508, requestId: "r1" }))) as {
      body: string; bodyBytes: number;
    };
    expect(body.body).toBe("hello-body");
    // second call reuses the same tap — Network.enable sent only once
    expect(cdp.sent.filter((s) => s.method === "Network.enable")).toHaveLength(1);
  });

  test("page.responseBody unknown requestId → browser.not_found", async () => {
    const cdp = fakeCdp();
    const h = createToolHostHandler(cdpDeps(509, cdp));
    await h(req("browser.page.responseBody", { tabId: 509 }));
    await expect(h(req("browser.page.responseBody", { tabId: 509, requestId: "nope" }))).rejects.toMatchObject({ code: "browser.not_found" });
  });

  test("click trusted dispatches CDP mouse events; frameId!=0 unsupported", async () => {
    const cdp = fakeCdp();
    const h = createToolHostHandler(cdpDeps(510, cdp));
    const res = (await h(req("browser.page.click", { tabId: 510, selector: "#btn", trusted: true }))) as {
      ok: boolean; step?: { trusted?: boolean };
    };
    expect(res.ok).toBe(true);
    expect(res.step?.trusted).toBe(true);
    const types = cdp.sent.filter((s) => s.method === "Input.dispatchMouseEvent").map((s) => s.params?.type);
    expect(types).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    await expect(h(req("browser.page.click", { tabId: 510, selector: "#b", trusted: true, frameId: 3 }))).rejects.toMatchObject({ code: "proto.unsupported" });
  });

  test("press trusted dispatches keyDown/keyUp and focuses an element target", async () => {
    const cdp = fakeCdp();
    const sentToTab: Array<Record<string, unknown>> = [];
    const h = createToolHostHandler(cdpDeps(511, cdp, {
      sendToTab: vi.fn(async (_t: number, message: Record<string, unknown>) => {
        sentToTab.push(message);
        if (message.type === "page.dom.locate") {
          return { found: true, x: 1, y: 2, width: 3, height: 4, selector: "#k", tagName: "input", visible: true };
        }
        return { ok: true, results: [{ ok: true }] };
      }),
    }));
    const res = (await h(req("browser.page.press", {
      tabId: 511, selector: "#k", key: "Enter", trusted: true,
    }))) as { ok: boolean; step?: { trusted?: boolean; key?: string } };
    expect(res.ok).toBe(true);
    expect(res.step?.trusted).toBe(true);
    expect(res.step?.key).toBe("Enter");
    // focus step went through the content script before the key events
    const perform = sentToTab.find((m) => m.type === "page.dom.perform");
    expect((perform?.steps as Array<{ action?: string; selector?: string }>)?.[0]).toMatchObject({
      action: "focus", selector: "#k",
    });
    const keyEvents = cdp.sent.filter((s) => s.method === "Input.dispatchKeyEvent");
    expect(keyEvents.map((s) => s.params?.type)).toEqual(["keyDown", "keyUp"]);
    expect(keyEvents[0]?.params).toMatchObject({
      key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r",
    });
  });

  test("press trusted normalizes shifted chars; rejects unknown keys", async () => {
    const cdp = fakeCdp();
    const h = createToolHostHandler(cdpDeps(512, cdp));
    // "A" → Shift+a; "!" → Shift+1 (US layout)
    await h(req("browser.page.press", { tabId: 512, key: "A", trusted: true }));
    await h(req("browser.page.press", { tabId: 512, key: "!", trusted: true }));
    const downs = cdp.sent.filter((s) => s.method === "Input.dispatchKeyEvent" && s.params?.type === "keyDown");
    expect(downs[0]?.params).toMatchObject({ key: "A", code: "KeyA", windowsVirtualKeyCode: 65, text: "A", modifiers: 8 });
    expect(downs[1]?.params).toMatchObject({ key: "!", code: "Digit1", windowsVirtualKeyCode: 49, text: "!", modifiers: 8 });
    await expect(h(req("browser.page.press", { tabId: 512, key: "F13", trusted: true }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.press", { tabId: 512, trusted: true }))).rejects.toMatchObject({ code: "proto.invalid" });
    // keyboard trusted ops allow subframes (focus happens in-frame);
    // pointer ops still reject frameId!=0
    const sub = await h(req("browser.page.press", { tabId: 512, key: "Enter", trusted: true, frameId: 2 }));
    expect((sub as { ok?: boolean }).ok).toBe(true);
    await expect(h(req("browser.page.click", { tabId: 512, selector: "#b", trusted: true, frameId: 2 }))).rejects.toMatchObject({ code: "proto.unsupported" });
  });

  test("type trusted dispatches per-char key events; rejects non-ASCII before dispatch", async () => {
    const cdp = fakeCdp();
    const h = createToolHostHandler(cdpDeps(513, cdp));
    const res = (await h(req("browser.page.type", {
      tabId: 513, selector: "#k", text: "Hi!", trusted: true,
    }))) as { ok: boolean; step?: { trusted?: boolean; chars?: number } };
    expect(res.ok).toBe(true);
    expect(res.step?.trusted).toBe(true);
    expect(res.step?.chars).toBe(3);
    const downs = cdp.sent.filter((s) => s.method === "Input.dispatchKeyEvent" && s.params?.type === "keyDown");
    // H→Shift+h, i→i, !→Shift+1 — three chars, six events total
    expect(downs.map((s) => s.params?.key)).toEqual(["H", "i", "!"]);
    expect(cdp.sent.filter((s) => s.method === "Input.dispatchKeyEvent")).toHaveLength(6);
    // non-ASCII fails BEFORE any dispatch — no partial input
    const before = cdp.sent.length;
    await expect(h(req("browser.page.type", {
      tabId: 513, selector: "#k", text: "oké", trusted: true,
    }))).rejects.toMatchObject({ code: "proto.invalid" });
    expect(cdp.sent.length).toBe(before);
  });

  test("hover trusted dispatches a single mouseMoved; coords or target", async () => {
    const cdp = fakeCdp();
    const h = createToolHostHandler(cdpDeps(514, cdp));
    const res = (await h(req("browser.page.hover", { tabId: 514, selector: "#btn", trusted: true }))) as {
      ok: boolean; step?: { trusted?: boolean };
    };
    expect(res.ok).toBe(true);
    expect(res.step?.trusted).toBe(true);
    const moves = cdp.sent.filter((s) => s.method === "Input.dispatchMouseEvent");
    expect(moves).toHaveLength(1);
    expect(moves[0]?.params).toMatchObject({ type: "mouseMoved", x: 10, y: 20 });
    await h(req("browser.page.hover", { tabId: 514, x: 5, y: 6, trusted: true }));
    expect(cdp.sent.filter((s) => s.method === "Input.dispatchMouseEvent")).toHaveLength(2);
    await expect(h(req("browser.page.hover", { tabId: 514, selector: "#b", x: 1, y: 2, trusted: true }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.hover", { tabId: 514, trusted: true, frameId: 3 }))).rejects.toMatchObject({ code: "proto.unsupported" });
  });

  test("fill trusted sends select-all + delete + per-char keys", async () => {
    const cdp = fakeCdp();
    const h = createToolHostHandler(cdpDeps(515, cdp));
    const res = (await h(req("browser.page.fill", {
      tabId: 515, selector: "#k", text: "ab", trusted: true,
    }))) as { ok: boolean; step?: { trusted?: boolean } };
    expect(res.ok).toBe(true);
    expect(res.step?.trusted).toBe(true);
    // select-all goes through the content script (page.dom.perform);
    // CDP sees only Backspace + the typed chars.
    const downs = cdp.sent.filter((s) => s.method === "Input.dispatchKeyEvent" && s.params?.type === "keyDown");
    expect(downs.map((s) => `${s.params?.key}:${s.params?.modifiers}`)).toEqual([
      "Backspace:0", "a:0", "b:0",
    ]);
    await expect(h(req("browser.page.fill", {
      tabId: 515, selector: "#k", text: "é", trusted: true,
    }))).rejects.toMatchObject({ code: "proto.invalid" });
  });

  test("drag trusted sends press + interpolated moves + release", async () => {
    const cdp = fakeCdp();
    const h = createToolHostHandler(cdpDeps(516, cdp));
    const res = (await h(req("browser.page.drag", {
      tabId: 516, x: 10, y: 20, dropX: 110, dropY: 120, trusted: true,
    }))) as { ok: boolean; step?: { trusted?: boolean } };
    expect(res.ok).toBe(true);
    expect(res.step?.trusted).toBe(true);
    const evs = cdp.sent.filter((s) => s.method === "Input.dispatchMouseEvent");
    const types = evs.map((s) => s.params?.type);
    expect(types[0]).toBe("mouseMoved");
    expect(types[1]).toBe("mousePressed");
    expect(types[types.length - 1]).toBe("mouseReleased");
    expect(types.filter((t) => t === "mouseMoved")).toHaveLength(9); // initial + 8 steps
    const release = evs[evs.length - 1];
    expect(release?.params).toMatchObject({ x: 110, y: 120, button: "left" });
    await expect(h(req("browser.page.drag", {
      tabId: 516, selector: "#s", trusted: true,
    }))).rejects.toMatchObject({ code: "proto.invalid" });
    await expect(h(req("browser.page.drag", {
      tabId: 516, x: 1, y: 2, dropX: 3, dropY: 4, trusted: true, frameId: 3,
    }))).rejects.toMatchObject({ code: "proto.unsupported" });
  });
});
