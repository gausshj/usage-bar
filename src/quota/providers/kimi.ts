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

import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { fetchJson } from '../http.js';
import {
  parseWithSchema,
  kimiUsagesResponseSchema,
  type KimiUsagesResponseParsed,
} from '../schemas.js';
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

// Parsed response types derived from the zod schema (numbers come as decimal
// strings, units as proto-style enum strings — normalized in the mappers below).

type RawUsagesResponse = KimiUsagesResponseParsed;
type RawUsageDetail = NonNullable<RawUsagesResponse['usage']>;
type RawUsageWindow = NonNullable<NonNullable<NonNullable<RawUsagesResponse['limits']>[number]>['window']>;

interface StoredCredentials {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number; // seconds (Kimi stores epoch-seconds)
  expires_in?: number; // seconds (lifetime, e.g. 900)
}

/** OAuth refresh endpoint + client id (from kimi-cli source). */
const OAUTH_HOST = 'https://auth.kimi.com';
const OAUTH_CLIENT_ID = '17e5f671-d194-4dfb-9706-5516cb48c098';

export class KimiProvider implements QuotaProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly displayName = DISPLAY_NAME;

  private readonly accessTokenOverride: string | undefined;
  private readonly credentialsPath: string;
  private readonly baseUrl: string;

  constructor(config: KimiProviderConfig = {}) {
    this.accessTokenOverride = config.accessToken;
    this.credentialsPath = config.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  isConfigured(): boolean {
    if (this.accessTokenOverride) return true;
    const creds = readCredentials(this.credentialsPath);
    return !!(creds.access_token || creds.refresh_token);
  }

  async fetch(previous: QuotaSnapshot | null): Promise<QuotaSnapshot> {
    const fetchedAt = new Date().toISOString();

    // Resolve a valid access token, refreshing via OAuth if necessary (#15).
    let token: string;
    try {
      token = await this.resolveAccessToken();
    } catch {
      return empty(fetchedAt, previous, {
        code: 'token_expired',
        safeMessage: 'Kimi Code token expired or revoked. Re-login via kimi-cli.',
        retryable: false,
      }, 'unconfigured');
    }

    if (!token) {
      return empty(fetchedAt, previous, {
        code: 'no_credentials',
        safeMessage: 'Kimi Code not logged in. Run kimi-cli login.',
        retryable: false,
      }, 'unconfigured');
    }

    try {
      const result = await fetchJson<unknown>('kimi', `${this.baseUrl}/usages`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
        },
      });
      const parsed = parseWithSchema('kimi', kimiUsagesResponseSchema, result.value);
      return this.toSnapshot(parsed, fetchedAt, previous);
    } catch (err) {
      return this.toErrorSnapshot(err, fetchedAt, previous);
    }
  }

  /**
   * Resolve a valid access token. If an override is configured, use it as-is.
   * Otherwise read the credentials file; if the stored token is expired (or
   * near expiry), refresh it via the OAuth refresh_token grant and write the
   * refreshed credentials back so kimi-cli and this app stay in sync (#15).
   * Throws if no usable token can be obtained.
   */
  private async resolveAccessToken(): Promise<string> {
    if (this.accessTokenOverride) return this.accessTokenOverride;

    const creds = readCredentials(this.credentialsPath);
    if (!creds.access_token && !creds.refresh_token) return '';

    // Re-read each call so we pick up tokens refreshed by kimi-cli between calls.
    if (creds.access_token && !isExpired(creds)) {
      return creds.access_token;
    }

    // Token missing or expired → refresh with the refresh_token.
    if (!creds.refresh_token) return creds.access_token ?? '';

    const refreshed = await refreshOAuthToken(creds.refresh_token);
    // Write back so the CLI and subsequent calls see the fresh token.
    writeCredentials(this.credentialsPath, { ...creds, ...refreshed });
    return refreshed.access_token ?? '';
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

/** Read the stored credentials file (best-effort). */
function readCredentials(path: string): StoredCredentials {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as StoredCredentials;
  } catch {
    return {};
  }
}

/**
 * Is the stored token expired? Kimi stores expires_at as epoch-SECONDS, and
 * tokens last ~15min (expires_in=900). We treat it as expired if less than
 * 60s of life remains, to avoid a race right at the boundary.
 */
function isExpired(creds: StoredCredentials): boolean {
  const expiresAtSec = creds.expires_at;
  if (typeof expiresAtSec !== 'number') {
    // No expiry recorded → assume expired (forces a refresh attempt, which
    // fails safely into the 401 path if the token is actually still valid).
    return true;
  }
  // expires_at is seconds; compare against now-in-seconds + 60s buffer.
  const nowSec = Math.floor(Date.now() / 1000);
  return expiresAtSec <= nowSec + 60;
}

/** Refresh the access token via the OAuth refresh_token grant. */
async function refreshOAuthToken(refreshToken: string): Promise<StoredCredentials> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: OAUTH_CLIENT_ID,
  });
  const res = await fetch(`${OAUTH_HOST}/api/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`kimi oauth refresh failed: HTTP ${res.status}`);
  }
  const data = (await res.json()) as StoredCredentials;
  // Compute expires_at (seconds) from expires_in so isExpired works next time.
  if (data.expires_in != null && data.expires_at == null) {
    data.expires_at = Math.floor(Date.now() / 1000) + data.expires_in;
  }
  return data;
}

/** Write refreshed credentials back, preserving file permissions (#15). */
function writeCredentials(path: string, creds: StoredCredentials): void {
  try {
    writeFileSync(path, JSON.stringify(creds, null, 2));
  } catch {
    // Non-fatal: if we can't persist, the in-memory token still works for
    // this request; next call will refresh again.
  }
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
