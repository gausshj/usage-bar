import { randomUUID } from 'node:crypto';
import type { ConnectorFactory } from '../connectors/index.js';
import type { SecureSecretService } from '../security/index.js';
import type {
  EnqueueProviderSyncInput,
  WorkerJob,
  WorkerJobInput,
  WorkerJobRepository,
  WorkerJobResult,
  WorkerRunResult,
  WorkerSchedulerOptions,
} from './types.js';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;

export class WorkerScheduler {
  private readonly workerId: string;
  private readonly maxAttempts: number;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(
    private readonly repository: WorkerJobRepository,
    private readonly connectorFactory: ConnectorFactory,
    private readonly secrets: SecureSecretService,
    options: WorkerSchedulerOptions,
  ) {
    this.workerId = options.workerId;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.retryBaseDelayMs =
      options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
    this.retryMaxDelayMs =
      options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async enqueueProviderSync(
    input: EnqueueProviderSyncInput,
  ): Promise<WorkerJob> {
    const timestamp = this.now().toISOString();
    const idempotencyKey =
      input.idempotencyKey ?? createProviderSyncIdempotencyKey(input);

    const existing = await this.repository.getByIdempotencyKey(idempotencyKey);
    if (existing) {
      return existing;
    }

    return this.repository.enqueue({
      id: this.idFactory(),
      type: 'sync_provider_usage',
      status: 'queued',
      input: buildWorkerJobInput(input),
      idempotencyKey,
      attempts: 0,
      maxAttempts: input.maxAttempts ?? this.maxAttempts,
      runAfter: input.runAfter ?? timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
  }

  async runOnce(): Promise<WorkerRunResult> {
    const now = this.now();
    const job = await this.repository.claimNext(now, this.workerId);
    if (!job) {
      return { processed: 0, succeeded: 0, failed: 0 };
    }

    try {
      const result = await this.execute(job);
      await this.repository.complete(job.id, result, this.now());
      return { processed: 1, succeeded: 1, failed: 0 };
    } catch (error) {
      const failedAttempts = job.attempts + 1;
      const nextRunAt =
        failedAttempts >= job.maxAttempts
          ? null
          : new Date(
              this.now().getTime() +
                computeRetryDelayMs(
                  failedAttempts,
                  this.retryBaseDelayMs,
                  this.retryMaxDelayMs,
                ),
            );

      await this.repository.fail(
        job.id,
        serializeWorkerError(error),
        nextRunAt,
        this.now(),
      );
      return { processed: 1, succeeded: 0, failed: 1 };
    }
  }

  async drain(maxJobs = 100): Promise<WorkerRunResult> {
    const total: WorkerRunResult = { processed: 0, succeeded: 0, failed: 0 };

    for (let index = 0; index < maxJobs; index++) {
      const result = await this.runOnce();
      total.processed += result.processed;
      total.succeeded += result.succeeded;
      total.failed += result.failed;

      if (result.processed === 0) {
        break;
      }
    }

    return total;
  }

  private async execute(job: WorkerJob): Promise<WorkerJobResult> {
    switch (job.type) {
      case 'sync_provider_usage':
        return this.executeProviderSync(job);
      default:
        return assertNever(job.type);
    }
  }

  private async executeProviderSync(job: WorkerJob): Promise<WorkerJobResult> {
    const credential = await this.secrets.revealCredential(job.input.accountId);
    const records = await this.connectorFactory.fetchNormalized(
      job.input.provider,
      {
        apiKey: credential,
        adminApiKey: credential,
      },
      job.input.startTime,
      job.input.endTime,
    );

    return { records };
  }
}

export function createProviderSyncIdempotencyKey(
  input: Omit<EnqueueProviderSyncInput, 'idempotencyKey' | 'runAfter' | 'maxAttempts'>,
): string {
  return [
    input.provider,
    input.accountId,
    input.projectId ?? '',
    input.organizationId ?? '',
    input.startTime,
    input.endTime,
  ].join(':');
}

export function computeRetryDelayMs(
  failedAttempts: number,
  baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
  maxDelayMs = DEFAULT_RETRY_MAX_DELAY_MS,
): number {
  const exponent = Math.max(0, failedAttempts - 1);
  return Math.min(baseDelayMs * 2 ** exponent, maxDelayMs);
}

export function serializeWorkerError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function assertNever(value: never): never {
  throw new Error(`Unsupported worker job type: ${String(value)}`);
}

function buildWorkerJobInput(input: EnqueueProviderSyncInput): WorkerJobInput {
  const jobInput: WorkerJobInput = {
    provider: input.provider,
    accountId: input.accountId,
    startTime: input.startTime,
    endTime: input.endTime,
  };
  if (input.projectId !== undefined) {
    jobInput.projectId = input.projectId;
  }
  if (input.organizationId !== undefined) {
    jobInput.organizationId = input.organizationId;
  }
  return jobInput;
}
