// ============================================================================
// src/quota/providers/glm.ts
// GLM Coding Plan quota provider (official_compatibility).
//
// Endpoint: GET {base}/api/monitor/usage/quota/limit
// Auth: bare token in Authorization header (matches the official glm-plan-usage
// plugin). Supports both the China站 (open.bigmodel.cn) and the global 站
// (api.z.ai) via explicit region config — never guessed from the token.
//
// Source level: official_compatibility — it exists in official tooling but is
// not a promised stable public API (PRD §5, §7.2). The UI surfaces this label.
// ============================================================================

import { fetchJson } from '../http.js';
import { parseWithSchema, glmQuotaResponseSchema, type GlmQuotaResponseParsed } from '../schemas.js';
import type { CredentialResolver, ExpectedScope } from '../credentials.js';
import type {
  QuotaBucket,
  QuotaBalance,
  QuotaProviderAdapter,
  QuotaSnapshot,
} from '../contract.js';

export type GlmRegion = 'bigmodel' | 'zai';

export interface GlmProviderConfig {
  /** GLM Coding Plan token (bare, used directly as Authorization). env fallback. */
  token?: string;
  /** A credentialId to resolve via `resolver` instead of a raw token (#22). */
  credentialId?: string;
  /** Resolver used to decrypt `credentialId` with scope validation. */
  resolver?: CredentialResolver;
  /** Region selection — explicit, never inferred (PRD §7.2). */
  region?: GlmRegion;
  /** Override the full base URL. */
  baseUrl?: string;
}

const PROVIDER_ID = 'glm_coding_plan' as const;
const DISPLAY_NAME = 'GLM Coding Plan';
const SOURCE = { kind: 'official_compatibility' as const, name: 'GLM monitor API', version: null, isFallback: false };
const EXPECTED_SCOPE: ExpectedScope = { provider: 'glm_coding_plan', kind: 'api_key' };

const REGION_BASE_URLS: Record<GlmRegion, string> = {
  bigmodel: 'https://open.bigmodel.cn',
  zai: 'https://api.z.ai',
};

// Raw response shapes -------------------------------------------------------

/** A single GLM limit entry (type derived from the zod schema). */
type GlmLimit = NonNullable<NonNullable<NonNullable<GlmQuotaResponseParsed['data']>['limits']>[number]>;

export class GlmProvider implements QuotaProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly displayName = DISPLAY_NAME;

  private readonly tokenOverride: string | undefined;
  private readonly credentialId: string | undefined;
  private readonly resolver: CredentialResolver | undefined;
  private readonly baseUrl: string;

  constructor(config: GlmProviderConfig) {
    // Allow both token and credentialId to be absent — the adapter then reports
    // unconfigured (via isConfigured()/fetch) instead of throwing at build time.
    // This lets the aggregation service build all three providers even when one
    // is simply not configured.
    this.tokenOverride = config.token;
    this.credentialId = config.credentialId;
    this.resolver = config.resolver;
    const base = config.baseUrl ?? REGION_BASE_URLS[config.region ?? 'bigmodel'];
    this.baseUrl = base.replace(/\/+$/, '');
  }

  isConfigured(): boolean {
    return !!(this.tokenOverride || this.credentialId);
  }

  /**
   * Resolve the token. credentialId (with scope validation) takes precedence;
   * otherwise fall back to the raw token (env-based, Local Alpha).
   */
  private async resolveToken(): Promise<string> {
    if (this.credentialId) {
      if (!this.resolver) throw new Error('credentialId set but no resolver provided');
      return this.resolver.reveal(this.credentialId, EXPECTED_SCOPE);
    }
    return this.tokenOverride ?? '';
  }

  async fetch(previous: QuotaSnapshot | null): Promise<QuotaSnapshot> {
    const fetchedAt = new Date().toISOString();
    const url = `${this.baseUrl}/api/monitor/usage/quota/limit`;

    let token: string;
    try {
      token = await this.resolveToken();
    } catch {
      // Credential resolution failed (missing / scope mismatch / revoked).
      return empty(fetchedAt, previous, {
        code: 'credential_unavailable',
        safeMessage: 'GLM credential could not be resolved.',
        retryable: false,
      }, 'unconfigured');
    }
    if (!token) {
      return empty(fetchedAt, previous, {
        code: 'no_credentials',
        safeMessage: 'GLM token not configured.',
        retryable: false,
      }, 'unconfigured');
    }

    try {
      const result = await fetchJson<unknown>('glm', url, {
        headers: {
          Authorization: token,
          'Accept-Language': 'en-US,en',
          'Content-Type': 'application/json',
        },
      });
      const parsed = parseWithSchema('glm', glmQuotaResponseSchema, result.value);
      return this.toSnapshot(parsed, fetchedAt, previous);
    } catch (err) {
      return this.toErrorSnapshot(err, fetchedAt, previous);
    }
  }

  // -----------------------------------------------------------------

  private toSnapshot(
    body: GlmQuotaResponseParsed,
    fetchedAt: string,
    previous: QuotaSnapshot | null,
  ): QuotaSnapshot {
    const limits = body.data?.limits ?? body.limits ?? [];
    const buckets: QuotaBucket[] = [];
    const balances: QuotaBalance[] = [];

    for (const limit of limits) {
      const bucket = limitToBucket(limit);
      if (bucket) buckets.push(bucket);
    }

    if (buckets.length === 0 && limits.length === 0) {
      return empty(fetchedAt, previous, {
        code: 'empty_response',
        safeMessage: 'GLM returned no quota limits.',
        retryable: true,
      }, 'error');
    }

    return {
      providerId: PROVIDER_ID,
      status: 'ready',
      fetchedAt,
      observedAt: fetchedAt,
      source: SOURCE,
      plan: { name: null, accountLabel: null },
      buckets,
      balances: balances.length > 0 ? balances : undefined,
    };
  }

  private toErrorSnapshot(
    err: unknown,
    fetchedAt: string,
    previous: QuotaSnapshot | null,
  ): QuotaSnapshot {
    const { code, message, retryable, status } = classifyGlmError(err);
    // Stale fallback if we have a prior good snapshot.
    if (previous && previous.status === 'ready') {
      return { ...previous, status: 'stale', fetchedAt, error: { code, safeMessage: message, retryable } };
    }
    return empty(fetchedAt, previous, { code, safeMessage: message, retryable }, status);
  }
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

