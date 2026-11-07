import { describe, expect, test } from "vitest";

import { BrowserHostRegistry, type HostAffinityKey } from "../src/browser/host-registry.js";

const key = (over: Partial<HostAffinityKey> = {}): HostAffinityKey => ({
  profileId: "p1",
  browserInstanceId: "bi-1",
  backendId: "chrome-extension",
  tabId: 42,
  ...over,
});

const reg = (hostInstanceId: string, over = {}) => ({
  hostInstanceId,
  connectionId: `conn-${hostInstanceId}`,
  browserInstanceId: "bi-1",
  profileId: "p1",
  backendId: "chrome-extension",
  ...over,
});

describe("BrowserHostRegistry — §6.1 affinity", () => {
  test("register + resolve live host", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1"));
    expect(r.resolveHost(key())).toEqual({ kind: "host", hostInstanceId: "h1", connectionId: "conn-h1" });
  });

  test("affinity survives hostInstanceId change on same browserInstanceId (SW restart)", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1"));
    r.noteTabAffinity(key(), "h1");
    // host process restarts → new hostInstanceId, same Chrome run
    r.unregisterByConnection("conn-h1");
    r.register(reg("h2"));
    const res = r.resolveHost(key());
    expect(res).toEqual({ kind: "host", hostInstanceId: "h2", connectionId: "conn-h2" });
  });

  test("disconnect without reconnect → stranded, not no_host", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1"));
    r.noteTabAffinity(key(), "h1");
    r.unregisterByConnection("conn-h1");
    expect(r.resolveHost(key())).toEqual({ kind: "stranded", lastHostInstanceId: "h1" });
  });

  test("different browserInstanceId host does NOT inherit stranded affinity", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1"));
    r.noteTabAffinity(key(), "h1");
    r.unregisterByConnection("conn-h1");
    // Chrome restarted → new browserInstanceId; old-scope lookup stays stranded
    r.register(reg("h2", { browserInstanceId: "bi-2" }));
    expect(r.resolveHost(key())).toEqual({ kind: "stranded", lastHostInstanceId: "h1" });
    // new scope routes to the new host — binding staleness is the
    // state machine's job (tab-binding.ts), not routing's.
    expect(r.resolveHost(key({ browserInstanceId: "bi-2" }))).toEqual({
      kind: "host",
      hostInstanceId: "h2",
      connectionId: "conn-h2",
    });
  });

  test("wrong_profile when only other-profile hosts exist", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1", { profileId: "p2" }));
    const res = r.resolveHost(key({ profileId: "p1" }));
    expect(res).toEqual({ kind: "wrong_profile", expected: "p1", got: "p2" });
  });

  test("not_in_scope when hosts exist for other backends", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1", { backendId: "playwright-isolated" }));
    expect(r.resolveHost(key())).toEqual({ kind: "not_in_scope" });
  });

  test("no_host when nothing registered", () => {
    expect(new BrowserHostRegistry().resolveHost(key())).toEqual({ kind: "no_host" });
  });

  test("degraded mode affinity is connection-scoped and dies with it", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1", { browserInstanceId: null }));
    const dkey = key({ browserInstanceId: null, tabId: 9 });
    r.noteTabAffinity(dkey, "h1");
    r.unregisterByConnection("conn-h1");
    // degraded stranded entries are unreachable → no_host (not stranded)
    r.register(reg("h2", { browserInstanceId: null }));
    expect(r.resolveHost(dkey)).toEqual({ kind: "host", hostInstanceId: "h2", connectionId: "conn-h2" });
  });

  test("SW restart: newest live registration wins over a lingering zombie host (S7)", () => {
    const r = new BrowserHostRegistry();
    // gen-1 host conn lingers after its service worker died
    r.register(reg("h1"));
    // gen-2 host registers for the same Chrome run
    r.register(reg("h2"));
    // scope-level resolve must pick the current generation, not h1
    expect(r.resolveHost(key({ tabId: undefined }))).toEqual({
      kind: "host",
      hostInstanceId: "h2",
      connectionId: "conn-h2",
    });
    // once the zombie conn finally drops, h2 is unaffected
    r.unregisterByConnection("conn-h1");
    expect(r.resolveHost(key({ tabId: undefined }))).toEqual({
      kind: "host",
      hostInstanceId: "h2",
      connectionId: "conn-h2",
    });
  });

  test("tab affinity still beats a newer host registration", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1"));
    r.noteTabAffinity(key(), "h1");
    r.register(reg("h2"));
    expect(r.resolveHost(key())).toEqual({ kind: "host", hostInstanceId: "h1", connectionId: "conn-h1" });
  });

  test("unregisterByConnection keeps the host while another conn shares its hostInstanceId", () => {
    const r = new BrowserHostRegistry();
    r.register(reg("h1"));
    // same native-host process reconnected on a second socket
    r.register({ ...reg("h1"), connectionId: "conn-h1b" });
    r.unregisterByConnection("conn-h1");
    expect(r.resolveHost(key())).toEqual({ kind: "host", hostInstanceId: "h1", connectionId: "conn-h1b" });
    r.unregisterByConnection("conn-h1b");
    expect(r.resolveHost(key())).toEqual({ kind: "no_host" });
  });
});
