import { mkdtemp, mkdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CodexSessionQuotaSource } from '../../src/quota/codex-session.js';

const FIXED_NOW = new Date('2026-07-30T12:00:00Z');

/** A rollout line carrying rate_limits — mirrors real Codex output. */
function tokenCountLine(
  timestamp: string,
  usedPrimary: number,
  usedSecondary: number,
  resetsPrimary = 1783077771,
  resetsSecondary = 1783391018,
): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        primary: {
          used_percent: usedPrimary,
          window_minutes: 300,
          resets_at: resetsPrimary,
        },
        secondary: {
          used_percent: usedSecondary,
          window_minutes: 10080,
          resets_at: resetsSecondary,
        },
        plan_type: 'plus',
      },
    },
  });
}

/** A token_count line with a credits object (post-5h-lift plan shape). */
function tokenCountWithCreditsLine(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        limit_id: 'codex',
        // When the 5h window is lifted, primary may hold the weekly window.
        primary: { used_percent: 54, window_minutes: 10080, resets_at: 1785922683 },
        secondary: null,
        credits: { has_credits: true, unlimited: false, balance: '2165.7760700000' },
        plan_type: 'plus',
      },
    },
  });
}

/** A non-relevant rollout line (should be skipped). */
function otherLine(timestamp: string): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: { type: 'agent_message', content: 'hello' },
  });
}

async function makeSessionsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'codex-sessions-'));
}

describe('CodexSessionQuotaSource', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeSessionsDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('maps rate_limits windows into labeled buckets', async () => {
    const sessionDir = join(dir, '2026', '07', '30');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'rollout-2026-07-30T10-00-00-abc.jsonl'),
      [
        otherLine('2026-07-30T10:00:01Z'),
        tokenCountLine('2026-07-30T10:05:00Z', 15, 83),
      ].join('\n') + '\n',
    );

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const snapshot = await source.fetchSnapshot();

    expect(snapshot.provider).toBe('codex');
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.buckets).toHaveLength(2);

    const fiveHour = snapshot.buckets[0];
    expect(fiveHour.label).toBe('5-hour');
    expect(fiveHour.usedPercent).toBe(15);
    expect(fiveHour.usedDisplay).toBe('15%');
    expect(fiveHour.resetsAt).toBe(1783077771);
    expect(fiveHour.kind).toBe('windowed');

    const weekly = snapshot.buckets[1];
    expect(weekly.label).toBe('weekly');
    expect(weekly.usedPercent).toBe(83);
    expect(weekly.resetsAt).toBe(1783391018);
  });

  it('returns the newest snapshot when multiple sessions exist', async () => {
    const dirA = join(dir, '2026', '07', '29');
    const dirB = join(dir, '2026', '07', '30');
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });

    await writeFile(
      join(dirA, 'rollout-old.jsonl'),
      tokenCountLine('2026-07-29T09:00:00Z', 50, 50) + '\n',
    );
    await writeFile(
      join(dirB, 'rollout-new.jsonl'),
      tokenCountLine('2026-07-30T11:00:00Z', 20, 70) + '\n',
    );

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const snapshot = await source.fetchSnapshot();

    expect(snapshot.buckets[0].usedPercent).toBe(20); // primary from newest
    expect(snapshot.buckets[1].usedPercent).toBe(70); // secondary from newest
  });

  it('picks the latest token_count event within a single file', async () => {
    const sessionDir = join(dir, '2026', '07', '30');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'rollout-multi.jsonl'),
      [
        tokenCountLine('2026-07-30T08:00:00Z', 10, 40),
        tokenCountLine('2026-07-30T09:00:00Z', 42, 55),
        tokenCountLine('2026-07-30T10:00:00Z', 17, 60),
      ].join('\n') + '\n',
    );

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const snapshot = await source.fetchSnapshot();

    expect(snapshot.buckets[0].usedPercent).toBe(17);
    expect(snapshot.buckets[1].usedPercent).toBe(60);
  });

  it('reports a graceful error when no session files exist', async () => {
    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const snapshot = await source.fetchSnapshot();

    expect(snapshot.buckets).toHaveLength(0);
    expect(snapshot.error?.code).toBe('no_codex_sessions');
  });

  it('reports a graceful error when files lack rate-limit events', async () => {
    const sessionDir = join(dir, '2026', '07', '30');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'rollout-empty.jsonl'),
      otherLine('2026-07-30T08:00:00Z') + '\n',
    );

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const snapshot = await source.fetchSnapshot();

    expect(snapshot.buckets).toHaveLength(0);
    expect(snapshot.error?.code).toBe('no_rate_limit_event');
  });

  it('ignores malformed JSON lines without failing', async () => {
    const sessionDir = join(dir, '2026', '07', '30');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'rollout-mixed.jsonl'),
      [
        'this is not json{',
        tokenCountLine('2026-07-30T10:00:00Z', 33, 88),
        '{ broken again',
      ].join('\n') + '\n',
    );

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const snapshot = await source.fetchSnapshot();

    expect(snapshot.error).toBeUndefined();
    expect(snapshot.buckets[0].usedPercent).toBe(33);
  });

  it('clamps out-of-range percentages into 0-100', async () => {
    const sessionDir = join(dir, '2026', '07', '30');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'rollout-over.jsonl'),
      tokenCountLine('2026-07-30T10:00:00Z', 150, -5) + '\n',
    );

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const snapshot = await source.fetchSnapshot();

    expect(snapshot.buckets[0].usedPercent).toBe(100);
    expect(snapshot.buckets[1].usedPercent).toBe(0);
  });

  it('classifies windows by window_minutes even when primary holds the weekly window (5h lifted)', async () => {
    const sessionDir = join(dir, '2026', '07', '30');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'rollout-credits.jsonl'),
      tokenCountWithCreditsLine('2026-07-30T08:20:39Z') + '\n',
    );

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const snapshot = await source.fetchSnapshot();

    // Weekly window is correctly labeled by window_minutes, not by position.
    const weekly = snapshot.buckets.find((b) => b.label === 'weekly');
    expect(weekly).toBeDefined();
    expect(weekly!.usedPercent).toBe(54);
    expect(weekly!.resetsAt).toBe(1785922683);

    // No 5-hour window present, so none mislabeled.
    expect(snapshot.buckets.some((b) => b.label === '5-hour')).toBe(false);

    // Credits surface as a depleting balance bucket.
    const credit = snapshot.buckets.find((b) => b.label === 'Credit balance');
    expect(credit).toBeDefined();
    expect(credit!.kind).toBe('depleting');
    expect(credit!.usedPercent).toBeNull();
    expect(credit!.usedDisplay).toBe('2,165.78');
  });

  it('omits the credit bucket when the plan is unlimited', async () => {
    const sessionDir = join(dir, '2026', '07', '30');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'rollout-unlimited.jsonl'),
      JSON.stringify({
        timestamp: '2026-07-30T08:20:39Z',
        type: 'event_msg',
        payload: {
          type: 'token_count',
          rate_limits: {
            primary: { used_percent: 0, window_minutes: 10080, resets_at: 1785922683 },
            credits: { has_credits: true, unlimited: true, balance: '9999' },
          },
        },
      }) + '\n',
    );

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const snapshot = await source.fetchSnapshot();

    expect(snapshot.buckets.some((b) => b.label === 'Credit balance')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// fetchUsage — daily token aggregation
// ---------------------------------------------------------------------------

/** A token_count line carrying cumulative usage in `info.total_token_usage`. */
function usageLine(
  timestamp: string,
  total: { input_tokens?: number; output_tokens?: number; reasoning_output_tokens?: number; total_tokens?: number; cached_input_tokens?: number },
): string {
  return JSON.stringify({
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: total, model_context_window: 200000 },
    },
  });
}

