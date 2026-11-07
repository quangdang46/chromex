/**
 * Durable event payload bound — enforces MAX_EVENT_PAYLOAD_BYTES (§4.1)
 * at the appendTaskEvent boundary so mappers/emitters that copy raw
 * provider input/output can never write an unbounded payload into the
 * event log (S8: oversized evidence must degrade, not corrupt).
 *
 * Strategy: measure the serialized event; when over budget, truncate
 * over-long strings with a marker and re-measure, halving the per-string
 * cap until the payload fits. Truncation is honest — the marker stays in
 * the persisted text — and cheaper than artifact spill at this layer
 * (artifact minting belongs to the emitter that knows the kind).
 */

import { MAX_EVENT_PAYLOAD_BYTES } from "@codex-sidepanel/shared";

const TRUNCATED_MARKER = "…[truncated]";
/** recursion guard — event payloads are shallow; deeper means hostile */
const MAX_DEPTH = 12;

function byteLen(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

function truncateStrings(value: unknown, maxChars: number, depth = 0): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === "string") {
    return value.length > maxChars
      ? `${value.slice(0, Math.max(0, maxChars - TRUNCATED_MARKER.length))}${TRUNCATED_MARKER}`
      : value;
  }
  if (Array.isArray(value)) {
    return value.map((v) => truncateStrings(v, maxChars, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = truncateStrings(v, maxChars, depth + 1);
    }
    return out;
  }
  return value;
}

/**
 * Return an event whose JSON serialization fits MAX_EVENT_PAYLOAD_BYTES.
 * Returns the input untouched when it already fits (the common case —
 * no clone cost on the hot path).
 */
export function boundTaskEventPayload<E>(event: E): E {
  let json: string;
  try {
    json = JSON.stringify(event);
  } catch {
    return event; // unserializable payloads fail later at INSERT anyway
  }
  if (byteLen(json) <= MAX_EVENT_PAYLOAD_BYTES) return event;

  // halve the per-string cap until the whole event fits
  let cap = 16 * 1024;
  for (let i = 0; i < 8; i += 1) {
    const bounded = truncateStrings(event, cap) as E;
    try {
      if (byteLen(JSON.stringify(bounded)) <= MAX_EVENT_PAYLOAD_BYTES) return bounded;
    } catch {
      return bounded;
    }
    cap = Math.max(256, Math.floor(cap / 2));
  }
  // last resort: 256-char strings — a flat event object cannot exceed
  // the cap unless it carries hundreds of fields, which no event does.
  return truncateStrings(event, 256) as E;
}

/**
 * Bound a single event field (tool input/output, diff text) to
 * `maxChars` of JSON — emitters use this for a tighter per-field budget
 * than the whole-event MAX_EVENT_PAYLOAD_BYTES cap.
 */
export function boundJsonPreview(value: unknown, maxChars: number): unknown {
  if (value === undefined) return undefined;
  let s: string;
  try {
    s = JSON.stringify(value) ?? String(value);
  } catch {
    s = String(value);
  }
  if (s.length <= maxChars) return value;
  return {
    truncated: true,
    bytes: s.length,
    preview: `${s.slice(0, Math.max(0, maxChars - TRUNCATED_MARKER.length))}${TRUNCATED_MARKER}`,
  };
}
