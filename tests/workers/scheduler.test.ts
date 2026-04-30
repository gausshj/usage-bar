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
