import type {
  WorkerJob,
  WorkerJobRepository,
  WorkerJobResult,
  WorkerJobStatus,
} from './types.js';

export class InMemoryWorkerJobRepository implements WorkerJobRepository {
  private readonly jobs = new Map<string, WorkerJob>();
  private readonly idempotencyIndex = new Map<string, string>();

  async enqueue(job: WorkerJob): Promise<WorkerJob> {
    const existingId = this.idempotencyIndex.get(job.idempotencyKey);
    if (existingId) {
      const existing = this.jobs.get(existingId);
      if (existing) {
        return cloneJob(existing);
      }
    }

    const stored = cloneJob(job);
    this.jobs.set(stored.id, stored);
    this.idempotencyIndex.set(stored.idempotencyKey, stored.id);
    return cloneJob(stored);
  }

  async getById(id: string): Promise<WorkerJob | null> {
    const job = this.jobs.get(id);
    return job ? cloneJob(job) : null;
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<WorkerJob | null> {
    const id = this.idempotencyIndex.get(idempotencyKey);
    if (!id) {
      return null;
    }
    return this.getById(id);
  }

  async claimNext(now: Date, workerId: string): Promise<WorkerJob | null> {
    const nowMs = now.getTime();
    const candidate = [...this.jobs.values()]
      .filter((job) => isClaimable(job.status) && Date.parse(job.runAfter) <= nowMs)
      .sort((a, b) => {
        const byRunAfter = Date.parse(a.runAfter) - Date.parse(b.runAfter);
        if (byRunAfter !== 0) {
          return byRunAfter;
        }
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      })[0];

    if (!candidate) {
      return null;
    }

    const updated: WorkerJob = {
      ...candidate,
      status: 'running',
      lockedAt: now.toISOString(),
      lockOwner: workerId,
      updatedAt: now.toISOString(),
    };
    this.jobs.set(updated.id, cloneJob(updated));
    return cloneJob(updated);
  }

  async complete(
    id: string,
    result: WorkerJobResult,
    now: Date,
  ): Promise<WorkerJob> {
    const existing = this.requireJob(id);
    const updated: WorkerJob = {
      ...existing,
      status: 'succeeded',
      result,
      updatedAt: now.toISOString(),
    };
    delete updated.lockedAt;
    delete updated.lockOwner;
    this.jobs.set(id, cloneJob(updated));
    return cloneJob(updated);
  }

  async fail(
    id: string,
    error: string,
    nextRunAfter: Date | null,
    now: Date,
  ): Promise<WorkerJob> {
    const existing = this.requireJob(id);
    const status: WorkerJobStatus = nextRunAfter ? 'retry_scheduled' : 'dead';
    const updated: WorkerJob = {
      ...existing,
      status,
      attempts: existing.attempts + 1,
      runAfter: nextRunAfter?.toISOString() ?? existing.runAfter,
      lastError: error,
      updatedAt: now.toISOString(),
    };
    delete updated.lockedAt;
    delete updated.lockOwner;
    this.jobs.set(id, cloneJob(updated));
    return cloneJob(updated);
  }

  async list(status?: WorkerJobStatus): Promise<WorkerJob[]> {
    return [...this.jobs.values()]
      .filter((job) => !status || job.status === status)
      .map((job) => cloneJob(job));
  }

  private requireJob(id: string): WorkerJob {
    const job = this.jobs.get(id);
    if (!job) {
      throw new Error(`Worker job not found: ${id}`);
    }
    return job;
  }
}

function isClaimable(status: WorkerJobStatus): boolean {
  return status === 'queued' || status === 'retry_scheduled';
}

function cloneJob(job: WorkerJob): WorkerJob {
  return structuredClone(job) as WorkerJob;
}
