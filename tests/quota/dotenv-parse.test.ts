import { describe, expect, it } from 'vitest';

import { parseDotenv } from '../../src/quota/dotenv-parse.js';

describe('parseDotenv', () => {
  it('parses simple KEY=VALUE', () => {
    expect(parseDotenv('FOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('strips trailing whitespace from unquoted values', () => {
    expect(parseDotenv('FOO=bar   ')).toEqual({ FOO: 'bar' });
  });

  it('strips inline comments from unquoted values', () => {
    expect(parseDotenv('REGION=bigmodel   # the default region')).toEqual({
      REGION: 'bigmodel',
    });
  });

  it('preserves # inside double-quoted values', () => {
    expect(parseDotenv('TOKEN="abc # not a comment"')).toEqual({
      TOKEN: 'abc # not a comment',
    });
  });

  it('preserves # inside single-quoted values', () => {
    expect(parseDotenv("TOKEN='x # y'")).toEqual({ TOKEN: 'x # y' });
  });

  it('strips surrounding quotes but keeps inner content', () => {
    expect(parseDotenv('KEY="hello world"')).toEqual({ KEY: 'hello world' });
    expect(parseDotenv("KEY='hello world'")).toEqual({ KEY: 'hello world' });
  });

  it('skips blank lines and full-line comments', () => {
    expect(parseDotenv('# comment\n\nKEY=val\n')).toEqual({ KEY: 'val' });
  });

  it('does not overwrite existing keys (first-wins)', () => {
    expect(parseDotenv('FOO=second', { FOO: 'first' })).toEqual({ FOO: 'first' });
  });

  it('handles the README example without breaking', () => {
    const env = `GLM_CODING_PLAN_TOKEN=my-token
GLM_CODING_PLAN_REGION=bigmodel   # 或 zai（api.z.ai 全球站）`;
    const result = parseDotenv(env);
    expect(result.GLM_CODING_PLAN_TOKEN).toBe('my-token');
    expect(result.GLM_CODING_PLAN_REGION).toBe('bigmodel');
  });
});
