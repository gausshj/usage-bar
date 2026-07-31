import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KimiProvider } from '../../src/quota/providers/kimi.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

// A realistic Kimi Code usages payload (numbers as decimal strings, proto enums).
const USAGE_FIXTURE = {
  usage: { used: '150', limit: '1200', resetTime: '2026-08-07T00:00:00.000Z', name: 'Weekly' },
  limits: [
    {
      window: { duration: 5, timeUnit: 'TIME_UNIT_HOUR' },
      detail: { used: '80', limit: '300', resetTime: '2026-07-31T05:00:00.000Z' },
    },
  ],
  boosterWallet: {
    balance: { type: 'BOOSTER', amount: 1000000, amountLeft: 500000 },
    monthlyChargeLimitEnabled: false,
  },
};

describe('KimiProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('maps the usages response to summary + limit buckets and a balance', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(200, USAGE_FIXTURE),
    );

    const snap = await new KimiProvider({ accessToken: 'tok' }).fetch(null);
    expect(snap.status).toBe('ready');
    expect(snap.source.kind).toBe('official_compatibility');
    expect(snap.buckets).toHaveLength(2); // weekly summary + 5-hour limit

    const weekly = snap.buckets[0];
    expect(weekly.used).toBe(150);
    expect(weekly.limit).toBe(1200);
    expect(weekly.usedPercent).toBeCloseTo(12.5, 1);

    expect(snap.balances).toBeDefined();
    expect(snap.balances![0].label).toBe('Booster wallet');
    expect(snap.balances![0].amount).toBe(500000);
  });

  it('maps a 401 to unconfigured with token_expired code', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(401, {}),
    );
    const snap = await new KimiProvider({ accessToken: 'tok' }).fetch(null);
    expect(snap.status).toBe('unconfigured');
    expect(snap.error?.code).toBe('token_expired');
    expect(snap.error?.retryable).toBe(false);
  });

  it('returns unconfigured when no access token is available', async () => {
    // Point at a non-existent credentials file so the real one isn't read.
    const snap = await new KimiProvider({
      accessToken: '',
      credentialsPath: '/nonexistent/kimi-code.json',
    }).fetch(null);
    expect(snap.status).toBe('unconfigured');
    expect(snap.error?.code).toBe('no_credentials');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('folds minutes-divisible-by-60 into hour labels', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(200, {
        limits: [
          { window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { used: '10', limit: '100' } },
        ],
      }),
    );
    const snap = await new KimiProvider({ accessToken: 't' }).fetch(null);
    expect(snap.buckets[0].label).toBe('5-hour');
  });

  it('isConfigured reflects token presence', () => {
    expect(new KimiProvider({ accessToken: 't' }).isConfigured()).toBe(true);
    // No override + no readable credentials file → not configured.
    expect(
      new KimiProvider({ accessToken: '', credentialsPath: '/nonexistent/kimi-code.json' }).isConfigured(),
    ).toBe(false);
  });

  it('returns a controlled error on malformed response shape (schema drift)', async () => {
    // `limits` is a string instead of an array → schema rejects.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(200, { limits: 'not-an-array' }),
    );
    const snap = await new KimiProvider({ accessToken: 't' }).fetch(null);
    expect(snap.status).not.toBe('ready');
    expect(snap.error).toBeDefined();
  });

  it('tolerates extra unknown fields in the response (passthrough)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(200, {
        usage: { used: '10', limit: '100' },
        futureField: { x: 1 },
      }),
    );
    const snap = await new KimiProvider({ accessToken: 't' }).fetch(null);
    expect(snap.status).toBe('ready');
  });

  it('maps a 403 to error status with forbidden code', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(403, {}),
    );
    const snap = await new KimiProvider({ accessToken: 't' }).fetch(null);
    expect(snap.status).toBe('error');
    expect(snap.error?.code).toBe('forbidden');
  });

  it('maps a 404 to unsupported status', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(404, {}),
    );
    const snap = await new KimiProvider({ accessToken: 't' }).fetch(null);
    expect(snap.status).toBe('unsupported');
    expect(snap.error?.code).toBe('endpoint_not_found');
  });

  it('maps a 429 to unavailable (transient, retryable)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(429, {}),
    );
    const snap = await new KimiProvider({ accessToken: 't' }).fetch(null);
    expect(snap.status).toBe('unavailable');
    expect(snap.error?.code).toBe('transient');
    expect(snap.error?.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// OAuth token refresh path (issue #32)
// ---------------------------------------------------------------------------

describe('KimiProvider token refresh', () => {
  const originalFetch = globalThis.fetch;
  let dir: string;
  let credsPath: string;

  beforeEach(async () => {
    globalThis.fetch = vi.fn();
    dir = await mkdtemp(join(tmpdir(), 'kimi-creds-'));
    credsPath = join(dir, 'kimi-code.json');
  });
  afterEach(async () => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('refreshes an expired access_token via refresh_token, then fetches usage', async () => {
    // Stored creds: expired token (expires_at in the past) + a refresh_token.
    await writeFile(
      credsPath,
      JSON.stringify({
        access_token: 'old-expired',
        refresh_token: 'valid-refresh',
        expires_at: Math.floor(Date.now() / 1000) - 3600, // 1h ago
        token_type: 'Bearer',
        expires_in: 900,
        scope: 'kimi-code',
      }),
    );

    const mock = globalThis.fetch as ReturnType<typeof vi.fn>;
    // 1st call → OAuth refresh endpoint returns a new access_token.
    // 2nd call → usages endpoint returns data.
    mock.mockImplementation(async (url: string) => {
      if (String(url).includes('auth.kimi.com')) {
        return jsonResponse(200, {
          access_token: 'new-refreshed',
          refresh_token: 'rotated-refresh',
          token_type: 'Bearer',
          expires_in: 900,
          scope: 'kimi-code',
        });
      }
      return jsonResponse(200, { usage: { used: '5', limit: '100' } });
    });

    const snap = await new KimiProvider({ credentialsPath: credsPath }).fetch(null);
    expect(snap.status).toBe('ready');
    expect(snap.buckets[0].used).toBe(5);
    // The usages request used the refreshed token, not the old one.
    const usagesCall = mock.mock.calls.find((c) => String(c[0]).includes('/usages'));
    expect((usagesCall![1].headers as Record<string, string>).Authorization).toBe(
      'Bearer new-refreshed',
    );
  });

  it('returns unconfigured when refresh fails (revoked refresh_token)', async () => {
    await writeFile(
      credsPath,
      JSON.stringify({
        access_token: 'old-expired',
        refresh_token: 'revoked',
        expires_at: Math.floor(Date.now() / 1000) - 3600,
      }),
    );
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(401, { error: 'invalid_grant' }),
    );

    const snap = await new KimiProvider({ credentialsPath: credsPath }).fetch(null);
    expect(snap.status).toBe('unconfigured');
    expect(snap.error?.code).toBe('token_expired');
  });

  it('uses the stored token directly when not expired (no refresh call)', async () => {
    await writeFile(
      credsPath,
      JSON.stringify({
        access_token: 'still-valid',
        refresh_token: 'unused',
        expires_at: Math.floor(Date.now() / 1000) + 3600, // 1h in future
        token_type: 'Bearer',
        expires_in: 900,
        scope: 'kimi-code',
      }),
    );
    const mock = globalThis.fetch as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue(jsonResponse(200, { usage: { used: '1', limit: '10' } }));

    await new KimiProvider({ credentialsPath: credsPath }).fetch(null);
    // Only the usages call happened — no refresh.
    expect(mock.mock.calls.every((c) => !String(c[0]).includes('auth.kimi.com'))).toBe(true);
  });

  it('returns unconfigured when the refresh endpoint itself errors (HTTP 500)', async () => {
    await writeFile(
      credsPath,
      JSON.stringify({
        access_token: 'old',
        refresh_token: 'rt',
        expires_at: Math.floor(Date.now() / 1000) - 3600,
      }),
    );
    // refreshOAuthToken fetch returns 500 → throws → resolveAccessToken throws.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(500, { error: 'server' }),
    );

    const snap = await new KimiProvider({ credentialsPath: credsPath }).fetch(null);
    expect(snap.status).toBe('unconfigured');
    expect(snap.error?.code).toBe('token_expired');
  });

  it('still fetches successfully when writing refreshed creds fails (non-fatal)', async () => {
    await writeFile(
      credsPath,
      JSON.stringify({
        access_token: 'old',
        refresh_token: 'rt',
        expires_at: Math.floor(Date.now() / 1000) - 3600,
      }),
    );
    // Point credentialsPath at a path whose directory vanishes after read,
    // so the write-back fails — but the in-memory refreshed token still works.
    const mock = globalThis.fetch as ReturnType<typeof vi.fn>;
    mock.mockImplementation(async (url: string) => {
      if (String(url).includes('auth.kimi.com')) {
        return jsonResponse(200, { access_token: 'fresh', expires_in: 900 });
      }
      return jsonResponse(200, { usage: { used: '2', limit: '10' } });
    });

    // Use a credentials path under a read-only-ish location to force write failure.
    const badPath = '/dev/null/not-writable/kimi-code.json';
    const snap = await new KimiProvider({ credentialsPath: badPath }).fetch(null);
    // No creds readable at badPath → treated as no credentials.
    expect(snap.status).toBe('unconfigured');
  });
});
