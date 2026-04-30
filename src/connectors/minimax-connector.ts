// ============================================================================
// src/connectors/minimax-connector.ts
// MiniMax Usage Connector Adapter
// Uses per-call token aggregation + pricing table (USD)
// No official usage/billing API; relies on per-request token tracking
// ============================================================================

import type {
  NormalizedRecord,
  Connector,
  UsageBucket,
  CostBucket,
  MinimaxConnectorConfig,
} from './types.js';

import { classifyError } from './errors.js';
import { withRetry } from './retry.js';
import { registerConnector } from './registry.js';

// ---------------------------------------------------------------------------
// Pricing table: USD per million tokens
// Source: https://platform.minimax.io/docs/guides/pricing-paygo
// ---------------------------------------------------------------------------

interface PricingEntry {
  inputPerMillion: number;   // USD / Mtokens
  outputPerMillion: number;  // USD / Mtokens
}

const MINIMAX_PRICING: Record<string, PricingEntry> = {
  // Current models
  'MiniMax-M2.7':             { inputPerMillion: 0.3,  outputPerMillion: 1.2 },
  'MiniMax-M2.7-highspeed':   { inputPerMillion: 0.6,  outputPerMillion: 2.4 },
  'MiniMax-M2.5':             { inputPerMillion: 0.3,  outputPerMillion: 1.2 },
  'MiniMax-M2.5-highspeed':   { inputPerMillion: 0.6,  outputPerMillion: 2.4 },
  'M2-her':                   { inputPerMillion: 0.3,  outputPerMillion: 1.2 },
  // Legacy models
  'MiniMax-M2.1':             { inputPerMillion: 0.3,  outputPerMillion: 1.2 },
  'MiniMax-M2.1-highspeed':  { inputPerMillion: 0.6,  outputPerMillion: 2.4 },
  'MiniMax-M2':              { inputPerMillion: 0.3,  outputPerMillion: 1.2 },
  // Legacy abab models (estimated — no longer listed on official pricing page)
  'abab-6.5-chat':           { inputPerMillion: 0.1,  outputPerMillion: 0.1 },
  'abab-6.5s-chat':          { inputPerMillion: 0.14, outputPerMillion: 0.14 },
  'abab-5.5-chat':           { inputPerMillion: 0.07, outputPerMillion: 0.07 },
};

// ---------------------------------------------------------------------------
// Internal store: accumulated per-call records
// ---------------------------------------------------------------------------

interface StoreEntry {
  model: string;
  date: string;           // YYYY-MM-DD
  inputTokens: number;
  outputTokens: number;
  requests: number;
}

// ---------------------------------------------------------------------------
// MinimaxConnector
// ---------------------------------------------------------------------------

export class MinimaxConnector implements Connector {
  readonly providerName = 'minimax';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  /** Accumulated usage records keyed by "date|model". */
  private store = new Map<string, StoreEntry>();

  constructor(config: MinimaxConnectorConfig) {
    if (!config.apiKey) {
      throw new Error('MiniMax API Key is required');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (
      config.baseUrl ?? 'https://api.minimax.chat'
    ).replace(/\/+$/, '');
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 1000;
  }

  // -----------------------------------------------------------------
  // Per-call usage recording (primary ingestion path)
  // -----------------------------------------------------------------

  /**
   * Record a single API call's token usage.
   * MiniMax returns token counts in every chat completion response:
   *   { usage: { total_tokens, prompt_tokens, completion_tokens } }
   *
   * Extract these from the response and pass them here.
   */
  recordUsage(params: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    date?: string; // YYYY-MM-DD, defaults to today
  }): void {
    const date = params.date ?? this.today();
    const key = `${date}|${params.model}`;
    const existing = this.store.get(key);

    if (existing) {
      existing.inputTokens += params.inputTokens;
      existing.outputTokens += params.outputTokens;
      existing.requests += 1;
    } else {
      this.store.set(key, {
        model: params.model,
        date,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        requests: 1,
      });
    }
  }

  // -----------------------------------------------------------------
  // Optional: record from raw MiniMax chat completion response
  // -----------------------------------------------------------------

  /**
   * Convenience: record usage directly from a MiniMax chat completion
   * response object. The response must contain a `usage` field.
   *
   * Example response shape:
   * {
   *   model: "MiniMax-M2.7",
   *   usage: { total_tokens: 150, prompt_tokens: 50, completion_tokens: 100 }
   * }
   */
  recordFromResponse(
    response: { model: string; usage: { prompt_tokens: number; completion_tokens: number } },
    date?: string,
  ): void {
    this.recordUsage({
      model: response.model,
      inputTokens: response.usage.prompt_tokens,
      outputTokens: response.usage.completion_tokens,
      ...(date !== undefined && { date }),
    });
  }

