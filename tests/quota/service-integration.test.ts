import { afterEach, describe, expect, it, vi } from 'vitest';

import { PROVIDER_ORDER } from '../../src/quota/contract.js';
import type {
  ProviderId,
  QuotaProviderAdapter,
  QuotaSnapshot,
} from '../../src/quota/contract.js';
import * as configModule from '../../src/quota/config.js';
import { QuotaService } from '../../src/quota/service.js';

// Integration test: an invalid GLM region must NOT crash the whole service.
// Only GLM should report an error; Codex and Kimi must still refresh.
// Uses the real buildDefaultAdapters() factory (P1).

const ORIGINAL_ENV = { ...process.env };

function readyAdapter(providerId: ProviderId): QuotaProviderAdapter {
  return {
    providerId,
    displayName: providerId,
    isConfigured: () => true,
    async fetch(): Promise<QuotaSnapshot> {
      const now = new Date().toISOString();
      return {
        providerId,
        status: 'ready',
        fetchedAt: now,
        observedAt: now,
        source: {
          kind: providerId === 'codex_chatgpt' ? 'official_protocol' : 'official_compatibility',
          name: 'integration-test',
          version: null,
          isFallback: false,
        },
        plan: { name: null, accountLabel: null },
        buckets: [],
      };
    },
  };
}

describe('service with invalid GLM region (integration)', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('readAll returns a provider-scoped invalid_config error without network I/O', async () => {
    const invalidRegion = 'secret-token-accidentally-pasted-here';
    process.env.GLM_CODING_PLAN_REGION = invalidRegion;
    // Provide a dummy token so GLM doesn't short-circuit to unconfigured.
    process.env.GLM_CODING_PLAN_TOKEN = 'dummy';
    delete process.env.GLM_CREDENTIAL_ID;
    delete process.env.KIMI_CREDENTIAL_ID;
    const networkFetch = vi.fn();
    vi.stubGlobal('fetch', networkFetch);

    const { buildDefaultAdapters } = await import('../../src/quota/service.js');
    const adapters = await buildDefaultAdapters();
    const glmFetch = vi.spyOn(adapters.glm_coding_plan, 'fetch');

    // Keep the integration deterministic while still exercising the real
    // default factory and its provider-scoped GLM config-error adapter.
    adapters.codex_chatgpt = readyAdapter('codex_chatgpt');
    adapters.kimi_code = readyAdapter('kimi_code');
    const codexFetch = vi.spyOn(adapters.codex_chatgpt, 'fetch');
    const kimiFetch = vi.spyOn(adapters.kimi_code, 'fetch');

    const snapshots = await new QuotaService({ adapters }).readAll();
    expect(snapshots.map((snapshot) => snapshot.providerId)).toEqual(PROVIDER_ORDER);
    expect(snapshots.map((snapshot) => snapshot.status)).toEqual([
      'ready',
      'error',
      'ready',
    ]);
    expect(snapshots[1].error).toEqual({
      code: 'invalid_config',
      safeMessage: 'Invalid GLM_CODING_PLAN_REGION. Must be "bigmodel" or "zai".',
      retryable: false,
    });
    expect(snapshots[1].error?.safeMessage).not.toContain(invalidRegion);
    expect(codexFetch).toHaveBeenCalledOnce();
    expect(glmFetch).toHaveBeenCalledOnce();
    expect(kimiFetch).toHaveBeenCalledOnce();
    expect(networkFetch).not.toHaveBeenCalled();
  });

  it('rethrows unexpected config parser errors instead of masking them', async () => {
    delete process.env.GLM_CREDENTIAL_ID;
    delete process.env.KIMI_CREDENTIAL_ID;
    const unexpected = new Error('unexpected config parser failure');
    const networkFetch = vi.fn();
    vi.stubGlobal('fetch', networkFetch);
    vi.spyOn(configModule, 'parseProviderConfigs').mockImplementationOnce(() => {
      throw unexpected;
    });

    const { buildDefaultAdapters } = await import('../../src/quota/service.js');
    await expect(buildDefaultAdapters()).rejects.toBe(unexpected);
    expect(networkFetch).not.toHaveBeenCalled();
  });
});
