import { describe, expect, it } from 'vitest';
import {
  InMemorySecureStorageRepository,
  SecureSecretService,
  StaticKeyProvider,
} from '../../src/security/index.js';
import {
  InMemoryWorkerJobRepository,
  WorkerScheduler,
  computeRetryDelayMs,
  createProviderSyncIdempotencyKey,
  serializeWorkerError,
} from '../../src/workers/index.js';
import type {
  AnyConnectorConfig,
  ConnectorFactory,
  NormalizedRecord,
  ProviderName,
} from '../../src/connectors/index.js';

const baseDate = new Date('2026-04-29T00:00:00.000Z');

describe('WorkerScheduler', () => {
  it('deduplicates provider sync jobs by idempotency key', async () => {
    const scheduler = makeScheduler();
    const input = {
      provider: 'minimax' as const,
      accountId: 'credential-1',
      startTime: 100,
      endTime: 200,
    };

    const first = await scheduler.enqueueProviderSync(input);
    const second = await scheduler.enqueueProviderSync(input);

    expect(second.id).toBe(first.id);
    expect(second.idempotencyKey).toBe(
      createProviderSyncIdempotencyKey(input),
    );
  });

  it('stores explicit project, organization, runAfter, and maxAttempts values', async () => {
    const scheduler = makeScheduler();
    const input = {
      provider: 'openai' as const,
      accountId: 'credential-1',
      startTime: 100,
      endTime: 200,
      projectId: 'project-1',
      organizationId: 'organization-1',
      runAfter: '2026-04-29T12:34:56.000Z',
      maxAttempts: 5,
    };

    const job = await scheduler.enqueueProviderSync(input);
    const stored = await scheduler.jobRepository.getById(job.id);

    expect(stored).toMatchObject({
      input: {
        provider: 'openai',
        accountId: 'credential-1',
        startTime: 100,
        endTime: 200,
        projectId: 'project-1',
        organizationId: 'organization-1',
      },
      runAfter: '2026-04-29T12:34:56.000Z',
      maxAttempts: 5,
    });
  });

  it('claims and executes a provider sync job through the connector factory', async () => {
    const records: NormalizedRecord[] = [
      {
        provider: 'openai',
        date: '2026-04-29',
        model: 'gpt-test',
        requests: 1,
        input_tokens: 10,
        output_tokens: 20,
        cost_usd: 0.01,
      },
    ];
    const connectorFactory = new FakeConnectorFactory(records);
    const scheduler = makeScheduler({ connectorFactory });

    await scheduler.enqueueProviderSync({
      provider: 'openai',
      accountId: 'credential-1',
      startTime: 100,
      endTime: 200,
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      processed: 1,
      succeeded: 1,
      failed: 0,
    });

    const completed = await scheduler.jobRepository.list('succeeded');
    expect(completed).toHaveLength(1);
    expect(completed[0]?.result?.records).toEqual(records);
    expect(connectorFactory.calls[0]).toMatchObject({
      provider: 'openai',
      startTime: 100,
      endTime: 200,
    });
  });

  it('returns an empty result when no job is claimable', async () => {
    const scheduler = makeScheduler();

    await expect(scheduler.runOnce()).resolves.toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0,
    });
  });

  it('retries failed jobs and moves exhausted jobs to dead', async () => {
    const connectorFactory = new FakeConnectorFactory([], new Error('temporary'));
    const scheduler = makeScheduler({
      connectorFactory,
      maxAttempts: 2,
      retryBaseDelayMs: 1_000,
    });

    await scheduler.enqueueProviderSync({
      provider: 'zhipu',
      accountId: 'credential-1',
      startTime: 100,
      endTime: 200,
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
    });
    const retrying = await scheduler.jobRepository.list('retry_scheduled');
    expect(retrying[0]?.attempts).toBe(1);
    expect(retrying[0]?.lastError).toBe('temporary');

    scheduler.advanceMs(1_000);
    await expect(scheduler.runOnce()).resolves.toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
    });
    const dead = await scheduler.jobRepository.list('dead');
    expect(dead[0]?.attempts).toBe(2);
  });

  it('moves exhausted jobs to dead when no retries remain', async () => {
    const connectorFactory = new FakeConnectorFactory([], new Error('boom'));
    const scheduler = makeScheduler({
      connectorFactory,
      maxAttempts: 1,
    });

    const job = await scheduler.enqueueProviderSync({
      provider: 'zhipu',
      accountId: 'credential-1',
      startTime: 100,
      endTime: 200,
      maxAttempts: 1,
    });

    await expect(scheduler.runOnce()).resolves.toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
    });

    const stored = await scheduler.jobRepository.getById(job.id);
    expect(stored).toMatchObject({
      status: 'dead',
      attempts: 1,
      lastError: 'boom',
    });
  });

  it('drains until no claimable jobs remain', async () => {
    const scheduler = makeScheduler({
      connectorFactory: new FakeConnectorFactory([]),
    });
    await scheduler.enqueueProviderSync({
      provider: 'openai',
      accountId: 'credential-1',
      startTime: 100,
      endTime: 200,
    });
    await scheduler.enqueueProviderSync({
      provider: 'minimax',
      accountId: 'credential-1',
      startTime: 200,
      endTime: 300,
    });

    await expect(scheduler.drain()).resolves.toEqual({
      processed: 2,
      succeeded: 2,
      failed: 0,
    });
    await expect(scheduler.runOnce()).resolves.toEqual({
      processed: 0,
      succeeded: 0,
      failed: 0,
    });
  });

  it('computes capped exponential retry delays', () => {
    expect(computeRetryDelayMs(1, 100, 1_000)).toBe(100);
    expect(computeRetryDelayMs(2, 100, 1_000)).toBe(200);
    expect(computeRetryDelayMs(10, 100, 1_000)).toBe(1_000);
  });
});

