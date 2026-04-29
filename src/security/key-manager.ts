import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface EncryptionKey {
  keyId: string;
  key: Buffer;
}

export interface EncryptionKeyProvider {
  getActiveKey(): Promise<EncryptionKey>;
  getKey(keyId: string): Promise<EncryptionKey>;
}

export interface KeychainAdapter {
  getSecret(service: string, account: string): Promise<string | null>;
  setSecret(service: string, account: string, value: string): Promise<void>;
}

export class StaticKeyProvider implements EncryptionKeyProvider {
  private readonly activeKey: EncryptionKey;

  constructor(key: Buffer | string, keyId = 'static-test-key') {
    const bytes = Buffer.isBuffer(key) ? key : Buffer.from(key, 'base64');
    assertKeyLength(bytes);
    this.activeKey = { keyId, key: Buffer.from(bytes) };
  }

  async getActiveKey(): Promise<EncryptionKey> {
    return cloneKey(this.activeKey);
  }

  async getKey(keyId: string): Promise<EncryptionKey> {
    if (keyId !== this.activeKey.keyId) {
      throw new Error(`Unknown encryption key: ${keyId}`);
    }
    return cloneKey(this.activeKey);
  }
}

export class LocalFallbackKeyProvider implements EncryptionKeyProvider {
  constructor(
    private readonly keyPath = 'data/security/master.key',
    private readonly keyId = 'local-fallback-v1',
  ) {}

  async getActiveKey(): Promise<EncryptionKey> {
    return this.getKey(this.keyId);
  }

  async getKey(keyId: string): Promise<EncryptionKey> {
    if (keyId !== this.keyId) {
      throw new Error(`Unknown encryption key: ${keyId}`);
    }

    const key = await this.readOrCreateKey();
    return { keyId: this.keyId, key };
  }

  private async readOrCreateKey(): Promise<Buffer> {
    try {
      const existing = (await readFile(this.keyPath, 'utf8')).trim();
      const key = Buffer.from(existing, 'base64');
      assertKeyLength(key);
      return key;
    } catch (error) {
      if (!isNotFoundError(error)) {
        throw error;
      }
    }

    const key = randomBytes(32);
    await mkdir(dirname(this.keyPath), { recursive: true });
    await writeFile(this.keyPath, key.toString('base64'), {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(this.keyPath, 0o600);
    return key;
  }
}

export class KeychainBackedKeyProvider implements EncryptionKeyProvider {
  constructor(
    private readonly adapter: KeychainAdapter,
    private readonly service = 'usage-bar',
    private readonly account = 'security-master-key',
    private readonly keyId = 'os-keychain-v1',
  ) {}

  async getActiveKey(): Promise<EncryptionKey> {
    return this.getKey(this.keyId);
  }

  async getKey(keyId: string): Promise<EncryptionKey> {
    if (keyId !== this.keyId) {
      throw new Error(`Unknown encryption key: ${keyId}`);
    }

    const encoded = await this.adapter.getSecret(this.service, this.account);
    if (encoded) {
      const key = Buffer.from(encoded, 'base64');
      assertKeyLength(key);
      return { keyId: this.keyId, key };
    }

    const key = randomBytes(32);
    await this.adapter.setSecret(
      this.service,
      this.account,
      key.toString('base64'),
    );
    return { keyId: this.keyId, key };
  }
}

function assertKeyLength(key: Buffer): void {
  if (key.byteLength !== 32) {
    throw new Error('Encryption key must be 32 bytes for AES-256-GCM');
  }
}

function cloneKey(input: EncryptionKey): EncryptionKey {
  return { keyId: input.keyId, key: Buffer.from(input.key) };
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ENOENT'
  );
}
