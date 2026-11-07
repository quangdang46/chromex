/**
 * Chrome Native Messaging hard limit: a single message may not exceed 1 MiB.
 * Frames beyond this are rejected before buffering so a malformed or hostile
 * peer cannot grow memory without bound.
 */
export const MAX_NATIVE_MESSAGE_BYTES = 1024 * 1024;

export class NativeMessageFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NativeMessageFramingError";
  }
}

export function encodeNativeMessage(payload: unknown): Buffer {
  const json = JSON.stringify(payload);
  const body = Buffer.from(json, "utf8");
  if (body.length > MAX_NATIVE_MESSAGE_BYTES) {
    throw new NativeMessageFramingError(
      `native message too large: ${body.length} bytes exceeds ${MAX_NATIVE_MESSAGE_BYTES}`,
    );
  }
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  return Buffer.concat([header, body]);
}

export function decodeNativeMessage(buffer: Buffer): unknown {
  const bodyLength = buffer.readUInt32LE(0);
  if (bodyLength > MAX_NATIVE_MESSAGE_BYTES) {
    throw new NativeMessageFramingError(
      `native message too large: declared ${bodyLength} bytes exceeds ${MAX_NATIVE_MESSAGE_BYTES}`,
    );
  }
  const body = buffer.subarray(4, 4 + bodyLength).toString("utf8");
  return JSON.parse(body);
}

export class NativeMessageStreamDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk: Buffer): unknown[] {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages: unknown[] = [];

    while (this.#buffer.length >= 4) {
      const bodyLength = this.#buffer.readUInt32LE(0);
      if (bodyLength > MAX_NATIVE_MESSAGE_BYTES) {
        // Reject on the header alone: waiting for the declared body would let
        // a peer stream an unbounded frame into memory.
        this.#buffer = Buffer.alloc(0);
        throw new NativeMessageFramingError(
          `native message too large: declared ${bodyLength} bytes exceeds ${MAX_NATIVE_MESSAGE_BYTES}`,
        );
      }
      const totalLength = 4 + bodyLength;
      if (this.#buffer.length < totalLength) {
        break;
      }

      messages.push(decodeNativeMessage(this.#buffer.subarray(0, totalLength)));
      this.#buffer = this.#buffer.subarray(totalLength);
    }

    return messages;
  }
}
