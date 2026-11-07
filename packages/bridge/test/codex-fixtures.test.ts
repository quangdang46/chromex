import { describe, expect, test } from "vitest";

import { loadAllCodexFixtures, listCodexFixtures } from "./fixtures/codex-loader.js";

const VALID_EVENT_TYPES = new Set([
  "conversation.opened",
  "conversation.closed",
  "user.message.created",
  "turn.started",
  "assistant.delta",
  "reasoning.delta",
  "assistant.message",
  "reasoning.summary",
  "tool.started",
  "tool.completed",
  "permission.requested",
  "permission.resolved",
  "permission.expired",
  "usage",
  "turn.completed",
  "turn.failed",
  "turn.cancelled",
  "turn.unknown",
  "provider.notice",
  // task-stream lifecycle events
  "task.created",
  "task.status_changed",
  "task.backend_changed",
  "task.attention_changed",
  "task.tab_binding",
  "task.completed",
  "task.failed",
  "task.cancelled",
]);

describe("codex fixture corpus (GateB-B2)", () => {
  test("corpus is non-empty and covers required scenarios", () => {
    const names = listCodexFixtures();
    expect(names.length).toBeGreaterThanOrEqual(5);
    const fixtures = loadAllCodexFixtures();
    const covered = new Set(fixtures.map((f) => f.name));
    for (const required of [
      "stream-basic",
      "tool-call",
      "permission-request",
      "turnid-race",
      "interrupt",
      "persistence-timing",
    ]) {
      expect(covered.has(required), `missing fixture ${required}`).toBe(true);
    }
  });

  test("every expected event type is a valid AgentEvent/TaskEvent type", () => {
    for (const fixture of loadAllCodexFixtures()) {
      for (const ev of [
        ...(fixture.expectedDurableEvents ?? []),
        ...(fixture.expectedEphemeralEvents ?? []),
      ]) {
        expect(
          VALID_EVENT_TYPES.has(ev.type as string),
          `${fixture.name}: invalid event type ${String(ev.type)}`,
        ).toBe(true);
      }
    }
  });

  test("durable events never include ephemeral types in expectedDurableEvents", () => {
    for (const fixture of loadAllCodexFixtures()) {
      for (const ev of fixture.expectedDurableEvents ?? []) {
        expect(ev.type).not.toBe("assistant.delta");
        expect(ev.type).not.toBe("reasoning.delta");
        expect(ev.type).not.toBe("gateway.notice");
      }
    }
  });

  test("every notification has a method string", () => {
    for (const fixture of loadAllCodexFixtures()) {
      for (const n of fixture.notifications ?? []) {
        expect(typeof n.method).toBe("string");
        expect(n.method.length).toBeGreaterThan(0);
      }
    }
  });
});
