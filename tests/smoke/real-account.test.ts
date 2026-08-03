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

// Only run when explicitly opted in.
const SMOKE = process.env.SMOKE === '1' || process.env.SMOKE === 'true';
const run = SMOKE ? describe : describe.skip;

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..', '..');

// Load .env.local into process.env (no secrets printed).
try {
  const envFile = readFileSync(join(root, '.env.local'), 'utf8');
  for (const line of envFile.split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch {
  // no .env.local
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

  it('glm via monitor API (configured region only)', async () => {
    const token = process.env.GLM_CODING_PLAN_TOKEN || process.env.GLM_QUOTA_TOKEN;
    if (!token) {
      // No token → must NOT pass; mark as skipped expectation explicitly.
      expect(token).toBeTruthy();
      return;
    }
    // Test ONLY the configured region — never send the same token to both the
    // CN and global domains (#1). Default to bigmodel if unset.
    const region = process.env.GLM_CODING_PLAN_REGION === 'zai' ? 'zai' : 'bigmodel';
    const { GlmProvider } = await import('../../src/quota/providers/glm.js');
    const snap = await new GlmProvider({ token, region }).fetch(null);
    row(snap, `glm_coding_plan (${region})`, 'monitor API');
    // Must be ready AND via official_compatibility — not unconfigured/error (#1).
    expect(snap.status).toBe('ready');
    expect(snap.source.kind).toBe('official_compatibility');
  }, 15000);

  it('kimi via OAuth refresh + usages', async () => {
    const { KimiProvider } = await import('../../src/quota/providers/kimi.js');
    const p = new KimiProvider({
      accessToken: process.env.KIMI_CODE_ACCESS_TOKEN || undefined,
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
