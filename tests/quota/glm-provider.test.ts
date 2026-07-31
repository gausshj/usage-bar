import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GlmProvider } from '../../src/quota/providers/glm.js';

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe('GlmProvider', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('maps a normal multi-window response to ready buckets', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(200, {
        data: {
          limits: [
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 42, nextResetTime: 1785436421682 },
            { type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 1, currentValue: 5, usage: 4000 },
          ],
        },
      }),
    );

    const snap = await new GlmProvider({ token: 'tok' }).fetch(null);
    expect(snap.status).toBe('ready');
    expect(snap.source.kind).toBe('official_compatibility');
    expect(snap.buckets).toHaveLength(2);
    expect(snap.buckets[0].usedPercent).toBe(42);
    expect(snap.buckets[0].resetsAt).toContain('2026');
  });

  it('maps a 401 to error status with auth_failed code', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(401, { error: 'unauthorized' }),
    );
    const snap = await new GlmProvider({ token: 'bad' }).fetch(null);
    expect(snap.status).toBe('error');
    expect(snap.error?.code).toBe('auth_failed');
    expect(snap.error?.retryable).toBe(false);
  });

  it('maps a 404 to unsupported (API may have changed)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(404, {}),
    );
    const snap = await new GlmProvider({ token: 't' }).fetch(null);
    expect(snap.status).toBe('unsupported');
    expect(snap.error?.code).toBe('endpoint_not_found');
  });

  it('falls back to stale when refresh fails but a prior ready snapshot exists', async () => {
    let ok = true;
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      if (ok) return jsonResponse(200, { data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 10 }] } });
      return jsonResponse(500, {});
    });

    const p = new GlmProvider({ token: 't' });
    const first = await p.fetch(null);
    expect(first.status).toBe('ready');

    ok = false;
    const second = await p.fetch(first);
    expect(second.status).toBe('stale');
    expect(second.buckets.length).toBeGreaterThan(0); // kept old data
  });

  it('respects explicit region selection for base URL', async () => {
    const mock = globalThis.fetch as ReturnType<typeof vi.fn>;
    mock.mockResolvedValue(jsonResponse(200, { data: { limits: [] } }));
    await new GlmProvider({ token: 't', region: 'zai' }).fetch(null);
    expect(mock.mock.calls[0][0]).toBe('https://api.z.ai/api/monitor/usage/quota/limit');
  });

  it('maps an unknown limit type to an unknown-metric bucket (not dropped)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(200, {
        data: { limits: [{ type: 'FUTURE_LIMIT_TYPE', percentage: 5, unit: 9, number: 1 }] },
      }),
    );
    const snap = await new GlmProvider({ token: 't' }).fetch(null);
    expect(snap.status).toBe('ready');
    expect(snap.buckets).toHaveLength(1);
    expect(snap.buckets[0].metric).toBe('unknown'); // visibly distinct, not 'tokens'
  });

  it('returns a controlled error on malformed response shape (schema drift)', async () => {
    // `data.limits` is a string instead of an array → schema rejects it.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(200, { data: { limits: 'not-an-array' } }),
    );
    const snap = await new GlmProvider({ token: 't' }).fetch(null);
    // Schema failure surfaces as an error status, not a crash or silent null.
    expect(snap.status).not.toBe('ready');
    expect(snap.error).toBeDefined();
  });

  it('tolerates extra unknown fields in the response (passthrough)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(200, {
        data: {
          limits: [{ type: 'TOKENS_LIMIT', percentage: 10, unit: 3, number: 5 }],
          newFutureField: { whatever: true },
        },
        extraRoot: 42,
      }),
    );
    const snap = await new GlmProvider({ token: 't' }).fetch(null);
    expect(snap.status).toBe('ready'); // unknown fields ignored, not rejected
  });
});
