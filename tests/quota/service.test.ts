import { describe, expect, it } from 'vitest';

import { QuotaService } from '../../src/quota/service.js';
import type {
  ProviderId,
  QuotaProviderAdapter,
  QuotaSnapshot,
} from '../../src/quota/contract.js';
import { PROVIDER_ORDER } from '../../src/quota/contract.js';

// ---------------------------------------------------------------------------
// Helpers: build mock adapters with controllable behavior
// ---------------------------------------------------------------------------

function readySnapshot(id: ProviderId, usedPercent = 50): QuotaSnapshot {
  return {
    providerId: id,
    status: 'ready',
    fetchedAt: new Date().toISOString(),
    observedAt: new Date().toISOString(),
    source: { kind: 'official_protocol', name: 'test', version: null, isFallback: false },
    plan: { name: null, accountLabel: null },
    buckets: [
      {
        id: 'w',
        label: 'window',
        metric: 'tokens',
        unit: null,
        used: null,
        limit: null,
        remaining: 100 - usedPercent,
        usedPercent,
        windowSeconds: null,
        resetsAt: null,
      },
    ],
  };
}

function makeAdapter(
  id: ProviderId,
  behavior: { configured: boolean; snapshot?: QuotaSnapshot; throwErr?: Error; delayMs?: number },
): QuotaProviderAdapter & { fetchCalls: number } {
  let fetchCalls = 0;
  return {
    providerId: id,
    displayName: id,
    isConfigured: () => behavior.configured,
    fetch: async () => {
      fetchCalls++;
      if (behavior.delayMs) await new Promise((r) => setTimeout(r, behavior.delayMs));
      if (behavior.throwErr) throw behavior.throwErr;
      return behavior.snapshot!;
    },
    get fetchCalls() {
      return fetchCalls;
    },
  } as unknown as QuotaProviderAdapter & { fetchCalls: number };
}

function adaptersFrom(records: Partial<Record<ProviderId, QuotaProviderAdapter>>) {
  const map = {} as Record<ProviderId, QuotaProviderAdapter>;
  for (const id of PROVIDER_ORDER) {
    map[id] =
      records[id] ??
      makeAdapter(id, { configured: false });
  }
  return map;
}

// ---------------------------------------------------------------------------

describe('QuotaService', () => {
  it('always returns exactly three providers in fixed order', async () => {
    const svc = new QuotaService({
      adapters: adaptersFrom({}),
    });
    const result = await svc.readAll();

    expect(result).toHaveLength(3);
    expect(result.map((s) => s.providerId)).toEqual(PROVIDER_ORDER);
  });

  it('marks unconfigured providers without calling fetch', async () => {
    const codex = makeAdapter('codex_chatgpt', { configured: true, snapshot: readySnapshot('codex_chatgpt') });
    const svc = new QuotaService({
      adapters: adaptersFrom({ codex_chatgpt: codex }),
    });
    const result = await svc.readAll();

    const glm = result.find((s) => s.providerId === 'glm_coding_plan')!;
    expect(glm.status).toBe('unconfigured');
    expect(glm.error?.code).toBe('unconfigured');
  });

  it('serves cached results within TTL without re-fetching', async () => {
    const codex = makeAdapter('codex_chatgpt', { configured: true, snapshot: readySnapshot('codex_chatgpt') });
    const svc = new QuotaService({ adapters: adaptersFrom({ codex_chatgpt: codex }), cacheTtlMs: 10_000 });

    await svc.readAll();
    await svc.readAll();

    expect(codex.fetchCalls).toBe(1); // second read hit cache
  });

  it('singleflight merges concurrent refreshes of the same provider', async () => {
    const codex = makeAdapter('codex_chatgpt', {
      configured: true,
      snapshot: readySnapshot('codex_chatgpt'),
      delayMs: 50,
    });
    const svc = new QuotaService({ adapters: adaptersFrom({ codex_chatgpt: codex }) });

    // Two concurrent refreshes should result in one fetch.
    await Promise.all([svc.refreshAll(), svc.refreshAll()]);

    expect(codex.fetchCalls).toBe(1);
  });

  it('falls back to stale when a refresh fails but a prior good snapshot exists', async () => {
    // First succeeds, then throws.
    let succeed = true;
    const codex: QuotaProviderAdapter = {
      providerId: 'codex_chatgpt',
      displayName: 'Codex',
      isConfigured: () => true,
      fetch: async (prev) => {
        if (succeed) return readySnapshot('codex_chatgpt');
        throw new Error('boom');
        void prev;
      },
    };
    const svc = new QuotaService({ adapters: adaptersFrom({ codex_chatgpt: codex }) });

    const first = await svc.readAll();
    expect(first[0].status).toBe('ready');

    succeed = false;
    const second = await svc.refreshAll();
    expect(second[0].status).toBe('stale');
    // stale keeps the old buckets, not empty.
    expect(second[0].buckets.length).toBeGreaterThan(0);
  });

  it('returns unavailable (not stale) when there is no prior good snapshot', async () => {
    const codex = makeAdapter('codex_chatgpt', { configured: true, throwErr: new Error('boom') });
    const svc = new QuotaService({ adapters: adaptersFrom({ codex_chatgpt: codex }) });

    const result = await svc.readAll();
    expect(result[0].status).toBe('unavailable');
    expect(result[0].error?.code).toBe('unavailable');
  });

  it('a single provider failing never blocks the others', async () => {
    const codex = makeAdapter('codex_chatgpt', { configured: true, snapshot: readySnapshot('codex_chatgpt') });
    const glm = makeAdapter('glm_coding_plan', { configured: true, throwErr: new Error('glm down') });
    const svc = new QuotaService({
      adapters: adaptersFrom({ codex_chatgpt: codex, glm_coding_plan: glm }),
    });

    const result = await svc.readAll();
    expect(result[0].status).toBe('ready'); // codex ok
    expect(result[1].status).toBe('unavailable'); // glm failed
    expect(result[2].status).toBe('unconfigured'); // kimi not configured
  });
});
