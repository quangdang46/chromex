import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";

import { resolveBrowserInstanceId } from "../src/browser-instance.js";

describe("resolveBrowserInstanceId (B6)", () => {
  test("mints stable ID per (ppid, startTime); changes when parent changes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bi-"));
    const id1 = await resolveBrowserInstanceId({ dataDir: dir, ppid: 12345 });
    const id2 = await resolveBrowserInstanceId({ dataDir: dir, ppid: 12345 });
    expect(id1).toBeTruthy();
    expect(id1).toBe(id2); // same Chrome run → stable (SW/host restart safe)

    // different ppid (Chrome restarted) → new ID
    const id3 = await resolveBrowserInstanceId({ dataDir: dir, ppid: 99999 });
    expect(id3).not.toBe(id1);
    await fs.rm(dir, { recursive: true, force: true });
  });

  test("null dataDir or non-Chrome parent → null (degraded)", async () => {
    expect(await resolveBrowserInstanceId({})).toBeNull();
    expect(await resolveBrowserInstanceId({ dataDir: "/tmp/x", ppid: 1 })).toBeNull();
  });

  test("record file is 0600 and contains ppid binding", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "bi-"));
    await resolveBrowserInstanceId({ dataDir: dir, ppid: 4242 });
    const stat = await fs.stat(path.join(dir, "browser-instance.json"));
    expect(stat.mode & 0o777).toBe(0o600);
    const rec = JSON.parse(await fs.readFile(path.join(dir, "browser-instance.json"), "utf8"));
    expect(rec.chromePpid).toBe(4242);
    expect(typeof rec.browserInstanceId).toBe("string");
    await fs.rm(dir, { recursive: true, force: true });
  });
});