describe('InMemoryWorkerJobRepository', () => {
  it('returns null for missing lookups and claim attempts', async () => {
    const repository = new InMemoryWorkerJobRepository();

    await expect(repository.getById('missing')).resolves.toBeNull();
    await expect(repository.getByIdempotencyKey('missing')).resolves.toBeNull();
    await expect(repository.claimNext(baseDate, 'worker-a')).resolves.toBeNull();
  });

  it('returns the existing job when enqueue sees a duplicate idempotency key', async () => {
    const repository = new InMemoryWorkerJobRepository();
    const queuedAt = baseDate.toISOString();

    const first = await repository.enqueue({
      id: 'job-1',
      type: 'sync_provider_usage',
      status: 'queued',
      input: {
        provider: 'openai',
        accountId: 'credential-1',
        startTime: 100,
        endTime: 200,
      },
      idempotencyKey: 'duplicate-key',
      attempts: 0,
      maxAttempts: 3,
      runAfter: queuedAt,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    });
    const second = await repository.enqueue({
      id: 'job-2',
      type: 'sync_provider_usage',
      status: 'queued',
      input: {
        provider: 'minimax',
        accountId: 'credential-1',
        startTime: 300,
        endTime: 400,
      },
      idempotencyKey: 'duplicate-key',
      attempts: 0,
      maxAttempts: 3,
      runAfter: queuedAt,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    });

    expect(second).toMatchObject({
      id: first.id,
      idempotencyKey: 'duplicate-key',
      input: first.input,
    });
    await expect(repository.list()).resolves.toHaveLength(1);
  });

  it('claims the earliest claimable job and filters list(status)', async () => {
    const repository = new InMemoryWorkerJobRepository();
    const queuedAt = baseDate.toISOString();
    const laterQueuedAt = new Date(baseDate.getTime() + 60_000).toISOString();

    await repository.enqueue({
      id: 'job-running',
      type: 'sync_provider_usage',
      status: 'running',
      input: {
        provider: 'openai',
        accountId: 'credential-1',
        startTime: 100,
        endTime: 200,
      },
      idempotencyKey: 'job-running-key',
      attempts: 0,
      maxAttempts: 3,
      runAfter: queuedAt,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    });
    await repository.enqueue({
      id: 'job-queued',
      type: 'sync_provider_usage',
      status: 'queued',
      input: {
        provider: 'minimax',
        accountId: 'credential-1',
        startTime: 300,
        endTime: 400,
      },
      idempotencyKey: 'job-queued-key',
      attempts: 0,
      maxAttempts: 3,
      runAfter: laterQueuedAt,
      createdAt: laterQueuedAt,
      updatedAt: laterQueuedAt,
    });
    await repository.enqueue({
      id: 'job-retry',
      type: 'sync_provider_usage',
      status: 'retry_scheduled',
      input: {
        provider: 'zhipu',
        accountId: 'credential-1',
        startTime: 500,
        endTime: 600,
      },
      idempotencyKey: 'job-retry-key',
      attempts: 1,
      maxAttempts: 3,
      runAfter: queuedAt,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    });

    const claimed = await repository.claimNext(baseDate, 'worker-a');
    expect(claimed).toMatchObject({
      id: 'job-retry',
      status: 'running',
      lockOwner: 'worker-a',
    });

    await expect(repository.list('queued')).resolves.toHaveLength(1);
    await expect(repository.list('retry_scheduled')).resolves.toHaveLength(0);
    await expect(repository.list('running')).resolves.toHaveLength(2);
  });

  it('orders claimable jobs by runAfter before createdAt', async () => {
    const repository = new InMemoryWorkerJobRepository();
    const claimTime = new Date(baseDate.getTime() + 120_000);
    const earlierRunAfter = baseDate.toISOString();
    const laterRunAfter = new Date(baseDate.getTime() + 60_000).toISOString();
    const earlierCreatedAt = baseDate.toISOString();
    const laterCreatedAt = new Date(baseDate.getTime() + 30_000).toISOString();

    await repository.enqueue({
      id: 'job-later',
      type: 'sync_provider_usage',
      status: 'queued',
      input: {
        provider: 'openai',
        accountId: 'credential-1',
        startTime: 100,
        endTime: 200,
      },
      idempotencyKey: 'job-later-key',
      attempts: 0,
      maxAttempts: 3,
      runAfter: laterRunAfter,
      createdAt: earlierCreatedAt,
      updatedAt: earlierCreatedAt,
    });
    await repository.enqueue({
      id: 'job-earlier',
      type: 'sync_provider_usage',
      status: 'queued',
      input: {
        provider: 'minimax',
        accountId: 'credential-1',
        startTime: 300,
        endTime: 400,
      },
      idempotencyKey: 'job-earlier-key',
      attempts: 0,
      maxAttempts: 3,
      runAfter: earlierRunAfter,
      createdAt: laterCreatedAt,
      updatedAt: laterCreatedAt,
    });

    const claimed = await repository.claimNext(claimTime, 'worker-a');
    expect(claimed?.id).toBe('job-earlier');
  });

  it('updates state through complete and fail and filters list(status)', async () => {
    const repository = new InMemoryWorkerJobRepository();
    const queuedAt = baseDate.toISOString();
    const retryAt = new Date(baseDate.getTime() + 60_000);

    const completedJob = await repository.enqueue({
      id: 'job-complete',
      type: 'sync_provider_usage',
      status: 'queued',
      input: {
        provider: 'openai',
        accountId: 'credential-1',
        startTime: 100,
        endTime: 200,
      },
      idempotencyKey: 'job-complete-key',
      attempts: 0,
      maxAttempts: 3,
      runAfter: queuedAt,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    });
    const failedJob = await repository.enqueue({
      id: 'job-fail',
      type: 'sync_provider_usage',
      status: 'queued',
      input: {
        provider: 'minimax',
        accountId: 'credential-1',
        startTime: 300,
        endTime: 400,
      },
      idempotencyKey: 'job-fail-key',
      attempts: 0,
      maxAttempts: 3,
      runAfter: queuedAt,
      createdAt: queuedAt,
      updatedAt: queuedAt,
    });

    const completed = await repository.complete(
      completedJob.id,
      { records: [] as NormalizedRecord[] },
      baseDate,
    );
    const failed = await repository.fail(
      failedJob.id,
      'temporary',
      retryAt,
      baseDate,
    );

    expect(completed).toMatchObject({
      status: 'succeeded',
      result: { records: [] },
    });
    expect(failed).toMatchObject({
      status: 'retry_scheduled',
      attempts: 1,
      lastError: 'temporary',
      runAfter: retryAt.toISOString(),
    });

    await expect(repository.list('succeeded')).resolves.toHaveLength(1);
    await expect(repository.list('retry_scheduled')).resolves.toHaveLength(1);
    await expect(repository.list('queued')).resolves.toHaveLength(0);
  });

  it('throws when complete or fail targets a missing job', async () => {
    const repository = new InMemoryWorkerJobRepository();

    await expect(
      repository.complete('missing', { records: [] }, baseDate),
    ).rejects.toThrow('Worker job not found: missing');
    await expect(
      repository.fail('missing', 'boom', baseDate, baseDate),
    ).rejects.toThrow('Worker job not found: missing');
  });
});

