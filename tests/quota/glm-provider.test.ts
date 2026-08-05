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
    // Fixture mirrors a REAL account's monitor API response (3 windows):
    //   TIME_LIMIT  {number:1, unit:5}  → MCP tools, monthly
    //   TOKENS_LIMIT{number:5, unit:3}  → 5-hour token window
    //   TOKENS_LIMIT{number:1, unit:6}  → 7-day token window (the bug source)
    // unit is an opaque enum, NOT minutes: 3=hour, 5=month, 6=week (#42).
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(200, {
        data: {
          limits: [
            {
              type: 'TIME_LIMIT', unit: 5, number: 1, percentage: 1, currentValue: 5, usage: 4000,
              usageDetails: [
                { modelCode: 'search-prime', usage: 3 },
                { modelCode: 'web-reader', usage: 2 },
              ],
              nextResetTime: 1787676680997,
            },
            { type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 1, nextResetTime: 1785949413655 },
            { type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 6, nextResetTime: 1786207880998 },
          ],
        },
      }),
    );

    const snap = await new GlmProvider({ token: 'tok' }).fetch(null);
    expect(snap.status).toBe('ready');
    expect(snap.source.kind).toBe('official_compatibility');
    expect(snap.buckets).toHaveLength(3);

    // TIME_LIMIT is MCP tools usage (联网搜索/网页读取/开源仓库) — a monthly
    // internet/tool-call quota, NOT a monthly token quota (#37).
    const mcp = snap.buckets[0];
    expect(mcp.label).toBe('MCP tools (1-month)');
    expect(mcp.metric).toBe('requests');
    expect(mcp.used).toBe(5);
    expect(mcp.limit).toBe(4000);
    // usageDetails surfaced as a readable breakdown (#37).
    expect(mcp.details).toBe('search-prime=3, web-reader=2');

    // 5-hour token window (unit 3 = hour).
    expect(snap.buckets[1].label).toBe('5-hour (tokens)');

    // 7-day token window (unit 6 = week; "1-week" folded to "7-day" to match
    // GLM's own "7天" wording). Previously mislabeled as "1-day" (#42).
    expect(snap.buckets[2].label).toBe('7-day (tokens)');
    expect(snap.buckets[2].usedPercent).toBe(6);
    expect(snap.buckets[2].resetsAt).toContain('2026');
  });

  it('labels a 1-week token window as "7-day" (GLM "7天" wording)', async () => {
    // Regression guard for the weekly-window mislabel (#42). The previous
    // mapping guessed unit 6 = 'day', so {number:1, unit:6} rendered as
    // "1-day". Real semantics: unit 6 = week, and 1-week → "7-day".
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(200, {
        data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 1, percentage: 6 }] },
      }),
    );
    const snap = await new GlmProvider({ token: 'tok' }).fetch(null);
    expect(snap.buckets[0].label).toBe('7-day (tokens)');
  });

  it('labels a multi-week window with its count rather than folding to days', async () => {
    // Only "1-week" folds to "7-day"; a 2-week window keeps "2-week" so the
    // count is honest and not ambiguously large in days.
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(200, {
        data: { limits: [{ type: 'TOKENS_LIMIT', unit: 6, number: 2, percentage: 10 }] },
      }),
    );
    const snap = await new GlmProvider({ token: 'tok' }).fetch(null);
    expect(snap.buckets[0].label).toBe('2-week (tokens)');
  });

  it('labels a TIME_LIMIT without unit/number as plain "MCP tools"', async () => {
    // Covers the no-period branch: unit/number absent → label has no "(period)".
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(200, {
        data: { limits: [{ type: 'TIME_LIMIT', percentage: 3 }] },
      }),
    );
    const snap = await new GlmProvider({ token: 'tok' }).fetch(null);
    expect(snap.buckets[0].label).toBe('MCP tools');
    expect(snap.buckets[0].metric).toBe('requests');
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

  it('resolves the token via credentialId with scope validation (#22)', async () => {
    const resolver = {
      reveal: vi.fn().mockResolvedValue('resolved-token'),
    };
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(200, { data: { limits: [{ type: 'TOKENS_LIMIT', percentage: 7, unit: 3, number: 5 }] } }),
    );

    const p = new GlmProvider({ credentialId: 'cred-123', resolver });
    const snap = await p.fetch(null);

    expect(resolver.reveal).toHaveBeenCalledWith('cred-123', {
      provider: 'glm_coding_plan',
      kind: 'api_key',
    });
    expect(snap.status).toBe('ready');
    const init = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('resolved-token');
  });

  it('maps a resolver failure (scope mismatch / revoked) to unconfigured', async () => {
    const resolver = {
      reveal: vi.fn().mockRejectedValue(new Error('scope mismatch')),
    };
    const p = new GlmProvider({ credentialId: 'cred-x', resolver });
    const snap = await p.fetch(null);
    expect(snap.status).toBe('unconfigured');
    expect(snap.error?.code).toBe('credential_unavailable');
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('maps missing resolver (credentialId set but no resolver) to unconfigured', async () => {
    const p = new GlmProvider({ credentialId: 'cred-x' }); // no resolver
    const snap = await p.fetch(null);
    expect(snap.status).toBe('unconfigured');
    expect(snap.error?.code).toBe('credential_unavailable');
  });

  it('is unconfigured (not a throw) when neither token nor credentialId is set', async () => {
    const p = new GlmProvider({});
    expect(p.isConfigured()).toBe(false);
    const snap = await p.fetch(null);
    expect(snap.status).toBe('unconfigured');
  });

  it('maps a 403 to error status with forbidden code', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(403, {}),
    );
    const snap = await new GlmProvider({ token: 't' }).fetch(null);
    expect(snap.status).toBe('error');
    expect(snap.error?.code).toBe('forbidden');
    expect(snap.error?.retryable).toBe(false);
  });

  it('maps a 429 to unavailable (transient, retryable)', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockResolvedValue(
      jsonResponse(429, {}),
    );
    const snap = await new GlmProvider({ token: 't' }).fetch(null);
    expect(snap.status).toBe('unavailable');
    expect(snap.error?.code).toBe('transient');
    expect(snap.error?.retryable).toBe(true);
  });

  it('maps a timeout (abort) to unavailable with retryable', async () => {
    (globalThis.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error('request timed out'), { name: 'AbortError' }),
    );
    const snap = await new GlmProvider({ token: 't' }).fetch(null);
    expect(snap.status).toBe('unavailable');
    expect(snap.error?.retryable).toBe(true);
  });
});
