import { describe, expect, it } from 'vitest';

import { parseProviderConfigs, ConfigError } from '../../src/quota/config.js';

describe('parseProviderConfigs', () => {
  it('defaults region to bigmodel when unset', () => {
    const cfg = parseProviderConfigs({});
    expect(cfg.glm.region).toBe('bigmodel');
  });

  it('accepts region=zai', () => {
    const cfg = parseProviderConfigs({ GLM_CODING_PLAN_REGION: 'zai' });
    expect(cfg.glm.region).toBe('zai');
  });

  it('accepts region=bigmodel explicitly', () => {
    const cfg = parseProviderConfigs({ GLM_CODING_PLAN_REGION: 'bigmodel' });
    expect(cfg.glm.region).toBe('bigmodel');
  });

  it('throws ConfigError for an invalid region (no silent fallback)', () => {
    expect(() => parseProviderConfigs({ GLM_CODING_PLAN_REGION: 'global' })).toThrow(ConfigError);
    expect(() => parseProviderConfigs({ GLM_CODING_PLAN_REGION: 'zai ' })).toThrow(ConfigError);
    expect(() => parseProviderConfigs({ GLM_CODING_PLAN_REGION: 'ZAI' })).toThrow(ConfigError);
  });

  it('passes custom base URLs through to the config', () => {
    const cfg = parseProviderConfigs({
      GLM_CODING_PLAN_BASE_URL: 'https://custom.glm.example.com',
      KIMI_CODE_BASE_URL: 'https://custom.kimi.example.com',
    });
    expect(cfg.glm.baseUrl).toBe('https://custom.glm.example.com');
    expect(cfg.kimi.baseUrl).toBe('https://custom.kimi.example.com');
  });

  it('reads tokens from the canonical env names', () => {
    const cfg = parseProviderConfigs({
      GLM_CODING_PLAN_TOKEN: 'glm-tok',
      KIMI_CODE_ACCESS_TOKEN: 'kimi-tok',
    });
    expect(cfg.glm.token).toBe('glm-tok');
    expect(cfg.kimi.accessToken).toBe('kimi-tok');
  });

  it('falls back to legacy GLM_QUOTA_TOKEN', () => {
    const cfg = parseProviderConfigs({ GLM_QUOTA_TOKEN: 'legacy-tok' });
    expect(cfg.glm.token).toBe('legacy-tok');
  });
});
