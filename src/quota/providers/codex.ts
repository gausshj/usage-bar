// ============================================================================
// src/quota/providers/codex.ts
// Codex (ChatGPT/Codex account) quota provider.
//
// Primary source: the local Codex App Server (official_protocol) via JSON-RPC —
// `account/rateLimits/read` for quota windows/credits, `account/usage/read` for
// activity (exposed via the usage module). Falls back to parsing local rollout
// files (local_estimate) only when the App Server is unavailable.
//
// Auth: the App Server owns the OAuth credentials; this adapter never reads or
// emits access tokens. It is "configured" as long as the user has logged into
// Codex (auth.json present) — which is the normal state for a Codex user.
// ============================================================================

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
  QuotaBucket,
  QuotaProviderAdapter,
  QuotaSnapshot,
  QuotaBalance,
} from '../contract.js';
import { CodexAppServerClient } from './codex-app-server.js';

// ---------------------------------------------------------------------------
// Raw App Server response shapes (camelCase on the wire)
// ---------------------------------------------------------------------------

interface RateLimitWindow {
  usedPercent: number | null;
  windowDurationMins: number | null;
  resetsAt: number | null; // Unix seconds
}
interface CreditsSnapshot {
  hasCredits: boolean | null;
  unlimited: boolean | null;
  balance: string | null;
}
interface SpendControlLimit {
  limit: string;
  used: string;
  remainingPercent: number | null;
  resetsAt: number | null;
}
interface RateLimitSnapshot {
  limitId: string | null;
  primary: RateLimitWindow | null;
  secondary: RateLimitWindow | null;
  credits: CreditsSnapshot | null;
  individualLimit: SpendControlLimit | null;
  planType: string | null;
}
interface GetAccountRateLimitsResponse {
  rateLimits: RateLimitSnapshot | null;
}

interface AppServerConfig {
  /** Override CODEX_HOME (defaults to ~/.codex). */
  codexHome?: string;
  /** Inject a client (testing). */
  client?: Pick<CodexAppServerClient, 'connect' | 'call' | 'done'>;
}

const PROVIDER_ID = 'codex_chatgpt' as const;
const DISPLAY_NAME = 'Codex';
const APP_SERVER_SOURCE = { kind: 'official_protocol' as const, name: 'Codex App Server', version: null, isFallback: false };
const ROLLOUT_SOURCE = { kind: 'local_estimate' as const, name: 'Codex rollout files', version: null, isFallback: true };

export class CodexProvider implements QuotaProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly displayName = DISPLAY_NAME;

  private readonly codexHome: string;
  private readonly clientFactory: () => Pick<CodexAppServerClient, 'connect' | 'call' | 'done'>;

  constructor(config: AppServerConfig = {}) {
    this.codexHome = config.codexHome ?? `${homedir()}/.codex`;
    this.clientFactory = config.client
      ? () => config.client!
      : () => new CodexAppServerClient({ codexHome: this.codexHome });
  }

  isConfigured(): boolean {
    // Configured = the user has logged into Codex (auth.json exists) OR rollout
    // files exist. Either way we can produce some data.
    return existsSync(join(this.codexHome, 'auth.json'));
  }

  async fetch(previous: QuotaSnapshot | null): Promise<QuotaSnapshot> {
    const fetchedAt = new Date().toISOString();

    // --- Primary path: App Server ---
    const client = this.clientFactory();
    try {
      await client.connect();
      const result = await client.call<GetAccountRateLimitsResponse>('account/rateLimits/read');
      const snapshot = RateLimitsToSnapshot(result, fetchedAt, previous);
      // usage data is fetched separately by the usage module; here we only
      // surface quota. Mark observedAt as now since the App Server read is live.
      return snapshot;
    } catch {
      // Fall through to rollout estimate.
    } finally {
      // `done` may not exist on an injected mock that threw before assignment;
      // guard via optional chaining. Real clients always have it.
      (client as CodexAppServerClient).done?.();
    }

    // --- Fallback: rollout estimate ---
    return rolloutFallback(this.codexHome, fetchedAt, previous);
  }
}

// ---------------------------------------------------------------------------
// App Server response → QuotaSnapshot
// ---------------------------------------------------------------------------

