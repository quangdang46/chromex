import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import type { DurableTabDescriptor, TabIntent } from "@codex-sidepanel/shared";

import { BrowserHostRegistry, type HostAffinityKey } from "../../bridge/src/browser/host-registry.js";
import { resolveTabBinding, type BindingCandidate } from "../../bridge/src/gateway/tab-binding.js";
import { resolveBrowserInstanceId } from "../src/browser-instance.js";

const key = (over: Partial<HostAffinityKey> = {}): HostAffinityKey => ({
  profileId: "p1",
  browserInstanceId: "bi-1",
  backendId: "chrome-extension",
  tabId: 42,
  ...over,
});

const reg = (hostInstanceId: string, over: Record<string, unknown> = {}) => ({
  hostInstanceId,
  connectionId: `conn-${hostInstanceId}`,
  browserInstanceId: "bi-1",
  profileId: "p1",
  backendId: "chrome-extension",
  ...over,
});

const desc = (over: Partial<DurableTabDescriptor> = {}): DurableTabDescriptor => ({
  profileId: "p1",
  origin: "https://app.example.com",
  pathPattern: "/inbox",
  resolvedAt: 1000,
  originBrowserInstanceId: "bi-1",
  ...over,
});

const tab = (id: number, url: string, over: Partial<BindingCandidate> = {}): BindingCandidate => ({
  tabId: id,
  url,
  ...over,
});

describe("BrowserHostRegistry — cross-profile isolation", () => {
  test("affinity is profile-scoped: p1 tab binding never resolves to p2 host", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h-p1"));
    r.register(reg("h-p2", { profileId: "p2" }));
    r.noteTabAffinity(key(), "h-p1");

    expect(r.resolveHost(key())).toEqual({ kind: "host", hostInstanceId: "h-p1" });
    // same tabId/browserInstanceId/backend, different profile → p2 host,
    // not the p1 affinity entry.
    expect(r.resolveHost(key({ profileId: "p2" }))).toEqual({
      kind: "host",
      hostInstanceId: "h-p2",
    });
  });

  test("host without declared profileId serves any profile scope", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h-any", { profileId: undefined }));
    expect(r.resolveHost(key({ profileId: "p1" }))).toEqual({
      kind: "host",
      hostInstanceId: "h-any",
    });
    expect(r.resolveHost(key({ profileId: "p9" }))).toEqual({
      kind: "host",
      hostInstanceId: "h-any",
    });
  });

  test("stranded affinity is reported before wrong_profile", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h-p1"));
    r.noteTabAffinity(key(), "h-p1");
    r.unregisterByConnection("conn-h-p1");
    // only a different-profile host remains
    r.register(reg("h-p2", { profileId: "p2" }));
    expect(r.resolveHost(key())).toEqual({ kind: "stranded", lastHostInstanceId: "h-p1" });
  });

  test("same profile + backend but different browserInstanceId → not_in_scope", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h-new", { browserInstanceId: "bi-2" }));
    // no affinity for the old run and no live host for bi-1
    expect(r.resolveHost(key())).toEqual({ kind: "not_in_scope" });
  });

  test("backendId 'auto' is a wildcard and matches a declared backend", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1", { backendId: "playwright-isolated" }));
    expect(r.resolveHost(key({ backendId: "auto" }))).toEqual({
      kind: "host",
      hostInstanceId: "h1",
    });
    expect(r.resolveHost(key({ backendId: "chrome-extension" }))).toEqual({
      kind: "not_in_scope",
    });
  });

  test("wrong_profile contract carries expected/got profile ids", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h-p2", { profileId: "p2" }));
    r.register(reg("h-p3", { profileId: "p3" }));
    expect(r.resolveHost(key({ profileId: "p1" }))).toEqual({
      kind: "wrong_profile",
      expected: "p1",
      got: expect.any(String),
    });
  });
});

describe("BrowserHostRegistry — tab affinity updates", () => {
  test("affinity prefers the host that served the tab over a live fallback", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1"));
    r.register(reg("h2")); // same scope — both live
    r.noteTabAffinity(key(), "h2");
    expect(r.resolveHost(key())).toEqual({ kind: "host", hostInstanceId: "h2" });
  });

  test("re-noting affinity moves the tab to the new host", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1"));
    r.register(reg("h2"));
    r.noteTabAffinity(key(), "h1");
    expect(r.resolveHost(key())).toEqual({ kind: "host", hostInstanceId: "h1" });
    r.noteTabAffinity(key(), "h2");
    expect(r.resolveHost(key())).toEqual({ kind: "host", hostInstanceId: "h2" });
  });

  test("affinity is per-tabId: neighbouring tabs keep their own host", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1"));
    r.register(reg("h2"));
    r.noteTabAffinity(key({ tabId: 42 }), "h1");
    r.noteTabAffinity(key({ tabId: 43 }), "h2");
    expect(r.resolveHost(key({ tabId: 42 }))).toEqual({ kind: "host", hostInstanceId: "h1" });
    expect(r.resolveHost(key({ tabId: 43 }))).toEqual({ kind: "host", hostInstanceId: "h2" });
  });

  test("scope-level key (no tabId) does not match tab-level affinity", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1"));
    r.register(reg("h2"));
    r.noteTabAffinity(key({ tabId: 42 }), "h1");
    const scope = key({ tabId: undefined });
    // no affinity for "*" scope → falls back to first live host, not h1
    const res = r.resolveHost(scope);
    expect(res.kind).toBe("host");
    expect((res as { hostInstanceId: string }).hostInstanceId).not.toBeUndefined();
  });

  test("unregisterHost removes the host and its connection mapping", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1"));
    r.unregisterHost("h1");
    expect(r.listHosts()).toHaveLength(0);
    expect(r.resolveHost(key())).toEqual({ kind: "no_host" });
    // connection id is free again — a stale unregister is a no-op
    r.unregisterByConnection("conn-h1");
    expect(r.listHosts()).toHaveLength(0);
  });
});

