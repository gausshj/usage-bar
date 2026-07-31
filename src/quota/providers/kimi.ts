// ============================================================================
// src/quota/providers/kimi.ts
// Kimi Code quota provider (official_compatibility).
//
// Endpoint: GET https://api.kimi.com/coding/v1/usages
// Auth: Bearer <accessToken> — the Kimi Code OAuth access token, obtained via
// the device-code flow by kimi-cli and stored at ~/.kimi-code/credentials/.
// This is the KIMI CODE subscription usage, NOT Moonshot Open Platform balance
// (PRD §7.3 explicitly forbids substituting the latter).
//
// The backend returns numbers as decimal strings and time units as proto-style
// enum strings; this adapter normalizes them to the contract's numeric fields.
// ============================================================================

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { fetchJson } from '../http.js';
import type {
  QuotaBucket,
  QuotaBalance,
  QuotaProviderAdapter,
  QuotaSnapshot,
} from '../contract.js';

export interface KimiProviderConfig {
  /** Access token override; otherwise read from kimi-cli credentials. */
  accessToken?: string;
  /** Override credentials file path. */
  credentialsPath?: string;
  /** Override base URL. */
  baseUrl?: string;
}

const PROVIDER_ID = 'kimi_code' as const;
const DISPLAY_NAME = 'Kimi Code';
const SOURCE = { kind: 'official_compatibility' as const, name: 'Kimi Code usages', version: null, isFallback: false };
const DEFAULT_BASE_URL = 'https://api.kimi.com/coding/v1';
const DEFAULT_CREDENTIALS_PATH = `${homedir()}/.kimi-code/credentials/kimi-code.json`;

// Raw response shapes (numbers come as decimal strings, units as enum strings)

interface RawUsageDetail {
  used?: string;
  limit?: string;
  resetTime?: string;
  name?: string;
}
interface RawUsageWindow {
  duration?: number;
  timeUnit?: string; // TIME_UNIT_MINUTE | HOUR | DAY | WEEK
}
interface RawLimitEntry {
  window?: RawUsageWindow;
  detail?: RawUsageDetail;
}
interface RawBoosterBalance {
  type?: string;
  amount?: number;
  amountLeft?: number;
}
interface RawBoosterWallet {
  balance?: RawBoosterBalance;
  monthlyChargeLimitEnabled?: boolean;
}
interface RawUsagesResponse {
  usage?: RawUsageDetail; // weekly summary
  limits?: RawLimitEntry[];
  boosterWallet?: RawBoosterWallet;
}

interface StoredCredentials {
  access_token?: string;
  expires_at?: number;
}

