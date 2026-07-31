// ============================================================================
// src/app/page.tsx
// Usage Dashboard — Overview Page
//
// Layout (PRD §6):
//   1. Plan Quota — three fixed provider cards (Codex / GLM / Kimi)
//   2. Codex Activity (Beta) — local token usage estimate
// ============================================================================

import { QuotaCards } from './_components/quota-cards';
import { UsageOverviewSection } from './_components/usage-overview-section';

export default function DashboardPage() {
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
                  Quota headroom across Codex, GLM Coding Plan and Kimi Code —
                  status, windows and resets in one view.
                </p>
              </div>
            </div>
          </div>
        </header>

        {/* Main Content */}
        <main className="space-y-10">
          {/* 1. Plan Quota — three fixed cards (primary) */}
          <QuotaCards />

          {/* 2. Codex Activity (Beta) — local estimate, not part of the quota cards */}
          <UsageOverviewSection />
        </main>
      </div>
    </div>
  );
}
