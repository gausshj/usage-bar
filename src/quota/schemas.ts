// ============================================================================
// src/quota/schemas.ts
// Runtime schema validation for provider responses (PRD §12.1 / §8.1 / #13).
//
// These zod schemas validate the raw JSON returned by each provider before the
// adapter trusts it. Rules:
//   - Unknown fields are ignored (third-party APIs evolve).
//   - Required fields missing / wrong type => a controlled SchemaError (NOT a
//     silent null), which adapters map to `error` or `unsupported` status.
//   - All schemas are lenient about optionals — providers omit fields often.
// ============================================================================

import { z } from 'zod';

/** Error thrown when a response fails schema validation. */
export class SchemaError extends Error {
  constructor(
    public readonly provider: string,
    message: string,
  ) {
    super(message);
    this.name = 'SchemaError';
  }
}

/**
 * Parse `unknown` JSON against a schema, throwing a SchemaError on failure.
 * Use this in adapters instead of bare `as T` casts.
 */
export function parseWithSchema<T>(
  provider: string,
  schema: z.ZodType<T>,
  data: unknown,
): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const path = first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
    throw new SchemaError(provider, `unexpected response shape${path}: ${first.message}`);
  }
  return result.data;
}

// ---------------------------------------------------------------------------
// GLM Coding Plan — /api/monitor/usage/quota/limit
// ---------------------------------------------------------------------------

export const glmLimitSchema = z
  .object({
    type: z.string(),
    percentage: z.number().optional(),
    unit: z.number().optional(),
    number: z.number().optional(),
    currentValue: z.number().optional(),
    usage: z.number().optional(),
    remaining: z.number().optional(),
    nextResetTime: z.number().optional(), // ms epoch
    // MCP tools breakdown (search-prime / web-reader / zread), e.g.
    // [{ modelCode: 'search-prime', usage: 26 }]
    usageDetails: z
      .array(z.object({ modelCode: z.string(), usage: z.number() }).passthrough())
      .optional(),
  })
  .passthrough(); // tolerate new fields

export const glmQuotaResponseSchema = z.object({
  data: z.object({ limits: z.array(glmLimitSchema).optional() }).optional(),
  limits: z.array(glmLimitSchema).optional(),
}).passthrough();

export type GlmQuotaResponseParsed = z.infer<typeof glmQuotaResponseSchema>;

// ---------------------------------------------------------------------------
// Kimi Code — /coding/v1/usages
// Numbers arrive as decimal strings; we accept string|number and normalize later.
// ---------------------------------------------------------------------------

export const kimiUsageDetailSchema = z
  .object({
    used: z.union([z.string(), z.number()]).optional(),
    limit: z.union([z.string(), z.number()]).optional(),
    resetTime: z.string().optional(),
    name: z.string().optional(),
  })
  .passthrough();

export const kimiUsageWindowSchema = z
  .object({
    duration: z.number().optional(),
    timeUnit: z.string().optional(),
  })
  .passthrough();

export const kimiLimitEntrySchema = z
  .object({
    window: kimiUsageWindowSchema.optional(),
    detail: kimiUsageDetailSchema.optional(),
  })
  .passthrough();

export const kimiBoosterBalanceSchema = z
  .object({
    type: z.string().optional(),
    amount: z.number().optional(),
    amountLeft: z.number().optional(),
  })
  .passthrough();

export const kimiBoosterWalletSchema = z
  .object({
    balance: kimiBoosterBalanceSchema.optional(),
    monthlyChargeLimitEnabled: z.boolean().optional(),
  })
  .passthrough();

export const kimiUsagesResponseSchema = z
  .object({
    usage: kimiUsageDetailSchema.optional(), // weekly summary
    limits: z.array(kimiLimitEntrySchema).optional(),
    boosterWallet: kimiBoosterWalletSchema.optional(),
  })
  .passthrough();

export type KimiUsagesResponseParsed = z.infer<typeof kimiUsagesResponseSchema>;

// ---------------------------------------------------------------------------
// Codex App Server — account/rateLimits/read
// All fields nullable (the App Server uses null liberally).
// ---------------------------------------------------------------------------

export const codexRateLimitWindowSchema = z.object({
  usedPercent: z.number().nullable().optional(),
  windowDurationMins: z.number().nullable().optional(),
  resetsAt: z.number().nullable().optional(), // Unix seconds
}).passthrough();

export const codexCreditsSchema = z.object({
  hasCredits: z.boolean().nullable().optional(),
  unlimited: z.boolean().nullable().optional(),
  balance: z.string().nullable().optional(),
}).passthrough();

export const codexRateLimitSnapshotSchema = z.object({
  limitId: z.string().nullable().optional(),
  primary: codexRateLimitWindowSchema.nullable().optional(),
  secondary: codexRateLimitWindowSchema.nullable().optional(),
  credits: codexCreditsSchema.nullable().optional(),
  planType: z.string().nullable().optional(),
}).passthrough();

export const codexRateLimitsResponseSchema = z.object({
  rateLimits: codexRateLimitSnapshotSchema.nullable(),
}).passthrough();

export type CodexRateLimitsResponseParsed = z.infer<typeof codexRateLimitsResponseSchema>;
