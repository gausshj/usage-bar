// ============================================================================
// src/quota/codex-session.ts
// Codex plan-quota source — reads rate limits from local Codex session files.
//
// Codex CLI writes one JSONL "rollout" per session under ~/.codex/sessions.
// Whenever it receives a token-count event from the backend, it records the
// accompanying `rate_limits` payload — which contains the live 5-hour (primary)
// and weekly (secondary) usage windows as percentages with reset timestamps.
//
// No API key needed: the data is already on disk, we just surface it.
// ============================================================================

import { readdir, stat, open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// NOTE: codex-session.ts predates the PRD contract (src/quota/contract.ts) and
// emits a legacy snapshot shape. The new CodexProvider (providers/codex.ts) maps
// this legacy shape into the contract when used as a rollout fallback. These
// types are kept local so the file has no external dependency on the deleted
// types.ts; they are intentionally NOT the contract types.

export interface CodexQuotaConfig {
  sessionsDir?: string;
  now?: () => Date;
}

export interface QuotaBucket {
  label: string;
  usedPercent: number | null;
  usedDisplay?: string;
  totalDisplay?: string;
  resetsAt?: number;
  kind: 'windowed' | 'depleting';
}

export interface QuotaSnapshot {
  provider: 'codex';
  displayName: string;
  fetchedAt: number;
  buckets: QuotaBucket[];
  error?: { message: string; code?: string };
}

export interface QuotaSource {
  readonly provider: 'codex';
  readonly displayName: string;
  fetchSnapshot(): Promise<QuotaSnapshot>;
}

/** Window length (minutes) → human label. Unknown widths fall through as-is. */
const WINDOW_LABELS: Record<number, string> = {
  300: '5-hour', // 5h
  10080: 'weekly', // 7d
};

// ---------------------------------------------------------------------------
// Raw rollout event shapes (Codex-specific, not exported)
// ---------------------------------------------------------------------------

interface RateLimitWindow {
  used_percent: number;
  window_minutes: number;
  resets_at: number; // Unix seconds
}

interface RateLimitCredits {
  has_credits?: boolean;
  /** When true, usage is unmetered (no meaningful percentage/balance). */
  unlimited?: boolean;
  /** Numeric balance string, e.g. "2165.7760700000". */
  balance?: string | number;
}

interface RateLimits {
  limit_id?: string;
  // NOTE: primary/secondary are positional, not semantic — which window a slot
  // holds depends on the plan/tier. We classify by window_minutes instead.
  primary?: RateLimitWindow | null;
  secondary?: RateLimitWindow | null;
  credits?: RateLimitCredits | null;
  plan_type?: string | null;
}

interface TokenCountPayload {
  type: 'token_count';
  rate_limits?: RateLimits | null;
  info?: TokenCountInfo | null;
}

/** Per-call + cumulative token counts attached to a token_count event. */
interface TokenCountInfo {
  total_token_usage?: TokenUsage;
  last_token_usage?: TokenUsage;
  model_context_window?: number;
}

interface TokenUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  cache_write_input_tokens?: number;
  output_tokens?: number;
  reasoning_output_tokens?: number;
  total_tokens?: number;
}

interface RolloutEvent {
  timestamp?: string;
  type?: string;
  payload?: {
    type?: string;
    rate_limits?: RateLimits | null;
    info?: TokenCountInfo | null;
  } & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Token-usage aggregation result (daily breakdown)
// ---------------------------------------------------------------------------

/**
 * One day's aggregated Codex token usage. `requests` counts the token_count
 * events observed for that day (≈ API turns). `*_tokens` are the cumulative
 * totals read from the final token_count event of each session on that day,
 * summed across sessions — i.e. real tokens consumed, not mid-stream deltas.
 */
export interface CodexUsageRecord {
  date: string; // YYYY-MM-DD
  provider: 'codex';
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens: number;
}

// ---------------------------------------------------------------------------

const DEFAULT_SESSIONS_DIR = join(homedir(), '.codex', 'sessions');

/** How many lines from the tail of each rollout file to scan. */
const TAIL_LINES = 400;

export class CodexSessionQuotaSource implements QuotaSource {
  readonly provider = 'codex' as const;
  readonly displayName = 'Codex';

