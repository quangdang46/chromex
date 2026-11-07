/**
 * Provider catalog cache — plan P1-04 / §8.4.
 *
 * - single-flight: concurrent fetchCatalog calls share one in-flight
 *   promise (one provider call regardless of waiter count)
 * - deadline 120s per fetch
 * - TTL 10 minutes
 * - invalidate() on config change
 * - NEVER creates a session for discovery — fetchCatalog only
 * - optional disk snapshots (<dataDir>/catalog/<provider>.json) so a
 *   gateway restart serves the last catalog instantly instead of
 *   refetching (chromex-w2h)
 */

import fs from "node:fs/promises";
import path from "node:path";

import type {
  AgentProvider,
  FetchCatalogOptions,
  ProviderCatalog,
  ProviderId,
} from "@codex-sidepanel/shared";

export const CATALOG_TTL_MS = 10 * 60 * 1000;
export const CATALOG_DEADLINE_MS = 120 * 1000;

export class CatalogFetchTimeoutError extends Error {
  constructor(providerId: ProviderId) {
    super(`catalog fetch for ${providerId} exceeded ${CATALOG_DEADLINE_MS}ms deadline`);
    this.name = "CatalogFetchTimeoutError";
  }
}

interface CacheEntry {
  catalog: ProviderCatalog;
  fetchedAt: number;
}

export interface CatalogSnapshot {
  catalog: ProviderCatalog;
  fetchedAt: number;
}

/**
 * Durable catalog snapshot backend. Implementations must be tolerant:
 * load() returns null on missing/corrupt/stale-shaped data, save()
 * failures must never break a fetch.
 */
export interface CatalogSnapshotStore {
  load(id: ProviderId): Promise<CatalogSnapshot | null>;
  save(id: ProviderId, snapshot: CatalogSnapshot): Promise<void>;
}

function snapshotFileName(id: ProviderId): string {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]/g, "_");
  return `${safe}.json`;
}

function isCatalogSnapshot(v: unknown): v is CatalogSnapshot {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.fetchedAt !== "number" || !Number.isFinite(s.fetchedAt)) return false;
  const catalog = s.catalog as Record<string, unknown> | undefined;
  return typeof catalog === "object" && catalog !== null && Array.isArray(catalog.models);
}

/**
 * JSON-file snapshot store: `<dir>/<provider>.json` written atomically
 * (tmp + rename, 0600). `dir` is expected to be `<dataDir>/catalog`.
 */
export class FileCatalogSnapshotStore implements CatalogSnapshotStore {
  constructor(private readonly dir: string) {}

  private fileFor(id: ProviderId): string {
    return path.join(this.dir, snapshotFileName(id));
  }

  async load(id: ProviderId): Promise<CatalogSnapshot | null> {
    try {
      const raw = JSON.parse(await fs.readFile(this.fileFor(id), "utf8")) as unknown;
      const snap = (raw as Record<string, unknown>)?.snapshot;
      return isCatalogSnapshot(snap) ? snap : null;
    } catch {
      return null;
    }
  }

  async save(id: ProviderId, snapshot: CatalogSnapshot): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true });
    const file = this.fileFor(id);
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify({ v: 1, snapshot }), { mode: 0o600 });
    await fs.rename(tmp, file);
  }
}

/**
 * Catalog snapshot dir for the gateway data dir. The production spawn
 * path (native-host → gateway bin) always sets CHROMEX_GATEWAY_HOME to
 * the resolved dataDir, so env resolution matches main.ts's
 * resolveDataDir for every real deployment. Returns undefined when the
 * env is absent (e.g. embedded/test gateways with an explicit dataDir)
 * — callers then pass an explicit catalogDir or leave persistence off.
 * TODO(chromex-w2h): once gateway/main.ts is editable, pass
 * `catalogDir: path.join(dataDir, "catalog")` to ProviderRegistry and
 * drop this env heuristic.
 */
export function resolveCatalogSnapshotDir(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const home = env.CHROMEX_GATEWAY_HOME;
  if (!home) return undefined;
  return path.join(path.resolve(home), "catalog");
}

export class CatalogCache {
  private entries = new Map<ProviderId, CacheEntry>();
  private inflight = new Map<ProviderId, Promise<ProviderCatalog>>();

  constructor(
    private readonly providers: () => Iterable<AgentProvider>,
    private readonly now: () => number = () => Date.now(),
    private readonly snapshots?: CatalogSnapshotStore,
  ) {}

  private provider(id: ProviderId): AgentProvider {
    for (const p of this.providers()) {
      if (p.id === id) return p;
    }
    throw new Error(`provider ${id} not registered`);
  }

  /** Fresh-enough cached catalog or null. */
  peek(id: ProviderId): ProviderCatalog | null {
    const e = this.entries.get(id);
    if (!e) return null;
    if (this.now() - e.fetchedAt > CATALOG_TTL_MS) return null;
    return e.catalog;
  }

  /**
   * Single-flight fetch. Concurrent callers get the SAME promise.
   * forceRefresh bypasses TTL but still single-flights.
   */
  fetch(id: ProviderId, opts: FetchCatalogOptions = {}): Promise<ProviderCatalog> {
    if (!opts.forceRefresh) {
      const cached = this.peek(id);
      if (cached) return Promise.resolve(cached);
    }
    const existing = this.inflight.get(id);
    if (existing) return existing;

    const promise = this.fetchAndStore(id, opts)
      .finally(() => {
        this.inflight.delete(id);
      });
    this.inflight.set(id, promise);
    return promise;
  }

  private async fetchAndStore(id: ProviderId, opts: FetchCatalogOptions): Promise<ProviderCatalog> {
    // Restart path: a fresh on-disk snapshot beats a provider refetch —
    // first model.list after a gateway restart stays fast.
    if (!opts.forceRefresh && this.snapshots) {
      const snap = await this.snapshots.load(id).catch(() => null);
      if (snap && this.now() - snap.fetchedAt <= CATALOG_TTL_MS) {
        this.entries.set(id, snap);
        return snap.catalog;
      }
    }
    const catalog = await this.doFetch(id, opts.signal);
    const entry: CacheEntry = { catalog, fetchedAt: this.now() };
    this.entries.set(id, entry);
    if (this.snapshots) {
      // Fire-and-forget: persistence must never fail or delay a fetch.
      void this.snapshots.save(id, entry).catch(() => undefined);
    }
    return catalog;
  }

  private async doFetch(id: ProviderId, signal?: AbortSignal): Promise<ProviderCatalog> {
    const provider = this.provider(id);
    // Hard deadline via Promise.race — a provider that ignores the abort
    // signal still cannot hold the cache hostage past 120s.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new CatalogFetchTimeoutError(id)), CATALOG_DEADLINE_MS);
    });
    const abortPromise = signal
      ? new Promise<never>((_, reject) => {
          if (signal.aborted) reject(signal.reason ?? new Error("aborted"));
          else signal.addEventListener("abort", () => reject(signal.reason ?? new Error("aborted")), { once: true });
        })
      : null;
    try {
      const fetchP = provider.fetchCatalog(signal ? { signal } : {});
      return await Promise.race(
        abortPromise ? [fetchP, deadline, abortPromise] : [fetchP, deadline],
      );
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Config change → drop cached catalogs (in-flight completes but isn't cached? keep simple: drop entries). */
  invalidate(id?: ProviderId): void {
    if (id) this.entries.delete(id);
    else this.entries.clear();
  }

  /** Test hook. */
  _inflightSize(): number {
    return this.inflight.size;
  }
}
