import { afterEach, describe, expect, it } from 'vitest';

import { loadSmokeEnv } from './load-env.js';

const KEYS = [
  'SMOKE_ENV_BASE',
  'SMOKE_ENV_DUP',
  'SMOKE_ENV_ESCAPED',
  'SMOKE_ENV_EXISTING',
  'SMOKE_ENV_EXPANDED',
  'SMOKE_ENV_EXPORT',
  'SMOKE_ENV_HASH',
  'SMOKE_ENV_MULTI',
  'SMOKE_ENV_REGION',
  'SMOKE_ENV_TICK',
] as const;

const ORIGINAL_VALUES = Object.fromEntries(
  KEYS.map((key) => [key, process.env[key]]),
);
const ORIGINAL_NEXT_PROCESSED_ENV = process.env.__NEXT_PROCESSED_ENV;

describe('loadSmokeEnv', () => {
  afterEach(() => {
    for (const key of KEYS) {
      const original = ORIGINAL_VALUES[key];
      if (original === undefined) delete process.env[key];
      else process.env[key] = original;
    }
    if (ORIGINAL_NEXT_PROCESSED_ENV === undefined) {
      delete process.env.__NEXT_PROCESSED_ENV;
    } else {
      process.env.__NEXT_PROCESSED_ENV = ORIGINAL_NEXT_PROCESSED_ENV;
    }
  });

  it('uses Next semantics for comments, quotes, expansion, multiline, and duplicates', () => {
    for (const key of KEYS) delete process.env[key];
    process.env.SMOKE_ENV_EXISTING = 'shell-value';
    const contents = [
      'SMOKE_ENV_REGION="bigmodel" # selected region',
      'export SMOKE_ENV_EXPORT=exported',
      'SMOKE_ENV_HASH=value#comment',
      'SMOKE_ENV_MULTI="line1',
      'line2"',
      'SMOKE_ENV_TICK=`literal value`',
      'SMOKE_ENV_BASE=https://example.test',
      'SMOKE_ENV_EXPANDED=${SMOKE_ENV_BASE}/v1',
      'SMOKE_ENV_ESCAPED=\\$literal',
      'SMOKE_ENV_DUP=first',
      'SMOKE_ENV_DUP=second',
      'SMOKE_ENV_EXISTING=file-value',
    ].join('\n');

    const parsed = loadSmokeEnv(contents, process.cwd(), '.env.test');

    expect(parsed).toMatchObject({
      SMOKE_ENV_REGION: 'bigmodel',
      SMOKE_ENV_EXPORT: 'exported',
      SMOKE_ENV_HASH: 'value',
      SMOKE_ENV_MULTI: 'line1\nline2',
      SMOKE_ENV_TICK: 'literal value',
      SMOKE_ENV_BASE: 'https://example.test',
      SMOKE_ENV_EXPANDED: 'https://example.test/v1',
      SMOKE_ENV_ESCAPED: '$literal',
      SMOKE_ENV_DUP: 'second',
    });
    expect(process.env.SMOKE_ENV_REGION).toBe('bigmodel');
    expect(process.env.SMOKE_ENV_EXPANDED).toBe('https://example.test/v1');
    expect(process.env.SMOKE_ENV_EXISTING).toBe('shell-value');
  });
});
