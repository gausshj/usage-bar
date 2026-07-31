import { describe, expect, it, vi } from 'vitest';

import {
  CredentialScopeMismatchError,
  CredentialUnavailableError,
  NoopCredentialResolver,
  SecureCredentialResolver,
} from '../../src/quota/credentials.js';

function makeStore(record: { kind: string; provider: string; accountId?: string; status: string } | null) {
  return {
    get: vi.fn().mockResolvedValue(
      record
        ? {
            kind: record.kind,
            scope: { provider: record.provider, accountId: record.accountId ?? 'acct' },
            status: record.status,
          }
        : null,
    ),
  };
}

function makeService(plaintext = 'secret-value') {
  return { revealCredential: vi.fn().mockResolvedValue(plaintext) };
}

const SCOPE = { provider: 'glm_coding_plan', kind: 'api_key' as const };

describe('SecureCredentialResolver', () => {
  it('reveals a matching active credential', async () => {
    const repo = makeStore({ kind: 'api_key', provider: 'glm_coding_plan', status: 'active' });
    const svc = makeService();
    const resolver = new SecureCredentialResolver(repo as never, svc as never);
    const value = await resolver.reveal('cred-1', SCOPE);
    expect(value).toBe('secret-value');
    expect(svc.revealCredential).toHaveBeenCalledWith('cred-1');
  });

  it('rejects a missing credential', async () => {
    const resolver = new SecureCredentialResolver(makeStore(null) as never, makeService() as never);
    await expect(resolver.reveal('missing', SCOPE)).rejects.toThrow(CredentialUnavailableError);
  });

  it('rejects a non-active credential', async () => {
    const resolver = new SecureCredentialResolver(
      makeStore({ kind: 'api_key', provider: 'glm_coding_plan', status: 'revoked' }) as never,
      makeService() as never,
    );
    await expect(resolver.reveal('x', SCOPE)).rejects.toThrow(CredentialUnavailableError);
  });

  it('rejects a kind mismatch', async () => {
    const resolver = new SecureCredentialResolver(
      makeStore({ kind: 'oauth_token', provider: 'glm_coding_plan', status: 'active' }) as never,
      makeService() as never,
    );
    await expect(resolver.reveal('x', SCOPE)).rejects.toThrow(CredentialScopeMismatchError);
  });

  it('rejects a provider mismatch', async () => {
    const resolver = new SecureCredentialResolver(
      makeStore({ kind: 'api_key', provider: 'kimi_code', status: 'active' }) as never,
      makeService() as never,
    );
    await expect(resolver.reveal('x', SCOPE)).rejects.toThrow(CredentialScopeMismatchError);
  });

  it('rejects an accountId mismatch when one is expected', async () => {
    const resolver = new SecureCredentialResolver(
      makeStore({ kind: 'api_key', provider: 'glm_coding_plan', accountId: 'acct-B', status: 'active' }) as never,
      makeService() as never,
    );
    await expect(
      resolver.reveal('x', { ...SCOPE, accountId: 'acct-A' }),
    ).rejects.toThrow(CredentialScopeMismatchError);
  });
});

describe('NoopCredentialResolver', () => {
  it('always fails', async () => {
    const resolver = new NoopCredentialResolver();
    await expect(resolver.reveal('x', SCOPE)).rejects.toThrow(CredentialUnavailableError);
  });
});
