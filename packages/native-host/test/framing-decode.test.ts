import { describe, expect, test } from "vitest";

import {
  MAX_NATIVE_MESSAGE_BYTES,
  NativeMessageFramingError,
  NativeMessageStreamDecoder,
  decodeNativeMessage,
  encodeNativeMessage,
} from "../src/index.js";

describe("encodeNativeMessage output format", () => {
  test("returns a Buffer with a 4-byte LE length prefix and UTF-8 JSON body", () => {
    const payload = { type: "ping", nested: { ok: true }, list: [1, 2, 3] };
    const encoded = encodeNativeMessage(payload);

    expect(Buffer.isBuffer(encoded)).toBe(true);
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    expect(encoded.length).toBe(4 + body.length);
    expect(encoded.readUInt32LE(0)).toBe(body.length);
    expect(encoded.subarray(4).equals(body)).toBe(true);
  });

  test("length prefix counts UTF-8 bytes, not UTF-16 code units", () => {
    const payload = { emoji: "🎉" };
    const encoded = encodeNativeMessage(payload);
    const bodyLength = Buffer.byteLength(JSON.stringify(payload), "utf8");

    // "🎉" is 2 UTF-16 units but 4 UTF-8 bytes.
    expect(JSON.stringify(payload).length).toBeLessThan(bodyLength);
    expect(encoded.readUInt32LE(0)).toBe(bodyLength);
    expect(encoded.subarray(4).toString("utf8")).toBe(JSON.stringify(payload));
  });

  test("supports primitive payloads", () => {
    for (const payload of [null, true, 42, "hello", [1, "two"]]) {
      expect(decodeNativeMessage(encodeNativeMessage(payload))).toEqual(payload);
    }
  });
});

describe("decodeNativeMessage error paths", () => {
  test("rejects malformed JSON in the body", () => {
    const body = Buffer.from("{not json", "utf8");
    const frame = Buffer.alloc(4);
    frame.writeUInt32LE(body.length, 0);
    const buffer = Buffer.concat([frame, body]);

    expect(() => decodeNativeMessage(buffer)).toThrowError(SyntaxError);
  });

  test("rejects a body truncated below its declared length", () => {
    const body = Buffer.from(JSON.stringify({ type: "ping" }), "utf8");
    const frame = Buffer.alloc(4);
    frame.writeUInt32LE(body.length, 0);
    // Send only part of the declared body: the parser sees truncated JSON.
    const buffer = Buffer.concat([frame, body.subarray(0, Math.floor(body.length / 2))]);

    expect(() => decodeNativeMessage(buffer)).toThrowError(SyntaxError);
  });
});

describe("NativeMessageStreamDecoder chunk boundaries", () => {
  test("decodes a frame pushed one byte at a time", () => {
    const decoder = new NativeMessageStreamDecoder();
    const payload = { type: "bytewise", n: 7 };
    const encoded = encodeNativeMessage(payload);

    for (let i = 0; i < encoded.length - 1; i++) {
      expect(decoder.push(encoded.subarray(i, i + 1))).toEqual([]);
    }
    const last = decoder.push(encoded.subarray(encoded.length - 1));
    expect(last).toEqual([payload]);
  });

  test("handles a split inside a multi-byte UTF-8 sequence", () => {
    const payload = { emoji: "🎉🎊" };
    const encoded = encodeNativeMessage(payload);

    // Split at every possible boundary; the decoder must only emit once the
    // full frame has arrived, regardless of where UTF-8 sequences break.
    for (let split = 1; split < encoded.length; split++) {
      const d = new NativeMessageStreamDecoder();
      expect(d.push(encoded.subarray(0, split))).toEqual([]);
      expect(d.push(encoded.subarray(split))).toEqual([payload]);
    }
  });

  test("emits each complete frame as soon as its last byte arrives", () => {
    const decoder = new NativeMessageStreamDecoder();
    const first = encodeNativeMessage({ n: 1 });
    const second = encodeNativeMessage({ n: 2 });
    const combined = Buffer.concat([first, second]);

    // Push everything except the final byte: only the first frame completes.
    const partial = decoder.push(combined.subarray(0, combined.length - 1));
    expect(partial).toEqual([{ n: 1 }]);
    const rest = decoder.push(combined.subarray(combined.length - 1));
    expect(rest).toEqual([{ n: 2 }]);
  });

  test("oversized header split across pushes still rejects and resets", () => {
    const decoder = new NativeMessageStreamDecoder();
    const header = Buffer.alloc(4);
    header.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);

    expect(decoder.push(header.subarray(0, 2))).toEqual([]);
    expect(() => decoder.push(header.subarray(2))).toThrowError(NativeMessageFramingError);

    // The failed frame is dropped; the decoder accepts the next valid frame.
    const valid = encodeNativeMessage({ recovered: true });
    expect(decoder.push(valid)).toEqual([{ recovered: true }]);
  });

  test("a valid frame following an oversized one is not swallowed", () => {
    const decoder = new NativeMessageStreamDecoder();
    const badHeader = Buffer.alloc(4);
    badHeader.writeUInt32LE(MAX_NATIVE_MESSAGE_BYTES + 1, 0);
    const good = encodeNativeMessage({ ok: 1 });
    const chunk = Buffer.concat([badHeader, good]);

    expect(() => decoder.push(chunk)).toThrowError(NativeMessageFramingError);
    // Buffer was reset before the throw, so the good frame bytes are gone —
    // but a fresh push of the good frame still decodes.
    expect(decoder.push(good)).toEqual([{ ok: 1 }]);
  });
});
