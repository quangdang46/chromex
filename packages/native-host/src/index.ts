export { createBridgeProcessEnv, mergeShellProviderEnv } from "./environment.js";
export {
  MAX_NATIVE_MESSAGE_BYTES,
  NativeMessageFramingError,
  NativeMessageStreamDecoder,
  decodeNativeMessage,
  encodeNativeMessage,
} from "./framing.js";
export { NativeHostRelay, normalizeNativeHostPath } from "./relay.js";
export {
  GatewayClientError,
  GatewayConnection,
  ensureGateway,
  endpointPidAlive,
  readGatewayEndpoint,
  readGatewayToken,
} from "./gateway-client.js";
export type { EnsureGatewayOptions, GatewayConnectOptions, GatewayEndpointFile } from "./gateway-client.js";
