import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import {
  InMemorySecureStorageRepository,
  KeychainBackedKeyProvider,
  LocalFallbackKeyProvider,
  SecretUnavailableError,
  SecureSecretService,
  StaticKeyProvider,
  type KeychainAdapter,
} from '../../src/security/index.js';
import type { SecretRecord } from '../../src/security/index.js';

const scope = {
  provider: 'minimax',
  accountId: 'account-a',
  organizationId: 'org-a',
};

describe('key providers', () => {
  it('returns cloned static keys and rejects unknown or invalid keys', async () => {
    const encodedKey = Buffer.alloc(32, 4).toString('base64');
    const provider = new StaticKeyProvider(encodedKey, 'static-key');

    const first = await provider.getActiveKey();
    const second = await provider.getKey('static-key');
    first.key[0] = 99;

    expect(second.key[0]).toBe(4);
    await expect(provider.getKey('missing-key')).rejects.toThrow(
      'Unknown encryption key',
    );
    expect(() => new StaticKeyProvider(Buffer.alloc(16))).toThrow(
      'Encryption key must be 32 bytes',
    );
  });

  it('creates and reuses local fallback keys', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'usage-bar-key-'));
    const keyPath = join(directory, 'master.key');

    try {
      const provider = new LocalFallbackKeyProvider(keyPath, 'local-key');
      const created = await provider.getActiveKey();
      const stored = Buffer.from((await readFile(keyPath, 'utf8')).trim(), 'base64');
      const loaded = await new LocalFallbackKeyProvider(
        keyPath,
        'local-key',
      ).getKey('local-key');

      expect(created.key).toEqual(stored);
      expect(loaded.key).toEqual(created.key);
      await expect(provider.getKey('wrong-key')).rejects.toThrow(
        'Unknown encryption key',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('surfaces local fallback read errors that are not missing files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'usage-bar-key-dir-'));
    const keyPath = join(directory, 'key-as-directory');
    await mkdir(keyPath);

    try {
      const provider = new LocalFallbackKeyProvider(keyPath, 'local-key');
      await expect(provider.getActiveKey()).rejects.toMatchObject({
        code: 'EISDIR',
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('creates and reads keys through a keychain adapter', async () => {
    const adapter = new MemoryKeychainAdapter();
    const provider = new KeychainBackedKeyProvider(
      adapter,
      'service',
      'account',
      'keychain-key',
    );

    const created = await provider.getActiveKey();
    const loaded = await new KeychainBackedKeyProvider(
      adapter,
      'service',
      'account',
      'keychain-key',
    ).getKey('keychain-key');

    expect(loaded.key).toEqual(created.key);
    expect(adapter.values.size).toBe(1);
    await expect(provider.getKey('wrong-key')).rejects.toThrow(
      'Unknown encryption key',
    );
  });

  it('rejects malformed keychain values', async () => {
    const adapter = new MemoryKeychainAdapter();
    await adapter.setSecret('service', 'account', Buffer.alloc(8).toString('base64'));

    const provider = new KeychainBackedKeyProvider(adapter, 'service', 'account');
    await expect(provider.getActiveKey()).rejects.toThrow(
      'Encryption key must be 32 bytes',
    );
  });
});

describe('secure storage repository and service edges', () => {
  it('filters, clones, updates, and deletes records', async () => {
    const repository = new InMemorySecureStorageRepository();
    const baseRecord = makeRecord('record-1', {
      provider: 'minimax',
      accountId: 'account-a',
      projectId: 'project-a',
      organizationId: 'org-a',
    });
    await repository.upsert(baseRecord);
    await repository.upsert(makeRecord('record-2', {
      provider: 'openai',
      accountId: 'account-b',
    }));

    const stored = await repository.get('record-1');
    if (!stored) {
      throw new Error('Expected stored record');
    }
    stored.status = 'revoked';

    expect((await repository.get('record-1'))?.status).toBe('active');
    expect(await repository.list({ provider: 'minimax' })).toHaveLength(1);
    expect(await repository.list({ accountId: 'account-a' })).toHaveLength(1);
    expect(await repository.list({ projectId: 'project-a' })).toHaveLength(1);
    expect(await repository.list({ organizationId: 'org-a' })).toHaveLength(1);
    expect(await repository.list({ kind: 'api_key' })).toHaveLength(2);
    expect(await repository.list({ status: 'active' })).toHaveLength(2);

    expect(await repository.updateStatus('missing', 'invalid', 'now')).toBeNull();
    expect((await repository.updateStatus('record-1', 'revoked', 'now'))?.status)
      .toBe('revoked');
    expect(await repository.delete('record-2')).toBe(true);
    expect(await repository.delete('record-2')).toBe(false);
  });

  it('handles service error paths without exposing secret payloads', async () => {
    const repository = new InMemorySecureStorageRepository();
    const service = new SecureSecretService(
      repository,
      new StaticKeyProvider(Buffer.alloc(32, 5)),
      () => new Date('2026-04-28T00:00:00.000Z'),
      () => 'service-edge-record',
    );

    await expect(service.revealCredential('missing')).rejects.toBeInstanceOf(
      SecretUnavailableError,
    );

    const sessionRecord = await service.savePlaywrightStorageState({
      scope,
      state: {
        cookies: [],
        origins: [
          {
            origin: 'https://example.test',
            localStorage: [{ name: 'marker', value: 'visible' }],
          },
        ],
      },
      metadata: { browser: 'chromium' },
    });

    await expect(service.revealCredential(sessionRecord.id)).rejects.toThrow(
      'Secret is not a credential',
    );
    expect((await repository.get(sessionRecord.id))?.metadata).toEqual({
      browser: 'chromium',
    });
  });
});

class MemoryKeychainAdapter implements KeychainAdapter {
  readonly values = new Map<string, string>();

  async getSecret(service: string, account: string): Promise<string | null> {
    return this.values.get(`${service}:${account}`) ?? null;
  }

  async setSecret(
    service: string,
    account: string,
    value: string,
  ): Promise<void> {
    this.values.set(`${service}:${account}`, value);
  }
}

function makeRecord(id: string, scopeValue: SecretRecord['scope']): SecretRecord {
  return {
    id,
    kind: 'api_key',
    scope: scopeValue,
    status: 'active',
    encryptedBlob: {
      version: 1,
      algorithm: 'aes-256-gcm',
      keyId: 'test-key',
      iv: 'aXY=',
      ciphertext: 'Y2lwaGVy',
      authTag: 'dGFn',
      aad: 'aad',
      createdAt: '2026-04-28T00:00:00.000Z',
    },
    createdAt: '2026-04-28T00:00:00.000Z',
    updatedAt: '2026-04-28T00:00:00.000Z',
  };
}
