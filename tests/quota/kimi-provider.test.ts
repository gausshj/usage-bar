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
    const snap = await new KimiProvider({ accessToken: '' }).fetch(null);
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
    expect(new KimiProvider({ accessToken: '' }).isConfigured()).toBe(false);
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
});