function RateLimitsToSnapshot(
  result: GetAccountRateLimitsResponse,
  fetchedAt: string,
  previous: QuotaSnapshot | null,
): QuotaSnapshot {
  const limits = result.rateLimits;
  if (!limits) {
    return emptySnapshot(fetchedAt, APP_SERVER_SOURCE, previous, {
      code: 'empty_rate_limits',
      safeMessage: 'App Server returned no rate limits.',
      retryable: true,
    }, 'error');
  }

  const buckets: QuotaBucket[] = [];
  for (const [slot, window] of [
    ['primary', limits.primary],
    ['secondary', limits.secondary],
  ] as const) {
    if (!window) continue;
    buckets.push(windowToBucket(slot, window));
  }

  const balances: QuotaBalance[] = [];
  if (limits.credits && limits.credits.balance != null) {
    balances.push({
      id: 'credits',
      label: 'Credit balance',
      amount: Number(limits.credits.balance),
      unit: 'credits',
    });
  }

  return {
    providerId: PROVIDER_ID,
    status: 'ready',
    fetchedAt,
    observedAt: fetchedAt,
    source: APP_SERVER_SOURCE,
    plan: { name: limits.planType ?? null, accountLabel: null },
    buckets,
    balances: balances.length > 0 ? balances : undefined,
  };
}

function windowToBucket(id: string, w: RateLimitWindow): QuotaBucket {
  const label = describeWindow(w.windowDurationMins);
  const usedPercent = w.usedPercent;
  return {
    id,
    label,
    metric: 'tokens',
    unit: null,
    used: null, // App Server gives percent, not absolute used/limit
    limit: null,
    remaining: usedPercent != null ? 100 - usedPercent : null,
    usedPercent,
    windowSeconds: w.windowDurationMins != null ? w.windowDurationMins * 60 : null,
    resetsAt: w.resetsAt != null ? new Date(w.resetsAt * 1000).toISOString() : null,
  };
}

function describeWindow(mins: number | null): string {
  if (mins == null) return 'quota';
  if (mins === 300) return '5-hour';
  if (mins === 10080) return 'weekly';
  if (mins % 1440 === 0) return `${mins / 1440}-day`;
  if (mins % 60 === 0) return `${mins / 60}-hour`;
  return `${mins}m`;
}

// ---------------------------------------------------------------------------
// Rollout fallback (local_estimate)
// ---------------------------------------------------------------------------

async function rolloutFallback(
  codexHome: string,
  fetchedAt: string,
  previous: QuotaSnapshot | null,
): Promise<QuotaSnapshot> {
  // Lazy import to avoid loading the rollout parser when the App Server works.
  // The legacy codex-session.ts lives next to the new contract under the old
  // quota module; we reuse its session-scanning logic.
  try {
    const { CodexSessionQuotaSource } = await import('../codex-session.js');
    const source = new CodexSessionQuotaSource({
      sessionsDir: join(codexHome, 'sessions'),
    });
    const snap = await source.fetchSnapshot();
    if (snap.error || snap.buckets.length === 0) {
      return emptySnapshot(fetchedAt, ROLLOUT_SOURCE, previous, {
        code: 'no_rollout_data',
        safeMessage: 'No Codex session data found.',
        retryable: false,
      }, 'unconfigured');
    }
    // Map legacy bucket shape → contract bucket shape.
    const buckets: QuotaBucket[] = snap.buckets.map((b) => ({
      id: b.label,
      label: b.label,
      metric: 'unknown',
      unit: null,
      used: null,
      limit: null,
      remaining: b.usedPercent != null ? 100 - b.usedPercent : null,
      usedPercent: b.usedPercent,
      windowSeconds: null,
      resetsAt: b.resetsAt != null ? new Date(b.resetsAt * 1000).toISOString() : null,
    }));
    return {
      providerId: PROVIDER_ID,
      status: 'ready',
      fetchedAt,
      observedAt: fetchedAt,
      source: ROLLOUT_SOURCE,
      plan: { name: null, accountLabel: null },
      buckets,
    };
  } catch {
    return emptySnapshot(fetchedAt, ROLLOUT_SOURCE, previous, {
      code: 'rollout_read_failed',
      safeMessage: 'Could not read local Codex session files.',
      retryable: true,
    }, 'error');
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptySnapshot(
  fetchedAt: string,
  source: typeof APP_SERVER_SOURCE | typeof ROLLOUT_SOURCE,
  previous: QuotaSnapshot | null,
  error: { code: string; safeMessage: string; retryable: boolean },
  status: QuotaSnapshot['status'],
): QuotaSnapshot {
  // If we have a previous good snapshot, degrade to stale instead of error.
  if (previous && previous.status === 'ready') {
    return { ...previous, status: 'stale', fetchedAt, source, error };
  }
  return {
    providerId: PROVIDER_ID,
    status,
    fetchedAt,
    observedAt: null,
    source,
    plan: { name: null, accountLabel: null },
    buckets: [],
    error,
  };
}
