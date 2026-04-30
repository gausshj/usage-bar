// ============================================================================
// src/connectors/retry.ts
// Retry logic with exponential back-off and rate-limit awareness
// ============================================================================

import { RateLimitError, NetworkError, TimeoutError, ConnectorError } from './errors.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface RetryConfig {
  /** Max retry attempts for retryable errors (default 3). */
  maxRetries: number;
  /** Base delay in ms for exponential back-off (default 1000). */
  baseDelayMs: number;
  /**
   * Max rate-limit retries that are separate from maxRetries.
   * Rate-limit retries don't consume the retry budget (default 5).
   */
  maxRateLimitRetries: number;
  /** Max total time to spend retrying in ms (default 30_000). */
  maxTotalRetryMs: number;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxRateLimitRetries: 5,
  maxTotalRetryMs: 30_000,
};

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------

/**
 * Result of a connector operation that may be retried.
 * Caller should check result.ok before using result.value.
 */
export type RetryResult<T> =
  | { ok: true; value: T; attempts: number }
  | { ok: false; error: ConnectorError; attempts: number };

// ---------------------------------------------------------------------------
// Core retry function
// ---------------------------------------------------------------------------

/**
 * Execute an operation with retry on retryable errors.
 * Rate-limit errors (429) are handled separately and don't consume maxRetries.
 *
 * @param operation - Async function that performs the API call.
 * @param config - Retry configuration.
 * @param provider - Provider name for error classification.
 */
export async function withRetry<T>(
  operation: () => Promise<T>,
  config: Partial<RetryConfig> = {},
  provider = 'connector',
): Promise<RetryResult<T>> {
  const cfg: RetryConfig = { ...DEFAULT_RETRY_CONFIG, ...config };

  let attempt = 0;
  let rateLimitAttempts = 0;
  const startTime = Date.now();
  let lastError: ConnectorError | null = null;

  while (true) {
    const elapsed = Date.now() - startTime;
    if (elapsed >= cfg.maxTotalRetryMs) {
      return {
        ok: false,
        error: lastError ?? new NetworkError(provider, 'max total retry time exceeded'),
        attempts: attempt,
      };
    }

    attempt++;

    try {
      const value = await operation();
      return { ok: true, value, attempts: attempt };
    } catch (err) {
      lastError = normalizeError(err, provider);

      // Rate-limit errors never consume the retry budget
      if (lastError instanceof RateLimitError) {
        rateLimitAttempts++;
        if (rateLimitAttempts > cfg.maxRateLimitRetries) {
          return { ok: false, error: lastError, attempts: attempt };
        }

        const waitMs = lastError.retryAfterMs ?? cfg.baseDelayMs * Math.pow(2, rateLimitAttempts - 1);
        await sleep(Math.min(waitMs, cfg.maxTotalRetryMs - elapsed));
        continue;
      }

      // Non-retryable errors fail immediately
      if (!lastError.isRetryable) {
        return { ok: false, error: lastError, attempts: attempt };
      }

      // Retryable (server error, network error)
      if (attempt > cfg.maxRetries) {
        return { ok: false, error: lastError, attempts: attempt };
      }

      const delay = cfg.baseDelayMs * Math.pow(2, attempt - 1);
      await sleep(Math.min(delay, cfg.maxTotalRetryMs - elapsed));
    }
  }
}

// ---------------------------------------------------------------------------
// Normalize unknown error to ConnectorError
// ---------------------------------------------------------------------------

function normalizeError(err: unknown, provider: string): ConnectorError {
  if (err instanceof ConnectorError) return err;

  if (err instanceof Error) {
    const msg = err.message.toLowerCase();

    if (msg.includes('timeout') || msg.includes('timed out')) {
      return new TimeoutError(provider, 30_000);
    }

    if (msg.includes('fetch') || msg.includes('network') || msg.includes('econnreset') || msg.includes('enotfound')) {
      return new NetworkError(provider, err.message);
    }

    return new NetworkError(provider, err.message);
  }

  return new NetworkError(provider, String(err));
}

// ---------------------------------------------------------------------------
// Sleep utility
// ---------------------------------------------------------------------------

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}