describe('CodexSessionQuotaSource.fetchUsage', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await makeSessionsDir();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('computes daily usage from incremental deltas, not raw cumulative totals', async () => {
    // One session with two events: cumulative total grows 1000 → 3500.
    // The day's consumption is the DELTA (2500), not the final total (3500).
    const sessionDir = join(dir, '2026', '07', '30');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'rollout-a.jsonl'),
      [
        usageLine('2026-07-30T10:00:00Z', { input_tokens: 1000, output_tokens: 200, total_tokens: 1200, cached_input_tokens: 100 }),
        usageLine('2026-07-30T11:00:00Z', { input_tokens: 3000, output_tokens: 500, total_tokens: 3500, cached_input_tokens: 150 }),
      ].join('\n') + '\n',
    );

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const records = await source.fetchUsage(7);

    expect(records).toHaveLength(1);
    const day = records[0];
    expect(day.date).toBe('2026-07-30');
    expect(day.requests).toBe(1); // one delta (between the two events)
    // Deltas: input 3000-1000=2000, output 500-200=300, total 3500-1200=2300, cached 150-100=50
    expect(day.input_tokens).toBe(2000);
    expect(day.output_tokens).toBe(300);
    expect(day.total_tokens).toBe(2300);
    expect(day.cached_input_tokens).toBe(50);
  });

  it('does NOT add reasoning_output_tokens into output (already included)', async () => {
    // output_tokens already contains reasoning; the delta must not add it again.
    const sessionDir = join(dir, '2026', '07', '30');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'rollout-reason.jsonl'),
      [
        usageLine('2026-07-30T10:00:00Z', { output_tokens: 100, reasoning_output_tokens: 40, total_tokens: 100 }),
        usageLine('2026-07-30T11:00:00Z', { output_tokens: 300, reasoning_output_tokens: 120, total_tokens: 300 }),
      ].join('\n') + '\n',
    );

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const records = await source.fetchUsage(7);

    // output delta = 300-100 = 200 (NOT 200 + reasoning delta 80)
    expect(records[0].output_tokens).toBe(200);
  });

  it('splits a cross-day session into the correct days via deltas', async () => {
    // A session active across two days: day1 event total=1000, day2 event total=3000.
    // day1 gets nothing (no predecessor before it in the tail), day2 gets delta 2000.
    const sessionDir = join(dir, '2026', '07', '29');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'rollout-cross.jsonl'),
      [
        usageLine('2026-07-29T22:00:00Z', { total_tokens: 1000, input_tokens: 800, output_tokens: 200 }),
        usageLine('2026-07-30T02:00:00Z', { total_tokens: 3000, input_tokens: 2600, output_tokens: 400 }),
      ].join('\n') + '\n',
    );

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const records = await source.fetchUsage(7);

    // Only day2 (the delta target) appears; day1's baseline is not counted.
    const dates = records.map((r) => r.date);
    expect(dates).toContain('2026-07-30');
    expect(dates).not.toContain('2026-07-29');
    const day2 = records.find((r) => r.date === '2026-07-30')!;
    expect(day2.total_tokens).toBe(2000);
  });

  it('skips files whose mtime is older than the window', async () => {
    const recentDir = join(dir, '2026', '07', '30');
    const oldDir = join(dir, '2026', '06', '01');
    await mkdir(recentDir, { recursive: true });
    await mkdir(oldDir, { recursive: true });

    await writeFile(
      join(recentDir, 'rollout-recent.jsonl'),
      [
        usageLine('2026-07-30T09:00:00Z', { total_tokens: 50 }),
        usageLine('2026-07-30T10:00:00Z', { total_tokens: 100, input_tokens: 50 }),
      ].join('\n') + '\n',
    );
    const oldFile = join(oldDir, 'rollout-old.jsonl');
    await writeFile(
      oldFile,
      [
        usageLine('2026-06-01T09:00:00Z', { total_tokens: 500 }),
        usageLine('2026-06-01T10:00:00Z', { total_tokens: 999, input_tokens: 499 }),
      ].join('\n') + '\n',
    );

    const thirtyDaysAgo = new Date('2026-06-30T12:00:00Z');
    await utimes(oldFile, thirtyDaysAgo, thirtyDaysAgo);

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const records = await source.fetchUsage(7);

    expect(records).toHaveLength(1);
    expect(records[0].date).toBe('2026-07-30');
  });

  it('returns records sorted oldest-first', async () => {
    const day1 = join(dir, '2026', '07', '28');
    const day2 = join(dir, '2026', '07', '30');
    await mkdir(day1, { recursive: true });
    await mkdir(day2, { recursive: true });

    // Each file has two events so a delta is produced.
    await writeFile(
      join(day1, 'rollout-b.jsonl'),
      [usageLine('2026-07-28T09:00:00Z', { total_tokens: 0 }), usageLine('2026-07-28T10:00:00Z', { total_tokens: 2, input_tokens: 2 })].join('\n') + '\n',
    );
    await writeFile(
      join(day2, 'rollout-a.jsonl'),
      [usageLine('2026-07-30T09:00:00Z', { total_tokens: 0 }), usageLine('2026-07-30T10:00:00Z', { total_tokens: 1, input_tokens: 1 })].join('\n') + '\n',
    );

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const records = await source.fetchUsage(7);

    expect(records.map((r) => r.date)).toEqual(['2026-07-28', '2026-07-30']);
  });

  it('ignores token_count events that lack usage info', async () => {
    const sessionDir = join(dir, '2026', '07', '30');
    await mkdir(sessionDir, { recursive: true });
    await writeFile(
      join(sessionDir, 'rollout-noinfo.jsonl'),
      // rate_limits only, no info block → not a usage event
      tokenCountLine('2026-07-30T10:00:00Z', 50, 50) + '\n',
    );

    const source = new CodexSessionQuotaSource({ sessionsDir: dir, now: () => FIXED_NOW });
    const records = await source.fetchUsage(7);

    expect(records).toHaveLength(0);
  });

  it('buckets by local timezone, not UTC', async () => {
    // localDateKey uses the system's local timezone via Intl en-CA.
    // An event at 2026-07-30T23:30 UTC: in UTC+N zones it falls on 07-31 local,
    // in UTC-N zones it stays 07-30. Either way it must NOT be a raw UTC slice
    // when the local zone differs from UTC — we assert it equals what the local
    // Date says the Y/M/D is, proving it's local-zoned (not toISOString).
    const { _localDateKeyForTest } = await import('../../src/quota/codex-session.js');
    const ts = Date.parse('2026-07-30T23:30:00Z');
    const expected = new Date(ts).toLocaleString('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit' });
    expect(_localDateKeyForTest(ts)).toBe(expected);
    // And it's a valid YYYY-MM-DD shape.
    expect(_localDateKeyForTest(ts)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
