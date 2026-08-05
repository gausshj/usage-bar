// ============================================================================
// src/quota/providers/kimi.ts
// Kimi Code quota provider (official_compatibility).
//
// Endpoint: GET https://api.kimi.com/coding/v1/usages
// Auth: Bearer <credential> — two first-class credential kinds (#40):
//   1. api_key: a Console-issued API key (Kimi Code Console → API Keys), passed
//      via KIMI_CODE_ACCESS_TOKEN or a credentialId. Static: NEVER sent through
//      the OAuth refresh flow; a 401 means the key is invalid/revoked.
//   2. oauth_token: the Kimi CLI OAuth access token, obtained via the
//      device-code flow and stored at ~/.kimi-code/credentials/. Short-lived
//      (~15min) and auto-refreshed via the stored refresh_token (#15).
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
import {
  CredentialScopeMismatchError,
  type CredentialResolver,
  type ExpectedScope,
} from '../credentials.js';
import type {
  QuotaBucket,
  QuotaBalance,
  QuotaProviderAdapter,
  QuotaSnapshot,
} from '../contract.js';

export interface KimiProviderConfig {
  /** Console API key (or static token) override; otherwise read from kimi-cli credentials. env fallback. */
  accessToken?: string;
  /** A credentialId resolved via `resolver` with scope validation (#22). */
  credentialId?: string;
  /** Resolver used to decrypt `credentialId`. */
  resolver?: CredentialResolver;
  /** Override credentials file path. */
  credentialsPath?: string;
  /** Override base URL. */
  baseUrl?: string;
}

/** The two credential kinds this adapter accepts (#40). */
type KimiCredentialKind = 'api_key' | 'oauth_token';

