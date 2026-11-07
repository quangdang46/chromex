#!/usr/bin/env node
import "./cli.js";
import { GatewayModeRelay } from "./gateway-mode.js";
import { NativeHostRelay } from "./relay.js";
import { normalizeNativeHostPath } from "./relay.js";

// gatewayMode flag (§11 dual-path): env CHROMEX_GATEWAY_MODE=1 or
// GATEWAY_DATA_DIR set → speak Envelope to the Gateway; otherwise the
// legacy bridge-spawn relay. Default OFF during migration.
const gatewayMode =
  process.env.CHROMEX_GATEWAY_MODE === "1" || process.env.CHROMEX_GATEWAY_MODE === "true";

if (gatewayMode) {
  const dataDir =
    normalizeNativeHostPath(process.env.CHROMEX_GATEWAY_HOME ?? "") ||
    `${process.env.HOME ?? process.env.USERPROFILE ?? ""}/.chromex/gateway`;
  void new GatewayModeRelay({ dataDir }).start(process.stdin).catch((err) => {
    console.error(`chromex-native-host[gateway]: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
} else {
  new NativeHostRelay().start();
}
