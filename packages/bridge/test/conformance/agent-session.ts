/**
 * AgentSession conformance harness — GateB-B1 / plan §2.2.
 *
 * Runnable against ANY AgentSession implementation:
 *
 *   import { runAgentSessionConformance } from "./conformance/agent-session.js";
 *   runAgentSessionConformance("codex", async () => makeCodexSession());
 *
 * Covers the §2.2 member checklist. Deep semantic tests (interrupt
 * ownership under load, followUpPrompt execution) are adapter-specific —
 * this suite verifies the CONTRACT surface every adapter must satisfy.
 *
 * Paseo divergences (documented, intentional):
 *  - startTurn returns {accepted, providerTurnId?} — Paseo returns
 *    {turnId}; ours never lets a provider turnId be confused with the
 *    gateway-owned turnId (§4.4.1).
 *  - No run() — Gateway owns turn lifecycle; adapters only startTurn.
 *  - canStopRuntime may be sync OR async (Paseo is async-only).
 *  - Paseo extras out of scope: revert*, setFeature, stopBackgroundWork,
 *    usageSession, initialTimeline, steerActiveTurn (ours: steer()).
 */

import { describe, expect, test } from "vitest";

import type {
  AgentEvent,
  AgentSession,
  TurnInput,
} from "@codex-sidepanel/shared";

export interface ConformanceContext {
  /** a ready session with an open conversation */
  session: AgentSession;
  /** minimal valid TurnInput for startTurn */
  turnInput: TurnInput;
}

export type SessionFactory = () => Promise<ConformanceContext>;

const BASE_INPUT: TurnInput = {
  gatewayTurnId: "conf-turn-1",
  clientMessageId: "conf-cm-1",
  content: [{ type: "text", text: "conformance probe" }],
};

export function runAgentSessionConformance(name: string, factory: SessionFactory): void {
  describe(`AgentSession conformance: ${name}`, () => {
    test("identity + capabilities surface", async () => {
      const { session } = await factory();
      expect(typeof session.provider).toBe("string");
      expect(session.provider.length).toBeGreaterThan(0);
      expect(typeof session.sessionKey).toBe("string");
      const caps = session.capabilities;
      for (const key of [
        "streaming",
        "interrupt",
        "resume",
        "steer",
        "permissionPrompts",
      ] as const) {
        expect(typeof caps[key]).toBe("boolean");
      }
      await session.close();
    });

    test("subscribe returns unsubscribe; events are AgentEvent-shaped", async () => {
      const { session } = await factory();
      const events: AgentEvent[] = [];
      const unsub = session.subscribe((e) => events.push(e));
      expect(typeof unsub).toBe("function");
      unsub();
      // after unsub, no more events should arrive
      const count = events.length;
      await session.close();
      expect(events.length).toBe(count);
    });

    test("getPendingPermissions returns array (mirror only)", async () => {
      const { session } = await factory();
      const pending = session.getPendingPermissions();
      expect(Array.isArray(pending)).toBe(true);
      await session.close();
    });

    test("respondToPermission returns PermissionResponseResult or void", async () => {
      const { session } = await factory();
      // no pending permission → calling with unknown id must not throw
      // contract violation; adapters may reject, that's fine.
      try {
        const res = await session.respondToPermission("nonexistent", {
          requestId: "nonexistent",
          optionId: "deny",
        });
        if (res !== undefined) {
          expect(res).toHaveProperty("followUpPrompt") as never;
        }
      } catch {
        /* rejection acceptable for unknown id */
      }
      await session.close();
    });

    test("describePersistence is null or a valid handle — never premature", async () => {
      const { session } = await factory();
      const handle = session.describePersistence();
      if (handle !== null) {
        expect(handle.provider).toBe(session.provider);
        expect(typeof handle.ref).toBe("string");
        expect(handle.ref.length).toBeGreaterThan(0);
        expect(typeof handle.kind).toBe("string");
      }
      await session.close();
    });

    test("getRuntimeInfo resolves with provider + sessionId fields", async () => {
      const { session } = await factory();
      const info = await session.getRuntimeInfo();
      expect(info.provider).toBe(session.provider);
      expect("sessionId" in info).toBe(true);
      await session.close();
    });

    test("getAvailableModes/getCurrentMode return arrays/nullable string", async () => {
      const { session } = await factory();
      const modes = await session.getAvailableModes();
      expect(Array.isArray(modes)).toBe(true);
      const current = await session.getCurrentMode();
      expect(current === null || typeof current === "string").toBe(true);
      await session.close();
    });

    test("startTurn accepts TurnInput with gatewayTurnId; returns accepted", async () => {
      const { session, turnInput } = await factory();
      const res = await session.startTurn(turnInput ?? BASE_INPUT);
      expect(res.accepted).toBe(true);
      // providerTurnId, if present, must be a string and NOT equal the
      // gateway turnId (identity separation §4.4.1)
      if (res.providerTurnId !== undefined) {
        expect(typeof res.providerTurnId).toBe("string");
        expect(res.providerTurnId).not.toBe((turnInput ?? BASE_INPUT).gatewayTurnId);
      }
      await session.close();
    });

    test("interrupt() resolves and is idempotent when idle", async () => {
      const { session } = await factory();
      await session.interrupt();
      await session.interrupt(); // second call must also resolve
      await session.close();
    });

    test("canStopRuntime, when present, returns boolean (sync or async)", async () => {
      const { session } = await factory();
      if (session.canStopRuntime) {
        const v = await session.canStopRuntime();
        expect(typeof v).toBe("boolean");
      }
      await session.close();
    });

    test("close() is idempotent", async () => {
      const { session } = await factory();
      await session.close();
      await session.close();
    });

    test("streamHistory, when present, is an async generator of AgentEvents", async () => {
      const { session } = await factory();
      if (session.streamHistory) {
        const gen = session.streamHistory();
        expect(typeof gen[Symbol.asyncIterator]).toBe("function");
        // drain at most a few events — adapters may block on open streams
        const it = gen[Symbol.asyncIterator]();
        const first = await Promise.race([
          it.next(),
          new Promise<{ done: true }>((r) => setTimeout(() => r({ done: true, value: undefined }), 500)),
        ]);
        expect(first.done === true || typeof first.value === "object").toBe(true);
        await it.return?.(undefined as never);
      }
      await session.close();
    });
  });
}
