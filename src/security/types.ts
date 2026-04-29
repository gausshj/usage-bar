export type SecretKind =
  | 'api_key'
  | 'admin_api_key'
  | 'oauth_token'
  | 'playwright_storage_state';

export type SecretStatus = 'active' | 'expired' | 'invalid' | 'revoked';

export interface SecretScope {
  provider: string;
  accountId: string;
  projectId?: string;
  organizationId?: string;
}

export interface EncryptedBlob {
  version: 1;
  algorithm: 'aes-256-gcm';
  keyId: string;
  iv: string;
  ciphertext: string;
  authTag: string;
  aad: string;
  createdAt: string;
}

export interface SecretRecord {
  id: string;
  kind: SecretKind;
  scope: SecretScope;
  status: SecretStatus;
  encryptedBlob: EncryptedBlob;
  createdAt: string;
  updatedAt: string;
  expiresAt?: string;
  lastValidatedAt?: string;
  metadata?: Record<string, unknown>;
}

export interface SecretListFilter {
  provider?: string;
  accountId?: string;
  projectId?: string;
  organizationId?: string;
  kind?: SecretKind;
  status?: SecretStatus;
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

export interface PlaywrightStorageOrigin {
  origin: string;
  localStorage: Array<{ name: string; value: string }>;
}

export interface PlaywrightStorageState {
  cookies: PlaywrightCookie[];
  origins: PlaywrightStorageOrigin[];
}