  // -----------------------------------------------------------------
  // Connector interface: fetchUsage (aggregation from store)
  // -----------------------------------------------------------------

  async fetchUsage(startTime: number, endTime: number): Promise<UsageBucket[]> {
    const startDate = new Date(startTime * 1000).toISOString().slice(0, 10);
    const endDate = new Date(endTime * 1000).toISOString().slice(0, 10);

    const buckets = new Map<string, UsageBucket>();

    for (const entry of this.store.values()) {
      if (entry.date >= startDate && entry.date <= endDate) {
        const bucketStart = new Date(entry.date).getTime() / 1000;
        const bucketEnd = bucketStart + 86400;

        let bucket = buckets.get(entry.date);
        if (!bucket) {
          bucket = { startTime: bucketStart, endTime: bucketEnd, results: [] };
          buckets.set(entry.date, bucket);
        }

        bucket.results.push({
          model: entry.model,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          requests: entry.requests,
          projectId: null,
          inputCachedTokens: 0,
          inputAudioTokens: 0,
          outputAudioTokens: 0,
        });
      }
    }

    return Array.from(buckets.values());
  }

  // -----------------------------------------------------------------
  // Connector interface: fetchCosts (computed from pricing table)
  // -----------------------------------------------------------------

  async fetchCosts(startTime: number, endTime: number): Promise<CostBucket[]> {
    const startDate = new Date(startTime * 1000).toISOString().slice(0, 10);
    const endDate = new Date(endTime * 1000).toISOString().slice(0, 10);

    const buckets = new Map<string, CostBucket>();

    for (const entry of this.store.values()) {
      if (entry.date >= startDate && entry.date <= endDate) {
        const bucketStart = new Date(entry.date).getTime() / 1000;
        const bucketEnd = bucketStart + 86400;

        let bucket = buckets.get(entry.date);
        if (!bucket) {
          bucket = { startTime: bucketStart, endTime: bucketEnd, results: [] };
          buckets.set(entry.date, bucket);
        }

        const inputCost = this.computeCost(entry.model, entry.inputTokens, 'input');
        const outputCost = this.computeCost(entry.model, entry.outputTokens, 'output');

        bucket.results.push({
          lineItem: `${entry.model}, input`,
          amount: inputCost,
          currency: 'USD',
          projectId: null,
          organizationId: '',
        });
        bucket.results.push({
          lineItem: `${entry.model}, output`,
          amount: outputCost,
          currency: 'USD',
          projectId: null,
          organizationId: '',
        });
      }
    }

    return Array.from(buckets.values());
  }

  // -----------------------------------------------------------------
  // Connector interface: normalizeUsageAndCosts
  // -----------------------------------------------------------------

  normalizeUsageAndCosts(
    usage: UsageBucket[],
    costs: CostBucket[],
  ): NormalizedRecord[] {
    const costMap = new Map<string, number>();

    for (const cb of costs) {
      const date = this.formatDate(cb.startTime);
      for (const cr of cb.results) {
        const model = this.parseModelFromLineItem(cr.lineItem);
        const key = `${date}|${model}`;
        costMap.set(key, (costMap.get(key) ?? 0) + cr.amount);
      }
    }

    const records: NormalizedRecord[] = [];

    for (const ub of usage) {
      const date = this.formatDate(ub.startTime);
      for (const ur of ub.results) {
        const key = `${date}|${ur.model}`;
        records.push({
          provider: this.providerName,
          date,
          model: ur.model,
          requests: ur.requests,
          input_tokens: ur.inputTokens,
          output_tokens: ur.outputTokens,
          cost_usd: costMap.get(key) ?? 0,
        });
      }
    }

    return records;
  }

  // -----------------------------------------------------------------
  // Convenience: get NormalizedRecords directly from store
  // -----------------------------------------------------------------

