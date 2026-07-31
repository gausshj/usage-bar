// ============================================================================
// src/quota/service.ts
// Aggregation service: orchestrates all three providers with caching,
// singleflight, parallel refresh, overall time budget, and stale fallback.
// (PRD §9, §10, §12.2)
// ============================================================================

import type {
  ProviderId,
  QuotaProviderAdapter,
  QuotaSnapshot,
} from './contract.js';
import { PROVIDER_ORDER } from './contract.js';

export interface QuotaServiceOptions {
  /** Per-provider success cache TTL in ms (default 60000). */
  cacheTtlMs?: number;
  /** Overall refresh budget in ms (default 8000). */
  refreshBudgetMs?: number;
  /** Inject adapters (testing) or provide explicit configs. */
  adapters?: Record<ProviderId, QuotaProviderAdapter>;
}

interface CacheEntry {
  snapshot: QuotaSnapshot;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 60_000;
const DEFAULT_REFRESH_BUDGET_MS = 8_000;

export class QuotaService {
  private readonly cacheTtlMs: number;
  private readonly refreshBudgetMs: number;
  private adapters: Record<ProviderId, QuotaProviderAdapter> | null;
  private readonly adapterFactory: () => Promise<Record<ProviderId, QuotaProviderAdapter>>;

  // Per-provider cache + last-known-good + in-flight singleflight.
  private readonly cache = new Map<ProviderId, CacheEntry>();
  private readonly lastKnownGood = new Map<ProviderId, QuotaSnapshot>();
  private readonly inFlight = new Map<ProviderId, Promise<QuotaSnapshot>>();

  constructor(options: QuotaServiceOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.refreshBudgetMs = options.refreshBudgetMs ?? DEFAULT_REFRESH_BUDGET_MS;
    // Injected adapters are used synchronously; otherwise lazy-build on demand.
    this.adapters = options.adapters ?? null;
    this.adapterFactory = () => Promise.resolve(options.adapters!);
    if (!options.adapters) {
      // Override factory for the default async build.
      this.adapterFactory = buildDefaultAdapters;
    }
  }

  private async getAdapters(): Promise<Record<ProviderId, QuotaProviderAdapter>> {
    if (!this.adapters) {
      this.adapters = await this.adapterFactory();
    }
    return this.adapters;
  }

  /**
   * Read all three snapshots. Uses cache when fresh; otherwise refreshes.
   * Always returns exactly three providers in fixed order (PRD §9.1). A single
   * provider failure never blocks the others.
   */
  async readAll(): Promise<QuotaSnapshot[]> {
    const results = await Promise.all(
      PROVIDER_ORDER.map((id) => this.readOne(id)),
    );
    return results;
  }

  /**
   * Force-refresh all three, ignoring cache (PRD §9.2). Singleflight merges
   * concurrent calls to the same provider.
   */
  async refreshAll(): Promise<QuotaSnapshot[]> {
    const results = await Promise.all(
      PROVIDER_ORDER.map((id) => this.refreshOne(id)),
    );
    return results;
  }

  // -----------------------------------------------------------------

  private async readOne(id: ProviderId): Promise<QuotaSnapshot> {
    const cached = this.cache.get(id);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.snapshot;
    }
    return this.refreshOne(id);
  }

  private async refreshOne(id: ProviderId): Promise<QuotaSnapshot> {
    // Singleflight: dedupe concurrent refreshes of the same provider.
    const existing = this.inFlight.get(id);
    if (existing) return existing;

    const promise = this.doRefresh(id).finally(() => {
      this.inFlight.delete(id);
    });
    this.inFlight.set(id, promise);
    return promise;
  }

  private async doRefresh(id: ProviderId): Promise<QuotaSnapshot> {
    const adapters = await this.getAdapters();
    const adapter = adapters[id];
    const previous = this.lastKnownGood.get(id) ?? null;

    // Unconfigured short-circuit (cheap, no network).
    if (!adapter.isConfigured()) {
      return this.unconfigured(id);
    }

    try {
      // Race the fetch against the overall budget.
      const snapshot = await withTimeout(
        adapter.fetch(previous),
        this.refreshBudgetMs,
        id,
      );
      // Only cache successful/usable results (PRD §10). Caching errors would
      // suppress retries for the full TTL and keep showing a failure.
      if (snapshot.status === 'ready' || snapshot.status === 'stale') {
        this.cache.set(id, { snapshot, expiresAt: Date.now() + this.cacheTtlMs });
      }
      if (snapshot.status === 'ready') {
        this.lastKnownGood.set(id, snapshot);
      }
      return snapshot;
    } catch {
      // Unexpected throw from adapter → stale fallback or unavailable.
      return this.staleOrUnavailable(id, previous);
    }
  }