  private readonly sessionsDir: string;
  private readonly now: () => Date;

  constructor(config: CodexQuotaConfig = {}) {
    this.sessionsDir = config.sessionsDir ?? DEFAULT_SESSIONS_DIR;
    this.now = config.now ?? (() => new Date());
  }

  async fetchSnapshot(): Promise<QuotaSnapshot> {
    const fetchedAt = this.now().getTime();

    try {
      const files = await collectRolloutFilesWithMtime(this.sessionsDir);
      if (files.length === 0) {
        return this.empty(fetchedAt, 'no_codex_sessions', 'No Codex session files found');
      }

      // Scan files newest-mtime-first and keep the event with the largest
      // timestamp. In practice the most-recently-modified session holds the
      // newest rate_limits, so this usually resolves after one or two files.
      // We cap how many we open to bound worst-case work.
      const byNewest = files.slice().sort((a, b) => b[1] - a[1]);
      const SCAN_LIMIT = 40;

      let best: { timestampMs: number; limits: RateLimits } | null = null;

      for (let i = 0; i < Math.min(byNewest.length, SCAN_LIMIT); i++) {
        const hit = await readLatestRateLimits(byNewest[i][0]);
        if (hit && (!best || hit.timestampMs > best.timestampMs)) {
          best = hit;
        }
      }

      if (!best) {
        return this.empty(fetchedAt, 'no_rate_limit_event', 'No rate-limit events in Codex sessions');
      }

      const buckets = toBuckets(best.limits);
      if (buckets.length === 0) {
        return this.empty(fetchedAt, 'empty_rate_limit_windows', 'Codex rate-limit windows are empty');
      }

      return {
        provider: 'codex',
        displayName: this.displayName,
        fetchedAt,
        buckets,
      };
    } catch (error) {
      return this.empty(
        fetchedAt,
        'read_failed',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Aggregate daily token usage across recent Codex sessions.
   *
   * Computes consumption as the DELTA between consecutive token_count events'
   * cumulative totals (not the raw cumulative value), so a session spanning
   * multiple days attributes each day's increment to that day rather than
   * dumping everything onto the last day (PRD §7.1 / §14.2). Buckets use the
   * user's LOCAL timezone, not UTC. output_tokens already includes reasoning
   * tokens, so reasoning is NOT added again.
   *
   * Only the last `days` days are scanned (file mtime pre-filter + tail read).
   * Returns records sorted oldest-first.
   */
  async fetchUsage(days = 7): Promise<CodexUsageRecord[]> {
    const cutoffMs = this.now().getTime() - days * 86_400_000;

    const candidates = await collectRolloutFilesWithMtime(this.sessionsDir);
    const recent = candidates.filter(([, mtimeMs]) => mtimeMs >= cutoffMs);

    // local-date(YYYY-MM-DD) → accumulator
    const byDay = new Map<
      string,
      { requests: number; input: number; output: number; total: number; cached: number }
    >();

    for (const [file] of recent) {
      const series = await readTokenCountSeries(file);
      if (series.length === 0) continue;

      // Walk consecutive pairs; each delta belongs to the LATER event's day.
      // The first event in the (tail-limited) series has no predecessor here,
      // so its own total is treated as the baseline and skipped — we only count
      // increments, which keeps totals honest even when the tail doesn't start
      // at the session's very first event.
      for (let i = 1; i < series.length; i++) {
        const prev = series[i - 1];
        const curr = series[i];
        if (curr.timestampMs < cutoffMs) continue;

        const pu = prev.info.total_token_usage ?? {};
        const cu = curr.info.total_token_usage ?? {};
        const dInput = Math.max(0, (cu.input_tokens ?? 0) - (pu.input_tokens ?? 0));
        // output_tokens already includes reasoning_output_tokens — do NOT add it again.
        const dOutput = Math.max(0, (cu.output_tokens ?? 0) - (pu.output_tokens ?? 0));
        const dTotal = Math.max(0, (cu.total_tokens ?? 0) - (pu.total_tokens ?? 0));
        const dCached = Math.max(0, (cu.cached_input_tokens ?? 0) - (pu.cached_input_tokens ?? 0));
        if (dTotal === 0 && dInput === 0 && dOutput === 0) continue;

        const day = localDateKey(curr.timestampMs);
        const acc = byDay.get(day) ?? { requests: 0, input: 0, output: 0, total: 0, cached: 0 };
        acc.requests += 1;
        acc.input += dInput;
        acc.output += dOutput;
        acc.total += dTotal;
        acc.cached += dCached;
        byDay.set(day, acc);
      }
    }

    return Array.from(byDay.entries())
      .map(([date, a]) => ({
        date,
        provider: 'codex' as const,
        requests: a.requests,
        input_tokens: a.input,
        output_tokens: a.output,
        total_tokens: a.total,
        cached_input_tokens: a.cached,
      }))
      .sort((a, b) => (a.date < b.date ? -1 : 1));
  }

  private empty(fetchedAt: number, code: string, message: string): QuotaSnapshot {
    return {
      provider: 'codex',
      displayName: this.displayName,
      fetchedAt,
      buckets: [],
      error: { code, message },
    };
  }
}

// ---------------------------------------------------------------------------
// File collection
// ---------------------------------------------------------------------------

/** Recursively gather all rollout-*.jsonl files under root, with mtime. */
async function collectRolloutFilesWithMtime(
  root: string,
): Promise<Array<[string, number]>> {
  const results: Array<[string, number]> = [];

  async function walk(dir: string): Promise<void> {
    let entries: import('node:fs').Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
        try {
          const s = await stat(full);
          results.push([full, s.mtimeMs]);
        } catch {
          // stat failed (file vanished mid-scan) — skip
        }
      }
    }
  }

  await walk(root);
  return results;
}

// ---------------------------------------------------------------------------
// JSONL parsing — scan the tail for the last token_count event
// ---------------------------------------------------------------------------

interface RateLimitHit {
  timestampMs: number;
  limits: RateLimits;
}

/**
 * Read the tail of a rollout file and return the most recent token_count
 * event's rate_limits. We only scan the tail because rate-limit events are
 * emitted continuously; the latest state is always near the end.
 */
async function readLatestRateLimits(file: string): Promise<RateLimitHit | null> {
  const text = await readTail(file, TAIL_BYTES);
  if (text === null) return null;

  let best: RateLimitHit | null = null;

  const lines = text.split('\n');
  const start = Math.max(0, lines.length - TAIL_LINES);
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.includes('"token_count"')) continue;

