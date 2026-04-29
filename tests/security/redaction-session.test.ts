import { describe, expect, it } from 'vitest';
import {
  derivePlaywrightStorageStateExpiry,
  isPlaywrightStorageStateExpired,
  isSecretRecordExpired,
  redactSensitive,
  redactString,
} from '../../src/security/index.js';

const bearerSample = `Bearer ${'a'.repeat(16)}`;
const keySample = `sk-${'b'.repeat(26)}`;

describe('redaction utilities', () => {
  it('redacts sensitive keys recursively', () => {
    const redacted = redactSensitive({
      provider: 'openai',
      apiKey: 'opaque-value-alpha',
      nested: {
        sessionCookie: 'opaque-value-cookie',
        safe: 'visible',
      },
    });

    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('opaque-value-alpha');
    expect(serialized).not.toContain('opaque-value-cookie');
    expect(serialized).toContain('visible');
  });

  it('redacts common secret-shaped strings inside messages', () => {
    expect(redactString(`Authorization: ${bearerSample}`)).toBe(
      'Authorization: [REDACTED]',
    );
    expect(redactString(`key=${keySample}`)).toBe(
      'key=[REDACTED]',
    );
  });
});

describe('session expiry helpers', () => {
  it('derives the earliest finite cookie expiry from storage state', () => {
    const expiresAt = derivePlaywrightStorageStateExpiry({
      cookies: [
        {
          name: 'later',
          value: '1',
          domain: 'example.test',
          path: '/',
          expires: 1_777_600_000,
        },
        {
          name: 'earlier',
          value: '2',
          domain: 'example.test',
          path: '/',
          expires: 1_777_500_000,
        },
      ],
      origins: [],
    });

    expect(expiresAt).toBe('2026-04-29T22:00:00.000Z');
  });

  it('detects expired Playwright storage states', () => {
    expect(
      isPlaywrightStorageStateExpired(
        {
          cookies: [
            {
              name: 'sid',
              value: '1',
              domain: 'example.test',
              path: '/',
              expires: 1_777_400_000,
            },
          ],
          origins: [],
        },
        new Date('2026-05-01T00:00:00.000Z'),
      ),
    ).toBe(true);

    expect(
      isPlaywrightStorageStateExpired(
        {
          cookies: [
            {
              name: 'sid',
              value: '1',
              domain: 'example.test',
              path: '/',
              expires: -1,
            },
          ],
          origins: [],
        },
        new Date('2026-05-01T00:00:00.000Z'),
      ),
    ).toBe(false);
  });

  it('detects stored record expiry', () => {
    expect(
      isSecretRecordExpired(
        {
          status: 'active',
          expiresAt: '2026-04-27T00:00:00.000Z',
        },
        new Date('2026-04-28T00:00:00.000Z'),
      ),
    ).toBe(true);
    expect(
      isSecretRecordExpired(
        {
          status: 'active',
        },
        new Date('2026-04-28T00:00:00.000Z'),
      ),
    ).toBe(false);
  });
});
