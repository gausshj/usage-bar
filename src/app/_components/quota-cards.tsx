'use client';

// ============================================================================
// src/app/_components/quota-cards.tsx
// The three fixed provider quota cards (PRD §6).
//
// Renders Codex / GLM Coding Plan / Kimi Code — always all three, in fixed
// order, including unconfigured/failed ones. Each card shows status, source
// level, quota windows (used + remaining), balances, reset times, and
// observed/fetched timestamps. Data comes from GET /api/v1/quota.
// ============================================================================

import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  ProviderId,
  ProviderStatus,
  QuotaBalance,
  QuotaBucket,
  QuotaSnapshot,
  SourceKind,
} from '@/quota/contract';

interface ApiResponse {
  schemaVersion: number;
  generatedAt: string;
  providers: QuotaSnapshot[];
}

const PROVIDER_META: Record<ProviderId, { name: string; product: string }> = {
  codex_chatgpt: { name: 'Codex', product: 'ChatGPT / Codex' },
  glm_coding_plan: { name: '智谱 GLM', product: 'GLM Coding Plan' },
  kimi_code: { name: 'Kimi', product: 'Kimi Code' },
};

const STATUS_META: Record<ProviderStatus, { label: string; chip: string }> = {
  ready: { label: 'Ready', chip: 'bg-emerald-100 text-emerald-800' },
  stale: { label: 'Stale', chip: 'bg-amber-100 text-amber-800' },
  unconfigured: { label: 'Not configured', chip: 'bg-slate-100 text-slate-600' },
  unavailable: { label: 'Unavailable', chip: 'bg-orange-100 text-orange-800' },
  unsupported: { label: 'Unsupported', chip: 'bg-purple-100 text-purple-800' },
  error: { label: 'Error', chip: 'bg-red-100 text-red-800' },
};

const SOURCE_LABEL: Record<SourceKind, string> = {
  official_protocol: 'Official Protocol',
  official_compatibility: 'Official Compatibility',
  local_estimate: 'Local Estimate',
};