  private unconfigured(id: ProviderId): QuotaSnapshot {
    return {
      providerId: id,
      status: 'unconfigured',
      fetchedAt: new Date().toISOString(),
      observedAt: null,
      source: { kind: 'official_compatibility', name: displayName(id), version: null, isFallback: false },
      plan: { name: null, accountLabel: null },
      buckets: [],
      error: { code: 'unconfigured', safeMessage: 'Not configured.', retryable: false },
    };
  }

  private staleOrUnavailable(id: ProviderId, previous: QuotaSnapshot | null): QuotaSnapshot {
    if (previous && previous.status === 'ready') {
      return {
        ...previous,
        status: 'stale',
        fetchedAt: new Date().toISOString(),
        error: { code: 'refresh_failed', safeMessage: 'Refresh failed; showing last known data.', retryable: true },
      };
    }
    return {
      providerId: id,
      status: 'unavailable',
      fetchedAt: new Date().toISOString(),
      observedAt: null,
      source: { kind: 'official_compatibility', name: displayName(id), version: null, isFallback: false },
      plan: { name: null, accountLabel: null },
      buckets: [],
      error: { code: 'unavailable', safeMessage: 'Provider temporarily unavailable.', retryable: true },
    };
  }
}

// ---------------------------------------------------------------------------
// Default adapter wiring (reads env / local state)
// ---------------------------------------------------------------------------

async function buildDefaultAdapters(): Promise<Record<ProviderId, QuotaProviderAdapter>> {
  // Dynamic imports keep this ESM-safe and avoid loading provider code (App
  // Server, fs reads) in environments that inject mock adapters instead.
  const [{ CodexProvider }, { GlmProvider }, { KimiProvider }, credentialsMod] = await Promise.all([
    import('./providers/codex.js'),
    import('./providers/glm.js'),
    import('./providers/kimi.js'),
    import('./credentials.js'),
  ]);

  // Resolve a credential store only if a credentialId is configured. The
  // security module is loaded lazily so it doesn't affect the no-credentialId
  // (env-only) path.
  const glmCredId = process.env.GLM_CREDENTIAL_ID;
  const kimiCredId = process.env.KIMI_CREDENTIAL_ID;
  let resolver;
  if (glmCredId || kimiCredId) {
    resolver = await buildSecureResolver(credentialsMod);
  }

  return {
    codex_chatgpt: new CodexProvider(),
    glm_coding_plan: new GlmProvider({
      token: process.env.GLM_CODING_PLAN_TOKEN || process.env.GLM_QUOTA_TOKEN || '',
      credentialId: glmCredId,
      resolver,
      region: process.env.GLM_CODING_PLAN_REGION === 'zai' ? 'zai' : 'bigmodel',
      baseUrl: process.env.GLM_CODING_PLAN_BASE_URL,
    }),
    kimi_code: new KimiProvider({
      accessToken: process.env.KIMI_CODE_ACCESS_TOKEN || undefined,
      credentialId: kimiCredId,
      resolver,
      baseUrl: process.env.KIMI_CODE_BASE_URL,
    }),
  };
}

/** Build the security-module-backed CredentialResolver (lazy-loaded). */
async function buildSecureResolver(
  credentialsMod: typeof import('./credentials.js'),
) {
  const { SecureSecretService, InMemorySecureStorageRepository } = await import('../security/storage.js');
  const { LocalFallbackKeyProvider } = await import('../security/key-manager.js');
  const repository = new InMemorySecureStorageRepository();
  const service = new SecureSecretService(repository, new LocalFallbackKeyProvider());
  return new credentialsMod.SecureCredentialResolver(repository, service);
}

function displayName(id: ProviderId): string {
  switch (id) {
    case 'codex_chatgpt': return 'Codex';
    case 'glm_coding_plan': return 'GLM Coding Plan';
    case 'kimi_code': return 'Kimi Code';
  }
}

async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} refresh timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
