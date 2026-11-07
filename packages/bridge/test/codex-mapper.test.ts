/**
 * CodexEventMapper replay tests — GateB-B2 / P1-05.
 * Replays each fixture's notifications through the real mapper and
 * asserts the durable + ephemeral sequences. The turnId-race fixture
 * additionally asserts §4.4.1 buffering: events arriving before
 * bindTurn() flush only after the provider↔gateway binding resolves.
 */

import { describe, expect, test } from "vitest";

import { CodexEventMapper, type MappedAgentEvent } from "../src/agents/providers/codex/mapper.js";
import { loadAllCodexFixtures, type CodexFixture } from "./fixtures/codex-loader.js";

function findProviderTurnId(fixture: CodexFixture): string | null {
  for (const n of fixture.notifications ?? []) {
    const params = n.params as Record<string, unknown> | undefined;
    const turn = params?.turn as Record<string, unknown> | undefined;
    if (typeof turn?.id === "string") return turn.id;
    if (typeof params?.turnId === "string") return params.turnId;
  }
  return null;
}

function replay(fixture: CodexFixture): { durable: MappedAgentEvent[]; ephemeral: MappedAgentEvent[] } {
  const mapper = new CodexEventMapper("sess-test");
  const durable: MappedAgentEvent[] = [];
  const ephemeral: MappedAgentEvent[] = [];
  mapper.onEvent((e) => (e.ephemeral ? ephemeral.push(e) : durable.push(e)));

  const providerTurnId = findProviderTurnId(fixture);
  const isRace = fixture.name === "turnid-race";

  if (!isRace && providerTurnId) {
    mapper.bindTurn(providerTurnId, fixture.gatewayTurnId);
  }
  for (const n of fixture.notifications ?? []) {
    mapper.mapNotification(n.method, n.params);
  }
  if (isRace && providerTurnId) {
    mapper.bindTurn(providerTurnId, fixture.gatewayTurnId);
  }
  return { durable, ephemeral };
}

function subset(actual: Record<string, unknown>, expected: Record<string, unknown>): boolean {
  return Object.entries(expected).every(([k, v]) => {
    const av = actual[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return (
        av !== null &&
        typeof av === "object" &&
        subset(av as Record<string, unknown>, v as Record<string, unknown>)
      );
    }
    return av === v;
  });
}

describe("CodexEventMapper fixture replay", () => {
  const fixtures = loadAllCodexFixtures().filter(
    (f) => f.expectedDurableEvents || f.expectedEphemeralEvents,
  );

  for (const fixture of fixtures) {
    test(`${fixture.name}: durable + ephemeral sequences`, () => {
      const { durable, ephemeral } = replay(fixture);
      const actualDurable = durable.map((e) => e.event as unknown as Record<string, unknown>);
      const actualEphemeral = ephemeral.map((e) => ({
        ...(e.event as unknown as Record<string, unknown>),
        ...(e.deltaOffset !== undefined ? { deltaOffset: e.deltaOffset } : {}),
      }));

      for (const [i, expected] of (fixture.expectedDurableEvents ?? []).entries()) {
        expect(
          subset(actualDurable[i] ?? {}, expected),
          `durable[${i}] expected ${JSON.stringify(expected)} got ${JSON.stringify(actualDurable[i])}`,
        ).toBe(true);
      }
      expect(actualDurable.length).toBe((fixture.expectedDurableEvents ?? []).length);

      for (const [i, expected] of (fixture.expectedEphemeralEvents ?? []).entries()) {
        expect(
          subset(actualEphemeral[i] ?? {}, expected),
          `ephemeral[${i}] expected ${JSON.stringify(expected)} got ${JSON.stringify(actualEphemeral[i])}`,
        ).toBe(true);
      }
      expect(actualEphemeral.length).toBe((fixture.expectedEphemeralEvents ?? []).length);
    });
  }

  test("turnid-race: events buffer until bindTurn resolves", () => {
    const fixture = fixtures.find((f) => f.name === "turnid-race")!;
    const mapper = new CodexEventMapper("sess-race");
    const seen: string[] = [];
    mapper.onEvent((e) => seen.push(`${e.ephemeral ? "E" : "D"}:${(e.event as { type: string }).type}`));

    const providerTurnId = findProviderTurnId(fixture)!;
    // replay BEFORE binding — nothing may emit yet
    for (const n of fixture.notifications ?? []) mapper.mapNotification(n.method, n.params);
    expect(seen).toEqual([]);

    mapper.bindTurn(providerTurnId, fixture.gatewayTurnId);
    const durableTypes = seen.filter((s) => s.startsWith("D:")).map((s) => s.slice(2));
    expect(durableTypes).toEqual(["turn.started", "assistant.message"]);
    expect(seen.some((s) => s === "E:assistant.delta")).toBe(true);
  });

  test("no-turnId events drop + count when unbound", () => {
    const mapper = new CodexEventMapper("sess-drop");
    let emitted = 0;
    mapper.onEvent(() => emitted++);
    mapper.mapNotification("item/agentMessage/delta", {
      itemId: "m",
      delta: "orphan",
    });
    expect(emitted).toBe(0);
    expect(mapper.droppedEventCount).toBe(1);
  });

  test("single bound turn: no-turnId events assign to it", () => {
    const mapper = new CodexEventMapper("sess-single");
    const durable: string[] = [];
    mapper.onEvent((e) => {
      if (!e.ephemeral) durable.push((e.event as { type: string; turnId?: string }).type + ":" + (e.event as { turnId?: string }).turnId);
    });
    mapper.bindTurn("pt-x", "gt-x");
    mapper.mapNotification("item/completed", {
      item: { id: "m1", type: "agentMessage", text: "hi" },
    });
    expect(durable).toContain("assistant.message:gt-x");
  });
});
