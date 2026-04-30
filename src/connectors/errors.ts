// ============================================================================
// src/connectors/errors.ts
// Error classification for the connector framework
// ============================================================================

/**
 * Base class for all connector errors.
 * Subclasses carry semantic meaning that drives retry decisions.
 */
export class ConnectorError extends Error {
  readonly provider: string;
  readonly statusCode: number | null;
  readonly isRetryable: boolean;

  constructor(
    message: string,
    provider: string,
    statusCode: number | null = null,
    isRetryable = false,
  ) {
    super(message);
    this.name = 'ConnectorError';
    this.provider = provider;
    this.statusCode = statusCode;
    this.isRetryable = isRetryable;
  }
}

// ---------------------------------------------------------------------------
// Retryable errors
// ---------------------------------------------------------------------------

/** 429 Too Many Requests — rate limit hit. */
export class RateLimitError extends ConnectorError {
  readonly retryAfterMs: number | null;

  constructor(provider: string, retryAfterMs: number | null = null) {
    const msg = retryAfterMs
      ? `${provider} rate limited, retry after ${retryAfterMs}ms`
      : `${provider} rate limited (429)`;
    super(msg, provider, 429, true);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

/** 500/502/503/504 — transient server errors. */
export class ServerError extends ConnectorError {
  constructor(provider: string, statusCode: number) {
    super(`${provider} server error (${statusCode})`, provider, statusCode, true);
    this.name = 'ServerError';
  }
}

/** Network-level failure (DNS, connection reset, timeout). */
export class NetworkError extends ConnectorError {
  constructor(provider: string, message: string) {
    super(`${provider} network failure: ${message}`, provider, null, true);
    this.name = 'NetworkError';
  }
}

/** Timeout waiting for response. */
export class TimeoutError extends ConnectorError {
  constructor(provider: string, timeoutMs: number) {
    super(`${provider} request timed out after ${timeoutMs}ms`, provider, null, true);
    this.name = 'TimeoutError';
  }
}

// ---------------------------------------------------------------------------
// Non-retryable errors
// ---------------------------------------------------------------------------

/** 401 Unauthorized — bad or expired credentials. */
export class AuthError extends ConnectorError {
  constructor(provider: string, message?: string) {
    const msg = message ?? `${provider} authentication failed (401). Verify the API key is valid and has required permissions.`;
    super(msg, provider, 401, false);
    this.name = 'AuthError';
  }
}

/** 403 Forbidden — valid credentials but insufficient permissions. */
export class PermissionError extends ConnectorError {
  constructor(provider: string, message?: string) {
    const msg = message ?? `${provider} permission denied (403). Check API key scopes.`;
    super(msg, provider, 403, false);
    this.name = 'PermissionError';
  }
}

/** 400 Bad Request — malformed request or invalid parameters. */
export class ValidationError extends ConnectorError {
  constructor(provider: string, message: string) {
    super(`${provider} bad request: ${message}`, provider, 400, false);
    this.name = 'ValidationError';
  }
}

/** 404 Not Found — resource doesn't exist. */
export class NotFoundError extends ConnectorError {
  constructor(provider: string, resource: string) {
    super(`${provider} resource not found: ${resource}`, provider, 404, false);
    this.name = 'NotFoundError';
  }
}

/**
 * Classification helper — given an HTTP status code and provider name,
 * return the appropriate error instance.
 */
export function classifyError(
  provider: string,
  statusCode: number,
  message?: string,
  retryAfterMs?: number | null,
): ConnectorError {
  switch (statusCode) {
    case 401:
      return new AuthError(provider, message);
    case 403:
      return new PermissionError(provider, message);
    case 404:
      return new NotFoundError(provider, message ?? 'resource');
    case 429:
      return new RateLimitError(provider, retryAfterMs ?? null);
    default:
      if (statusCode >= 500) {
        return new ServerError(provider, statusCode);
      }
      if (statusCode >= 400) {
        return new ValidationError(provider, message ?? `HTTP ${statusCode}`);
      }
      return new ConnectorError(
        message ?? `${provider} unexpected error (${statusCode})`,
        provider,
        statusCode,
        false,
      );
  }
}
