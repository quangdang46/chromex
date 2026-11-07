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
    for (const tool of ["browser.page.evaluate", "browser.page.screenshot", "browser.page.extract", "browser.page.upload"]) {
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
});
