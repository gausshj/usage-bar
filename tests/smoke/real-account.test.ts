// ============================================================================
// tests/smoke/real-account.test.ts
// Opt-in real-account smoke test (PRD §13.3 / issue #21).
//
// Skipped by default. Run with real credentials via:
//   npm run smoke
//
// Each provider is verified against real state and results are appended to
// docs/smoke-test-report.md. The report records ONLY an allowlisted set of
// fields (provider / path / source kind / version / status / error code) —
// never tokens, account identity, safeMessages, or raw responses.
// ============================================================================

import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import type { QuotaSnapshot } from '../../src/quota/contract.js';
import { loadSmokeEnv } from './load-env.js';

// Only run when explicitly opted in.
const SMOKE = process.env.SMOKE === '1' || process.env.SMOKE === 'true';
const run = SMOKE ? describe : describe.skip;

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

// Loading real credentials is opt-in together with the smoke suite. Ordinary
// `npm test` must not read or inject .env.local at module evaluation time.
if (SMOKE) {
  // Use Next's own dotenv + expansion implementation, so smoke and the
  // application agree exactly (review P2).
  try {
    const envFile = readFileSync(join(root, '.env.local'), 'utf8');
    loadSmokeEnv(envFile, root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

const startedAt = new Date().toISOString();

// Report rows — strictly allowlisted fields only (review #1: no safeMessage,
// no raw responses). error code is fine (it's a stable enum, not free text).
const report: Array<{
  provider: string;
  path: string;
  sourceKind: string;
  version: string | null;
  status: string;
  errorCode: string | null;
  ok: boolean;
}> = [];

function row(snap: QuotaSnapshot, provider: string, path: string): void {
  report.push({
    provider,
    path,
    sourceKind: snap.source.kind,
    version: snap.source.version,
    status: snap.status,
    errorCode: snap.error?.code ?? null,
    ok: snap.status === 'ready',
  });
}

run('real-account smoke test', () => {
  it('codex via App Server (official protocol, not rollout fallback)', async () => {
    const { CodexProvider } = await import('../../src/quota/providers/codex.js');
    const snap = await new CodexProvider().fetch(null);
    row(snap, 'codex_chatgpt', 'App Server');
    // Must be ready AND actually via the official protocol — a rollout
    // fallback (local_estimate) is NOT an App Server success (#1).
    expect(snap.status).toBe('ready');
    expect(snap.source.kind).toBe('official_protocol');
  }, 20000);

  it('glm via monitor API (configured region only, shared config)', async () => {
    const { parseProviderConfigs } = await import('../../src/quota/config.js');
    const cfg = parseProviderConfigs();
    if (!cfg.glm.token) {
      // No token → must NOT pass; mark as skipped expectation explicitly.
      expect(cfg.glm.token).toBeTruthy();
      return;
    }
    // Use the shared config so smoke tests the SAME endpoint/region/baseUrl as
    // the real application (review P1-2). Region is already validated here —
    // an invalid value would have thrown ConfigError before this point.
    const { GlmProvider } = await import('../../src/quota/providers/glm.js');
    const snap = await new GlmProvider({
      token: cfg.glm.token,
      region: cfg.glm.region,
      baseUrl: cfg.glm.baseUrl,
    }).fetch(null);
    row(snap, `glm_coding_plan (${cfg.glm.region})`, 'monitor API');
    // Must be ready AND via official_compatibility — not unconfigured/error.
    expect(snap.status).toBe('ready');
    expect(snap.source.kind).toBe('official_compatibility');
  }, 15000);

  it('kimi via OAuth refresh + usages (shared config)', async () => {
    const { parseProviderConfigs } = await import('../../src/quota/config.js');
    const cfg = parseProviderConfigs();
    const { KimiProvider } = await import('../../src/quota/providers/kimi.js');
    const p = new KimiProvider({
      accessToken: cfg.kimi.accessToken,
      baseUrl: cfg.kimi.baseUrl,
      credentialsPath: join(homedir(), '.kimi-code/credentials/kimi-code.json'),
    });
    const snap = await p.fetch(null);
    row(snap, 'kimi_code', 'OAuth refresh + usages');
    // Must be ready AND via official_compatibility — not unconfigured/error (#1).
    expect(snap.status).toBe('ready');
    expect(snap.source.kind).toBe('official_compatibility');
  }, 20000);

  it('writes an allowlisted report to docs/smoke-test-report.md', () => {
    mkdirSync(join(root, 'docs'), { recursive: true });
    const outPath = join(root, 'docs', 'smoke-test-report.md');
    const lines = [
      `# Smoke Test Report`,
      ``,
      `- started: ${startedAt}`,
      `- completed: ${new Date().toISOString()}`,
      ``,
      `| Provider | Path | Source | Version | Status | Error Code |`,
      `|---|---|---|---|---|---|`,
      ...report.map(
        (r) =>
          `| ${r.provider} | ${r.path} | ${r.sourceKind} | ${r.version ?? '-'} | ${r.status} | ${r.errorCode ?? '-'} |`,
      ),
      ``,
    ];
    appendFileSync(outPath, lines.join('\n'));
    expect(report.length).toBeGreaterThan(0);
  });
});
