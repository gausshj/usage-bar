// ============================================================================
// src/app/api/v1/quota/refresh/route.ts
// POST /api/v1/quota/refresh — force-refresh all three providers (PRD §9.2).
// Singleflight is handled inside the service, so concurrent POSTs are merged.
// ============================================================================

import { NextResponse } from 'next/server';
import { getQuotaService } from '@/quota/service-instance';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function POST() {
  const service = getQuotaService();
  const providers = await service.refreshAll();
  return NextResponse.json(
    { schemaVersion: 1, generatedAt: new Date().toISOString(), providers },
    { headers: { 'Cache-Control': 'no-store' } },
  );
}
