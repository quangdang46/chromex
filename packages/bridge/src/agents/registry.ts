/**
 * Provider registry — plan P1-04 / §8.4.
 *
 * Factories + profile overrides + derived profiles. Persistence always
 * keeps the ORIGINAL provider id + `metadata.profileOf` so a derived
 * profile never masquerades as a different provider.
 *
 * Contract-level implementation modeled on Paseo provider-registry
 * semantics (registry/snapshot separation, capability intersection) —
 * no code copied.
 */

import type {
  AgentCapabilityFlags,
  AgentProvider,
  AgentSessionConfig,
  FetchCatalogOptions,
  ProviderCatalog,
  ProviderId,
} from "@codex-sidepanel/shared";

import type { GatewayProviderConfig } from "../gateway/config.js";
import { CatalogCache } from "./catalog-cache.js";

export type ProviderFactory = () => AgentProvider | Promise<AgentProvider>;

/** A derived profile: same provider, narrowed config (model/mode/…). */
export interface DerivedProfile {
  /** stable profile id, e.g. "codex:fast" */
  profileId: string;
  providerId: ProviderId;
  /** original provider — persistence records THIS, never the profile id */
  overrides: {
    model?: string | null;
    modeId?: string | null;
    thinkingOptionId?: string | null;
    defaultModel?: string | null;
  };
}

export interface RegistryProviderEntry {
  provider: AgentProvider;
  config: GatewayProviderConfig;
  /** profileId → derived profile resolved against this provider */
  profiles: Map<string, DerivedProfile>;
}

export interface ResolvedSessionTarget {
  provider: AgentProvider;
  providerId: ProviderId;
  /** persistence.provider — always the ORIGINAL provider id */
  persistenceProviderId: ProviderId;
  config: AgentSessionConfig;
  profileOf?: string;
}

export class ProviderRegistry {
  private entries = new Map<ProviderId, RegistryProviderEntry>();
  private profileIndex = new Map<string, { providerId: ProviderId; profile: DerivedProfile }>();
  private readonly catalogCache = new CatalogCache(() => this.providerValues());

  constructor(private readonly providerConfigs: Record<string, GatewayProviderConfig>) {}

  private *providerValues(): Iterable<AgentProvider> {
    for (const e of this.entries.values()) yield e.provider;
  }

  /** provider.catalog — single-flight + TTL cached provider catalog (§8.4). */
  async catalog(id: ProviderId, opts: FetchCatalogOptions = {}): Promise<ProviderCatalog> {
    const catalog = await this.catalogCache.fetch(id, opts);
    return this.applyProviderConfig(id, catalog);
  }

  /**
   * §5.8 provider config → catalog: `models` acts as an allowlist over the
   * provider-fetched list, `additionalModels` always appends, and any
   * configured id missing from the fetched list is added verbatim (routers
   * and custom providers serve ids the agent CLI never reports).
   */
  private applyProviderConfig(id: ProviderId, catalog: ProviderCatalog): ProviderCatalog {
    const cfg = this.entries.get(id)?.config;
    if (!cfg) return catalog;
    let models = catalog.models;
    if (cfg.models) {
      const allow = new Set(cfg.models);
      models = models.filter((m) => allow.has(m.id));
    }
    const seen = new Set(models.map((m) => m.id));
    const additions = [...(cfg.models ?? []), ...(cfg.additionalModels ?? [])]
      .filter((mid): mid is string => typeof mid === "string" && mid.length > 0 && !seen.has(mid))
      .map((mid) => ({ id: mid, label: mid }));
    const defaultModel = cfg.defaultModel ?? catalog.defaultModel ?? null;
    if (!additions.length && models === catalog.models && defaultModel === (catalog.defaultModel ?? null)) {
      return catalog;
    }
    return { ...catalog, models: [...models, ...additions], defaultModel };
  }

  /** Config/profile change → drop cached catalogs. */
  invalidateCatalog(id?: ProviderId): void {
    this.catalogCache.invalidate(id);
  }

