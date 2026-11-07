/**
 * Self-test: proves the conformance harness runs end-to-end against a
 * minimal scripted AgentSession. Real adapters (Codex P1-05, Claude
 * P3-01) invoke runAgentSessionConformance with their own factory.
 */

import { describe, expect, test } from "vitest";

import type { AgentSession, AgentEvent } from "@codex-sidepanel/shared";
import { NO_CAPABILITIES } from "@codex-sidepanel/shared";

import { runAgentSessionConformance } from "./agent-session.js";

function makeMockSession(): AgentSession {
  const listeners = new Set<(e: AgentEvent) => void>();
  return {
    provider: "mock",
    sessionKey: "mock-1",
    capabilities: { ...NO_CAPABILITIES, streaming: true, interrupt: true },
    startTurn: async () => ({ accepted: true as const, providerTurnId: "pt-mock-1" }),
    interrupt: async () => {},
    respondToPermission: async () => ({}),
    getPendingPermissions: () => [],
    subscribe: (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getRuntimeInfo: async () => ({ provider: "mock", sessionId: null, model: null, modeId: null }),
    getAvailableModes: async () => [],
    getCurrentMode: async () => null,
    describePersistence: () => null,
    close: async () => {},
    canStopRuntime: () => true,
  };
}

// Register the full conformance suite against the mock at collection
// time — all §2.2 member checks execute as real tests.
runAgentSessionConformance("mock", async () => ({
  session: makeMockSession(),
  turnInput: {
    gatewayTurnId: "g1",
    clientMessageId: "c1",
    content: [{ type: "text", text: "hi" }],
  },
}));