  getNormalizedRecords(startTime: number, endTime: number): NormalizedRecord[] {
    const startDate = new Date(startTime * 1000).toISOString().slice(0, 10);
    const endDate = new Date(endTime * 1000).toISOString().slice(0, 10);

    const syncUsage: UsageBucket[] = [];
    const costBuckets: CostBucket[] = [];

    for (const entry of this.store.values()) {
      if (entry.date >= startDate && entry.date <= endDate) {
        const bucketStart = new Date(entry.date).getTime() / 1000;
        const bucketEnd = bucketStart + 86400;

        let usageBucket: UsageBucket | undefined;
        for (const b of syncUsage) {
          if (b.startTime === bucketStart) { usageBucket = b; break; }
        }
        if (!usageBucket) {
          usageBucket = { startTime: bucketStart, endTime: bucketEnd, results: [] };
          syncUsage.push(usageBucket);
        }

        usageBucket.results.push({
          model: entry.model,
          inputTokens: entry.inputTokens,
          outputTokens: entry.outputTokens,
          requests: entry.requests,
          projectId: null,
          inputCachedTokens: 0,
          inputAudioTokens: 0,
          outputAudioTokens: 0,
        });

        const inputCost = this.computeCost(entry.model, entry.inputTokens, 'input');
        const outputCost = this.computeCost(entry.model, entry.outputTokens, 'output');

        let costBucket: CostBucket | undefined;
        for (const b of costBuckets) {
          if (b.startTime === bucketStart) { costBucket = b; break; }
        }
        if (!costBucket) {
          costBucket = { startTime: bucketStart, endTime: bucketEnd, results: [] };
          costBuckets.push(costBucket);
        }

        costBucket.results.push({
          lineItem: `${entry.model}, input`,
          amount: inputCost,
          currency: 'USD',
          projectId: null,
          organizationId: '',
        });
        costBucket.results.push({
          lineItem: `${entry.model}, output`,
          amount: outputCost,
          currency: 'USD',
          projectId: null,
          organizationId: '',
        });
      }
    }

    return this.normalizeUsageAndCosts(syncUsage, costBuckets);
  }

  // -----------------------------------------------------------------
  // Store persistence helpers
  // -----------------------------------------------------------------

  /** Serialize store to JSON for persistence (e.g. SQLite). */
  exportStore(): string {
    return JSON.stringify(Array.from(this.store.entries()));
  }

  /** Restore store from previously serialized JSON. */
  importStore(json: string): void {
    const entries: Array<[string, StoreEntry]> = JSON.parse(json);
    this.store = new Map(entries);
  }

  /** Get the raw store size (number of unique date|model entries). */
  get storeSize(): number {
    return this.store.size;
  }

  // -----------------------------------------------------------------
  // Private: cost computation
  // -----------------------------------------------------------------

  /** Compute cost in USD for a given token count. */
  private computeCost(
    model: string,
    tokens: number,
    direction: 'input' | 'output',
  ): number {
    const pricing = MINIMAX_PRICING[model];
    if (!pricing) {
      // Unknown model — use MiniMax-M2.5 as fallback
      const fallback = MINIMAX_PRICING['MiniMax-M2.5'];
      if (!fallback) {
        return 0;
      }
      const rate = direction === 'input'
        ? fallback.inputPerMillion
        : fallback.outputPerMillion;
      return (tokens / 1_000_000) * rate;
    }
    const rate = direction === 'input'
      ? pricing.inputPerMillion
      : pricing.outputPerMillion;
    return (tokens / 1_000_000) * rate;
  }

  // -----------------------------------------------------------------
  // Private: HTTP with retry (for future API expansion)
  // -----------------------------------------------------------------

  private async requestWithRetry<T>(
    method: string,
    url: string,
  ): Promise<T> {
    const result = await withRetry<T>(
      async () => {
        const res = await fetch(url, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
        });

        if (res.ok) {
          return (await res.json()) as T;
        }

        const retryAfterMs = res.status === 429
          ? Number(res.headers.get('Retry-After') ?? 'null')
          : null;
        const body = await res.text();
        throw classifyError(this.providerName, res.status, body, retryAfterMs);
      },
      { maxRetries: this.maxRetries, baseDelayMs: this.retryBaseDelayMs },
      this.providerName,
    );

    if (!result.ok) {
      throw result.error;
    }
    return result.value;
  }

  // -----------------------------------------------------------------
  // Private: utilities
  // -----------------------------------------------------------------

  private parseModelFromLineItem(lineItem: string): string {
    const idx = lineItem.lastIndexOf(',');
    return idx > 0 ? lineItem.slice(0, idx).trim() : lineItem.trim();
  }

  private formatDate(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
  }

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerConnector('minimax', MinimaxConnector as unknown as new (config: import('./types.js').AnyConnectorConfig) => import('./types.js').Connector);