function limitToBucket(limit: GlmLimit): QuotaBucket | null {
  // Known limit types get a friendly window label from {type, unit, number}.
  const label = describeGlmWindow(limit);
  // Unknown limit types are surfaced as 'unknown' metric buckets (not dropped)
  // so a new type doesn't silently disappear, but is visibly distinct (PRD #13).
  const isKnown = limit.type === 'TOKENS_LIMIT' || limit.type === 'TIME_LIMIT';
  // TIME_LIMIT is MCP tool-call volume → metric 'requests', not 'time' (#37).
  const metric: QuotaBucket['metric'] = !isKnown
    ? 'unknown'
    : limit.type === 'TIME_LIMIT'
      ? 'requests'
      : 'tokens';
  const usedPercent = typeof limit.percentage === 'number' ? limit.percentage : null;

  return {
    id: `${limit.type}-${limit.unit ?? '?'}-${limit.number ?? '?'}`,
    label,
    metric,
    unit: limit.type === 'TIME_LIMIT' ? 'calls' : 'tokens',
    // GLM gives percentage + sometimes currentValue/usage.
    used: typeof limit.currentValue === 'number' ? limit.currentValue : null,
    limit: typeof limit.usage === 'number' ? limit.usage : null,
    remaining: typeof limit.remaining === 'number' ? limit.remaining : null,
    usedPercent,
    windowSeconds: null,
    resetsAt: limit.nextResetTime ? new Date(limit.nextResetTime).toISOString() : null,
  };
}

function describeGlmWindow(limit: GlmLimit): string {
  // TIME_LIMIT is the MCP tool-call volume window, NOT a monthly token quota
  // (verified against the official glm-plan-usage plugin + a real account, #37).
  // The window period is still shown via its unit/number, but the label names
  // the metric honestly.
  if (limit.type === 'TIME_LIMIT') {
    const period = limit.unit != null && limit.number != null
      ? GLM_UNIT_MINUTES_LABEL(limit.unit)
      : null;
    return period ? `MCP calls (${period})` : 'MCP calls';
  }
  const typeLabel = limit.type === 'TOKENS_LIMIT' ? 'tokens' : limit.type;
  if (limit.unit != null && limit.number != null) {
    const unitName = GLM_UNIT_MINUTES_LABEL(limit.unit);
    return `${limit.number}-${unitName} (${typeLabel})`;
  }
  return typeLabel;
}

function GLM_UNIT_MINUTES_LABEL(unit: number): string {
  // Observed: 3=hour, 5=month, 6=day, 7=week
  switch (unit) {
    case 3: return 'hour';
    case 5: return 'month';
    case 6: return 'day';
    case 7: return 'week';
    default: return `unit${unit}`;
  }
}

// ---------------------------------------------------------------------------
// Error classification (PRD §7.2: distinct safe codes)
// ---------------------------------------------------------------------------

function classifyGlmError(err: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  status: QuotaSnapshot['status'];
} {
  const e = err as { statusCode?: number; message?: string; isRetryable?: boolean };
  if (e.statusCode === 401) {
    return { code: 'auth_failed', message: 'GLM authentication failed. Check the token.', retryable: false, status: 'error' };
  }
  if (e.statusCode === 403) {
    return { code: 'forbidden', message: 'GLM token lacks permission.', retryable: false, status: 'error' };
  }
  if (e.statusCode === 404) {
    return { code: 'endpoint_not_found', message: 'GLM quota endpoint not found (API may have changed).', retryable: false, status: 'unsupported' };
  }
  if (e.isRetryable || e.statusCode === 429 || (e.statusCode ?? 0) >= 500) {
    return { code: 'transient', message: 'GLM temporarily unavailable.', retryable: true, status: 'unavailable' };
  }
  return { code: 'fetch_failed', message: e.message ?? 'GLM fetch failed.', retryable: true, status: 'unavailable' };
}

function empty(
  fetchedAt: string,
  _previous: QuotaSnapshot | null,
  error: { code: string; safeMessage: string; retryable: boolean },
  status: QuotaSnapshot['status'],
): QuotaSnapshot {
  return {
    providerId: PROVIDER_ID,
    status,
    fetchedAt,
    observedAt: null,
    source: SOURCE,
    plan: { name: null, accountLabel: null },
    buckets: [],
    error,
  };
}
