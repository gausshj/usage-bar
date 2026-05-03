// ============================================================================
// src/connectors/openai-connector.ts
// OpenAI Usage & Cost Connector Adapter
// Calls official OpenAI Organization Usage and Costs APIs with Admin Key auth
// ============================================================================

import type {
  NormalizedRecord,
  Connector,
  UsageBucket,
  CostBucket,
  OpenAIConnectorConfig,
} from './types.js';

import { classifyError } from './errors.js';
import { withRetry } from './retry.js';
import { registerConnector } from './registry.js';

// ---------------------------------------------------------------------------
// Internal raw API response shapes (OpenAI-specific, not exported)
// ---------------------------------------------------------------------------

interface RawUsageResult {
  object: string;
  input_tokens: number;
  output_tokens: number;
  num_model_requests: number;
  model: string;
  project_id: string | null;
  user_id: string | null;
  api_key_id: string | null;
  batch: boolean | null;
  input_cached_tokens: number;
  input_audio_tokens: number;
  output_audio_tokens: number;
}

interface RawUsageBucket {
  object: 'bucket';
  start_time: number;
  end_time: number;
  results: RawUsageResult[];
}

interface RawUsageResponse {
  data: RawUsageBucket[];
  next_page: string | null;
}

interface RawCostResult {
  object: string;
  amount: { value: number; currency: string };
  line_item: string;
  project_id: string | null;
  organization_id: string;
}

interface RawCostBucket {
  object: 'bucket';
  start_time: number;
  end_time: number;
  results: RawCostResult[];
}

interface RawCostResponse {
  data: RawCostBucket[];
  next_page: string | null;
}

// ---------------------------------------------------------------------------
// OpenAIConnector
// ---------------------------------------------------------------------------

export class OpenAIConnector implements Connector {
  readonly providerName = 'openai';

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;

  constructor(config: OpenAIConnectorConfig) {
    if (!config.adminApiKey) {
      throw new Error(
        'OpenAI Admin API Key is required (organization admin key, not project key)',
      );
    }
    this.apiKey = config.adminApiKey;
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com').replace(
      /\/+$/,
      '',
    );
    this.maxRetries = config.maxRetries ?? 3;
    this.retryBaseDelayMs = config.retryBaseDelayMs ?? 1000;
  }

  // -----------------------------------------------------------------
  // fetchUsage — paginated /v1/organization/usage/completions
  // -----------------------------------------------------------------

  async fetchUsage(
    startTime: number,
    endTime: number,
  ): Promise<UsageBucket[]> {
    const buckets: UsageBucket[] = [];
    let nextPage: string | null = null;
    let firstPage = true;

    while (firstPage || nextPage) {
      const params = new URLSearchParams({
        start_time: String(startTime),
        end_time: String(endTime),
        bucket_width: '1d',
        limit: '100',
      });
      if (nextPage) params.set('next_page', nextPage);

      const url =
        `${this.baseUrl}/v1/organization/usage/completions?${params}`;
      const body =
        await this.requestWithRetry<RawUsageResponse>('GET', url);

      for (const raw of body.data ?? []) {
        buckets.push({
          startTime: raw.start_time,
          endTime: raw.end_time,
          results: raw.results.map((r) => ({
            model: r.model,
            inputTokens: r.input_tokens,
            outputTokens: r.output_tokens,
            requests: r.num_model_requests,
            projectId: r.project_id,
            inputCachedTokens: r.input_cached_tokens,
            inputAudioTokens: r.input_audio_tokens,
            outputAudioTokens: r.output_audio_tokens,
          })),
        });
      }

      nextPage = body.next_page;
      firstPage = false;
    }

    return buckets;
  }

  // -----------------------------------------------------------------
  // fetchCosts — paginated /v1/organization/costs
  // -----------------------------------------------------------------

  async fetchCosts(
    startTime: number,
    _endTime: number,
  ): Promise<CostBucket[]> {
    const buckets: CostBucket[] = [];
    let nextPage: string | null = null;
    let firstPage = true;

    while (firstPage || nextPage) {
      const params = new URLSearchParams({
        start_time: String(startTime),
        bucket_width: '1d',
        limit: '100',
      });
      if (nextPage) params.set('next_page', nextPage);

      const url = `${this.baseUrl}/v1/organization/costs?${params}`;
      const body =
        await this.requestWithRetry<RawCostResponse>('GET', url);

      for (const raw of body.data ?? []) {
        buckets.push({
          startTime: raw.start_time,
          endTime: raw.end_time,
          results: raw.results.map((r) => ({
            lineItem: r.line_item,
            amount: r.amount.value,
            currency: r.amount.currency,
            projectId: r.project_id,
            organizationId: r.organization_id,
          })),
        });
      }

      nextPage = body.next_page;
      firstPage = false;
    }

    return buckets;
  }

  // -----------------------------------------------------------------
  // normalizeUsageAndCosts — merge usage + cost into flat records
  // -----------------------------------------------------------------

  normalizeUsageAndCosts(
    usage: UsageBucket[],
    costs: CostBucket[],
  ): NormalizedRecord[] {
    // Build cost lookup keyed by "date|model"
    // Cost line_items look like "gpt-4o-2024-08-06, input" — we sum
    // both input and output lines for the same model into one entry.
    const costMap = new Map<string, number>();

    for (const cb of costs) {
      const date = this.formatDate(cb.startTime);
      for (const cr of cb.results) {
        const model = this.parseModelFromLineItem(cr.lineItem);
        const key = `${date}|${model}`;
        costMap.set(key, (costMap.get(key) ?? 0) + cr.amount);
      }
    }

    // Produce one NormalizedRecord per usage result row, enriching
    // with the matched cost.
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
  // Private: HTTP with retry + exponential back-off
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

  /** Parse model name from cost line_item like "gpt-4o-2024-08-06, input". */
  private parseModelFromLineItem(lineItem: string): string {
    const idx = lineItem.lastIndexOf(',');
    return idx > 0 ? lineItem.slice(0, idx).trim() : lineItem.trim();
  }

  /** Format Unix timestamp (seconds) to YYYY-MM-DD. */
  private formatDate(unixSeconds: number): string {
    return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
  }
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerConnector('openai', OpenAIConnector as unknown as new (config: import('./types.js').AnyConnectorConfig) => import('./types.js').Connector);
