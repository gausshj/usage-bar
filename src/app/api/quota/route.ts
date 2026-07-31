// ============================================================================
// src/app/api/quota/route.ts
// Compatibility route (PRD §9.1): forwards to the v1 aggregation service so
// legacy callers keep working during the migration. New code should call
// /api/v1/quota directly.
// ============================================================================

import { NextResponse } from 'next/server';
import { getQuotaService } from '@/quota/service-instance';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const service = getQuotaService();
  const providers = await service.readAll();
  // Return the legacy { snapshots, fetchedAt } shape for backward compat.
  return NextResponse.json(
    { snapshots: providers, fetchedAt: Date.now() },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
