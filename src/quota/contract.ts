// ============================================================================
// src/quota/contract.ts
// Unified data contract for the v1 quota dashboard (PRD §8).
//
// This is the single source of truth shared by every provider adapter, the
// aggregation service, the API routes, and the UI. Adapters normalize their
// provider-specific responses into these types; the UI formats for display.
//
// Contract rules (PRD §8.1):
//   - parsers keep raw numbers; formatting happens only in the UI layer.
//   - unknown values are null, never coerced to 0.
//   - observedAt = when the data actually corresponds to; fetchedAt = when we
//     read it. They differ and the UI shows both.
//   - known-required fields missing => controlled error, not silent 0.
// ============================================================================

/** Stable internal provider identifiers (PRD §5). */
export type ProviderId = 'codex_chatgpt' | 'glm_coding_plan' | 'kimi_code';

/** Fixed display order on the home page (PRD §6.1). */
export const PROVIDER_ORDER: ProviderId[] = [
  'codex_chatgpt',
  'glm_coding_plan',
  'kimi_code',
];

export type ProviderStatus =
  | 'unconfigured' // missing login/credentials
  | 'ready' // last refresh succeeded, within freshness window
  | 'stale' // current refresh failed, but a last-known-good exists
  | 'unavailable' // provider/CLI/bridge temporarily unreachable
  | 'unsupported' // CLI/response version not supported
  | 'error'; // config/auth/validation failure

export type SourceKind =
  | 'official_protocol' // provider's formal protocol (Codex App Server)
  | 'official_compatibility' // exists in official tooling, not a stable public API (GLM/Kimi)
  | 'local_estimate'; // derived from local activity files (Codex rollout fallback)

/** What the quota window is measured in. `unknown` for unrecognized metrics. */
export type QuotaMetric = 'tokens' | 'requests' | 'time' | 'credits' | 'unknown';

/** Provenance of a snapshot — where it came from and whether it's a fallback. */
export interface QuotaSourceInfo {
  kind: SourceKind;
  name: string;
  version: string | null;
  isFallback: boolean;
}

export interface QuotaPlan {
  name: string | null;
  /** Safe masked account label, e.g. "user@exam***.com". Never a raw token. */
  accountLabel: string | null;
}

/**
 * A single quota window (e.g. 5-hour, weekly, monthly) or a spend-control limit.
 * All numeric fields are null when unknown — the UI must render "—", not 0.
 */
export interface QuotaBucket {
  id: string;
  label: string;
  metric: QuotaMetric;
  /** Human unit hint, e.g. "tokens", "requests", "hours". null if N/A. */
  unit: string | null;
  used: number | null;
  limit: number | null;
  remaining: number | null;
  /** Usage percentage 0-100. null when no fixed ceiling (balance-type). */
  usedPercent: number | null;
  /** Window length in seconds, when applicable. */
  windowSeconds: number | null;
  /** ISO 8601 reset time. null when there is no reset (balances). */
  resetsAt: string | null;
}

/**
 * A spend-down balance distinct from periodic quota windows — e.g. purchased
 * credit, booster wallet. Grouped separately from windows per PRD §6.3.
 */
export interface QuotaBalance {
  id: string;
  label: string;
  amount: number | null;
  unit: string | null;
}

/** A safe error summary — never includes raw responses or tokens (PRD §8.1). */
export interface QuotaError {
  code: string;
  safeMessage: string;
  retryable: boolean;
}

/**
 * A provider's full quota state at a point in time. On any failure the snapshot
 * is still returned (status != ready) so the dashboard renders a graceful card.
 */
export interface QuotaSnapshot {
  providerId: ProviderId;
  status: ProviderStatus;
  /** ISO timestamp of when we read this (for "updated X ago"). */
  fetchedAt: string;
  /** ISO timestamp the data actually corresponds to; null if unknown. */
  observedAt: string | null;
  source: QuotaSourceInfo;
  plan: QuotaPlan;
  buckets: QuotaBucket[];
  balances?: QuotaBalance[];
  error?: QuotaError;
}

// ---------------------------------------------------------------------------
// Adapter interface — every provider implements this
// ---------------------------------------------------------------------------

/**
 * Reads one provider's quota and returns a normalized QuotaSnapshot.
 *
 * Implementations MUST:
 *   - never throw for expected conditions (missing creds, network failure);
 *     return a snapshot with the appropriate non-ready status instead.
 *   - only throw for programmer errors.
 *   - map auth/schema/failures to distinct, safe error codes.
 */
export interface QuotaProviderAdapter {
  readonly providerId: ProviderId;
  /** Human product name, e.g. "Codex", "GLM Coding Plan". */
  readonly displayName: string;

  /**
   * Fetch the latest snapshot. Resolve (don't throw) on soft failures with a
   * non-ready status. `previous` is the last-known-good for stale fallback.
   */
  fetch(previous: QuotaSnapshot | null): Promise<QuotaSnapshot>;

  /**
   * Whether the provider has the credentials/state required to attempt a fetch.
   * false => the service short-circuits to status `unconfigured` without calling
   * fetch(). Cheap, synchronous, no network.
   */
  isConfigured(): boolean;
}
