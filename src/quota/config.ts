// ============================================================================
// src/quota/config.ts
// Shared configuration parsing for env-based provider settings.
//
// Both the aggregation service (service.ts) and the smoke test read from here
// so they always use the SAME endpoints and the same region-validation rules
// (review P1-2). A misspelled region throws before any network request.
// ============================================================================

import type { GlmRegion } from './providers/glm.js';

export type { GlmRegion };

/** Thrown when an env-provided config value is invalid (e.g. bad region). */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

const VALID_REGIONS = new Set<GlmRegion>(['bigmodel', 'zai']);

export interface ProviderConfigs {
  glm: {
    token: string;
    region: GlmRegion;
    baseUrl: string | undefined;
  };
  kimi: {
    accessToken: string | undefined;
    baseUrl: string | undefined;
  };
  codex: {
    binaryPath: string | undefined;
  };
}

/**
 * Parse provider configs from process.env. Throws ConfigError if
 * GLM_CODING_PLAN_REGION is set to a value other than bigmodel|zai — before
 * any token can be sent to the wrong region.
 */
export function parseProviderConfigs(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): ProviderConfigs {
  return {
    glm: {
      token: env.GLM_CODING_PLAN_TOKEN || env.GLM_QUOTA_TOKEN || '',
      region: parseGlmRegion(env.GLM_CODING_PLAN_REGION),
      baseUrl: env.GLM_CODING_PLAN_BASE_URL || undefined,
    },
    kimi: {
      accessToken: env.KIMI_CODE_ACCESS_TOKEN || undefined,
      baseUrl: env.KIMI_CODE_BASE_URL || undefined,
    },
    codex: {
      binaryPath: env.CODEX_BINARY_PATH || undefined,
    },
  };
}

/**
 * Parse and validate the GLM region. Returns 'bigmodel' when unset (the
 * documented default). Throws ConfigError for any value that is not exactly
 * 'bigmodel' or 'zai' — no silent fallback on a typo (review P1-2).
 */
function parseGlmRegion(raw: string | undefined): GlmRegion {
  if (raw === undefined || raw === '') return 'bigmodel';
  if (!VALID_REGIONS.has(raw as GlmRegion)) {
    throw new ConfigError(
      `Invalid GLM_CODING_PLAN_REGION "${raw}". Must be "bigmodel" or "zai".`,
    );
  }
  return raw as GlmRegion;
}