  /** Register a provider implementation + its §5.8 config block. */
  async register(id: ProviderId, factory: ProviderFactory): Promise<void> {
    const provider = await factory();
    const config = this.providerConfigs[id] ?? {
      enabled: true,
      command: null,
      env: {},
      models: null,
      additionalModels: null,
      defaultModel: null,
    };
    const entry: RegistryProviderEntry = {
      provider,
      config,
      profiles: new Map(),
    };
    this.entries.set(id, entry);
    this.rebuildProfileIndex();
  }

  unregister(id: ProviderId): void {
    this.entries.delete(id);
    this.rebuildProfileIndex();
  }

  has(id: ProviderId): boolean {
    return this.entries.has(id);
  }

  get(id: ProviderId): RegistryProviderEntry | undefined {
    return this.entries.get(id);
  }

  list(): ProviderId[] {
    return [...this.entries.keys()];
  }

  /**
   * Register a derived profile for a provider. `profileId` must be unique
   * across the registry; overrides are validated against catalog models
   * lazily (unknown model ids are kept — catalog may not be fetched yet).
   */
  addProfile(profile: DerivedProfile): void {
    const entry = this.entries.get(profile.providerId);
    if (!entry) throw new Error(`provider ${profile.providerId} not registered`);
    entry.profiles.set(profile.profileId, profile);
    this.profileIndex.set(profile.profileId, { providerId: profile.providerId, profile });
  }

  /**
   * Resolve a session target from a profileId or bare providerId.
   * - bare providerId → provider defaults (config.defaultModel etc.)
   * - "provider:slug" profileId → derived profile overrides on top
   * Returns null when provider unknown or disabled.
   */
  resolve(
    profileOrProviderId: string,
    base: Partial<AgentSessionConfig> = {},
  ): ResolvedSessionTarget | null {
    const direct = this.entries.get(profileOrProviderId);
    if (direct) {
      if (!direct.config.enabled) return null;
      return {
        provider: direct.provider,
        providerId: direct.provider.id,
        persistenceProviderId: direct.provider.id,
        config: {
          ...base,
          provider: direct.provider.id,
          model: direct.config.defaultModel ?? base.model ?? null,
        },
      };
    }

    const indexed = this.profileIndex.get(profileOrProviderId);
    if (!indexed) return null;
    const entry = this.entries.get(indexed.providerId);
    if (!entry || !entry.config.enabled) return null;
    const { profile } = indexed;
    return {
      provider: entry.provider,
      providerId: entry.provider.id,
      persistenceProviderId: entry.provider.id,
      profileOf: profile.profileId,
      config: {
        ...base,
        provider: entry.provider.id,
        model:
          profile.overrides.model ??
          profile.overrides.defaultModel ??
          entry.config.defaultModel ??
          base.model ??
          null,
        ...(profile.overrides.modeId ? { modeId: profile.overrides.modeId } : {}),
        ...(profile.overrides.thinkingOptionId
          ? { thinkingOptionId: profile.overrides.thinkingOptionId }
          : {}),
      },
    };
  }

  /** Providers + derived profiles for hello/catalog surfaces. */
  describe(): Array<{
    providerId: ProviderId;
    enabled: boolean;
    profiles: DerivedProfile[];
  }> {
    return [...this.entries.values()].map((e) => ({
      providerId: e.provider.id,
      enabled: e.config.enabled,
      profiles: [...e.profiles.values()],
    }));
  }

  private rebuildProfileIndex(): void {
    this.profileIndex.clear();
    for (const entry of this.entries.values()) {
      for (const profile of entry.profiles.values()) {
        this.profileIndex.set(profile.profileId, {
          providerId: entry.provider.id,
          profile,
        });
      }
    }
  }
}

/**
 * Effective capability = static ∩ runtime-reported.
 * Runtime may only NARROW (same rule as backend capabilities).
 */
export function effectiveCapabilities(
  staticCaps: AgentCapabilityFlags,
  runtime?: Partial<AgentCapabilityFlags>,
): AgentCapabilityFlags {
  if (!runtime) return staticCaps;
  const out = { ...staticCaps };
  for (const key of Object.keys(runtime) as Array<keyof AgentCapabilityFlags>) {
    if (runtime[key] === false) {
      (out as Record<string, boolean>)[key] = false;
    }
  }
  return out;
}