describe('worker scheduler helpers', () => {
  it('serializes plain worker errors as strings', () => {
    expect(serializeWorkerError('plain failure')).toBe('plain failure');
  });

  it('fails unsupported job types through assertNever', async () => {
    const repository = new InMemoryWorkerJobRepository();
    const connectorFactory = new FakeConnectorFactory([]);
    const secretsRepository = new InMemorySecureStorageRepository();
    const secrets = new SecureSecretService(
      secretsRepository,
      new StaticKeyProvider(Buffer.alloc(32, 9)),
      () => new Date(baseDate),
      () => 'credential-1',
    );
    await secrets.saveCredential({
      kind: 'api_key',
      scope: { provider: 'openai', accountId: 'credential-1' },
      value: 'opaque-worker-key',
    });

    await repository.enqueue({
      id: 'job-invalid',
      type: 'unsupported' as never,
      status: 'queued',
      input: {
        provider: 'openai',
        accountId: 'credential-1',
        startTime: 100,
        endTime: 200,
      },
      idempotencyKey: 'job-invalid-key',
      attempts: 0,
      maxAttempts: 3,
      runAfter: baseDate.toISOString(),
      createdAt: baseDate.toISOString(),
      updatedAt: baseDate.toISOString(),
    });

    const invalidScheduler = new WorkerScheduler(
      repository,
      connectorFactory,
      secrets,
      {
        workerId: 'worker-a',
        now: () => new Date(baseDate),
      },
    );

    await expect(invalidScheduler.runOnce()).resolves.toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
    });

    const retrying = await repository.list('retry_scheduled');
    expect(retrying[0]?.lastError).toContain('Unsupported worker job type');
  });
});

