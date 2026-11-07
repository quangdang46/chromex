/**
 * Legacy bridge sidecar — plan §10/§11 dual-path (chromex-rzf).
 *
 * In gatewayMode the native host still owns the non-agent RPC domains
 * (image/voice/dictation/translation/diagnostics/runtime.config/
 * workspace.harness/local.file/account login+mcp reload/skills archive).
 * The extension sends them as legacy BridgeRequest JSON
 * ({id, method, params}) on the same NM port; GatewayModeRelay demuxes
 * by message shape and hands them here. This class owns a
 * lazily-spawned bridge child (bridge/dist/cli.js) speaking
 * line-delimited JSON — the same contract NativeHostRelay relays.
 *
 * Bridge stdout lines are forwarded to the extension VERBATIM as NM
 * messages: {id,result|error} responses (the extension's pending map
 * matches by id) and {event} notifications (voice/image job progress).
 * The sidecar never sees gateway traffic and the gateway never sees
 * sidecar traffic — one NM port, two logical channels.
 */

import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import readline from "node:readline";

import {
  MAX_NATIVE_MESSAGE_BYTES,
  encodeNativeMessage,
} from "./framing.js";
import { createBridgeProcessEnv, mergeShellProviderEnv } from "./environment.js";
import { resolveBridgeEntryPath } from "./relay.js";

export interface LegacySidecarOptions {
  /** parsed message → NM stdout (caller applies NM framing) */
  emit: (message: unknown) => void;
  /** bridge entry override (tests); default resolveBridgeEntryPath() */
  bridgeEntry?: string | null;
  log?: (msg: string) => void;
}

export class LegacyBridgeSidecar {
  #child: ChildProcessByStdio<Writable, Readable, null> | null = null;
  /** ids written to the bridge but not yet answered — failed loudly on
   *  child exit so extension requests reject instead of hanging. */
  #pending = new Set<string>();
  #shuttingDown = false;
  readonly #opts: LegacySidecarOptions;

  constructor(opts: LegacySidecarOptions) {
    this.#opts = opts;
  }

  /** Handle one demuxed legacy BridgeRequest ({id,method,params}). */
  handleRequest(raw: unknown): void {
    if (this.#shuttingDown) return;
    const id = (raw as { id?: unknown }).id;
    if (typeof id === "string") this.#pending.add(id);
    // spawn failures surface via the child's 'error'/'exit' events,
    // which reject every pending id — never throw here.
    const child = this.#ensureChild();
    try {
      child.stdin.write(`${JSON.stringify(raw)}\n`);
    } catch (error) {
      this.#opts.log?.(`sidecar stdin write failed: ${error instanceof Error ? error.message : String(error)}`);
      this.#teardownChild();
      this.#failPending("bridge sidecar stdin closed");
    }
  }

  #ensureChild(): ChildProcessByStdio<Writable, Readable, null> {
    if (this.#child && !this.#child.killed) return this.#child;
    const bridgeBaseEnv = mergeShellProviderEnv(process.env);
    const child = spawn(process.execPath, [this.#opts.bridgeEntry || resolveBridgeEntryPath()], {
      stdio: ["pipe", "pipe", "inherit"],
      env: createBridgeProcessEnv(bridgeBaseEnv),
    });
    this.#child = child;
    child.on("error", (error) => {
      this.#opts.log?.(`sidecar bridge spawn error: ${error.message}`);
      this.#teardownChild();
      if (!this.#shuttingDown) {
        this.#failPending(`bridge sidecar spawn failed: ${error.message}`);
      }
    });
    child.on("exit", (code) => {
      this.#opts.log?.(`sidecar bridge exited (code ${code ?? "?"})`);
      this.#teardownChild();
      if (!this.#shuttingDown) {
        this.#failPending(`bridge sidecar exited (code ${code ?? "?"})`);
      }
    });
    child.stdin.on("error", () => {
      // exit/error handlers above own teardown + pending rejection
    });

    const lineReader = readline.createInterface({ input: child.stdout });
    lineReader.on("line", (line) => {
      if (!line.trim()) return;
      if (line.length > MAX_NATIVE_MESSAGE_BYTES) {
        this.#opts.log?.(`dropping oversized sidecar line: ${line.length} bytes`);
        return;
      }
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        this.#opts.log?.("dropping unparseable sidecar line");
        return;
      }
      const id = (message as { id?: unknown }).id;
      if (typeof id === "string") this.#pending.delete(id);
      this.#emit(message);
    });
    return child;
  }

  #emit(message: unknown): void {
    try {
      // size-check before handing to the NM writer (encodeNativeMessage
      // throws past the 1 MiB Chrome limit)
      encodeNativeMessage(message);
      this.#opts.emit(message);
    } catch (error) {
      this.#opts.log?.(`dropping oversized/invalid sidecar message: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  #failPending(reason: string): void {
    for (const id of this.#pending) {
      this.#emit({ id, error: { message: reason } });
    }
    this.#pending.clear();
  }

  #teardownChild(): void {
    const child = this.#child;
    this.#child = null;
    child?.kill();
    child?.stdin.destroy();
    child?.stdout.destroy();
  }

  shutdown(): void {
    this.#shuttingDown = true;
    this.#teardownChild();
  }
}