describe("resolveTabBinding — hostInstanceId restart vs Chrome restart", () => {
  test("SW restart (new hostInstanceId, same browserInstanceId) keeps ok binding", () => {
    // binding layer only sees browserInstanceId — hostInstanceId churn
    // is invisible here by design; registry hands back the live host.
    const r = resolveTabBinding(
      { scope: "active_resolved", resolved: desc() },
      [tab(7, "https://app.example.com/inbox")],
      "bi-1",
    );
    expect(r).toMatchObject({ state: "ok", tabId: 7, reason: "bound" });
  });

  test("new browserInstanceId (Chrome restart) → stale, never auto-bind", () => {
    const intent: TabIntent = { scope: "active_resolved", resolved: desc() };
    const r = resolveTabBinding(
      intent,
      [tab(7, "https://app.example.com/inbox", { browserInstanceId: "bi-2" })],
      "bi-2",
    );
    expect(r).toMatchObject({ state: "stale", reason: "stale_instance" });
  });

  test("explicit re-pick on the NEW Chrome run binds; a third instance stays stale", () => {
    const intent: TabIntent = {
      scope: "explicit",
      refs: [desc({ originBrowserInstanceId: "bi-1" })],
    };
    // user explicitly re-picked a tab owned by the current run → ok
    expect(
      resolveTabBinding(
        intent,
        [tab(9, "https://app.example.com/inbox", { browserInstanceId: "bi-2" })],
        "bi-2",
      ),
    ).toMatchObject({ state: "ok", tabId: 9, reason: "bound" });
    // candidate owned by an instance that is neither the ref's nor the
    // live one → stale_instance
    expect(
      resolveTabBinding(
        intent,
        [tab(9, "https://app.example.com/inbox", { browserInstanceId: "bi-3" })],
        "bi-2",
      ),
    ).toMatchObject({ state: "stale", reason: "stale_instance" });
  });

  test("explicit match with unknown tab instance still binds (guard needs proof)", () => {
    const intent: TabIntent = { scope: "explicit", refs: [desc()] };
    const r = resolveTabBinding(
      intent,
      [tab(4, "https://app.example.com/inbox")], // no browserInstanceId on candidate
      "bi-2",
    );
    expect(r).toMatchObject({ state: "ok", tabId: 4, reason: "bound" });
  });

  test("descriptor without originBrowserInstanceId → degraded, needs_confirmation", () => {
    const intent: TabIntent = {
      scope: "active_resolved",
      resolved: desc({ originBrowserInstanceId: undefined }),
    };
    const r = resolveTabBinding(intent, [tab(7, "https://app.example.com/inbox")], "bi-1");
    expect(r).toMatchObject({ state: "needs_confirmation", reason: "degraded_identity" });
  });
});

describe("resolveBrowserInstanceId — PID-reuse guard (browser-instance.md)", () => {
  async function tempDir(): Promise<string> {
    return fs.mkdtemp(path.join(os.tmpdir(), "bi-binding-"));
  }

  test("record with stale parent start time → new ID minted (PID reuse detected)", async () => {
    const dir = await tempDir();
    try {
      // Simulate a record left by a previous Chrome run: same ppid value
      // (PID got reused by a new Chrome) but the recorded start time can
      // never match the live process's `ps lstart` output.
      const record = {
        browserInstanceId: "stale-instance-id",
        chromePpid: process.pid,
        chromePpidStartedAt: "Mon Jan  1 00:00:00 1990",
        createdAt: 0,
      };
      await fs.writeFile(path.join(dir, "browser-instance.json"), JSON.stringify(record), {
        mode: 0o600,
      });

      const id = await resolveBrowserInstanceId({ dataDir: dir, ppid: process.pid });
      expect(id).toBeTruthy();
      expect(id).not.toBe("stale-instance-id");

      const rewritten = JSON.parse(
        await fs.readFile(path.join(dir, "browser-instance.json"), "utf8"),
      );
      expect(rewritten.chromePpid).toBe(process.pid);
      expect(rewritten.chromePpidStartedAt).not.toBe("Mon Jan  1 00:00:00 1990");
      expect(rewritten.browserInstanceId).toBe(id);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  test("empty parent start time (Windows fallback / ps failure) is stable but ppid still distinguishes runs", async () => {
    const dir = await tempDir();
    try {
      // A pid that has already exited → `ps` fails → startedAt "".
      // This is the same shape the Windows CIM fallback produces, so it
      // exercises the documented accepted-reuse-window path.
      const deadPpid = spawnSync(process.execPath, ["-e", ""]).pid;
      expect(deadPpid).toBeGreaterThan(1);

      const id1 = await resolveBrowserInstanceId({ dataDir: dir, ppid: deadPpid });
      const id2 = await resolveBrowserInstanceId({ dataDir: dir, ppid: deadPpid });
      expect(id1).toBeTruthy();
      expect(id1).toBe(id2); // stable within the "run"

      // a different (also dead) ppid still mints a different ID — the
      // ppid itself remains part of the identity even without start time
      const otherDead = spawnSync(process.execPath, ["-e", ""]).pid;
      const id3 = await resolveBrowserInstanceId({ dataDir: dir, ppid: otherDead });
      expect(id3).not.toBe(id1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
