import { describe, expect, it } from 'vitest';
import {
  decryptUtf8,
  InMemorySecureStorageRepository,
  SecretUnavailableError,
  SecureSecretService,
  StaticKeyProvider,
  type EncryptedBlob,
} from '../../src/security/index.js';

const testKey = Buffer.alloc(32, 7);
const scope = {
  provider: 'openai',
  accountId: 'acct_123',
  projectId: 'proj_456',
};

describe('SecureSecretService', () => {
  it('rejects unsupported encrypted blob formats before decrypting', async () => {
    const blob: EncryptedBlob = {
      version: 2 as EncryptedBlob['version'],
      algorithm: 'aes-256-gcm',
      keyId: 'static-test-key',
      iv: Buffer.alloc(12).toString('base64'),
      ciphertext: Buffer.from('ciphertext').toString('base64'),
      authTag: Buffer.alloc(16).toString('base64'),
      aad: 'scope',
      createdAt: '2026-04-28T00:00:00.000Z',
    };

    await expect(
      decryptUtf8(blob, 'scope', new StaticKeyProvider(testKey)),
    ).rejects.toThrow('Unsupported encrypted blob format');
  });

  it('encrypts stored credentials and decrypts them through the service', async () => {
    const repository = new InMemorySecureStorageRepository();
    const service = new SecureSecretService(
      repository,
      new StaticKeyProvider(testKey),
      () => new Date('2026-04-28T00:00:00.000Z'),
      () => 'secret-1',
    );

    const record = await service.saveCredential({
      kind: 'api_key',
      scope,
      value: 'opaque-value-alpha',
    });

    const stored = await repository.get(record.id);
    expect(stored).not.toBeNull();
    expect(stored?.encryptedBlob.ciphertext).not.toContain(
      'opaque-value-alpha',
    );
    await expect(service.revealCredential(record.id)).resolves.toBe(
      'opaque-value-alpha',
    );
  });

  it('rejects decryption when the scope-bound AAD is changed', async () => {
    const repository = new InMemorySecureStorageRepository();
    const service = new SecureSecretService(
      repository,
      new StaticKeyProvider(testKey),
      () => new Date('2026-04-28T00:00:00.000Z'),
      () => 'secret-2',
    );

    const record = await service.saveCredential({
      kind: 'admin_api_key',
      scope,
      value: 'opaque-value-admin',
    });
    const stored = await repository.get(record.id);
    if (!stored) {
      throw new Error('Expected stored record');
    }

    stored.encryptedBlob.aad = stored.encryptedBlob.aad.replace(
      'openai',
      'minimax',
    );
    await repository.upsert(stored);

    await expect(service.revealCredential(record.id)).rejects.toThrow(
      'Encrypted blob scope mismatch',
    );
  });

  it('blocks expired and invalid credentials', async () => {
    const repository = new InMemorySecureStorageRepository();
    const service = new SecureSecretService(
      repository,
      new StaticKeyProvider(testKey),
      () => new Date('2026-04-28T00:00:00.000Z'),
      () => 'secret-3',
    );

    const expired = await service.saveCredential({
      kind: 'api_key',
      scope,
      value: 'opaque-value-expired',
      expiresAt: '2026-04-27T23:59:59.000Z',
    });
    await expect(service.revealCredential(expired.id)).rejects.toBeInstanceOf(
      SecretUnavailableError,
    );

    const invalid = await service.saveCredential({
      kind: 'api_key',
      scope,
      value: 'opaque-value-invalid',
    });
    await service.markStatus(invalid.id, 'invalid');
    await expect(service.revealCredential(invalid.id)).rejects.toBeInstanceOf(
      SecretUnavailableError,
    );
  });

  it('encrypts and restores Playwright storage state', async () => {
    const repository = new InMemorySecureStorageRepository();
    const service = new SecureSecretService(
      repository,
      new StaticKeyProvider(testKey),
      () => new Date('2026-04-28T00:00:00.000Z'),
      () => 'session-1',
    );

    const state = {
      cookies: [
        {
          name: 'sid',
          value: 'opaque-value-cookie',
          domain: 'example.test',
          path: '/',
          expires: 1_777_500_000,
          httpOnly: true,
          secure: true,
          sameSite: 'Lax' as const,
        },
      ],
      origins: [],
    };

    const record = await service.savePlaywrightStorageState({ scope, state });
    const stored = await repository.get(record.id);
    expect(stored?.expiresAt).toBe('2026-04-29T22:00:00.000Z');
    expect(stored?.encryptedBlob.ciphertext).not.toContain(
      'opaque-value-cookie',
    );
    await expect(service.revealPlaywrightStorageState(record.id)).resolves.toEqual(
      state,
    );
  });

  it('uses default time and id factories when none are supplied', async () => {
    const repository = new InMemorySecureStorageRepository();
    const service = new SecureSecretService(
      repository,
      new StaticKeyProvider(testKey),
    );

    const record = await service.saveCredential({
      kind: 'api_key',
      scope,
      value: 'opaque-defaults',
    });

    expect(record.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    expect(Date.parse(record.createdAt)).not.toBeNaN();
  });

  it('rejects credential records when revealing Playwright storage state', async () => {
    const repository = new InMemorySecureStorageRepository();
    const service = new SecureSecretService(
      repository,
      new StaticKeyProvider(testKey),
      () => new Date('2026-04-28T00:00:00.000Z'),
      () => 'secret-credential',
    );

    const record = await service.saveCredential({
      kind: 'api_key',
      scope,
      value: 'opaque-value-alpha',
    });

    await expect(
      service.revealPlaywrightStorageState(record.id),
    ).rejects.toThrow('Secret is not a Playwright session');
  });
});
