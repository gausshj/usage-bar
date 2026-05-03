// ============================================================================
// src/app/page.tsx
// Usage Dashboard — Overview Page (Skeleton v1)
// ============================================================================

import {
  MOCK_RECORDS,
  MOCK_SYNC_STATUS,
  MOCK_PROVIDER_META,
  formatCurrency,
  formatNumber,
  formatTimeAgo,
  getQuotaPercentage,
} from '@/lib/mock-data';

// ---------------------------------------------------------------------------
// Overview Card
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

// ---------------------------------------------------------------------------
// Provider Row
// ---------------------------------------------------------------------------

function ProviderRow({ meta }: { meta: (typeof MOCK_PROVIDER_META)[number] }) {
  const pct = getQuotaPercentage(meta.quotaUsed, meta.quotaLimit);

  return (
    <div className="grid gap-4 px-5 py-4 last:border-b-0 sm:grid-cols-[minmax(0,1fr)_14rem_auto] sm:items-center">
      <div className="min-w-0">
        <div className="truncate font-medium text-foreground">
          {meta.displayName}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {meta.modelCount} models · {formatCurrency(meta.quotaUsed)} /{' '}
          {formatCurrency(meta.quotaLimit)}
        </div>
      </div>
      <div className="rounded-2xl border border-border/70 bg-slate-50/80 p-3">
        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>Provider Quota</span>
          <span className="font-medium text-foreground">{pct.toFixed(1)}%</span>
        </div>
        <div className="mt-2 h-2 rounded-full bg-slate-200">
          <div
            className="h-2 rounded-full bg-gradient-to-r from-slate-950 via-slate-800 to-slate-600 transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>
      <div className="sm:justify-self-end">
        <button className="rounded-full border border-transparent px-3 py-2 text-sm font-medium text-foreground transition hover:border-border hover:bg-white">
          Detail →
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sync Status Badge
// ---------------------------------------------------------------------------

function SyncStatusBadge({
  status,
}: {
  status: (typeof MOCK_SYNC_STATUS)[number]['status'];
}) {
  const config = {
    synced: { label: 'Synced', className: 'bg-green-100 text-green-800' },
    syncing: { label: 'Syncing', className: 'bg-blue-100 text-blue-800' },
    error: { label: 'Error', className: 'bg-red-100 text-red-800' },
    pending: { label: 'Pending', className: 'bg-yellow-100 text-yellow-800' },
  };

  const c = config[status];

  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${c.className}`}
    >
      {c.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Recent Records Table
// ---------------------------------------------------------------------------

function RecentRecords() {
  const recent = MOCK_RECORDS.slice(0, 5);

  return (
    <div className="overflow-hidden rounded-3xl border border-white/70 bg-white/75 text-card-foreground shadow-[0_24px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur">
      <div className="border-b border-white/60 px-6 py-4">
        <h3 className="text-base font-semibold tracking-tight">
          Recent Usage Records
        </h3>
      </div>
      <div className="divide-y divide-border/70">
        {recent.map((record, i) => (
          <div key={i} className="flex items-center justify-between px-6 py-4">
            <div>
              <div className="text-sm font-medium text-foreground">
                {record.provider}
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {record.model} · {record.date}
              </div>
            </div>
            <div className="text-right">
              <div className="text-sm font-medium text-foreground">
                {formatNumber(record.requests)} reqs
              </div>
              <div className="mt-1 text-xs text-muted-foreground">
                {formatCurrency(record.cost_usd)}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Empty State
// ---------------------------------------------------------------------------

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center rounded-3xl border border-white/70 bg-white/75 px-6 py-16 text-center shadow-[0_24px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur">
      <div className="mb-4 text-4xl">📊</div>
      <h3 className="text-lg font-semibold tracking-tight">No data yet</h3>
      <p className="mb-6 mt-2 text-sm text-muted-foreground">
        Configure your API credentials to start tracking usage.
      </p>
      <button className="rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white">
        Add Provider
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Loading Skeleton
// ---------------------------------------------------------------------------

function LoadingSkeleton() {
  return (
    <div className="space-y-6 animate-pulse">
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        {[1, 2, 3].map((i) => (
          <div
            key={i}
            className="h-28 rounded-3xl border border-white/50 bg-white/50"
          />
        ))}
      </div>
      <div className="h-72 rounded-3xl border border-white/50 bg-white/50" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function DashboardPage() {
  const isLoading = false;
  const hasData = MOCK_RECORDS.length > 0;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background px-4 py-8 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-7xl space-y-8">
          <div className="h-8 w-48 rounded-full bg-white/60" />
          <LoadingSkeleton />
        </div>
      </div>
    );
  }

  if (!hasData) {
    return (
      <div className="min-h-screen bg-background px-4 py-8 sm:px-6 lg:px-8">
        <EmptyState />
      </div>
    );
  }

  const totalCost = MOCK_RECORDS.reduce((sum, r) => sum + r.cost_usd, 0);
  const totalRequests = MOCK_RECORDS.reduce((sum, r) => sum + r.requests, 0);
  const totalTokens = MOCK_RECORDS.reduce(
    (sum, r) => sum + r.input_tokens + r.output_tokens,
    0,
  );

  return (
    <div className="relative min-h-screen overflow-hidden bg-background">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_top_left,_rgba(255,255,255,0.9),_transparent_35%),radial-gradient(circle_at_top_right,_rgba(226,232,240,0.9),_transparent_30%),linear-gradient(180deg,_rgba(248,250,252,0.92),_rgba(241,245,249,0.84))]" />
      <div className="pointer-events-none absolute -left-32 top-0 h-80 w-80 rounded-full bg-slate-200/40 blur-3xl" />
      <div className="pointer-events-none absolute right-0 top-40 h-72 w-72 rounded-full bg-slate-300/30 blur-3xl" />

      <div className="relative mx-auto flex min-h-screen max-w-7xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
        {/* Header */}
        <header className="overflow-hidden rounded-[2rem] border border-white/70 bg-white/75 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.6)] backdrop-blur">
          <div className="flex flex-col gap-5 border-b border-white/60 px-6 py-5 sm:flex-row sm:items-center sm:justify-between lg:px-8">
            <div className="space-y-3">
              <div className="inline-flex items-center rounded-full border border-slate-200/80 bg-slate-100/80 px-3 py-1 text-xs font-semibold uppercase tracking-[0.22em] text-slate-600">
                Usage Monitor
              </div>
              <div>
                <h1 className="text-3xl font-semibold tracking-tight text-slate-950">
                  Usage Dashboard
                </h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-600">
                  LLM API usage across providers, quota health, and sync status
                  in one view.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <button className="rounded-full border border-slate-200/80 bg-white px-4 py-2 text-sm font-medium text-slate-700 shadow-sm transition hover:border-slate-300 hover:bg-slate-50">
                Refresh All
              </button>
              <button className="rounded-full bg-slate-950 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-slate-800">
                + Add Provider
              </button>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="space-y-8">
          {/* Overview Cards */}
          <section className="space-y-4">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-slate-950">
                  Overview
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  High-level usage and spend across the current period.
                </p>
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
              <OverviewCard
                title="Total Cost (30d)"
                value={formatCurrency(totalCost)}
                subValue="Across all providers"
              />
              <OverviewCard
                title="Total Requests"
                value={formatNumber(totalRequests)}
                subValue="API calls this period"
              />
              <OverviewCard
                title="Total Tokens"
                value={formatNumber(totalTokens)}
                subValue="Input + Output combined"
              />
            </div>
          </section>

          {/* Provider Quota Section */}
          <section className="space-y-4">
            <div className="flex items-end justify-between gap-4">
              <div>
                <h2 className="text-lg font-semibold tracking-tight text-slate-950">
                  Provider Quota
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  Capacity and remaining headroom by provider.
                </p>
              </div>
              <span className="text-sm text-slate-600">
                {MOCK_PROVIDER_META.length} providers
              </span>
            </div>
            <div className="overflow-hidden rounded-3xl border border-white/70 bg-white/75 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur">
              <div className="divide-y divide-border/70">
                {MOCK_PROVIDER_META.map((meta) => (
                  <ProviderRow key={meta.id} meta={meta} />
                ))}
              </div>
            </div>
          </section>

          {/* Sync Status Section */}
          <section className="space-y-4">
            <h2 className="text-lg font-semibold tracking-tight text-slate-950">
              Sync Status
            </h2>
            <div className="overflow-hidden rounded-3xl border border-white/70 bg-white/75 shadow-[0_24px_60px_-40px_rgba(15,23,42,0.55)] backdrop-blur">
              <div className="divide-y divide-border/70">
                {MOCK_SYNC_STATUS.map((s) => (
                  <div
                    key={s.provider}
                    className="flex items-center justify-between gap-4 px-6 py-4"
                  >
                    <div className="min-w-0">
                      <div className="font-medium text-foreground">
                        {s.provider}
                      </div>
                      <div className="mt-1 text-xs text-muted-foreground">
                        Last sync: {formatTimeAgo(s.lastSyncTime)}
                      </div>
                      {s.errorMessage && (
                        <div className="mt-1 text-xs text-red-600">
                          {s.errorMessage}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-3">
                      <span className="text-xs text-muted-foreground">
                        {s.recordCount} records
                      </span>
                      <SyncStatusBadge status={s.status} />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* Recent Activity */}
          <section>
            <RecentRecords />
          </section>
        </main>
      </div>
    </div>
  );
}
