import { describe, expect, test } from "vitest";

import {
  MAX_NATIVE_MESSAGE_BYTES,
  NativeMessageFramingError,
  NativeMessageStreamDecoder,
  decodeNativeMessage,
  encodeNativeMessage,
} from "../src/index.js";

describe("native messaging framing", () => {
  test("encodes a message with a 32-bit little-endian length prefix", () => {
    const payload = { hello: "world" };
    const encoded = encodeNativeMessage(payload);

    expect(encoded.readUInt32LE(0)).toBe(Buffer.byteLength(JSON.stringify(payload)));
    expect(encoded.subarray(4).toString("utf8")).toBe(JSON.stringify(payload));
  });

  test("decodes a framed message back into an object", () => {
    const payload = { type: "ping", count: 1 };
    const encoded = encodeNativeMessage(payload);

    expect(decodeNativeMessage(encoded)).toEqual(payload);
  });
});

describe("native messaging framing limits", () => {
  test("encodeNativeMessage rejects a body larger than the Chrome limit", () => {
    const payload = { blob: "x".repeat(MAX_NATIVE_MESSAGE_BYTES) };

    expect(() => encodeNativeMessage(payload)).toThrowError(NativeMessageFramingError);
  });

  test("encodeNativeMessage accepts a body at the limit", () => {
    // JSON adds quotes/braces, so size the string to land exactly on the cap.
    const overhead = Buffer.byteLength(JSON.stringify({ blob: "" }));
    const payload = { blob: "x".repeat(MAX_NATIVE_MESSAGE_BYTES - overhead) };

    const encoded = encodeNativeMessage(payload);
    expect(encoded.readUInt32LE(0)).toBe(MAX_NATIVE_MESSAGE_BYTES);
  });

  test("decodeNativeMessage rejects a declared length above the limit", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);

    expect(() => decodeNativeMessage(header)).toThrowError(NativeMessageFramingError);
  });

  test("stream decoder rejects an oversized frame on the header alone", () => {
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
    const decoder = new NativeMessageStreamDecoder();

    // No body bytes are sent: the decoder must fail on the header, not buffer
    // while waiting for the declared length.
    expect(() => decoder.push(header)).toThrowError(NativeMessageFramingError);
  });

  test("stream decoder still accepts a valid frame after the limit check", () => {
    const decoder = new NativeMessageStreamDecoder();
    const encoded = encodeNativeMessage({ type: "ping" });

    const messages = decoder.push(encoded);
    expect(messages).toEqual([{ type: "ping" }]);
  });

  test("stream decoder handles a frame split across chunks", () => {
    const decoder = new NativeMessageStreamDecoder();
    const encoded = encodeNativeMessage({ type: "pong", n: 42 });
    const mid = Math.floor(encoded.length / 2);

    expect(decoder.push(encoded.subarray(0, mid))).toEqual([]);
    expect(decoder.push(encoded.subarray(mid))).toEqual([{ type: "pong", n: 42 }]);
  });

  test("stream decoder handles multiple frames in one chunk", () => {
    const decoder = new NativeMessageStreamDecoder();
    const first = encodeNativeMessage({ type: "a" });
    const second = encodeNativeMessage({ type: "b" });

    expect(decoder.push(Buffer.concat([first, second]))).toEqual([{ type: "a" }, { type: "b" }]);
  });
});