    let event: RolloutEvent;
    try {
      event = JSON.parse(line) as RolloutEvent;
    } catch {
      continue;
    }

    const payload = event.payload as TokenCountPayload | undefined;
    const limits = payload?.rate_limits;
    if (!limits) continue;

    const ts = event.timestamp ? Date.parse(event.timestamp) : NaN;
    const timestampMs = Number.isNaN(ts) ? 0 : ts;
    if (!best || timestampMs >= best.timestampMs) {
      best = { timestampMs, limits };
    }
  }

  return best;
}

interface TokenCountHit {
  timestampMs: number;
  info: TokenCountInfo;
}

/**
 * Read ALL token_count events (within the tail) as a time-ordered series.
 * Used for incremental daily usage: we diff cumulative totals between
 * consecutive events to attribute consumption to the correct local day.
 */
async function readTokenCountSeries(file: string): Promise<TokenCountHit[]> {
  const text = await readTail(file, TAIL_BYTES);
  if (text === null) return [];

  const hits: TokenCountHit[] = [];
  const lines = text.split('\n');
  const start = Math.max(0, lines.length - TAIL_LINES);
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (!line || !line.includes('"token_count"')) continue;

    let event: RolloutEvent;
    try {
      event = JSON.parse(line) as RolloutEvent;
    } catch {
      continue;
    }

    const payload = event.payload as TokenCountPayload | undefined;
    const info = payload?.info;
    if (!info || !info.total_token_usage) continue;

    const ts = event.timestamp ? Date.parse(event.timestamp) : NaN;
    const timestampMs = Number.isNaN(ts) ? 0 : ts;
    hits.push({ timestampMs, info });
  }

  // Earliest-first so deltas compute naturally.
  hits.sort((a, b) => a.timestampMs - b.timestampMs);
  return hits;
}

