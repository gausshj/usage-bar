// ============================================================================
// src/connectors/zhipu-connector.ts
// 智谱 GLM (Zhipu AI) Usage Connector Adapter
// Uses per-call token aggregation + pricing table (CNY → USD conversion)
// No official billing API; relies on per-request token tracking
// ============================================================================

import type {
  NormalizedRecord,
  Connector,
  UsageBucket,
  CostBucket,
  ZhipuConnectorConfig,
} from './types.js';

import { registerConnector } from './registry.js';

// ---------------------------------------------------------------------------
// Pricing table: CNY per million tokens (Mtokens)
// Source: https://open.bigmodel.cn/ (as of 2026-04)
// ---------------------------------------------------------------------------

interface PricingEntry {
  inputPerMillion: number;   // CNY / Mtokens
  outputPerMillion: number;  // CNY / Mtokens
}

const ZHIPU_PRICING: Record<string, PricingEntry> = {
  'glm-4':               { inputPerMillion: 100,  outputPerMillion: 100 },
  'glm-4-air':           { inputPerMillion: 10,   outputPerMillion: 10 },
  'glm-4-airx':          { inputPerMillion: 50,   outputPerMillion: 50 },
  'glm-4-flash':         { inputPerMillion: 1,    outputPerMillion: 1 },
  'glm-4-long':          { inputPerMillion: 1,    outputPerMillion: 1 },
  'glm-4v':              { inputPerMillion: 50,   outputPerMillion: 50 },
  'glm-4v-plus':         { inputPerMillion: 10,   outputPerMillion: 10 },
  'glm-3-turbo':         { inputPerMillion: 1,    outputPerMillion: 1 },
  'cogview-3-plus':      { inputPerMillion: 10,   outputPerMillion: 10 },
  'cogview-3':           { inputPerMillion: 50,   outputPerMillion: 50 },
};

/** Default CNY→USD conversion rate. */
const DEFAULT_CNY_TO_USD = 0.14;

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
// ZhipuConnector
// ---------------------------------------------------------------------------

export class ZhipuConnector implements Connector {
  readonly providerName = 'zhipu';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly cnyToUsd: number;

  /** Accumulated usage records keyed by "date|model". */
  private store = new Map<string, StoreEntry>();

  constructor(config: ZhipuConnectorConfig) {
    if (!config.apiKey) {
      throw new Error('Zhipu API Key is required');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = (
      config.baseUrl ?? 'https://open.bigmodel.cn/api/paas'
    ).replace(/\/+$/, '');
    this.cnyToUsd = config.cnyToUsdRate ?? DEFAULT_CNY_TO_USD;
  }

  // -----------------------------------------------------------------
  // Per-call usage recording (primary ingestion path)
  // -----------------------------------------------------------------

  /**
   * Record a single API call's token usage.
   * This is the main data ingestion path since Zhipu has no billing API.
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
  // Connector interface: fetchUsage (aggregation from store)
  // -----------------------------------------------------------------

  async fetchUsage(startTime: number, endTime: number): Promise<UsageBucket[]> {
    // For Zhipu, usage is accumulated via recordUsage(), not fetched from
    // a remote API. We return store entries that fall within [startTime, endTime].
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

        const inputCost = this.computeCostCny(
          entry.model, entry.inputTokens, 'input',
        );
        const outputCost = this.computeCostCny(
          entry.model, entry.outputTokens, 'output',
        );

        bucket.results.push({
          lineItem: `${entry.model}, input`,
          amount: inputCost * this.cnyToUsd,
          currency: 'USD',
          projectId: null,
          organizationId: '',
        });
        bucket.results.push({
          lineItem: `${entry.model}, output`,
          amount: outputCost * this.cnyToUsd,
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
    // Costs depend on same store, so compute synchronously
    const costBuckets: CostBucket[] = [];

    const startDate = new Date(startTime * 1000).toISOString().slice(0, 10);
    const endDate = new Date(endTime * 1000).toISOString().slice(0, 10);

    for (const entry of this.store.values()) {
      if (entry.date >= startDate && entry.date <= endDate) {
        const bucketStart = new Date(entry.date).getTime() / 1000;
        const bucketEnd = bucketStart + 86400;

        let bucket: CostBucket | undefined;
        for (const b of costBuckets) {
          if (b.startTime === bucketStart) { bucket = b; break; }
        }
        if (!bucket) {
          bucket = { startTime: bucketStart, endTime: bucketEnd, results: [] };
          costBuckets.push(bucket);
        }

        const inputCost = this.computeCostCny(entry.model, entry.inputTokens, 'input');
        const outputCost = this.computeCostCny(entry.model, entry.outputTokens, 'output');

        bucket.results.push({
          lineItem: `${entry.model}, input`,
          amount: inputCost * this.cnyToUsd,
          currency: 'USD',
          projectId: null,
          organizationId: '',
        });
        bucket.results.push({
          lineItem: `${entry.model}, output`,
          amount: outputCost * this.cnyToUsd,
          currency: 'USD',
          projectId: null,
          organizationId: '',
        });
      }
    }

    // Usage was computed async, but our fetchUsage above returned a Promise
    // — for synchronous convenience, recompute inline:
    const syncUsage: UsageBucket[] = [];
    for (const entry of this.store.values()) {
      if (entry.date >= startDate && entry.date <= endDate) {
        const bucketStart = new Date(entry.date).getTime() / 1000;
        const bucketEnd = bucketStart + 86400;

        let bucket: UsageBucket | undefined;
        for (const b of syncUsage) {
          if (b.startTime === bucketStart) { bucket = b; break; }
        }
        if (!bucket) {
          bucket = { startTime: bucketStart, endTime: bucketEnd, results: [] };
          syncUsage.push(bucket);
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

  /** Compute cost in CNY for a given token count. */
  private computeCostCny(
    model: string,
    tokens: number,
    direction: 'input' | 'output',
  ): number {
    const pricing = ZHIPU_PRICING[model];
    if (!pricing) {
      // Unknown model — use GLM-4-flash as fallback (cheapest known)
      const fallback = ZHIPU_PRICING['glm-4-flash'];
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
  // Private: utilities
  // -----------------------------------------------------------------

  /** Parse model name from cost line_item like "glm-4, input". */
  private parseModelFromLineItem(lineItem: string): string {
    const idx = lineItem.lastIndexOf(',');
    return idx > 0 ? lineItem.slice(0, idx).trim() : lineItem.trim();
  }

  /** Format Unix timestamp (seconds) to YYYY-MM-DD. */
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

registerConnector('zhipu', ZhipuConnector as unknown as new (config: import('./types.js').AnyConnectorConfig) => import('./types.js').Connector);
