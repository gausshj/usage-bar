export const WORKER_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS worker_jobs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  run_after TEXT NOT NULL,
  locked_at TEXT,
  lock_owner TEXT,
  last_error TEXT,
  result_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_worker_jobs_claim
  ON worker_jobs (status, run_after, created_at);

CREATE INDEX IF NOT EXISTS idx_worker_jobs_idempotency
  ON worker_jobs (idempotency_key);
`.trim();