// credentialId credentials may be stored as either kind; both are valid for
// /usages. Scope validation tries each in turn — a kind mismatch falls through
// to the next, any other failure (missing/revoked) aborts immediately.
const EXPECTED_SCOPES: ExpectedScope[] = [
  { provider: 'kimi_code', kind: 'api_key' },
  { provider: 'kimi_code', kind: 'oauth_token' },
];

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
  private readonly credentialId: string | undefined;
  private readonly resolver: CredentialResolver | undefined;
  private readonly credentialsPath: string;
  private readonly baseUrl: string;

  constructor(config: KimiProviderConfig = {}) {
    this.accessTokenOverride = config.accessToken;
    this.credentialId = config.credentialId;
    this.resolver = config.resolver;
    this.credentialsPath = config.credentialsPath ?? DEFAULT_CREDENTIALS_PATH;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  isConfigured(): boolean {
    if (this.accessTokenOverride || this.credentialId) return true;
    const creds = readCredentials(this.credentialsPath);
    return !!(creds.access_token || creds.refresh_token);
  }

  async fetch(previous: QuotaSnapshot | null): Promise<QuotaSnapshot> {
    const fetchedAt = new Date().toISOString();

    // Resolve a usable credential. OAuth tokens are refreshed via OAuth if
    // necessary (#15); API keys are used as-is and never refreshed (#40).
    let cred: { token: string; kind: KimiCredentialKind };
    try {
      cred = await this.resolveAccessToken();
    } catch {
      return empty(fetchedAt, previous, {
        code: 'token_expired',
        safeMessage: this.credentialId
          ? 'Kimi Code credential could not be resolved (missing, revoked, or wrong scope).'
          : 'Kimi Code token expired or revoked. Run `kimi login` to re-authenticate.',
        retryable: false,
      }, 'unconfigured');
    }

    if (!cred.token) {
      return empty(fetchedAt, previous, {
        code: 'no_credentials',
        safeMessage:
          'Kimi Code not configured. Set KIMI_CODE_ACCESS_TOKEN to a Kimi Code Console API key, or run `kimi login`.',
        retryable: false,
      }, 'unconfigured');
    }

    try {
      const result = await fetchJson<unknown>('kimi', `${this.baseUrl}/usages`, {
        headers: {
          Authorization: `Bearer ${cred.token}`,
          Accept: 'application/json',
        },
      });
      const parsed = parseWithSchema('kimi', kimiUsagesResponseSchema, result.value);
      return this.toSnapshot(parsed, fetchedAt, previous);
    } catch (err) {
      return this.toErrorSnapshot(err, fetchedAt, previous, cred.kind);
    }
  }

  /**
   * Resolve a usable credential and its kind. A credentialId may be stored as
   * either an API key or an OAuth token (both are accepted, #40); an explicit
   * accessToken override is treated as a static API key and used as-is.
   * Otherwise read the CLI credentials file; if the stored token is expired
   * (or near expiry), refresh it via the OAuth refresh_token grant and write
   * the refreshed credentials back so kimi-cli and this app stay in sync (#15).
   * Throws if no usable token can be obtained.
   */
  private async resolveAccessToken(): Promise<{ token: string; kind: KimiCredentialKind }> {
    // credentialId takes precedence: resolve + scope-validate via the resolver,
    // accepting either credential kind.
    if (this.credentialId) return this.resolveCredentialById(this.credentialId);
    if (this.accessTokenOverride) return { token: this.accessTokenOverride, kind: 'api_key' };

    const creds = readCredentials(this.credentialsPath);
    if (!creds.access_token && !creds.refresh_token) return { token: '', kind: 'oauth_token' };

    // Use the stored token if it is still valid.
    if (creds.access_token && !isExpired(creds)) {
      return { token: creds.access_token, kind: 'oauth_token' };
    }

    // Token expired or missing. If there's no refresh_token, fall back to the
    // (stale) access_token — the usages request will likely 401, which maps to
    // a safe error. The guard above guarantees access_token is set here.
    if (!creds.refresh_token) {
      return { token: creds.access_token as string, kind: 'oauth_token' };
    }

    // Refresh via OAuth, then persist so kimi-cli stays in sync.
    const refreshed = await refreshOAuthToken(creds.refresh_token);
    writeCredentials(this.credentialsPath, { ...creds, ...refreshed });
    // A successful refresh must yield an access_token; treat its absence as
    // an auth failure (thrown → caller maps to token_expired).
    if (!refreshed.access_token) {
      throw new Error('kimi oauth refresh returned no access_token');
    }
    return { token: refreshed.access_token, kind: 'oauth_token' };
  }

  /**
   * Resolve a credentialId to a token, accepting either credential kind (#40).
   * A kind mismatch falls through to the next accepted kind; any other failure
   * (missing, revoked) aborts immediately.
   */
  private async resolveCredentialById(
    credentialId: string,
  ): Promise<{ token: string; kind: KimiCredentialKind }> {
    if (!this.resolver) throw new Error('credentialId set but no resolver provided');
    for (const scope of EXPECTED_SCOPES) {
      try {
        const token = await this.resolver.reveal(credentialId, scope);
        return { token, kind: scope.kind as KimiCredentialKind };
      } catch (err) {
        // A kind mismatch falls through to the next accepted kind; any other
        // failure (missing, revoked) aborts immediately.
        if (!(err instanceof CredentialScopeMismatchError)) throw err;
      }
    }
    // Every accepted kind mismatched — the credential is not usable here.
    throw new CredentialScopeMismatchError(
      `credential matches none of the accepted kinds (id: ${credentialId})`,
    );
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
    kind: KimiCredentialKind,
  ): QuotaSnapshot {
    const { code, message, retryable, status } = classifyKimiError(err, kind);
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

function classifyKimiError(
  err: unknown,
  kind: KimiCredentialKind,
): {
  code: string;
  message: string;
  retryable: boolean;
  status: QuotaSnapshot['status'];
} {
  const e = err as { statusCode?: number; message?: string; isRetryable?: boolean };
  if (e.statusCode === 401) {
    // A 401 on a static API key is terminal: keys don't expire on a timer, so
    // the key was revoked or is wrong — point the user at the Console (#40).
    if (kind === 'api_key') {
      return {
        code: 'api_key_invalid',
        message:
          'Kimi Code API key invalid or revoked. Create a new key in the Kimi Code Console and update KIMI_CODE_ACCESS_TOKEN.',
        retryable: false,
        status: 'unconfigured',
      };
    }
    return { code: 'token_expired', message: 'Kimi Code token expired or revoked. Run `kimi login` to re-authenticate.', retryable: false, status: 'unconfigured' };
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
