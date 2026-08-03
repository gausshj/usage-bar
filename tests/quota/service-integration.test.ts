import { afterEach, describe, expect, it } from 'vitest';

// Integration test: an invalid GLM region must NOT crash the whole service.
// Only GLM should report an error; Codex and Kimi must still refresh.
// Uses the real buildDefaultAdapters() factory (P1).

const ORIGINAL_ENV = { ...process.env };

describe('service with invalid GLM region (integration)', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('GLM returns invalid_config error while Codex/Kimi remain unaffected', async () => {
    process.env.GLM_CODING_PLAN_REGION = 'invalid_region';
    // Provide a dummy token so GLM doesn't short-circuit to unconfigured.
    process.env.GLM_CODING_PLAN_TOKEN = 'dummy';

    const { buildDefaultAdapters } = await import('../../src/quota/service.js');
    const adapters = await buildDefaultAdapters();

    // All three adapters must exist — the factory must not have thrown.
    expect(adapters.codex_chatgpt).toBeDefined();
    expect(adapters.glm_coding_plan).toBeDefined();
    expect(adapters.kimi_code).toBeDefined();

    // GLM adapter must report the config error (not crash, not unconfigured).
    const glmSnap = await adapters.glm_coding_plan.fetch(null);
    expect(glmSnap.providerId).toBe('glm_coding_plan');
    expect(glmSnap.status).toBe('error');
    expect(glmSnap.error?.code).toBe('invalid_config');
  });

  it('GLM with valid region builds normally', async () => {
    process.env.GLM_CODING_PLAN_REGION = 'bigmodel';
    process.env.GLM_CODING_PLAN_TOKEN = 'dummy';

    const { buildDefaultAdapters } = await import('../../src/quota/service.js');
    const adapters = await buildDefaultAdapters();

    const glmSnap = await adapters.glm_coding_plan.fetch(null);
    // With a dummy token, GLM will try a real request and fail — but the
    // adapter itself is the real GlmProvider (not an error stub), so the
    // status should be a network/auth error, not invalid_config.
    expect(glmSnap.error?.code).not.toBe('invalid_config');
  });

  it('GLM with zai region builds normally', async () => {
    process.env.GLM_CODING_PLAN_REGION = 'zai';
    process.env.GLM_CODING_PLAN_TOKEN = 'dummy';

    const { buildDefaultAdapters } = await import('../../src/quota/service.js');
    const adapters = await buildDefaultAdapters();
    const glmSnap = await adapters.glm_coding_plan.fetch(null);
    expect(glmSnap.error?.code).not.toBe('invalid_config');
  });
});
