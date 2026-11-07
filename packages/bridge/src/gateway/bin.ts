/**
 * Gateway process entrypoint — spawned detached by the native host
 * (§3.3.1). Signals are handled inside startGateway; this wrapper
 * guarantees the process actually exits afterwards.
 *
 * shutdown() closes IPC/locks/db but provider child processes and
 * pending timers can keep the event loop alive, so once the lifetime
 * lock is released (tail of shutdown) we exit explicitly — with a hard
 * deadline so a wedged shutdown can never ignore SIGTERM again
 * (chromex-f5ad). In-flight turns are left for §5.6 recovery
 * (turn→unknown on next boot), same as kill -9.
 */

import { startGateway } from "./main.js";

const gateway = await startGateway();

const SHUTDOWN_DEADLINE_MS = 5_000;

let exiting = false;
const forceExit = (code: number): void => {
  if (exiting) return;
  exiting = true;
  process.exit(code);
};

const onSignal = (signal: NodeJS.Signals): void => {
  // main.ts registered its own SIGTERM/SIGINT listeners during
  // startGateway, so its shutdown() is already in flight; our call
  // returns early on the shuttingDown guard. Wait for the lifetime
  // lock — released at the tail of shutdown — then exit.
  const deadline = Date.now() + SHUTDOWN_DEADLINE_MS;
  const force = setTimeout(() => forceExit(0), SHUTDOWN_DEADLINE_MS);
  force.unref?.();
  void (async () => {
    try {
      await gateway.shutdown(`signal:${signal}`);
    } catch {
      /* shutdown errors must not block exit */
    }
    while (gateway.lifetimeLock.isHeld() && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    clearTimeout(force);
    forceExit(0);
  })();
};

process.on("SIGTERM", onSignal);
process.on("SIGINT", onSignal);

// keep the process alive; the IPC server + locks hold the event loop.
void gateway;
