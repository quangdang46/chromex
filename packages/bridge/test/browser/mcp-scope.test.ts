import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  mcpScopePath,
  readMcpScopeFile,
  updateMcpScopeToken,
  writeMcpScopeFile,
} from "../../src/browser/mcp-scope.js";

let dir: string;
beforeEach(async () => { dir = await fs.mkdtemp(path.join(os.tmpdir(), "chromex-mcpscope-")); });
afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });

const base = {
  taskId: "t1",
  token: "tok-1",
  tokenExpiresAt: 1000,
  profileId: "p1",
  backendId: "chrome-extension" as const,
  allowedTools: ["browser.page.click"],
  gatewayEndpoint: "/tmp/gw.sock",
  gatewayTokenFile: "/tmp/auth/token",
};

describe("mcp scope files", () => {
  test("write/read roundtrip; file is 0600", async () => {
    const file = await writeMcpScopeFile(dir, base);
    expect(file).toBe(mcpScopePath(dir, "t1"));
    const stat = await fs.stat(file);
    expect(stat.mode & 0o777).toBe(0o600);
    const read = await readMcpScopeFile(file);
    expect(read?.token).toBe("tok-1");
    expect(read?.taskId).toBe("t1");
  });

  test("updateMcpScopeToken hot-updates token, keeps scope", async () => {
    await writeMcpScopeFile(dir, base);
    expect(await updateMcpScopeToken(dir, "t1", "tok-2", 2000)).toBe(true);
    const read = await readMcpScopeFile(mcpScopePath(dir, "t1"));
    expect(read?.token).toBe("tok-2");
    expect(read?.tokenExpiresAt).toBe(2000);
    expect(read?.allowedTools).toEqual(["browser.page.click"]);
  });

  test("update on missing file returns false; unsafe taskId sanitized", async () => {
    expect(await updateMcpScopeToken(dir, "nope", "x", 1)).toBe(false);
    const file = await writeMcpScopeFile(dir, { ...base, taskId: "a/b:c" });
    expect(path.basename(file)).toBe("a_b_c.json");
    expect((await readMcpScopeFile(file))?.taskId).toBe("a/b:c");
  });
});
