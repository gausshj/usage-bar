import type { PlaywrightStorageState, SecretRecord } from './types.js';

export function isSecretRecordExpired(
  record: Pick<SecretRecord, 'expiresAt' | 'status'>,
  now = new Date(),
): boolean {
  if (record.status === 'expired') {
    return true;
  }
  if (!record.expiresAt) {
    return false;
  }
  return Date.parse(record.expiresAt) <= now.getTime();
}

export function isSecretRecordUsable(
  record: Pick<SecretRecord, 'expiresAt' | 'status'>,
  now = new Date(),
): boolean {
  return record.status === 'active' && !isSecretRecordExpired(record, now);
}

export function derivePlaywrightStorageStateExpiry(
  state: PlaywrightStorageState,
): string | undefined {
  const finiteExpiries = state.cookies
    .map((cookie) => cookie.expires)
    .filter((expires) => Number.isFinite(expires) && expires > 0);

  if (finiteExpiries.length === 0) {
    return undefined;
  }

  const earliestExpirySeconds = Math.min(...finiteExpiries);
  return new Date(earliestExpirySeconds * 1000).toISOString();
}

export function isPlaywrightStorageStateExpired(
  state: PlaywrightStorageState,
  now = new Date(),
): boolean {
  const hasLocalStorage = state.origins.some(
    (origin) => origin.localStorage.length > 0,
  );
  const hasSessionCookie = state.cookies.some((cookie) => cookie.expires < 0);
  const hasUnexpiredCookie = state.cookies.some(
    (cookie) =>
      Number.isFinite(cookie.expires) &&
      cookie.expires > 0 &&
      cookie.expires * 1000 > now.getTime(),
  );

  return !hasLocalStorage && !hasSessionCookie && !hasUnexpiredCookie;
}
