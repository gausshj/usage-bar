'use client';

// ============================================================================
// src/app/_components/usage-overview-section.tsx
// "Usage Overview" section — real per-day Codex token usage.
//
// Fetches /api/usage (aggregated from local Codex session files) and renders:
//   - three summary cards (sessions, input tokens, output tokens over 7 days)
//   - a daily token-usage bar chart
//   - a recent-days breakdown table
// All data is real; no mock fallbacks.
// ============================================================================

import { useCallback, useEffect, useState } from 'react';

interface UsageRecord {
  date: string;
  provider: 'codex';
  requests: number;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  cached_input_tokens: number;
}

interface UsageApiResponse {
  records: UsageRecord[];
  summary: { requests: number; input: number; output: number; total: number };
  days: number;
  fetchedAt: number;
  error?: { message: string };
}

export function UsageOverviewSection() {
  const [data, setData] = useState<UsageApiResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/usage', { cache: 'no-store' });
      const json = (await res.json()) as UsageApiResponse;
      setData(json);
    } catch {
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const records = data?.records ?? [];
  const summary = data?.summary ?? { requests: 0, input: 0, output: 0, total: 0 };

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-950">
            Codex Activity <span className="text-sm font-normal text-amber-600">(Beta)</span>
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[11px] font-medium text-amber-700">
              Local Estimate
            </span>{' '}
            Codex token consumption over the last {data?.days ?? 7} days, derived
            from local session files.
          </p>
        </div>
        {data?.fetchedAt && !loading && (
          <span className="text-xs text-slate-500">
            Updated {formatTimeAgo(data.fetchedAt)}
          </span>
        )}
      </div>

      {loading ? (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
          {[1, 2, 3].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-3xl border border-white/50 bg-white/50"
            />
          ))}
        </div>
      ) : data?.error ? (
        <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-700">
          Couldn’t load usage data: {data.error.message}
        </div>
      ) : (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
            <OverviewCard
              title="Sessions (7d)"
              value={formatNumber(summary.requests)}
              subValue="Codex sessions with activity"
            />
            <OverviewCard
              title="Input Tokens (7d)"
              value={formatTokens(summary.input)}
              subValue="Prompt + context throughput"
            />
            <OverviewCard
              title="Output Tokens (7d)"
              value={formatTokens(summary.output)}
              subValue="Generated (incl. reasoning)"
            />
          </div>

          {/* Daily chart */}
          {records.length > 0 && <DailyChart records={records} />}

          {/* Per-day table */}
          {records.length > 0 && (
            <div className="overflow-hidden rounded-3xl border border-white/70 bg-white/75 text-card-foreground shadow-[0_24px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur">
              <div className="border-b border-white/60 px-6 py-4">
                <h3 className="text-base font-semibold tracking-tight">
                  Daily Breakdown
                </h3>
              </div>
              <div className="divide-y divide-border/70">
                {records
                  .slice()
                  .reverse()
                  .map((r) => (
                    <div
                      key={r.date}
                      className="flex items-center justify-between px-6 py-4"
                    >
                      <div>
                        <div className="text-sm font-medium text-foreground">
                          Codex · {r.date}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          {formatNumber(r.requests)} sessions
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-sm font-medium text-foreground">
                          {formatTokens(r.total_tokens)}
                        </div>
                        <div className="mt-1 text-xs text-muted-foreground">
                          in {formatTokens(r.input_tokens)} · out{' '}
                          {formatTokens(r.output_tokens)}
                        </div>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function OverviewCard({
  title,
  value,
  subValue,
}: {
  title: string;
  value: string;
  subValue?: string;
}) {
  return (
    <div className="rounded-3xl border border-white/70 bg-white/75 p-6 text-card-foreground shadow-[0_24px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur">
      <div className="text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
        {title}
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-tight text-foreground">
        {value}
      </div>
      {subValue && (
        <div className="mt-2 text-sm leading-6 text-muted-foreground">
          {subValue}
        </div>
      )}
    </div>
  );
}

function DailyChart({ records }: { records: UsageRecord[] }) {
  // Normalize against the largest day for relative bar heights.
  const max = Math.max(...records.map((r) => r.total_tokens), 1);

  return (
    <div className="rounded-3xl border border-white/70 bg-white/75 p-6 text-card-foreground shadow-[0_24px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur">
      <h3 className="text-base font-semibold tracking-tight">Daily Token Usage</h3>
      <div className="mt-5 flex items-end justify-between gap-2" style={{ height: 160 }}>
        {records.map((r) => {
          const h = Math.max(4, Math.round((r.total_tokens / max) * 140));
          return (
            <div
              key={r.date}
              className="flex flex-1 flex-col items-center gap-2"
              title={`${r.date}: ${formatTokens(r.total_tokens)}`}
            >
              <div
                className="w-full rounded-t bg-gradient-to-t from-slate-400 to-slate-700 transition-all"
                style={{ height: h }}
              />
              <span className="text-[11px] text-slate-400">{r.date.slice(5)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

function formatNumber(n: number): string {
  return new Intl.NumberFormat('en-US').format(n);
}

/** Compact token formatter: 1234 → "1.2K", 2_500_000 → "2.5M". */
function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return formatNumber(n);
}

function formatTimeAgo(ms: number): string {
  const seconds = Math.floor((Date.now() - ms) / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}
