/**
 * Gateway process entrypoint — spawned detached by the native host
 * (§3.3.1). Signals are handled inside startGateway.
 */

import { startGateway } from "./main.js";

const gateway = await startGateway();

// keep the process alive; the IPC server + locks hold the event loop.
// Explicit exit only via signals handled in main.ts.
void gateway;
