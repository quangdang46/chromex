/**
 * Provider catalog cache — plan P1-04 / §8.4.
 *
 * - single-flight: concurrent fetchCatalog calls share one in-flight
 *   promise (one provider call regardless of waiter count)
 * - deadline 120s per fetch
 * - TTL 10 minutes
 * - invalidate() on config change
 * - NEVER creates a session for discovery — fetchCatalog only
 */

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

export class CatalogCache {
  private entries = new Map<ProviderId, CacheEntry>();
  private inflight = new Map<ProviderId, Promise<ProviderCatalog>>();

  constructor(
    private readonly providers: () => Iterable<AgentProvider>,
    private readonly now: () => number = () => Date.now(),
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

    const promise = this.doFetch(id, opts.signal)
      .then((catalog) => {
        this.entries.set(id, { catalog, fetchedAt: this.now() });
        return catalog;
      })
      .finally(() => {
        this.inflight.delete(id);
      });
    this.inflight.set(id, promise);
    return promise;
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