class FakeConnectorFactory implements ConnectorFactory {
  readonly calls: Array<{
    provider: ProviderName;
    config: AnyConnectorConfig;
    startTime: number;
    endTime: number;
  }> = [];

  constructor(
    private readonly records: NormalizedRecord[] = [],
    private readonly error?: Error,
  ) {}

  create(): never {
    throw new Error('Not used by worker tests');
  }

  async fetchNormalized(
    provider: ProviderName,
    config: AnyConnectorConfig,
    startTime: number,
    endTime: number,
  ): Promise<NormalizedRecord[]> {
    this.calls.push({ provider, config, startTime, endTime });
    if (this.error) {
      throw this.error;
    }
    return this.records;
  }

  async fetchBuckets(): Promise<never> {
    throw new Error('Not used by worker tests');
  }

  availableProviders(): ProviderName[] {
    return ['openai', 'zhipu', 'minimax'];
  }

  isRegistered(): boolean {
    return true;
  }
}

interface SchedulerHarness {
  scheduler: WorkerScheduler;
  jobRepository: InMemoryWorkerJobRepository;
  advanceMs: (ms: number) => void;
}

function makeScheduler(options: {
  connectorFactory?: ConnectorFactory;
  maxAttempts?: number;
  retryBaseDelayMs?: number;
} = {}): WorkerScheduler & SchedulerHarness {
  const repository = new InMemoryWorkerJobRepository();
  let nowMs = baseDate.getTime();
  const secretsRepository = new InMemorySecureStorageRepository();
  const secrets = new SecureSecretService(
    secretsRepository,
    new StaticKeyProvider(Buffer.alloc(32, 9)),
    () => new Date(nowMs),
    () => 'credential-1',
  );

  void secrets.saveCredential({
    kind: 'api_key',
    scope: { provider: 'openai', accountId: 'credential-1' },
    value: 'opaque-worker-key',
  });

  const schedulerOptions: ConstructorParameters<typeof WorkerScheduler>[3] = {
    workerId: 'worker-a',
    now: () => new Date(nowMs),
    idFactory: () => `job-${repositorySize(repository) + 1}`,
  };
  if (options.maxAttempts !== undefined) {
    schedulerOptions.maxAttempts = options.maxAttempts;
  }
  if (options.retryBaseDelayMs !== undefined) {
    schedulerOptions.retryBaseDelayMs = options.retryBaseDelayMs;
  }

  const scheduler = new WorkerScheduler(
    repository,
    options.connectorFactory ?? new FakeConnectorFactory([]),
    secrets,
    schedulerOptions,
  );

  return Object.assign(scheduler, {
    scheduler,
    jobRepository: repository,
    advanceMs: (ms: number) => {
      nowMs += ms;
    },
  });
}

function repositorySize(repository: InMemoryWorkerJobRepository): number {
  return Reflect.get(repository, 'jobs').size as number;
}
