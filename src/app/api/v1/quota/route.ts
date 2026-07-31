// ============================================================================
// src/app/api/v1/quota/route.ts
// GET /api/v1/quota — aggregated three-provider quota snapshots (PRD §9.1).
//
// Always returns exactly three providers in fixed order, even on partial
// failure. A single provider failing never makes the whole response non-200.
// ============================================================================

import { NextResponse } from 'next/server';
import { getQuotaService } from '@/quota/service-instance';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET() {
  const service = getQuotaService();
  const providers = await service.readAll();
  return NextResponse.json(
    { schemaVersion: 1, generatedAt: new Date().toISOString(), providers },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
