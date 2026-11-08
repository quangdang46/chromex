/**
 * content/storage.ts — fixed-shape Web Storage access for
 * `browser.page.localStorage` / sessionStorage.
 *
 * Same delivery path as chromexEvaluate: chrome.scripting serializes
 * this function into the page MAIN world, so it must stay
 * SELF-CONTAINED (no module-scope references). The agent supplies
 * keys/values through args — never code — which is why this tool can
 * be more granularly risk-classified than page.evaluate.
 */

export interface ChromexStorageResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

export function chromexStorageOp(
  area: string,
  action: string,
  key: string,
  value: string,
  includeValues: boolean,
): ChromexStorageResult {
  // caps inlined — chrome.scripting serializes only this function body
  const VALUE_CHAR_CAP = 32 * 1024;
  const RESULT_CHAR_CAP = 200 * 1024;
  try {
    const s =
      area === "session"
        ? (window as unknown as { sessionStorage: Storage }).sessionStorage
        : (window as unknown as { localStorage: Storage }).localStorage;
    if (action === "set") {
      s.setItem(key, value);
      return { ok: true, result: { area, set: true, key } };
    }
    if (action === "remove") {
      s.removeItem(key);
      return { ok: true, result: { area, removed: key } };
    }
    if (action === "clear") {
      s.clear();
      return { ok: true, result: { area, cleared: true } };
    }
    if (action === "get") {
      const v = s.getItem(key);
      return {
        ok: true,
        result: {
          area,
          key,
          found: v !== null,
          value: v === null ? null : v.slice(0, VALUE_CHAR_CAP),
          ...(v !== null && v.length > VALUE_CHAR_CAP ? { truncated: true } : {}),
        },
      };
    }
    // list — keys only unless includeValues
    const keys: string[] = [];
    const entries: Record<string, string> = {};
    for (let i = 0; i < s.length; i += 1) {
      const k = s.key(i);
      if (k === null) continue;
      keys.push(k);
      if (includeValues) {
        const v = s.getItem(k);
        if (v !== null) entries[k] = v.slice(0, VALUE_CHAR_CAP);
      }
    }
    const result: Record<string, unknown> = includeValues
      ? { area, entries, truncatedValues: Object.values(entries).some((v) => v.length >= VALUE_CHAR_CAP) }
      : { area, keys };
    if (JSON.stringify(result).length > RESULT_CHAR_CAP) {
      return { ok: true, result: { area, keys, truncated: true } };
    }
    return { ok: true, result };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
