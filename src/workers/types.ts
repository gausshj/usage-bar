import type { NormalizedRecord, ProviderName } from '../connectors/index.js';

export type WorkerJobType = 'sync_provider_usage';

export type WorkerJobStatus =
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'retry_scheduled'
  | 'dead';

export interface WorkerJobInput {
  provider: ProviderName;
  accountId: string;
  startTime: number;
  endTime: number;
  projectId?: string;
  organizationId?: string;
}

export interface WorkerJobResult {
  records: NormalizedRecord[];
}

export interface WorkerJob {
  id: string;
  type: WorkerJobType;
  status: WorkerJobStatus;
  input: WorkerJobInput;
  idempotencyKey: string;
  attempts: number;
  maxAttempts: number;
  runAfter: string;
  createdAt: string;
  updatedAt: string;
  lockedAt?: string;
  lockOwner?: string;
  lastError?: string;
  result?: WorkerJobResult;
}

export interface EnqueueProviderSyncInput extends WorkerJobInput {
  idempotencyKey?: string;
  runAfter?: string;
  maxAttempts?: number;
}

export interface WorkerJobRepository {
  enqueue(job: WorkerJob): Promise<WorkerJob>;
  getById(id: string): Promise<WorkerJob | null>;
  getByIdempotencyKey(idempotencyKey: string): Promise<WorkerJob | null>;
  claimNext(now: Date, workerId: string): Promise<WorkerJob | null>;
  complete(id: string, result: WorkerJobResult, now: Date): Promise<WorkerJob>;
  fail(
    id: string,
    error: string,
    nextRunAfter: Date | null,
    now: Date,
  ): Promise<WorkerJob>;
  list(status?: WorkerJobStatus): Promise<WorkerJob[]>;
}

export interface WorkerSchedulerOptions {
  workerId: string;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  now?: () => Date;
  idFactory?: () => string;
}

export interface WorkerRunResult {
  processed: number;
  succeeded: number;
  failed: number;
}
