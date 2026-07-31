import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { QuotaSnapshot } from '../../src/quota/contract.js';

// We test the route handler by mocking the shared service singleton.
const mockSnapshots: QuotaSnapshot[] = [];

function snap(providerId: QuotaSnapshot['providerId'], status: QuotaSnapshot['status']): QuotaSnapshot {
  return {
    providerId,
    status,
    fetchedAt: new Date().toISOString(),
    observedAt: null,
    source: { kind: 'official_protocol', name: 'test', version: null, isFallback: false },
    plan: { name: null, accountLabel: null },
    buckets: [],
  };
}

vi.mock('@/quota/service-instance', () => ({
  getQuotaService: () => ({
    readAll: async () => mockSnapshots,
    refreshAll: async () => mockSnapshots,
  }),
}));

describe('GET /api/v1/quota (contract)', () => {
  beforeEach(() => {
    mockSnapshots.length = 0;
    mockSnapshots.push(
      snap('codex_chatgpt', 'ready'),
      snap('glm_coding_plan', 'unavailable'),
      snap('kimi_code', 'unconfigured'),
    );
  });

  it('always returns all three providers in fixed order, even on partial failure', async () => {
    const { GET } = await import('../../src/app/api/v1/quota/route.js');
    const res = await GET();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.providers).toHaveLength(3);
    expect(body.providers.map((p: QuotaSnapshot) => p.providerId)).toEqual([
      'codex_chatgpt',
      'glm_coding_plan',
      'kimi_code',
    ]);
    // A single failed provider still yields 200 with its error status.
    expect(body.providers[1].status).toBe('unavailable');
    expect(body.providers[2].status).toBe('unconfigured');
  });

  it('includes schemaVersion and generatedAt', async () => {
    const { GET } = await import('../../src/app/api/v1/quota/route.js');
    const res = await GET();
    const body = await res.json();
    expect(body.schemaVersion).toBe(1);
    expect(typeof body.generatedAt).toBe('string');
  });

  it('sets no-store cache headers', async () => {
    const { GET } = await import('../../src/app/api/v1/quota/route.js');
    const res = await GET();
    expect(res.headers.get('Cache-Control')).toContain('no-store');
  });
});

describe('POST /api/v1/quota/refresh (contract)', () => {
  it('returns three providers after forced refresh', async () => {
    const { POST } = await import('../../src/app/api/v1/quota/refresh/route.js');
    const res = await POST();
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.providers).toHaveLength(3);
  });
});
