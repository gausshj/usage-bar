// ============================================================================
// src/quota/credentials.ts
// Credential resolution with scope validation (PRD §11.2 / issue #22).
//
// Providers should NOT receive raw tokens directly. They receive a
// `credentialId` and resolve the secret through a CredentialResolver, which
// verifies that the stored credential's scope (provider / account / kind)
// matches what the adapter expects before revealing the plaintext.
//
// For Local Alpha, environment variables remain a supported fallback: when no
// credentialId is configured, a provider may still read its token from env.
// ============================================================================

import type { SecretKind, SecretScope } from '../security/types.js';

/**
 * The minimal surface a provider needs to resolve a credentialId to a secret
 * value. Implemented by the real SecureSecretService-backed resolver and by
 * test doubles.
 */
export interface CredentialResolver {
  /**
   * Reveal the plaintext for a credential id, verifying its scope matches
   * `expected` first. Throws if the credential is missing, wrong scope, or
   * wrong kind. NEVER logs or leaks the plaintext.
   */
  reveal(credentialId: string, expected: ExpectedScope): Promise<string>;
}

/** The scope/kind an adapter requires for a given credential. */
export interface ExpectedScope {
  provider: string;
  accountId?: string;
  kind: SecretKind;
}

/** Thrown when a credential's scope doesn't match what the adapter expects. */
export class CredentialScopeMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialScopeMismatchError';
  }
}

/** Thrown when the credential cannot be revealed (missing, expired, revoked). */
export class CredentialUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CredentialUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Default implementation backed by the security module
// ---------------------------------------------------------------------------

interface SecureSecretServiceLike {
  revealCredential(id: string): Promise<string>;
}

interface SecureStorageRepositoryLike {
  /** Public record lookup used for scope validation. */
  get(id: string): Promise<SecretRecordLike | null>;
}

interface SecretRecordLike {
  kind: SecretKind;
  scope: SecretScope;
  status: string;
}

/**
 * Wraps the SecureSecretService, adding scope validation on top of reveal.
 * The repository provides the record for scope checks; the service decrypts.
 * This asserts the credential's scope/kind match the caller's expectation (#22).
 */
export class SecureCredentialResolver implements CredentialResolver {
  constructor(
    private readonly repository: SecureStorageRepositoryLike,
    private readonly service: SecureSecretServiceLike,
  ) {}

  async reveal(credentialId: string, expected: ExpectedScope): Promise<string> {
    const record = await this.repository.get(credentialId);
    if (!record) {
      throw new CredentialUnavailableError(`credential not found: ${credentialId}`);
    }
    if (record.status !== 'active') {
      throw new CredentialUnavailableError(`credential not active: ${credentialId}`);
    }
    if (record.kind !== expected.kind) {
      throw new CredentialScopeMismatchError(
        `credential kind mismatch: expected ${expected.kind}, got ${record.kind}`,
      );
    }
    if (record.scope.provider !== expected.provider) {
      throw new CredentialScopeMismatchError(
        `credential provider mismatch: expected ${expected.provider}, got ${record.scope.provider}`,
      );
    }
    if (expected.accountId && record.scope.accountId !== expected.accountId) {
      throw new CredentialScopeMismatchError(
        `credential account mismatch: expected ${expected.accountId}, got ${record.scope.accountId}`,
      );
    }
    return this.service.revealCredential(credentialId);
  }
}

// ---------------------------------------------------------------------------
// Test / env fallback helpers
// ---------------------------------------------------------------------------

/** A resolver that always fails — used when no credential store is wired. */
export class NoopCredentialResolver implements CredentialResolver {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async reveal(credentialId: string, _expected?: ExpectedScope): Promise<string> {
    throw new CredentialUnavailableError(`no credential store configured (id: ${credentialId})`);
  }
}
