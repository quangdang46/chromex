// S5 — Interruption recovery: kill -9 the gateway mid-activity, respawn,
// verify the task survives and subsequent browser.tool.call still works
// with no duplicate tool.completed records.
//
// Deterministic path (no provider): task.create → browser.mcp.spawn →
// tool.call #1 → SIGKILL gateway → ensureGateway respawn → tool.call #2 →
// task.sync replay shows both calls, exactly one tool.completed each.
import { runScenario, sleep } from "./lib/harness.mjs";
import { startFixtureServer } from "./fixtures/server.mjs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import process from "node:process";

const SCENARIO = "s5-interruption";

await runScenario(
  SCENARIO,
  async ({ runner, browser, evidence, gateway }) => {
    const fixture = await startFixtureServer();
    let conn2 = null;
    try {
      const taskId = await runner.createTask({
        title: "s5 interruption e2e",
        cwd: "/tmp",
        backend: { backendId: "chrome-extension", pinnedBy: "user" },
        tabIntent: { scope: "untitled" },
      });
      evidence.note(`task ${taskId}`);
      const { token } = await runner.spawnBrowserScope(taskId);

      // bind a tab first so post-respawn calls have scope
      const page = await browser.context.newPage();
      await page.goto(fixture.url("/"), { waitUntil: "domcontentloaded" });
      await page.bringToFront();

      const CALL1_ID = "s5-interrupted-call";
      const call1 = await runner.browserToolCall(taskId, "browser.page.get", {}, token, 60_000, {
        toolCallId: CALL1_ID,
      });
      evidence.note(`pre-kill page.get → ${JSON.stringify(call1)?.slice(0, 200)}`);
      if (call1?.status !== "completed") {
        return { status: "FAIL", summary: "pre-kill browser.tool.call did not complete", details: { call1 } };
      }

      // ---- kill -9 the gateway ----
      const ep = JSON.parse(await readFile(join(gateway.dataDir, "run", "gateway.json"), "utf8"));
      const gwPid = ep.gatewayPid ?? ep.pid;
      evidence.note(`gateway pid=${gwPid} — sending SIGKILL`);
      try {
        process.kill(gwPid, "SIGKILL");
      } catch (e) {
        evidence.note(`kill failed: ${e.message}`);
      }
      await sleep(500);

      // The spawn-budget ledger suppresses respawns for SPAWN_IN_FLIGHT_MS
      // (20s) after the last recorded spawn — and a suppressed call never
      // retries spawning, it just waits out its deadline. Wait out the
      // window so the respawn is allowed on the first attempt.
      try {
        const ledger = JSON.parse(
          await readFile(join(gateway.dataDir, "run", "gateway.spawns.json"), "utf8"),
        );
        const newest = Math.max(0, ...(ledger.attempts ?? [0]));
        const waitMs = Math.max(0, newest + 21_000 - Date.now());
        if (waitMs > 0) {
          evidence.note(`spawn_in_flight window: waiting ${Math.ceil(waitMs / 1000)}s before respawn`);
          await sleep(waitMs);
        }
      } catch {
        /* no ledger — proceed */
      }

      // ---- respawn via a fresh ensureGateway on the SAME dataDir ----
      // (the old conn is dead; our runner keeps recording nothing new)
      const { ensureGateway, GATEWAY_BIN } = await import("./lib/harness.mjs");
      try {
        conn2 = await ensureGateway(gateway.dataDir, {
          hello: {
            protocolVersion: 1,
            clientId: `accept-s5-respawn-${Date.now()}`,
            clientVersion: "0.0.0-acceptance",
            profileId: "default",
            hostInstanceId: "",
            browserInstanceId: null,
          },
          startupTimeoutMs: 60_000,
          gatewayBin: GATEWAY_BIN,
          log: (m) => console.log("[gw2]", m),
        });
      } catch (e) {
        return {
          status: "FAIL",
          summary: `gateway respawn failed: ${e?.message ?? e}`,
          details: { killPid: gwPid },
        };
      }
      evidence.note("gateway respawned");

      // swap the runner's connection so post-respawn calls + events flow
      runner.conn = conn2;
      conn2.onEvent((env) => runner._onEnvelope(env));

      // The extension's NM host only reconnects to the gateway on inbound
      // Envelope traffic, and the extension only talks to the NM host when
      // the UI needs it. Nudge it like a user would: open the sidepanel —
      // its catalog/model requests flow SW → NM host → gateway, which
      // re-establishes the conn and re-registers the browser host.
      try {
        const sp = await browser.context.newPage();
        await sp.goto(`chrome-extension://${browser.extensionId}/sidepanel.html?mode=popup&test=1`);
        await sleep(4_000);
        await sp.close().catch(() => {});
        evidence.note("sidepanel opened to wake NM host → gateway reconnect");
      } catch (e) {
        evidence.note(`sidepanel wake failed: ${e?.message ?? e}`);
      }

      // the MCP scope token was issued by the OLD gateway — tokens may be
      // signed with a per-boot key; try the same token first, then re-spawn.
      let token2 = token;
      let call2;
      try {
        call2 = await runner.browserToolCall(taskId, "browser.page.get", {}, token2, 60_000);
      } catch (e) {
        evidence.note(`post-respawn call with old token failed: ${e?.message} — re-spawning scope`);
        const scope2 = await runner.spawnBrowserScope(taskId);
        token2 = scope2.token;
        call2 = await runner.browserToolCall(taskId, "browser.page.get", {}, token2, 60_000);
      }
      // The extension's NM host reconnects lazily — browser.no_host means
      // it has not re-registered yet. Retry briefly; each attempt is a
      // durable tool event (honest evidence of recovery lag).
      const hostDeadline = Date.now() + 90_000;
      while (
        call2?.status === "failed" &&
        call2?.error?.code === "browser.no_host" &&
        Date.now() < hostDeadline
      ) {
        evidence.note("browser.no_host — waiting for extension host re-register, retrying");
        await sleep(3_000);
        try {
          call2 = await runner.browserToolCall(taskId, "browser.page.get", {}, token2, 60_000);
        } catch (e) {
          evidence.note(`retry threw: ${e?.message ?? e}`);
          break;
        }
      }
      evidence.note(`post-respawn page.get → ${JSON.stringify(call2)?.slice(0, 300)}`);

      // durable dedup (371fe7a): replaying the pre-kill toolCallId after
      // the restart must NOT re-dispatch — duplicate_tool_call proves the
      // seeded outcome survived the respawn.
      let dedup = null;
      try {
        dedup = await runner.browserToolCall(taskId, "browser.page.get", {}, token2, 30_000, {
          toolCallId: CALL1_ID,
        });
      } catch (e) {
        dedup = { status: "threw", error: { code: e?.code ?? e?.message } };
      }
      evidence.note(`post-respawn replay of ${CALL1_ID} → ${JSON.stringify(dedup)?.slice(0, 200)}`);
      const dedupBlocked =
        dedup?.status === "failed" && dedup?.error?.code === "browser.duplicate_tool_call";

      const sync = await runner.taskSync(taskId);
      const events = sync.events ?? [];
      const completed = events.filter((e) => {
        const t = e.type ?? e.payload?.type;
        const p = e.payload ?? e;
        return t === "tool.completed" && p.tool === "browser.page.get";
      });
      const started = events.filter((e) => {
        const t = e.type ?? e.payload?.type;
        const p = e.payload ?? e;
        return t === "tool.started" && p.tool === "browser.page.get";
      });
      evidence.note(`durable: tool.started=${started.length} tool.completed=${completed.length}`);

      const pass =
        call2?.status === "completed" && completed.length >= 2 && started.length >= 2 && dedupBlocked;
      // a dedup-rejected replay still writes tool.completed (outcome=failed,
      // code=duplicate_tool_call) — that is evidence, not a second dispatch.
      // "duplicate" means two completions that actually ran for one id.
      const dispatched = completed.filter(
        (e) => (e.payload ?? e).output?.error?.code !== "browser.duplicate_tool_call",
      );
      const ids = dispatched.map((e) => (e.payload ?? e).toolCallId).filter(Boolean);
      const dup = ids.length !== new Set(ids).size;
      return {
        status: pass && !dup ? "PASS" : "FAIL",
        summary:
          pass && !dup
            ? "gateway SIGKILL → respawn → task + tab scope survived, calls completed once, replayed toolCallId deduped"
            : `call2=${call2?.status} completed=${completed.length} started=${started.length} dup=${dup} dedupBlocked=${dedupBlocked}`,
        details: { call1Status: call1?.status, call2, dedup, completed: completed.length, started: started.length, duplicateCompletions: dup },
      };
    } finally {
      // stop the respawned gateway so no detached process leaks
      try {
        const ep2 = JSON.parse(await readFile(join(gateway.dataDir, "run", "gateway.json"), "utf8"));
        if (ep2.gatewayPid) process.kill(ep2.gatewayPid, "SIGTERM");
      } catch {}
      try {
        conn2?.close?.();
      } catch {}
      await fixture.close();
    }
  },
  { autoAnswer: "allow", gatewayProviders: [], headless: process.env.CHROMEX_ACCEPTANCE_HEADFUL !== "1" },
);
