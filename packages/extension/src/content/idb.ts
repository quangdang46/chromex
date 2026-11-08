/**
 * content/idb.ts — fixed-shape IndexedDB access for
 * `browser.page.indexedDB`.
 *
 * Same delivery path as chromexStorageOp: chrome.scripting serializes
 * this function into the page MAIN world — SELF-CONTAINED only, caps
 * inlined. The agent supplies database/store/key/value through args,
 * never code.
 *
 * Read ops (listDbs/listStores/keys/get) verify the database exists via
 * indexedDB.databases() first so they NEVER create a missing DB as a
 * side effect. Mutations (put/delete/clear/createStore) are
 * approval-gated by the risk classifier before reaching here.
 */

export interface ChromexIdbResult {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}

export async function chromexIdbOp(
  dbName: string,
  storeName: string,
  action: string,
  key: unknown,
  value: unknown,
  keyPath: string,
  limit: number,
): Promise<ChromexIdbResult> {
  const VALUE_CHAR_CAP = 32 * 1024;
  const RESULT_CHAR_CAP = 200 * 1024;
  const bounded = (v: unknown): unknown => {
    if (v === undefined) return { __missing: true };
    try {
      const s = JSON.stringify(v);
      if (s === undefined) return null;
      if (s.length > RESULT_CHAR_CAP) {
        return { __truncated: true, preview: s.slice(0, VALUE_CHAR_CAP) };
      }
      return JSON.parse(s) as unknown;
    } catch {
      return { __unserializable: true };
    }
  };
  const reqP = <T>(req: IDBRequest<T>): Promise<T> =>
    new Promise<T>((res, rej) => {
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error ?? new Error("indexedDB request failed"));
    });
  try {
    if (action === "listDbs") {
      const dbs = await indexedDB.databases();
      return {
        ok: true,
        result: {
          databases: dbs.map((d) => ({ name: d.name ?? null, version: d.version })),
        },
      };
    }

    const dbExists = async () =>
      (await indexedDB.databases()).some((d) => d.name === dbName);
    const openDb = () =>
      new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open(dbName);
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error ?? new Error("indexedDB.open failed"));
        req.onblocked = () => rej(new Error("indexedDB.open blocked by another connection"));
      });

    if (action === "listStores") {
      if (!(await dbExists())) {
        return { ok: true, result: { database: dbName, exists: false, stores: [] } };
      }
      const idb = await openDb();
      try {
        return {
          ok: true,
          result: {
            database: dbName,
            version: idb.version,
            stores: Array.from(idb.objectStoreNames),
          },
        };
      } finally {
        idb.close();
      }
    }

    if (action === "createStore") {
      if (!storeName) return { ok: false, error: "createStore requires a store name" };
      const cur = (await indexedDB.databases()).find((d) => d.name === dbName);
      const idb = await new Promise<IDBDatabase>((res, rej) => {
        const req = indexedDB.open(dbName, (cur?.version ?? 0) + 1);
        req.onupgradeneeded = () => {
          const d = req.result;
          if (!d.objectStoreNames.contains(storeName)) {
            d.createObjectStore(storeName, keyPath ? { keyPath } : undefined);
          }
        };
        req.onsuccess = () => res(req.result);
        req.onerror = () => rej(req.error ?? new Error("indexedDB.open failed"));
        req.onblocked = () => rej(new Error("indexedDB.open blocked by another connection"));
      });
      idb.close();
      return { ok: true, result: { database: dbName, store: storeName, created: true } };
    }

    if (!storeName) return { ok: false, error: `${action} requires a store name` };
    if (!(await dbExists())) {
      return { ok: true, result: { database: dbName, store: storeName, exists: false } };
    }
    const idb = await openDb();
    try {
      if (!Array.from(idb.objectStoreNames).includes(storeName)) {
        return { ok: true, result: { database: dbName, store: storeName, exists: false } };
      }
      const readOnly = action === "get" || action === "keys";
      const tx = idb.transaction(storeName, readOnly ? "readonly" : "readwrite");
      const os = tx.objectStore(storeName);
      const txDone = () =>
        new Promise<void>((res, rej) => {
          tx.oncomplete = () => res();
          tx.onerror = () => rej(tx.error ?? new Error("transaction failed"));
          tx.onabort = () => rej(tx.error ?? new Error("transaction aborted"));
        });

      if (action === "keys") {
        const keys = (await reqP(os.getAllKeys())) as IDBValidKey[];
        return {
          ok: true,
          result: {
            database: dbName,
            store: storeName,
            keys: keys.slice(0, limit).map((k) =>
              typeof k === "object" ? JSON.stringify(k) : (k as string | number),
            ),
            truncated: keys.length > limit,
          },
        };
      }
      if (action === "get") {
        const v = await reqP(os.get(key as IDBValidKey));
        return {
          ok: true,
          result: {
            database: dbName,
            store: storeName,
            key,
            found: v !== undefined,
            value: bounded(v),
          },
        };
      }
      if (action === "put") {
        // null/undefined key → in-line keyPath store form os.put(value)
        if (key === undefined || key === null) await reqP(os.put(value));
        else await reqP(os.put(value, key as IDBValidKey));
        await txDone();
        return { ok: true, result: { database: dbName, store: storeName, put: true, key } };
      }
      if (action === "delete") {
        await reqP(os.delete(key as IDBValidKey));
        await txDone();
        return { ok: true, result: { database: dbName, store: storeName, deleted: key } };
      }
      if (action === "clear") {
        await reqP(os.clear());
        await txDone();
        return { ok: true, result: { database: dbName, store: storeName, cleared: true } };
      }
      return { ok: false, error: `unknown action: ${action}` };
    } finally {
      idb.close();
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