export function QuotaCards() {
  const [providers, setProviders] = useState<QuotaSnapshot[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (force = false) => {
    setError(null);
    setRefreshing(true);
    try {
      const url = force ? '/api/v1/quota/refresh' : '/api/v1/quota';
      const res = await fetch(url, { method: force ? 'POST' : 'GET', cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ApiResponse;
      setProviders(data.providers);
      setGeneratedAt(data.generatedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const onRefresh = useCallback(() => {
    // Debounce: ignore clicks within 1s of the last (PRD §9.2).
    if (debounceRef.current) return;
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
    }, 1000);
    void load(true);
  }, [load]);

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-950">Plan Quota</h2>
          <p className="mt-1 text-sm text-slate-600">
            Live quota headroom across your coding subscriptions.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {generatedAt && !refreshing && (
            <span className="text-xs text-slate-500">Generated {timeAgo(generatedAt)}</span>
          )}
          <button
            type="button"
            onClick={onRefresh}
            disabled={refreshing}
            className="rounded-full border border-slate-200/80 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50 disabled:opacity-50"
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">
          Failed to load quota: {error}
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {providers.map((snap) => (
          <ProviderCard key={snap.providerId} snap={snap} />
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Single provider card
// ---------------------------------------------------------------------------

function ProviderCard({ snap }: { snap: QuotaSnapshot }) {
  const meta = PROVIDER_META[snap.providerId] ?? { name: snap.providerId, product: '' };
  const status = STATUS_META[snap.status];
  const isReady = snap.status === 'ready';

  return (
    <div className="flex flex-col rounded-3xl border border-white/70 bg-white/75 p-6 text-card-foreground shadow-[0_24px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur">
      {/* Header: name + status chip */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate text-base font-semibold tracking-tight text-slate-950">
            {meta.name}
          </h3>
          <p className="truncate text-xs text-slate-500">{meta.product}</p>
        </div>
        <span
          className={`shrink-0 inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium ${status.chip}`}
          aria-label={`status: ${status.label}`}
        >
          {status.label}
        </span>
      </div>

      {/* Source level + plan */}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-400">
        <span className="rounded bg-slate-100 px-1.5 py-0.5 font-medium text-slate-500">
          {SOURCE_LABEL[snap.source.kind]}
          {snap.source.isFallback ? ' · fallback' : ''}
        </span>
        {snap.plan.name && <span>· {snap.plan.name}</span>}
        {snap.plan.accountLabel && <span>· {snap.plan.accountLabel}</span>}
      </div>

      {/* Error / unconfigured / unsupported guidance (#17-3) */}
      {snap.error && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
          {snap.error.safeMessage}
          {snap.status === 'unconfigured' && snap.providerId === 'glm_coding_plan' && (
            <span className="mt-1 block text-slate-500">
              Set <code className="rounded bg-slate-100 px-1">GLM_CODING_PLAN_TOKEN</code> in .env.local.
            </span>
          )}
          {snap.status === 'unconfigured' && snap.providerId === 'kimi_code' && (
            <span className="mt-1 block text-slate-500">
              Run <code className="rounded bg-slate-100 px-1">kimi-cli login</code>, or set{' '}
              <code className="rounded bg-slate-100 px-1">KIMI_CODE_ACCESS_TOKEN</code>.
            </span>
          )}
          {snap.status === 'unsupported' && (
            <span className="mt-1 block text-slate-500">
              Update Codex to the latest version to enable this data source.
            </span>
          )}
        </p>
      )}

      {/* Quota windows */}
      {isReady && snap.buckets.length > 0 && (
        <div className="mt-4 space-y-4">
          {snap.buckets.map((b) => (
            <BucketBar key={b.id} bucket={b} />
          ))}
        </div>
      )}

      {/* Balances (grouped separately from periodic quota) */}
      {isReady && snap.balances && snap.balances.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3">
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Balances
          </div>
          {snap.balances.map((bal) => (
            <BalanceRow key={bal.id} balance={bal} />
          ))}
        </div>
      )}

      {/* Kimi: monthly quota is a product feature but not exposed by the usages
          API — state this honestly instead of fabricating a window (#37). */}
      {snap.providerId === 'kimi_code' && isReady && (
        <p className="mt-4 rounded-lg bg-sky-50 px-3 py-2 text-[11px] text-sky-700">
          Kimi Code's monthly quota isn't returned by its usage API, so it isn't shown here.
        </p>
      )}

      {/* Timestamps */}
      <div className="mt-auto pt-4 text-[11px] text-slate-400">
        {snap.observedAt && <div>Observed {timeAgo(snap.observedAt)}</div>}
        <div>Fetched {timeAgo(snap.fetchedAt)}</div>
      </div>
    </div>
  );
}

function BucketBar({ bucket }: { bucket: QuotaBucket }) {
  const pct = bucket.usedPercent;
  const hasBar = pct != null;

  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="font-medium text-foreground">{bucket.label}</span>
        <span className={hasBar ? 'font-medium text-foreground' : 'text-slate-500'}>
          {hasBar ? (
            <>
              <span>used {pct.toFixed(0)}%</span>
              <span className="ml-1 text-slate-400">
                · {Math.round(100 - pct)}% left
              </span>
            </>
          ) : (
            <span>
              {bucket.used != null ? formatNum(bucket.used) : '—'}
              {bucket.limit != null ? ` / ${formatNum(bucket.limit)}` : ''}
            </span>
          )}
        </span>
      </div>

      {hasBar ? (
        <div
          className="mt-2 h-2 rounded-full bg-slate-200"
          role="progressbar"
          aria-valuenow={Math.round(pct)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={`${bucket.label} used ${pct.toFixed(0)} percent`}
        >
          <div
            className={`h-2 rounded-full transition-all ${barColor(pct)}`}
            style={{ width: `${Math.min(100, pct)}%` }}
          />
        </div>
      ) : (
        <div className="mt-2 h-2 rounded-full bg-slate-100" />
      )}

      <div className="mt-1 flex items-center justify-between text-[11px] text-slate-400">
        <span>
          {bucket.used != null && bucket.limit != null
            ? `${formatNum(bucket.used)} / ${formatNum(bucket.limit)} ${bucket.unit ?? ''}`
            : ''}
        </span>
        {bucket.resetsAt && (
          <span title={bucket.resetsAt /* ISO for debugging */}>
            resets {formatAbsoluteTime(bucket.resetsAt)} ({timeUntil(bucket.resetsAt)})
          </span>
        )}
      </div>

      {/* Optional breakdown of what's inside the window (e.g. GLM MCP tools). */}
      {bucket.details && (
        <div className="mt-1 text-[11px] text-slate-400">{bucket.details}</div>
      )}
    </div>
  );
}

function BalanceRow({ balance }: { balance: QuotaBalance }) {
  return (
    <div className="flex items-center justify-between py-0.5 text-xs">
      <span className="text-slate-600">{balance.label}</span>
      <span className="font-medium text-foreground">
        {balance.amount != null ? formatNum(balance.amount) : '—'} {balance.unit ?? ''}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function barColor(pct: number): string {
  if (pct >= 90) return 'bg-gradient-to-r from-red-600 via-red-500 to-red-400';
  if (pct >= 70) return 'bg-gradient-to-r from-amber-500 via-amber-400 to-amber-300';
  return 'bg-gradient-to-r from-slate-900 via-slate-700 to-slate-500';
}

function formatNum(n: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(n);
}

function timeAgo(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const sec = Math.floor((Date.now() - ms) / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function timeUntil(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  const diff = ms - Date.now();
  if (diff <= 0) return 'soon';
  const hr = Math.floor(diff / 3_600_000);
  const min = Math.floor((diff % 3_600_000) / 60_000);
  if (hr >= 1) return `in ${hr}h ${min}m`;
  return `in ${min}m`;
}

/** Local-timezone absolute time, e.g. "Aug 5, 09:38" (PRD §6.3 / #17). */
function formatAbsoluteTime(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '—';
  return new Date(ms).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
