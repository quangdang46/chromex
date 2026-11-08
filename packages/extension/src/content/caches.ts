/**
 * chromexCacheOp — fixed-shape Cache Storage (Cache API) helper run in the
 * page MAIN world via chrome.scripting. The agent supplies cache names,
 * URLs and put-specs — never code.
 *
 * Actions: listCaches | listKeys | match | put | delete | clear.
 * Read ops never create caches. Response bodies are byte-capped.
 */
export function chromexCacheOp(
  action: string,
  cacheName: string,
  url: string | undefined,
  putSpec: {
    status?: number;
    headers?: Record<string, string>;
    bodyBase64?: string;
    bodyText?: string;
  } | undefined,
  ignoreSearch: boolean,
  limit: number,
): Promise<Record<string, unknown>> {
  const BODY_BYTE_CAP = 128 * 1024;
  const b64encode = (buf: ArrayBuffer): string => {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + 0x8000)) as number[]);
    }
    return btoa(s);
  };
  const reqInfo = (u: string): Request => new Request(u);
  return (async () => {
    try {
      if (action === "listCaches") {
        const names = await caches.keys();
        return { ok: true, result: { caches: names } };
      }
      // Read/delete ops must not create a missing cache — caches.open()
      // would. Check existence before opening.
      const noCreate = action === "listKeys" || action === "match" || action === "delete";
      const existed = noCreate ? await caches.has(cacheName) : true;
      if (!existed) {
        return {
          ok: true,
          result:
            action === "match"
              ? { cache: cacheName, url, found: false, exists: false }
              : action === "delete"
                ? { cache: cacheName, url, deleted: false, exists: false }
                : { cache: cacheName, entries: [], count: 0, truncated: false, exists: false },
        };
      }
      const cache = await caches.open(cacheName);
      try {
        if (action === "listKeys") {
          const keys = await cache.keys();
          const entries = keys.slice(0, limit).map((r) => ({
            url: r.url,
            method: r.method,
          }));
          return {
            ok: true,
            result: {
              cache: cacheName,
              entries,
              count: entries.length,
              truncated: keys.length > limit,
            },
          };
        }
        if (action === "match") {
          if (!url) return { ok: false, error: "match requires url" };
          let res: Response | undefined;
          if (ignoreSearch) {
            const target = new URL(url);
            const keys = await cache.keys();
            const hit = keys.find((r) => {
              const k = new URL(r.url);
              return k.origin === target.origin && k.pathname === target.pathname;
            });
            res = hit ? await cache.match(hit) : undefined;
          } else {
            res = await cache.match(reqInfo(url));
          }
          if (!res) return { ok: true, result: { cache: cacheName, url, found: false } };
          const buf = await res.arrayBuffer();
          const truncated = buf.byteLength > BODY_BYTE_CAP;
          const slice = truncated ? buf.slice(0, BODY_BYTE_CAP) : buf;
          const headers: Record<string, string> = {};
          res.headers.forEach((v, k) => {
            headers[k] = v;
          });
          return {
            ok: true,
            result: {
              cache: cacheName,
              url,
              found: true,
              status: res.status,
              statusText: res.statusText,
              headers,
              bodyBase64: b64encode(slice),
              bodyBytes: buf.byteLength,
              truncated,
            },
          };
        }
        if (action === "put") {
          if (!url) return { ok: false, error: "put requires url" };
          let bytes: Uint8Array;
          if (putSpec?.bodyBase64) {
            const bin = atob(putSpec.bodyBase64);
            bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
          } else if (putSpec?.bodyText !== undefined) {
            bytes = new TextEncoder().encode(putSpec.bodyText);
          } else {
            bytes = new Uint8Array(0);
          }
          const status = typeof putSpec?.status === "number" ? putSpec.status : 200;
          const res = new Response(bytes.buffer as ArrayBuffer, {
            status,
            headers: putSpec?.headers ?? { "content-type": "application/octet-stream" },
          });
          await cache.put(reqInfo(url), res);
          return { ok: true, result: { cache: cacheName, url, put: true, status } };
        }
        if (action === "delete") {
          if (!url) return { ok: false, error: "delete requires url" };
          const removed = await cache.delete(reqInfo(url));
          return { ok: true, result: { cache: cacheName, url, deleted: removed } };
        }
        if (action === "clear") {
          const removed = await caches.delete(cacheName);
          return { ok: true, result: { cache: cacheName, cleared: removed } };
        }
        return { ok: false, error: `unknown action: ${action}` };
      } finally {
        // Cache objects have no close(); nothing to release.
      }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  })();
}