/**
 * Stream the last `maxBytes` of a file without loading the whole file into
 * memory. Codex rollout files can exceed 100MB, so reading them whole would
 * blow the heap. We open the file, seek to `size - maxBytes`, and read only
 * the trailing chunk. The first (partial) line is discarded.
 *
 * Returns the tail text, or null if the file can't be opened.
 */
const TAIL_BYTES = 512 * 1024;

async function readTail(file: string, maxBytes: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(file, 'r');
  } catch {
    return null;
  }

  try {
    const { size } = await handle.stat();
    if (size === 0) return '';

    const readSize = Math.min(size, maxBytes);
    const start = size - readSize;
    const buffer = Buffer.alloc(readSize);
    await handle.read(buffer, 0, readSize, start);

    let text = buffer.toString('utf8');
    // If we didn't start at byte 0, the first segment up to the first newline
    // is a truncated line — drop it so we only parse complete JSON lines.
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline >= 0) text = text.slice(firstNewline + 1);
    }
    return text;
  } finally {
    await handle.close();
  }
}

// ---------------------------------------------------------------------------
// Mapping rate_limits → buckets
// ---------------------------------------------------------------------------

function toBuckets(limits: RateLimits): QuotaBucket[] {
  const buckets: QuotaBucket[] = [];

  // Windows: classify by window_minutes (primary/secondary are positional and
  // their meaning shifts with plan tier — e.g. when the 5h limit is lifted,
  // `primary` may hold the weekly window).
  for (const window of [limits.primary, limits.secondary]) {
    if (!window || typeof window.window_minutes !== 'number') continue;
    const label = WINDOW_LABELS[window.window_minutes] ?? `${window.window_minutes}m`;
    buckets.push({
      label,
      usedPercent: clampPercent(window.used_percent),
      usedDisplay: `${round1(window.used_percent)}%`,
      resetsAt: window.resets_at,
      kind: 'windowed',
    });
  }

  // Credits: a spend-down balance (e.g. purchased credit). Shown only when
  // present and finite — `unlimited` plans have no meaningful number.
  const credit = toCreditBucket(limits.credits);
  if (credit) buckets.push(credit);

  return buckets;
}

/** Map a credits object to a depleting balance bucket, or null to omit. */
function toCreditBucket(credits: RateLimitCredits | null | undefined): QuotaBucket | null {
  if (!credits || credits.unlimited) return null;

  const balance = credits.balance;
  if (balance === undefined || balance === null) return null;

  const numeric = typeof balance === 'number' ? balance : Number(balance);
  const display = Number.isFinite(numeric)
    ? `${numeric.toLocaleString('en-US', { maximumFractionDigits: 2 })}`
    : String(balance);

  return {
    label: 'Credit balance',
    usedPercent: null, // spend-down, no ceiling
    usedDisplay: display,
    kind: 'depleting',
  };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function round1(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 10) / 10;
}

/**
 * Format a Unix-ms timestamp as a LOCAL-timezone YYYY-MM-DD key (not UTC).
 * `en-CA` locale yields ISO-order dates without an explicit time zone, and
 * without `timeZone` it uses the runtime's local zone — so daily buckets align
 * with the user's calendar day (PRD §7.1).
 */
const LOCAL_DATE_FMT = new Intl.DateTimeFormat('en-CA', {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function localDateKey(timestampMs: number): string {
  return LOCAL_DATE_FMT.format(new Date(timestampMs));
}

/** Exported for testing the local-timezone bucketing behavior. */
export { localDateKey as _localDateKeyForTest };
