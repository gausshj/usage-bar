// ============================================================================
// src/connectors/types.ts
// Shared types for the connector framework
// ============================================================================

/** Normalized usage record — the universal currency of the connector layer. */
export interface NormalizedRecord {
  provider: string;
  date: string; // YYYY-MM-DD
  model: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

// ---------------------------------------------------------------------------
// Connector interface
// ---------------------------------------------------------------------------

/**
 * Core interface all provider connectors must implement.
 * Encapsulates fetching usage/cost data and normalizing it.
 */
export interface Connector {
  readonly providerName: string;

  /**
   * Fetch usage data for the given time window.
   * Returns an array of daily UsageBuckets, one per day that has data.
   */
  fetchUsage(startTime: number, endTime: number): Promise<UsageBucket[]>;

  /**
   * Fetch cost data for the given time window.
   * Returns an array of daily CostBuckets, one per day that has data.
   */
  fetchCosts(startTime: number, endTime: number): Promise<CostBucket[]>;

  /**
   * Merge usage and cost buckets into flat NormalizedRecords.
   * Each usage row gets enriched with its matched cost.
   */
  normalizeUsageAndCosts(usage: UsageBucket[], costs: CostBucket[]): NormalizedRecord[];
}

// ---------------------------------------------------------------------------
// Usage types
// ---------------------------------------------------------------------------

export interface UsageResult {
  model: string;
  inputTokens: number;
  outputTokens: number;
  requests: number;
  projectId: string | null;
  inputCachedTokens: number;
  inputAudioTokens: number;
  outputAudioTokens: number;
}

export interface UsageBucket {
  startTime: number; // Unix seconds
  endTime: number;
  results: UsageResult[];
}

// ---------------------------------------------------------------------------
// Cost types
// ---------------------------------------------------------------------------

export interface CostResult {
  lineItem: string;
  amount: number;
  currency: string;
  projectId: string | null;
  organizationId: string;
}

export interface CostBucket {
  startTime: number;
  endTime: number;
  results: CostResult[];
}

// ---------------------------------------------------------------------------
// Connector config types (per-provider)
// ---------------------------------------------------------------------------

export interface OpenAIConnectorConfig {
  adminApiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export interface ZhipuConnectorConfig {
  apiKey: string;
  baseUrl?: string;
  cnyToUsdRate?: number;
}

export interface MinimaxConnectorConfig {
  apiKey: string;
  baseUrl?: string;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export type AnyConnectorConfig = OpenAIConnectorConfig | ZhipuConnectorConfig | MinimaxConnectorConfig;

// ---------------------------------------------------------------------------
// Provider identifier
// ---------------------------------------------------------------------------

export type ProviderName = 'openai' | 'zhipu' | 'minimax';

/** Union of all supported provider names, for switch/case exhaustiveness. */
export const PROVIDER_NAMES = ['openai', 'zhipu', 'minimax'] as const;
