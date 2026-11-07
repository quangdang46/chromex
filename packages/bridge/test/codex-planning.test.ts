import { describe, expect, test } from "vitest";

import type { AgenticRouteInput, BrowserDomSnapshot } from "@codex-sidepanel/shared";

import { CodexAgentProvider } from "../src/agents/providers/codex/provider.js";
import type { CodexAppServerClient } from "../src/codex-app-server.js";

type NotificationPayload = {
  method: string;
  params?: Record<string, unknown>;
};

/** Minimal app-server fake: ephemeral thread + one assistant message. */
class FakePlanningClient {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  readonly handlers = new Set<(notification: NotificationPayload) => void>();

  constructor(private readonly replyText: string) {}

  onNotification(handler: (notification: NotificationPayload) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.calls.push({ method, params });
    if (method === "thread/start") {
      return { thread: { id: "thread-plan" } };
    }
    if (method === "turn/start") {
      const text = this.replyText;
      setTimeout(() => {
        this.emit({
          method: "item/completed",
          params: {
            threadId: "thread-plan",
            turnId: "turn-plan",
            item: { type: "agentMessage", text },
          },
        });
        this.emit({
          method: "turn/completed",
          params: { threadId: "thread-plan", turn: { id: "turn-plan" } },
        });
      }, 0);
      return { turn: { id: "turn-plan" } };
    }
    return {};
  }

  emit(notification: NotificationPayload): void {
    for (const handler of this.handlers) {
      handler(notification);
    }
  }
}

const routeInput: AgenticRouteInput = {
  message: "summarize this page",
  selectedProfileId: "default",
  selectedModel: "fast-model",
  models: [
    {
      id: "fast-model",
      label: "Fast",
      description: "Text model",
      isDefault: true,
      supportsImages: false,
      reasoningEfforts: ["low"],
    },
  ],
  readStrategyOverride: "auto",
  explicitAttachments: ["current-page"],
  fileAttachments: [],
};

const routeReply = JSON.stringify({
  task: "general",
  contextRequests: [
    { source: "current-page", readStrategy: "dom", required: true, reason: "Summarize the page." },
  ],
  requiresVision: false,
  intent: {
    summary: "Summarize the current page.",
    action: "summarize",
    target: "current-page",
    constraints: [],
    needsClarification: false,
  },
  selectedProfileId: "default",
  notes: [],
  confidence: 0.9,
});

const snapshot: BrowserDomSnapshot = {
  snapshotId: "snap:test-1",
  metadata: { url: "https://example.com", title: "Example", domain: "example.com" },
  elements: [
    {
      ref: "dom-1",
      role: "button",
      tagName: "button",
      label: "Search",
      text: "Search",
      selector: "button:nth-of-type(1)",
      disabled: false,
      viewportRect: { left: 10, top: 20, width: 90, height: 32 },
    },
  ],
};

const actionReply = JSON.stringify({
  shouldAct: true,
  summary: "Click the search button.",
  steps: [{ action: "click", targetRef: "dom-1", reason: "User asked to click search." }],
  requiresConfirmation: true,
  confidence: 0.9,
});

function providerWith(replyText: string): {
  provider: CodexAgentProvider;
  client: FakePlanningClient;
} {
  const client = new FakePlanningClient(replyText);
  return {
    provider: new CodexAgentProvider({ client: client as unknown as CodexAppServerClient }),
    client,
  };
}

describe("codex provider planning (gateway route.plan / browser.action.plan)", () => {
  test("planRoute returns the LLM plan on an ephemeral planner thread", async () => {
    const { provider, client } = providerWith(routeReply);

    const plan = await provider.planRoute(routeInput);

    expect(plan.source).toBe("llm");
    expect(plan.intent.action).toBe("summarize");
    expect(plan.contextRequests.map((r) => r.source)).toContain("current-page");
    const threadStart = client.calls.find((c) => c.method === "thread/start");
    expect(threadStart?.params).toMatchObject({ ephemeral: true, approvalPolicy: "never" });
    expect(client.calls.some((c) => c.method === "turn/start")).toBe(true);
  });

  test("planRoute degrades to a fallback plan when the app-server fails", async () => {
    const client = new FakePlanningClient("");
    client.request = async (method: string) => {
      client.calls.push({ method, params: {} });
      throw new Error("app-server unavailable");
    };
    const provider = new CodexAgentProvider({
      client: client as unknown as CodexAppServerClient,
    });

    const plan = await provider.planRoute(routeInput);

    expect(plan.source).toBe("fallback");
  });

  test("planBrowserAction returns a normalized DOM action plan", async () => {
    const { provider } = providerWith(actionReply);

    const plan = await provider.planBrowserAction({
      message: "click the search button",
      snapshot,
      locale: "en-US",
    });

    expect(plan.shouldAct).toBe(true);
    expect(plan.steps).toHaveLength(1);
    expect(plan.steps[0]).toMatchObject({ action: "click", targetRef: "dom-1" });
  });
});
