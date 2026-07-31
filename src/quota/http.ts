// ============================================================================
// src/quota/http.ts
// Shared HTTP helper for HTTP-based quota providers (GLM, Kimi).
// Provides timeout, retry (with correct Retry-After parsing), schema
// validation, and response redaction per PRD §10 and §12.3.
// ============================================================================

import { classifyError } from '../connectors/errors.js';

export interface HttpFetchOptions {
  headers?: Record<string, string>;
  /** Per-attempt timeout in ms (default 5000). */
  timeoutMs?: number;
  /** Max retries for retryable errors (default 2). */
  maxRetries?: number;
  /** Base backoff in ms (default 500). */
  baseDelayMs?: number;
}

export interface HttpFetchResult<T> {
  ok: true;
  value: T;
  status: number;
}

/**
 * Fetch a JSON endpoint with timeout, retry, and error classification.
 * Retries only on network errors, 429, and 5xx (PRD §10). 401/403/4xx are not
 * retried. Retry-After is parsed supporting BOTH seconds and HTTP-date.
 */
export async function fetchJson<T>(
  providerLabel: string,
  url: string,
  options: HttpFetchOptions = {},
): Promise<HttpFetchResult<T>> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxRetries = options.maxRetries ?? 2;
  const baseDelayMs = options.baseDelayMs ?? 500;

  let lastError: Error | null = null;
  /** Server-advised delay from a Retry-After header, consumed by the back-off. */
  let pendingRetryAfterMs: number | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await fetch(url, {
          method: 'GET',
          headers: options.headers,
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      if (res.ok) {
        const value = (await res.json()) as T;
        return { ok: true, value, status: res.status };
      }

      const body = await res.text().catch(() => '');
      const retryAfterMs = parseRetryAfter(res);
      const error = classifyError(providerLabel, res.status, redact(body), retryAfterMs);

      // Non-retryable: stop immediately.
      if (!error.isRetryable) {
        throw error;
      }
      // Stash Retry-After so the back-off below honors the server's hint.
      if (retryAfterMs != null) {
        pendingRetryAfterMs = retryAfterMs;
      }
      lastError = error;
    } catch (err) {
      // AbortController timeout or fetch network error.
      if (err instanceof Error && (err.name === 'AbortError' || err.message.includes('timed out'))) {
        lastError = new Error(`${providerLabel} request timed out after ${timeoutMs}ms`);
      } else if (err instanceof Error && !err.message.includes('rate limited') && !classifyAsRetryable(err)) {
        // A thrown classifyError (non-retryable) — re-throw as-is.
        throw err;
      } else {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    // Back off before the next retry. Prefer the server's Retry-After when
    // given (PRD §10); otherwise exponential back-off with jitter.
    if (attempt < maxRetries) {
      const delay =
        pendingRetryAfterMs != null
          ? pendingRetryAfterMs
          : baseDelayMs * 2 ** attempt + Math.random() * baseDelayMs;
      pendingRetryAfterMs = null; // consume, don't persist across attempts
      await sleep(delay);
    }
  }

  throw lastError ?? new Error(`${providerLabel} fetch failed`);
}

/** Parse Retry-After header — supports integer seconds AND HTTP-date. */
function parseRetryAfter(res: Response): number | null {
  const raw = res.headers.get('Retry-After');
  if (!raw) return null;
  const asSeconds = Number(raw);
  if (Number.isFinite(asSeconds)) return asSeconds * 1000; // seconds → ms
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function classifyAsRetryable(err: Error): boolean {
  const msg = err.message.toLowerCase();
  return (
    msg.includes('fetch') ||
    msg.includes('network') ||
    msg.includes('econnreset') ||
    msg.includes('enotfound') ||
    msg.includes('server error')
  );
}

/** Best-effort redaction of response bodies before they enter errors/logs. */
export function redact(text: string): string {
  // Strip anything that looks like a bearer token / api key.
  return text
    .replace(/(sk-[a-zA-Z0-9-_]{8,})[a-zA-Z0-9-_]*/g, '$1***')
    .replace(/(Bearer\s+)[a-zA-Z0-9-_.]+/gi, '$1***')
    .replace(/(["']?(?:token|access_token|api_key|authorization)["']?\s*[:=]\s*["']?)[^"'\s,}]+/gi, '$1***');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

// ---------------------------------------------------------------------------
// Legacy compatibility wrapper (used by the older glm-quota/kimi-quota modules
// until they migrate to the new provider contract). Delegates to fetchJson.
// ---------------------------------------------------------------------------

export interface LegacyHttpOptions {
  method: 'GET';
  headers?: Record<string, string>;
  maxRetries?: number;
  retryBaseDelayMs?: number;
}

export async function httpGetJson<T>(
  provider: string,
  url: string,
  options: LegacyHttpOptions,
): Promise<T> {
  const result = await fetchJson<T>(provider, url, {
    headers: options.headers,
    maxRetries: options.maxRetries,
    baseDelayMs: options.retryBaseDelayMs,
  });
  return result.value;
}