export class KimiProvider implements QuotaProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly displayName = DISPLAY_NAME;

  private readonly accessToken: string;
  private readonly baseUrl: string;

  constructor(config: KimiProviderConfig = {}) {
    this.accessToken = config.accessToken ?? readKimiAccessToken(config.credentialsPath);
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  isConfigured(): boolean {
    return !!this.accessToken;
  }

  async fetch(previous: QuotaSnapshot | null): Promise<QuotaSnapshot> {
    const fetchedAt = new Date().toISOString();

    if (!this.accessToken) {
      return empty(fetchedAt, previous, {
        code: 'no_credentials',
        safeMessage: 'Kimi Code not logged in. Run kimi-cli login.',
        retryable: false,
      }, 'unconfigured');
    }

    if (isTokenExpired()) {
      return empty(fetchedAt, previous, {
        code: 'token_expired',
        safeMessage: 'Kimi Code token expired. Re-login via kimi-cli.',
        retryable: false,
      }, 'unconfigured');
    }

    try {
      const result = await fetchJson<RawUsagesResponse>('kimi', `${this.baseUrl}/usages`, {
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/json',
        },
      });
      return this.toSnapshot(result.value, fetchedAt, previous);
    } catch (err) {
      return this.toErrorSnapshot(err, fetchedAt, previous);
    }
  }

  // -----------------------------------------------------------------

  private toSnapshot(
    body: RawUsagesResponse,
    fetchedAt: string,
    previous: QuotaSnapshot | null,
  ): QuotaSnapshot {
    const buckets: QuotaBucket[] = [];
    const balances: QuotaBalance[] = [];

    // Weekly summary (top-level `usage`, backend omits window → synthesize 1 week)
    if (body.usage) {
      const b = usageDetailToBucket('summary', 'weekly (summary)', body.usage, 7 * 86400);
      if (b) buckets.push(b);
    }

    // Granular limits
    for (const entry of body.limits ?? []) {
      const detail = entry.detail;
      if (!detail) continue;
      const windowSecs = windowToSeconds(entry.window);
      const label = windowLabel(entry.window) ?? 'limit';
      const b = usageDetailToBucket(`limit-${buckets.length}`, label, detail, windowSecs);
      if (b) buckets.push(b);
    }

    // Booster / extra-usage wallet → balance (separate from periodic quota)
    const booster = body.boosterWallet?.balance;
    if (booster && typeof booster.amountLeft === 'number') {
      balances.push({
        id: 'booster',
        label: 'Booster wallet',
        amount: booster.amountLeft,
        unit: 'credits',
      });
    }

    if (buckets.length === 0 && balances.length === 0) {
      return empty(fetchedAt, previous, {
        code: 'empty_response',
        safeMessage: 'Kimi Code returned no usage data.',
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
    const { code, message, retryable, status } = classifyKimiError(err);
    if (previous && previous.status === 'ready') {
      return { ...previous, status: 'stale', fetchedAt, error: { code, safeMessage: message, retryable } };
    }
    return empty(fetchedAt, previous, { code, safeMessage: message, retryable }, status);
  }
}

// ---------------------------------------------------------------------------
// Mapping helpers
// ---------------------------------------------------------------------------

function usageDetailToBucket(
  id: string,
  label: string,
  detail: RawUsageDetail,
  windowSeconds: number | null,
): QuotaBucket | null {
  const used = toNumber(detail.used);
  const limit = toNumber(detail.limit);
  const usedPercent = used != null && limit != null && limit > 0 ? (used / limit) * 100 : null;
  return {
    id,
    label: detail.name ?? label,
    metric: 'requests',
    unit: 'requests',
    used,
    limit,
    remaining: used != null && limit != null ? limit - used : null,
    usedPercent: usedPercent != null ? Math.min(100, Math.max(0, usedPercent)) : null,
    windowSeconds,
    resetsAt: detail.resetTime ?? null,
  };
}

function windowToSeconds(window?: RawUsageWindow): number | null {
  if (!window?.duration) return null;
  const unit = window.timeUnit ?? '';
  const d = window.duration;
  if (unit.includes('MINUTE')) return d * 60;
  if (unit.includes('HOUR')) return d * 3600;
  if (unit.includes('DAY')) return d * 86400;
  if (unit.includes('WEEK')) return d * 604800;
  return null;
}

function windowLabel(window?: RawUsageWindow): string | null {
  if (!window?.duration) return null;
  const unit = window.timeUnit ?? '';
  const d = window.duration;
  if (unit.includes('MINUTE')) {
    // Fold minutes divisible by 60 into hours (e.g. 300min → 5h).
    if (d % 60 === 0) return `${d / 60}-hour`;
    return `${d}-minute`;
  }
  if (unit.includes('HOUR')) return `${d}-hour`;
  if (unit.includes('DAY')) return `${d}-day`;
  if (unit.includes('WEEK')) return `${d}-week`;
  return `${d}`;
}

function toNumber(value: string | number | undefined): number | null {
  if (value == null) return null;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

// ---------------------------------------------------------------------------
// Credentials + expiry
// ---------------------------------------------------------------------------

function readKimiAccessToken(credentialsPath?: string): string {
  const path = credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
  try {
    const creds = JSON.parse(readFileSync(path, 'utf8')) as StoredCredentials;
    return creds.access_token ?? '';
  } catch {
    return '';
  }
}

function isTokenExpired(): boolean {
  // We can't access the stored expiry without re-reading; the 401 path handles
  // actual expiry. For a pre-check, rely on the server's 401. Return false here.
  return false;
}

// ---------------------------------------------------------------------------
// Error classification (PRD §7.3: OAuth/token expiry → safe state)
// ---------------------------------------------------------------------------

function classifyKimiError(err: unknown): {
  code: string;
  message: string;
  retryable: boolean;
  status: QuotaSnapshot['status'];
} {
  const e = err as { statusCode?: number; message?: string; isRetryable?: boolean };
  if (e.statusCode === 401) {
    return { code: 'token_expired', message: 'Kimi Code token expired or revoked. Re-login.', retryable: false, status: 'unconfigured' };
  }
  if (e.statusCode === 403) {
    return { code: 'forbidden', message: 'Kimi Code access denied.', retryable: false, status: 'error' };
  }
  if (e.statusCode === 404) {
    return { code: 'endpoint_not_found', message: 'Kimi Code usages endpoint not found.', retryable: false, status: 'unsupported' };
  }
  if (e.isRetryable || e.statusCode === 429 || (e.statusCode ?? 0) >= 500) {
    return { code: 'transient', message: 'Kimi Code temporarily unavailable.', retryable: true, status: 'unavailable' };
  }
  return { code: 'fetch_failed', message: e.message ?? 'Kimi Code fetch failed.', retryable: true, status: 'unavailable' };
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
