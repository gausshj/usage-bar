import { randomUUID } from 'node:crypto';
import { encryptUtf8, decryptUtf8, createSecretAad } from './crypto.js';
import {
  derivePlaywrightStorageStateExpiry,
  isSecretRecordUsable,
} from './session.js';
import type { EncryptionKeyProvider } from './key-manager.js';
import type {
  PlaywrightStorageState,
  SecretKind,
  SecretListFilter,
  SecretRecord,
  SecretScope,
  SecretStatus,
} from './types.js';

export interface SecureStorageRepository {
  upsert(record: SecretRecord): Promise<void>;
  get(id: string): Promise<SecretRecord | null>;
  list(filter?: SecretListFilter): Promise<SecretRecord[]>;
  updateStatus(
    id: string,
    status: SecretStatus,
    updatedAt: string,
  ): Promise<SecretRecord | null>;
  delete(id: string): Promise<boolean>;
}

export class InMemorySecureStorageRepository implements SecureStorageRepository {
  private readonly records = new Map<string, SecretRecord>();

  async upsert(record: SecretRecord): Promise<void> {
    this.records.set(record.id, cloneRecord(record));
  }

  async get(id: string): Promise<SecretRecord | null> {
    const record = this.records.get(id);
    return record ? cloneRecord(record) : null;
  }

  async list(filter: SecretListFilter = {}): Promise<SecretRecord[]> {
    return [...this.records.values()]
      .filter((record) => matchesFilter(record, filter))
      .map((record) => cloneRecord(record));
  }

  async updateStatus(
    id: string,
    status: SecretStatus,
    updatedAt: string,
  ): Promise<SecretRecord | null> {
    const existing = this.records.get(id);
    if (!existing) {
      return null;
    }

    const updated = { ...existing, status, updatedAt };
    this.records.set(id, cloneRecord(updated));
    return cloneRecord(updated);
  }

  async delete(id: string): Promise<boolean> {
    return this.records.delete(id);
  }
}

export class SecretUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretUnavailableError';
  }
}

export interface SaveCredentialInput {
  kind: Exclude<SecretKind, 'playwright_storage_state'>;
  scope: SecretScope;
  value: string;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SavePlaywrightStorageStateInput {
  scope: SecretScope;
  state: PlaywrightStorageState;
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export class SecureSecretService {
  constructor(
    private readonly repository: SecureStorageRepository,
    private readonly keyProvider: EncryptionKeyProvider,
    private readonly now: () => Date = () => new Date(),
    private readonly idFactory: () => string = randomUUID,
  ) {}

  async saveCredential(input: SaveCredentialInput): Promise<SecretRecord> {
    return this.saveSecret({
      kind: input.kind,
      scope: input.scope,
      plaintext: input.value,
      expiresAt: input.expiresAt,
      metadata: input.metadata,
    });
  }

  async revealCredential(id: string): Promise<string> {
    const record = await this.getUsableRecord(id);
    if (record.kind === 'playwright_storage_state') {
      throw new SecretUnavailableError('Secret is not a credential');
    }
    return decryptUtf8(
      record.encryptedBlob,
      this.aadForRecord(record),
      this.keyProvider,
    );
  }

  async savePlaywrightStorageState(
    input: SavePlaywrightStorageStateInput,
  ): Promise<SecretRecord> {
    return this.saveSecret({
      kind: 'playwright_storage_state',
      scope: input.scope,
      plaintext: JSON.stringify(input.state),
      expiresAt:
        input.expiresAt ?? derivePlaywrightStorageStateExpiry(input.state),
      metadata: input.metadata,
    });
  }

  async revealPlaywrightStorageState(
    id: string,
  ): Promise<PlaywrightStorageState> {
    const record = await this.getUsableRecord(id);
    if (record.kind !== 'playwright_storage_state') {
      throw new SecretUnavailableError('Secret is not a Playwright session');
    }

    const plaintext = await decryptUtf8(
      record.encryptedBlob,
      this.aadForRecord(record),
      this.keyProvider,
    );
    return JSON.parse(plaintext) as PlaywrightStorageState;
  }

  async markStatus(
    id: string,
    status: SecretStatus,
  ): Promise<SecretRecord | null> {
    return this.repository.updateStatus(
      id,
      status,
      this.now().toISOString(),
    );
  }

  private async saveSecret(input: {
    kind: SecretKind;
    scope: SecretScope;
    plaintext: string;
    expiresAt?: string | undefined;
    metadata?: Record<string, unknown> | undefined;
  }): Promise<SecretRecord> {
    const id = this.idFactory();
    const timestamp = this.now().toISOString();
    const aad = createSecretAad({
      id,
      kind: input.kind,
      provider: input.scope.provider,
      accountId: input.scope.accountId,
      projectId: input.scope.projectId,
      organizationId: input.scope.organizationId,
    });
    const encryptedBlob = await encryptUtf8(
      input.plaintext,
      aad,
      this.keyProvider,
      this.now(),
    );

    const record: SecretRecord = {
      id,
      kind: input.kind,
      scope: input.scope,
      status: 'active' as const,
      encryptedBlob,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    if (input.expiresAt) {
      record.expiresAt = input.expiresAt;
    }
    if (input.metadata) {
      record.metadata = input.metadata;
    }

    await this.repository.upsert(record);
    return record;
  }

  private async getUsableRecord(id: string): Promise<SecretRecord> {
    const record = await this.repository.get(id);
    if (!record) {
      throw new SecretUnavailableError('Secret not found');
    }
    if (!isSecretRecordUsable(record, this.now())) {
      throw new SecretUnavailableError(`Secret is ${record.status}`);
    }
    return record;
  }

  private aadForRecord(record: SecretRecord): string {
    return createSecretAad({
      id: record.id,
      kind: record.kind,
      provider: record.scope.provider,
      accountId: record.scope.accountId,
      projectId: record.scope.projectId,
      organizationId: record.scope.organizationId,
    });
  }
}

function matchesFilter(record: SecretRecord, filter: SecretListFilter): boolean {
  return (
    (!filter.provider || record.scope.provider === filter.provider) &&
    (!filter.accountId || record.scope.accountId === filter.accountId) &&
    (!filter.projectId || record.scope.projectId === filter.projectId) &&
    (!filter.organizationId ||
      record.scope.organizationId === filter.organizationId) &&
    (!filter.kind || record.kind === filter.kind) &&
    (!filter.status || record.status === filter.status)
  );
}

function cloneRecord(record: SecretRecord): SecretRecord {
  return structuredClone(record) as SecretRecord;
}
