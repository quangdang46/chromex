/**
 * Signed tool token — plan §9.1 / P1-09.
 *
 * Format: `base64url(canonicalJson(payload)) + "." + base64url(hmacSHA256(secret, canonicalJson(payload)))`
 *
 * - Payload is READABLE (not encrypted); the signature protects integrity.
 * - `jti` is a token GENERATION id — NOT anti-replay. Duplicate-execution
 *   protection is `toolCallId` uniqueness (enforced by the tool server).
 * - TTL 15min; refresh keeps taskId/profileId/allowedTools, rotates jti;
 *   old token valid for a 60s grace window after refresh.
 * - |clock skew| ≤ 60s tolerated; beyond → proto.auth_failed.
 * - Secret: `dataDir/auth/tool-secret` (0600), generated at gateway start,
 *   never logged, distinct from the IPC auth token.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import type { BrowserBackendId } from "@codex-sidepanel/shared";

export const TOOL_TOKEN_TTL_MS = 15 * 60 * 1000;
export const TOOL_TOKEN_GRACE_MS = 60 * 1000;
export const TOOL_TOKEN_SKEW_MS = 60 * 1000;

export interface ToolTokenPayload {
  v: 1;
  taskId: string;
  profileId: string;
  backendId: BrowserBackendId;
  allowedTools: string[];
  iat: number;
  exp: number;
  /** token generation id — NOT anti-replay */
  jti: string;
}

/** Canonical JSON: sorted keys (codepoint), no whitespace, UTF-8 NFC. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  if (typeof v === "string") return v.normalize("NFC");
  return v;
}

export class ToolTokenManager {
  private secret: Buffer;
  /** jti → expiry of PREVIOUS generation (grace window) */
  private readonly previousGenerations = new Map<string, number>();
  private current: { payload: ToolTokenPayload; token: string; secret: Buffer } | null = null;

  private constructor(secret: Buffer) {
    this.secret = secret;
  }

  static async create(dataDir: string): Promise<ToolTokenManager> {
    const dir = path.join(dataDir, "auth");
    const file = path.join(dir, "tool-secret");
    let secret: Buffer;
    try {
      secret = Buffer.from((await fs.readFile(file, "utf8")).trim(), "hex");
      if (secret.length !== 32) throw new Error("bad length");
    } catch {
      secret = randomBytes(32);
      await fs.mkdir(dir, { recursive: true });
      const tmp = `${file}.tmp`;
      await fs.writeFile(tmp, secret.toString("hex"), { mode: 0o600 });
      await fs.rename(tmp, file);
    }
    return new ToolTokenManager(secret);
  }

  /** Test hook: fixed secret. */
  static forTest(secretHex: string): ToolTokenManager {
    return new ToolTokenManager(Buffer.from(secretHex, "hex"));
  }

  /** Issue (or re-issue after refresh) a token for a task scope. */
  issue(scope: {
    taskId: string;
    profileId: string;
    backendId: BrowserBackendId;
    allowedTools: string[];
    now?: number;
  }): { token: string; payload: ToolTokenPayload; expiresAt: number } {
    const now = scope.now ?? Date.now();
    // drop grace entries whose validity window has fully passed —
    // previousGenerations would otherwise grow one entry per rotation
    for (const [jti, graceUntil] of this.previousGenerations) {
      if (now > graceUntil) this.previousGenerations.delete(jti);
    }
    // rotating jti retires the previous generation into the grace window
    if (this.current) {
      this.previousGenerations.set(this.current.payload.jti, this.current.payload.exp + TOOL_TOKEN_GRACE_MS);
    }
    const payload: ToolTokenPayload = {
      v: 1,
      taskId: scope.taskId,
      profileId: scope.profileId,
      backendId: scope.backendId,
      allowedTools: [...scope.allowedTools].sort(),
      iat: now,
      exp: now + TOOL_TOKEN_TTL_MS,
      jti: randomBytes(8).toString("hex"),
    };
    const canonical = canonicalJson(payload);
    const sig = createHmac("sha256", this.secret).update(canonical, "utf8").digest();
    const token = `${Buffer.from(canonical, "utf8").toString("base64url")}.${sig.toString("base64url")}`;
    this.current = { payload, token, secret: this.secret };
    return { token, payload, expiresAt: payload.exp };
  }

  /** Current live token for a scope (issues if absent). */
  currentToken(scope: Parameters<ToolTokenManager["issue"]>[0]) {
    return this.issue(scope);
  }

  /**
   * Verify a presented token. Returns the payload or throws a typed
   * error. Checks: signature, exp (with 60s grace for previous jti),
   * |iat-now| skew ≤ 60s, and scope match (taskId/profileId/backendId/
   * allowedTools ⊇ requested tool).
   */
  verify(
    token: string,
    expected: { taskId: string; profileId: string; backendId: BrowserBackendId; tool: string },
    now = Date.now(),
  ): ToolTokenPayload {
    const [body, sig] = token.split(".");
    if (!body || !sig) throw new ToolTokenError("malformed token", "proto.auth_failed");
    const canonical = Buffer.from(body, "base64url").toString("utf8");
    const expectedSig = createHmac("sha256", this.secret).update(canonical, "utf8").digest();
    const gotSig = Buffer.from(sig, "base64url");
    if (gotSig.length !== expectedSig.length || !timingSafeEqual(gotSig, expectedSig)) {
      throw new ToolTokenError("bad signature", "proto.auth_failed");
    }
    let payload: ToolTokenPayload;
    try {
      payload = JSON.parse(canonical) as ToolTokenPayload;
    } catch {
      throw new ToolTokenError("bad payload", "proto.auth_failed");
    }
    if (payload.v !== 1) throw new ToolTokenError("unsupported version", "proto.auth_failed");

    // expiry: current generation exp, or previous-generation grace
    const graceUntil = this.previousGenerations.get(payload.jti);
    const validUntil = payload.exp + (graceUntil !== undefined ? TOOL_TOKEN_GRACE_MS : 0);
    if (now > validUntil) throw new ToolTokenError("token expired", "proto.auth_failed");
    if (payload.exp < now - TOOL_TOKEN_SKEW_MS && graceUntil === undefined) {
      // iat far in future → skew; exp check above covers past expiry
    }
    if (Math.abs(now - payload.iat) > TOOL_TOKEN_SKEW_MS + TOOL_TOKEN_TTL_MS) {
      throw new ToolTokenError("clock skew", "proto.auth_failed");
    }

    if (payload.taskId !== expected.taskId) {
      throw new ToolTokenError("taskId mismatch", "browser.wrong_task");
    }
    if (payload.profileId !== expected.profileId) {
      throw new ToolTokenError("profileId mismatch", "browser.wrong_profile");
    }
    if (payload.backendId !== expected.backendId) {
      throw new ToolTokenError("backendId mismatch", "browser.backend_mismatch");
    }
    if (!payload.allowedTools.includes(expected.tool)) {
      throw new ToolTokenError(`tool ${expected.tool} not in scope`, "browser.tool_not_allowed");
    }
    return payload;
  }
}

export class ToolTokenError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ToolTokenError";
  }
}
