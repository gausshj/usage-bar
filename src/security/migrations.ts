export const SECURITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS secure_secrets (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  account_id TEXT NOT NULL,
  project_id TEXT,
  organization_id TEXT,
  secret_kind TEXT NOT NULL,
  status TEXT NOT NULL,
  encrypted_blob_json TEXT NOT NULL,
  expires_at TEXT,
  last_validated_at TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_secure_secrets_scope
  ON secure_secrets (provider, account_id, project_id, organization_id);

CREATE INDEX IF NOT EXISTS idx_secure_secrets_status
  ON secure_secrets (status, expires_at);
`.trim();
