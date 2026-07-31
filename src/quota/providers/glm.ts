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
import type {
  QuotaBucket,
  QuotaBalance,
  QuotaProviderAdapter,
  QuotaSnapshot,
} from '../contract.js';

export type GlmRegion = 'bigmodel' | 'zai';

export interface GlmProviderConfig {
  /** GLM Coding Plan token (bare, used directly as Authorization). */
  token: string;
  /** Region selection — explicit, never inferred (PRD §7.2). */
  region?: GlmRegion;
  /** Override the full base URL. */
  baseUrl?: string;
}

const PROVIDER_ID = 'glm_coding_plan' as const;
const DISPLAY_NAME = 'GLM Coding Plan';
const SOURCE = { kind: 'official_compatibility' as const, name: 'GLM monitor API', version: null, isFallback: false };

const REGION_BASE_URLS: Record<GlmRegion, string> = {
  bigmodel: 'https://open.bigmodel.cn',
  zai: 'https://api.z.ai',
};

// Raw response shapes -------------------------------------------------------

interface GlmLimit {
  type: string;
  percentage?: number;
  unit?: number;
  number?: number;
  currentValue?: number;
  usage?: number;
  remaining?: number;
  nextResetTime?: number; // ms epoch
}
interface GlmQuotaResponse {
  data?: { limits?: GlmLimit[] };
  limits?: GlmLimit[];
}

export class GlmProvider implements QuotaProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly displayName = DISPLAY_NAME;

  private readonly token: string;
  private readonly baseUrl: string;

  constructor(config: GlmProviderConfig) {
    if (!config.token) throw new Error('GLM token required');
    this.token = config.token;
    const base = config.baseUrl ?? REGION_BASE_URLS[config.region ?? 'bigmodel'];
    this.baseUrl = base.replace(/\/+$/, '');
  }

  isConfigured(): boolean {
    return !!this.token;
  }

  async fetch(previous: QuotaSnapshot | null): Promise<QuotaSnapshot> {
    const fetchedAt = new Date().toISOString();
    const url = `${this.baseUrl}/api/monitor/usage/quota/limit`;

    try {
      const result = await fetchJson<GlmQuotaResponse>('glm', url, {
        headers: {
          Authorization: this.token,
          'Accept-Language': 'en-US,en',
          'Content-Type': 'application/json',
        },
      });
      return this.toSnapshot(result.value, fetchedAt, previous);
    } catch (err) {
      return this.toErrorSnapshot(err, fetchedAt, previous);
    }
  }

  // -----------------------------------------------------------------

  private toSnapshot(
    body: GlmQuotaResponse,
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
  const metric = limit.type === 'TIME_LIMIT' ? 'time' : 'tokens';
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
  const typeLabel = limit.type === 'TOKENS_LIMIT' ? 'tokens' : limit.type === 'TIME_LIMIT' ? 'usage' : limit.type;
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
