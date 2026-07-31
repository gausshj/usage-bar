// ============================================================================
// src/app/api/usage/route.ts
// GET /api/usage — real per-day Codex token usage aggregated from local
// session files. No credentials needed.
//
// Returns:
//   { records: CodexUsageRecord[], summary: {requests, input, output, total}, days }
// ============================================================================

import { NextResponse } from 'next/server';

import { CodexSessionQuotaSource } from '@/quota/codex-session';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const days = 7;
  const source = new CodexSessionQuotaSource();

  try {
    const records = await source.fetchUsage(days);

    const summary = records.reduce(
      (acc, r) => {
        acc.requests += r.requests;
        acc.input += r.input_tokens;
        acc.output += r.output_tokens;
        acc.total += r.total_tokens;
        return acc;
      },
      { requests: 0, input: 0, output: 0, total: 0 },
    );

    return NextResponse.json(
      { records, summary, days, fetchedAt: Date.now() },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (error) {
    return NextResponse.json(
      {
        records: [],
        summary: { requests: 0, input: 0, output: 0, total: 0 },
        days,
        fetchedAt: Date.now(),
        error: {
          message: error instanceof Error ? error.message : String(error),
        },
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
