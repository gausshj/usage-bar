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
import {
  parseWithSchema,
  codexRateLimitsResponseSchema,
  type CodexRateLimitsResponseParsed,
} from '../schemas.js';
import { CodexAppServerClient } from './codex-app-server.js';

// ---------------------------------------------------------------------------
// Response types derived from the zod schema
// ---------------------------------------------------------------------------

type RateLimitsResponse = CodexRateLimitsResponseParsed;
type RateLimitSnapshot = NonNullable<RateLimitsResponse['rateLimits']>;
type RateLimitWindow = NonNullable<RateLimitSnapshot['primary']>;

interface AppServerConfig {
  /** Override CODEX_HOME (defaults to ~/.codex). */
  codexHome?: string;
  /** Inject a client (testing). Must expose getServerInfo for capability detection. */
  client?: Pick<CodexAppServerClient, 'connect' | 'call' | 'done' | 'getServerInfo'>;
}

const PROVIDER_ID = 'codex_chatgpt' as const;
const DISPLAY_NAME = 'Codex';
interface SourceDescriptor {
  kind: 'official_protocol' | 'local_estimate' | 'official_compatibility';
  name: string;
  version: string | null;
  isFallback: boolean;
}
const APP_SERVER_SOURCE: SourceDescriptor = { kind: 'official_protocol', name: 'Codex App Server', version: null, isFallback: false };
const ROLLOUT_SOURCE: SourceDescriptor = { kind: 'local_estimate', name: 'Codex rollout files', version: null, isFallback: true };

export class CodexProvider implements QuotaProviderAdapter {
  readonly providerId = PROVIDER_ID;
  readonly displayName = DISPLAY_NAME;

  private readonly codexHome: string;
  private readonly clientFactory: () => Pick<CodexAppServerClient, 'connect' | 'call' | 'done' | 'getServerInfo'>;

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

      // Capability detection: read the server's reported version (issue #14).
      const serverInfo = client.getServerInfo?.() ?? null;
      const version = serverInfo?.userAgent ?? null;

      const raw = await client.call<unknown>('account/rateLimits/read');
      // Runtime schema validation (issue #13, Codex part).
      const result = parseWithSchema('codex', codexRateLimitsResponseSchema, raw);
      return rateLimitsToSnapshot(result, fetchedAt, previous, version);
    } catch (err) {
      // Capability explicitly unsupported (method not found / low version) →
      // surface as `unsupported`, NOT a silent fallback (issue #14).
      if (isUnsupportedMethod(err)) {
        return unsupportedSnapshot(fetchedAt, previous);
      }
      // Otherwise transient (process missing, timeout, network) → rollout fallback.
    } finally {
      (client as CodexAppServerClient).done?.();
    }

    // --- Fallback: rollout estimate ---
    return rolloutFallback(this.codexHome, fetchedAt, previous);
  }
}

// ---------------------------------------------------------------------------
// App Server response → QuotaSnapshot
// ---------------------------------------------------------------------------

function rateLimitsToSnapshot(
  result: RateLimitsResponse,
  fetchedAt: string,
  previous: QuotaSnapshot | null,
  version: string | null,
): QuotaSnapshot {
  const limits = result.rateLimits;
  if (!limits) {
    return emptySnapshot(fetchedAt, withVersion(APP_SERVER_SOURCE, version), previous, {
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
    source: withVersion(APP_SERVER_SOURCE, version),
    plan: { name: limits.planType ?? null, accountLabel: null },
    buckets,
    balances: balances.length > 0 ? balances : undefined,
  };
}

/** Attach the detected server version to a source descriptor. */
function withVersion(base: SourceDescriptor, version: string | null): SourceDescriptor {
  return { ...base, version };
}

/** True if the error means the App Server explicitly lacks a method (unsupported). */
function isUnsupportedMethod(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message.toLowerCase();
  // JSON-RPC -32601 method not found, or a "not supported" hint.
  return msg.includes('-32601') || msg.includes('method not found') || msg.includes('not supported');
}

/** Snapshot for an explicitly unsupported capability (NOT a silent fallback). */
function unsupportedSnapshot(fetchedAt: string, previous: QuotaSnapshot | null): QuotaSnapshot {
  return emptySnapshot(fetchedAt, APP_SERVER_SOURCE, previous, {
    code: 'unsupported_capability',
    safeMessage: 'This Codex version does not support the required App Server methods.',
    retryable: false,
  }, 'unsupported');
}

function windowToBucket(id: string, w: RateLimitWindow): QuotaBucket {
  const label = describeWindow(w.windowDurationMins);
  const usedPercent = w.usedPercent ?? null;
  const windowMins = w.windowDurationMins ?? null;
  const resetsAt = w.resetsAt ?? null;
  return {
    id,
    label,
    metric: 'tokens',
    unit: null,
    used: null, // App Server gives percent, not absolute used/limit
    limit: null,
    remaining: usedPercent != null ? 100 - usedPercent : null,
    usedPercent,
    windowSeconds: windowMins != null ? windowMins * 60 : null,
    resetsAt: resetsAt != null ? new Date(resetsAt * 1000).toISOString() : null,
  };
}

function describeWindow(mins: number | null | undefined): string {
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
      // observedAt = when the rollout data was actually generated (the latest
      // rate_limits event time), NOT when we read it. This is what makes a
      // stale snapshot honestly report its age (PRD §8.1 / issue #10).
      observedAt: snap.observedAt != null ? new Date(snap.observedAt).toISOString() : fetchedAt,
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
