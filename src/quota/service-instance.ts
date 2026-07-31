// ============================================================================
// src/quota/service-instance.ts
// Process-wide singleton QuotaService so the in-memory cache, singleflight,
// and last-known-good survive across requests within the same server process.
// ============================================================================

import { QuotaService } from './service.js';

let instance: QuotaService | null = null;

/** Get (or lazily create) the shared QuotaService singleton. */
export function getQuotaService(): QuotaService {
  if (!instance) {
    instance = new QuotaService();
  }
  return instance;
}

/** Reset the singleton (testing only). */
export function resetQuotaService(): void {
  instance = null;
}
