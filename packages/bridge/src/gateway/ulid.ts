/**
 * ULID (Crockford base32, 48-bit ms timestamp + 80-bit random).
 * Used for fencing tokens — monotonic-ish, sortable, no deps.
 */

const ENCODING = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(now: number, len: number): string {
  let out = "";
  for (let i = len - 1; i >= 0; i -= 1) {
    const mod = now % 32;
    out = ENCODING[mod] + out;
    now = (now - mod) / 32;
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i += 1) {
    out += ENCODING[bytes[i]! % 32];
  }
  return out;
}

export function ulid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}
