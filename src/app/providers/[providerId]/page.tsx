// ============================================================================
// src/app/providers/[providerId]/page.tsx
// Provider Detail Page — shows per-provider usage breakdown
// ============================================================================

import {
  MOCK_RECORDS,
  MOCK_SYNC_STATUS,
  formatCurrency,
  formatNumber,
  formatTimeAgo,
} from '@/lib/mock-data';

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
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${c.className}`}>
      {c.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Model Breakdown Table
// ---------------------------------------------------------------------------

function ModelBreakdown({
  records,
}: {
  records: { model: string; requests: number; input_tokens: number; output_tokens: number; cost_usd: number }[];
}) {
  // Aggregate by model
  const byModel = records.reduce<
    Record<string, { requests: number; input: number; output: number; cost: number }>
  >((acc, r) => {
    if (!acc[r.model]) {
      acc[r.model] = { requests: 0, input: 0, output: 0, cost: 0 };
    }
    acc[r.model].requests += r.requests;
    acc[r.model].input += r.input_tokens;
    acc[r.model].output += r.output_tokens;
    acc[r.model].cost += r.cost_usd;
    return acc;
  }, {});

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b bg-gray-50">
        <h3 className="font-semibold">Model Breakdown</h3>
      </div>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b bg-gray-100/50">
            <th className="text-left px-4 py-2 font-medium">Model</th>
            <th className="text-right px-4 py-2 font-medium">Requests</th>
            <th className="text-right px-4 py-2 font-medium">Input Tokens</th>
            <th className="text-right px-4 py-2 font-medium">Output Tokens</th>
            <th className="text-right px-4 py-2 font-medium">Cost (USD)</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {Object.entries(byModel).map(([model, stats]) => (
            <tr key={model} className="hover:bg-gray-50">
              <td className="px-4 py-2 font-medium">{model}</td>
              <td className="px-4 py-2 text-right">{formatNumber(stats.requests)}</td>
              <td className="px-4 py-2 text-right">{formatNumber(stats.input)}</td>
              <td className="px-4 py-2 text-right">{formatNumber(stats.output)}</td>
              <td className="px-4 py-2 text-right">{formatCurrency(stats.cost)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Daily Trend Chart (text-based placeholder)
// ---------------------------------------------------------------------------

function DailyTrend({
  records,
}: {
  records: { date: string; requests: number; cost_usd: number }[];
}) {
  const byDate = records.reduce<Record<string, { requests: number; cost: number }>>((acc, r) => {
    if (!acc[r.date]) acc[r.date] = { requests: 0, cost: 0 };
    acc[r.date].requests += r.requests;
    acc[r.date].cost += r.cost_usd;
    return acc;
  }, {});

  const sortedDates = Object.keys(byDate).sort();
  const maxCost = Math.max(...sortedDates.map((d) => byDate[d].cost), 1);

  return (
    <div className="rounded-lg border bg-card text-card-foreground shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b bg-gray-50">
        <h3 className="font-semibold">Daily Cost Trend</h3>
      </div>
      <div className="p-4">
        <div className="flex items-end justify-between gap-1 h-32">
          {sortedDates.map((date) => {
            const h = Math.max(4, Math.round((byDate[date].cost / maxCost) * 128));
            return (
              <div key={date} className="flex-1 flex flex-col items-center gap-1">
                <div
                  className="w-full bg-primary rounded-t"
                  style={{ height: `${h}px` }}
                  title={`${date}: ${formatCurrency(byDate[date].cost)}`}
                />
                <span className="text-xs text-muted-foreground">
                  {date.slice(5)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

export default async function ProviderDetailPage({
  params,
}: {
  params: Promise<{ providerId: string }>;
}) {
  const { providerId } = await params;

  // Filter mock records for this provider
  const providerRecords = MOCK_RECORDS.filter((r) => r.provider === providerId);

  // Find sync status
  const syncStatus = MOCK_SYNC_STATUS.find((s) => s.provider === providerId);

  if (providerRecords.length === 0) {
    return (
      <div className="min-h-screen bg-background">
        <div className="max-w-6xl mx-auto p-8">
          <div className="text-center py-16">
            <div className="text-4xl mb-4">🔍</div>
            <h2 className="text-lg font-semibold">Provider not found</h2>
            <p className="text-sm text-muted-foreground mt-2">
              No data found for provider: {providerId}
            </p>
          </div>
        </div>
      </div>
    );
  }

  const totalCost = providerRecords.reduce((sum, r) => sum + r.cost_usd, 0);
  const totalRequests = providerRecords.reduce((sum, r) => sum + r.requests, 0);
  const totalInput = providerRecords.reduce((sum, r) => sum + r.input_tokens, 0);
  const totalOutput = providerRecords.reduce((sum, r) => sum + r.output_tokens, 0);

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b px-8 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div>
            <div className="flex items-center gap-3">
              <a href="/" className="text-sm text-muted-foreground hover:underline">
                ← Dashboard
              </a>
              <h1 className="text-xl font-bold capitalize">{providerId}</h1>
            </div>
            <p className="text-sm text-muted-foreground mt-1">
              Provider Detail View
            </p>
          </div>
          <div className="flex items-center gap-3">
            {syncStatus && (
              <div className="flex items-center gap-2">
                <SyncStatusBadge status={syncStatus.status} />
                <span className="text-xs text-muted-foreground">
                  Last sync: {formatTimeAgo(syncStatus.lastSyncTime)}
                </span>
              </div>
            )}
            <button className="px-3 py-1.5 text-sm border rounded-md hover:bg-accent">
              Sync Now
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-6xl mx-auto p-8 space-y-8">
        {/* Summary Cards */}
        <section>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-4">
              <div className="text-sm text-muted-foreground">Total Cost</div>
              <div className="text-2xl font-bold mt-1">{formatCurrency(totalCost)}</div>
            </div>
            <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-4">
              <div className="text-sm text-muted-foreground">Total Requests</div>
              <div className="text-2xl font-bold mt-1">{formatNumber(totalRequests)}</div>
            </div>
            <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-4">
              <div className="text-sm text-muted-foreground">Input Tokens</div>
              <div className="text-2xl font-bold mt-1">{formatNumber(totalInput)}</div>
            </div>
            <div className="rounded-lg border bg-card text-card-foreground shadow-sm p-4">
              <div className="text-sm text-muted-foreground">Output Tokens</div>
              <div className="text-2xl font-bold mt-1">{formatNumber(totalOutput)}</div>
            </div>
          </div>
        </section>

        {/* Daily Trend */}
        <section>
          <DailyTrend records={providerRecords} />
        </section>

        {/* Model Breakdown */}
        <section>
          <ModelBreakdown records={providerRecords} />
        </section>
      </main>
    </div>
  );
}