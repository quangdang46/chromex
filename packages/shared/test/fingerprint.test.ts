import { describe, expect, test } from "vitest";

import {
  SnapshotRegistry,
  boundsBucket,
  canonicalJson,
  fieldIdentity,
  fieldValueHash,
  scrollBucket,
  stateFingerprint,
  structuralFingerprint,
  urlOriginPath,
  SNAPSHOT_LRU_PER_TASK,
  SNAPSHOT_TTL_MS,
  type StateInputs,
  type StructuralInputs,
} from "../src/browser/fingerprint.js";

const SALT = "dGVzdC1zYWx0LXRoYXQtaXMtMzItYnl0ZXMtbG9uZyE";

function structural(elements: StructuralInputs["elements"]): StructuralInputs {
  return { version: 1, elementCount: elements.length, interactiveCount: elements.length, elements };
}

function state(over: Partial<StateInputs> = {}): StateInputs {
  return {
    version: 1,
    structural: "sfp1:x",
    urlOriginPath: "https://example.com/path",
    readyState: "complete",
    scrollBucket: [0, 0],
    fieldValueHashes: [],
    ...over,
  };
}

describe("canonicalJson", () => {
  test("sorted keys recursively, undefined dropped", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 }, skip: undefined })).toBe(
      '{"a":{"c":3,"d":2},"b":1}',
    );
  });
});

describe("fingerprints", () => {
  test("structuralFingerprint is stable for identical inputs, changes on structure", async () => {
    const el = [{ role: "button", name: "OK", tag: "button", boundsBucket: [0, 0, 64, 32] as [number, number, number, number] }];
    const a = await structuralFingerprint(structural(el));
    const b = await structuralFingerprint(structural([...el]));
    expect(a).toBe(b);
    expect(a.startsWith("sfp1:")).toBe(true);
    const c = await structuralFingerprint(structural([...el, { ...el[0]!, name: "Cancel" }]));
    expect(c).not.toBe(a);
  });

  test("stateFingerprint changes on value/url/scroll but not on unrelated fields", async () => {
    const base = state();
    const a = await stateFingerprint(base);
    expect(await stateFingerprint(state({ readyState: "complete" }))).toBe(a);
    expect(await stateFingerprint(state({ urlOriginPath: "https://example.com/other" }))).not.toBe(a);
    expect(await stateFingerprint(state({ scrollBucket: [64, 0] }))).not.toBe(a);
    expect(
      await stateFingerprint(
        state({ fieldValueHashes: [{ fieldIdentity: "f1", valueHash: "h1" }] }),
      ),
    ).not.toBe(a);
  });

  test("fieldValueHash is deterministic per (salt,origin,ref,value) and salt-sensitive", async () => {
    const h1 = await fieldValueHash(SALT, "https://a.com", "dom-1", "hello");
    const h2 = await fieldValueHash(SALT, "https://a.com", "dom-1", "hello");
    expect(h1).toBe(h2);
    expect(h1.length).toBe(22); // 16 bytes base64url
    expect(await fieldValueHash("other-salt", "https://a.com", "dom-1", "hello")).not.toBe(h1);
    expect(await fieldValueHash(SALT, "https://a.com", "dom-1", "world")).not.toBe(h1);
    expect(await fieldValueHash(SALT, "https://a.com", "dom-2", "hello")).not.toBe(h1);
  });

  test("fieldIdentity ignores value, stable across calls, changes on structure", async () => {
    const parts = { structuralPath: "html>body>form[0]>input[1]", role: "textbox", name: "q", type: "text", formIndex: 0 };
    const a = await fieldIdentity(parts);
    expect(await fieldIdentity({ ...parts })).toBe(a);
    expect(await fieldIdentity({ ...parts, structuralPath: "html>body>div[0]>input[1]" })).not.toBe(a);
    expect(await fieldIdentity({ ...parts, name: "other" })).not.toBe(a);
  });
});

