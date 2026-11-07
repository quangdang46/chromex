/**
 * S3 (chromex-7k3): host-side half of two-task isolation — the extension
 * tool host re-checks the RESOLVED tabId against the per-request
 * tabScope payload, so a task can never activate/close/snapshot another
 * task's tab even if the gateway payload were stale.
 */

import { describe, expect, test, vi } from "vitest";

import { createToolHostHandler, type ToolHostDeps } from "../../src/background/gateway/tool-host.js";

function deps(over: Partial<ToolHostDeps> = {}): ToolHostDeps & {
  sent: Array<{ tabId: number; message: Record<string, unknown> }>;
  activated: number[];
  closed: number[];
} {
  const sent: Array<{ tabId: number; message: Record<string, unknown> }> = [];
  const activated: number[] = [];
  const closed: number[] = [];
  return {
    sent,
    activated,
    closed,
    sendToTab: vi.fn(async (tabId: number, message: Record<string, unknown>) => {
      sent.push({ tabId, message });
      if (message.type === "page.dom.snapshot") {
        return {
          snapshotId: `snap:${(message as { forTask?: string }).forTask ?? "x"}`,
          structuralFingerprint: "sfp1:iso",
          stateFingerprint: "tfp1:iso",
          saltEpoch: 1,
          elements: [{ ref: "e1" }],
        };
      }
      return { ok: true, summary: "done", results: [{ step: (message as { steps?: unknown[] }).steps?.[0], ok: true, message: "ok" }] };
    }),
    getTab: vi.fn(async (tabId: number) => ({ id: tabId, url: `https://t${tabId}.example`, title: "T", active: tabId === 7 })),
    queryTabs: vi.fn(async () => [
      { id: 7, url: "https://a.example", title: "A", active: true, windowId: 1 },
      { id: 9, url: "https://b.example", title: "B", active: false, windowId: 1 },
    ]),
    activateTab: vi.fn(async (tabId: number) => {
      activated.push(tabId);
    }),
    closeTab: vi.fn(async (tabId: number) => {
      closed.push(tabId);
    }),
    activeTabId: vi.fn(async () => 7),
    ...over,
  };
}

const scopedReq = (
  taskId: string,
  tool: string,
  args: Record<string, unknown>,
  tabScope: Record<string, unknown>,
) => ({ toolCallId: `tc-${taskId}-${tool}`, taskId, tool, args, tabScope });

// task-a owns tab 7, task-b owns tab 9 — the payloads the gateway ships
const SCOPE_A = { boundTabId: 7, allowedTabIds: [7], foreignTabIds: [9] };
const SCOPE_B = { boundTabId: 9, allowedTabIds: [9], foreignTabIds: [7] };

describe("tool host two-task isolation (chromex-7k3 S3)", () => {
  test("tab.activate / tab.close on the other task's tab → browser.not_in_scope", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    for (const tool of ["browser.tab.activate", "browser.tab.close"]) {
      await expect(h(scopedReq("task-a", tool, { tabId: 9 }, SCOPE_A))).rejects.toMatchObject({
        code: "browser.not_in_scope",
      });
      await expect(h(scopedReq("task-b", tool, { tabId: 7 }, SCOPE_B))).rejects.toMatchObject({
        code: "browser.not_in_scope",
      });
    }
    expect(d.activated).toEqual([]);
    expect(d.closed).toEqual([]);
  });

  test("implicit target never falls through to the other task's tab", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    // active tab is 7 (task-a's). task-b has bound tab 9 → implicit hits 9.
    const res = (await h(scopedReq("task-b", "browser.page.snapshot", {}, SCOPE_B))) as {
      resolvedTabId: number;
    };
    expect(res.resolvedTabId).toBe(9);
    expect(d.sent[0].tabId).toBe(9);
    // task-a implicit hits its bound 7 even though 9 exists
    const resA = (await h(scopedReq("task-a", "browser.page.snapshot", {}, SCOPE_A))) as {
      resolvedTabId: number;
    };
    expect(resA.resolvedTabId).toBe(7);
    expect(d.sent[1].tabId).toBe(7);
  });

  test("snapshot ids do not cross tasks — even across different tabs", async () => {
    const d = deps({
      sendToTab: vi.fn(async (tabId: number, message: Record<string, unknown>) => {
        if (message.type === "page.dom.snapshot") {
          return {
            snapshotId: `snap:task-a:${tabId}`,
            structuralFingerprint: "sfp1:x",
            stateFingerprint: "tfp1:x",
            saltEpoch: 1,
            elements: [{ ref: "e1" }],
          };
        }
        return { ok: true, results: [] };
      }),
    });
    const h = createToolHostHandler(d);
    // task-a snapshots its tab 7
    await h(scopedReq("task-a", "browser.page.snapshot", {}, SCOPE_A));
    // task-b on ITS OWN tab 9 presents task-a's snapshotId → rejected
    await expect(
      h(scopedReq("task-b", "browser.page.click", { ref: "e1", snapshotId: "snap:task-a:7" }, SCOPE_B)),
    ).rejects.toMatchObject({ code: "browser.not_in_scope" });
    // task-a still resolves its own snapshot
    await h(scopedReq("task-a", "browser.page.click", { ref: "e1", snapshotId: "snap:task-a:7" }, SCOPE_A));
  });

  test("tabs.list hides the other task's tab for both directions", async () => {
    const d = deps();
    const h = createToolHostHandler(d);
    const resA = (await h(scopedReq("task-a", "browser.tabs.list", {}, SCOPE_A))) as {
      tabs: Array<{ id: number }>;
    };
    const resB = (await h(scopedReq("task-b", "browser.tabs.list", {}, SCOPE_B))) as {
      tabs: Array<{ id: number }>;
    };
    expect(resA.tabs.map((t) => t.id)).toEqual([7]);
    expect(resB.tabs.map((t) => t.id)).toEqual([9]);
  });
});
