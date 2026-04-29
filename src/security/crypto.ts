import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EncryptedBlob } from './types.js';
import type { EncryptionKeyProvider } from './key-manager.js';

const IV_LENGTH_BYTES = 12;

export async function encryptUtf8(
  plaintext: string,
  aad: string,
  keyProvider: EncryptionKeyProvider,
  now = new Date(),
): Promise<EncryptedBlob> {
  const activeKey = await keyProvider.getActiveKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv('aes-256-gcm', activeKey.key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));

  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return {
    version: 1,
    algorithm: 'aes-256-gcm',
    keyId: activeKey.keyId,
    iv: iv.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64'),
    aad,
    createdAt: now.toISOString(),
  };
}

export async function decryptUtf8(
  blob: EncryptedBlob,
  expectedAad: string,
  keyProvider: EncryptionKeyProvider,
): Promise<string> {
  if (blob.version !== 1 || blob.algorithm !== 'aes-256-gcm') {
    throw new Error('Unsupported encrypted blob format');
  }
  if (blob.aad !== expectedAad) {
    throw new Error('Encrypted blob scope mismatch');
  }

  const key = await keyProvider.getKey(blob.keyId);
  const decipher = createDecipheriv(
    'aes-256-gcm',
    key.key,
    Buffer.from(blob.iv, 'base64'),
  );
  decipher.setAAD(Buffer.from(blob.aad, 'utf8'));
  decipher.setAuthTag(Buffer.from(blob.authTag, 'base64'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(blob.ciphertext, 'base64')),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

export function createSecretAad(input: {
  id: string;
  kind: string;
  provider: string;
  accountId: string;
  projectId?: string | undefined;
  organizationId?: string | undefined;
}): string {
  return JSON.stringify({
    id: input.id,
    kind: input.kind,
    provider: input.provider,
    accountId: input.accountId,
    projectId: input.projectId ?? null,
    organizationId: input.organizationId ?? null,
  });
}