describe("url/bounds helpers", () => {
  test("urlOriginPath strips query and hash", () => {
    expect(urlOriginPath("https://ex.com/p?token=secret#frag")).toBe("https://ex.com/p");
    expect(urlOriginPath("not a url ?q=1")).toBe("not a url ");
  });

  test("boundsBucket quantizes to 32px", () => {
    expect(boundsBucket({ left: 10, top: 20, width: 100, height: 40 })).toEqual([0, 32, 96, 32]);
  });

  test("scrollBucket quantizes to 64px", () => {
    expect(scrollBucket(10, 90)).toEqual([0, 64]);
  });
});

describe("SnapshotRegistry", () => {
  const meta = (id: string, taskId = "t1", capturedAt = Date.now()) => ({
    snapshotId: id,
    taskId,
    structuralFingerprint: "sfp1:a",
    stateFingerprint: "tfp1:b",
    saltEpoch: 1,
    capturedAt,
  });

  test("put/get roundtrip; missing → null", () => {
    const r = new SnapshotRegistry();
    r.put(meta("snap:1"));
    expect(r.get("snap:1")?.saltEpoch).toBe(1);
    expect(r.get("snap:nope")).toBeNull();
  });

  test("TTL expiry removes entry", () => {
    const r = new SnapshotRegistry();
    const old = Date.now() - SNAPSHOT_TTL_MS - 1;
    r.put(meta("snap:old", "t1", old));
    expect(r.get("snap:old")).toBeNull();
    expect(r.size).toBe(0);
  });

  test("LRU keeps newest SNAPSHOT_LRU_PER_TASK per task", () => {
    const r = new SnapshotRegistry();
    const now = Date.now();
    for (let i = 0; i < SNAPSHOT_LRU_PER_TASK + 5; i += 1) {
      r.put(meta(`snap:${i}`, "t1", now - (SNAPSHOT_LRU_PER_TASK + 5 - i) * 1000));
    }
    expect(r.size).toBe(SNAPSHOT_LRU_PER_TASK);
    expect(r.get("snap:0")).toBeNull();
    expect(r.get(`snap:${SNAPSHOT_LRU_PER_TASK + 4}`)).not.toBeNull();
  });

  test("per-task LRU is independent", () => {
    const r = new SnapshotRegistry();
    const now = Date.now();
    for (let i = 0; i < SNAPSHOT_LRU_PER_TASK + 2; i += 1) {
      r.put(meta(`a:${i}`, "ta", now - i * 1000));
      r.put(meta(`b:${i}`, "tb", now - i * 1000));
    }
    expect(r.size).toBe(SNAPSHOT_LRU_PER_TASK * 2);
  });

  test("invalidateTab drops only that tab's snapshots", () => {
    const r = new SnapshotRegistry();
    const now = Date.now();
    r.put({ ...meta("snap:a", "t1", now), tabId: 1 });
    r.put({ ...meta("snap:b", "t1", now), tabId: 2 });
    r.invalidateTab(1);
    expect(r.get("snap:a")).toBeNull();
    expect(r.get("snap:b")).not.toBeNull();
  });

  test("latestForTab returns newest live snapshot for the tab", () => {
    const r = new SnapshotRegistry();
    const now = Date.now();
    r.put({ ...meta("snap:old", "t1", now - 10_000), tabId: 7 });
    r.put({ ...meta("snap:new", "t1", now), tabId: 7 });
    r.put({ ...meta("snap:other", "t1", now), tabId: 9 });
    expect(r.latestForTab(7)?.snapshotId).toBe("snap:new");
    expect(r.latestForTab(3)).toBeNull();
  });

  test("latestForTab ignores expired entries", () => {
    const r = new SnapshotRegistry();
    const old = Date.now() - SNAPSHOT_TTL_MS - 1;
    r.put({ ...meta("snap:old", "t1", old), tabId: 4 });
    expect(r.latestForTab(4)).toBeNull();
  });
});
