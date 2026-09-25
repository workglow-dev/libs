/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter, getLogger } from "@workglow/util";
import type { ILimiter } from "../limiter/ILimiter";
import { NullLimiter } from "../limiter/NullLimiter";
import type { IJobStore } from "../queue-storage/IJobStore";
import type { IMessageQueue } from "../queue-storage/IMessageQueue";
import type { JobStorageFormat, QueueChangePayload } from "../queue-storage/IQueueStorage";
import { JobStatus } from "../queue-storage/IQueueStorage";
import type { DeadLetter } from "./DeadLetter";
import type { Job, JobClass } from "./Job";
import type { JobQueueClient } from "./JobQueueClient";
import type { StreamEventLike } from "./JobQueueEventListeners";
import { JobQueueWorker } from "./JobQueueWorker";
import { storageToClass } from "./JobStorageConverters";

/**
 * Statistics tracked for the job queue
 */
export interface JobQueueStats {
  /**
   * Total number of execution ATTEMPTS started, not distinct jobs. Incremented
   * once per `job_start`, which the worker emits on every execution — so a job
   * that retries N times contributes N to this counter. It therefore will not
   * equal `completedJobs + failedJobs + disabledJobs` in any run with retries;
   * use {@link retriedJobs} to reconcile. Renamed semantics, not the field, to
   * preserve the public stats shape.
   */
  readonly totalJobs: number;
  readonly completedJobs: number;
  readonly failedJobs: number;
  readonly abortedJobs: number;
  readonly retriedJobs: number;
  readonly disabledJobs: number;
  readonly averageProcessingTime?: number;
  readonly lastUpdateTime: Date;
}

/**
 * Events emitted by JobQueueServer
 */
export type JobQueueServerEventListeners<Input, Output> = {
  server_start: (queueName: string) => void;
  server_stop: (queueName: string) => void;
  job_start: (queueName: string, jobId: unknown) => void;
  job_complete: (queueName: string, jobId: unknown, output: Output) => void;
  job_error: (queueName: string, jobId: unknown, error: string, errorCode?: string) => void;
  job_disabled: (queueName: string, jobId: unknown) => void;
  job_retry: (queueName: string, jobId: unknown, visibleAt: Date) => void;
  job_progress: (
    queueName: string,
    jobId: unknown,
    progress: number,
    message: string,
    details: Record<string, unknown> | null
  ) => void;
  job_stream: (queueName: string, jobId: unknown, event: StreamEventLike) => void;
};

export type JobQueueServerEvents = keyof JobQueueServerEventListeners<unknown, unknown>;

/**
 * Options for creating a JobQueueServer
 */
export interface JobQueueServerOptions<Input, Output> {
  readonly messageQueue: IMessageQueue<JobStorageFormat<Input, Output>>;
  readonly jobStore: IJobStore<Input, Output>;
  readonly queueName: string;
  readonly limiter?: ILimiter;
  readonly workerCount?: number;
  readonly pollIntervalMs?: number;
  readonly deleteAfterCompletionMs?: number;
  readonly deleteAfterFailureMs?: number;
  readonly deleteAfterDisabledMs?: number;
  readonly cleanupIntervalMs?: number;
  /**
   * Max time each worker's `stop()` waits for in-flight jobs before forcing aborts.
   * Defaults to 30s. Set to 0 to abort immediately.
   */
  readonly stopTimeoutMs?: number;
  /**
   * Dead-letter queue to forward exhausted jobs to, or "discard" to silently drop them.
   * Default: "discard".
   */
  readonly deadLetter?: IMessageQueue<DeadLetter<Input>> | "discard";
  /** Number of jobs to pre-fetch per poll iteration. Defaults to 1. */
  readonly prefetch?: number;
  /**
   * Passed to every worker; see {@link JobQueueWorkerOptions.leaseMs}. Without
   * it a server's workers always took the default lease, however long its jobs
   * run.
   */
  readonly leaseMs?: number;
  /**
   * Passed to every worker; see
   * {@link JobQueueWorkerOptions.extendLeaseWhileRunning}. A queue whose
   * storage lives only in this process should set it: a lease reclaim exists to
   * recover a job from a worker that died, and when the worker dies the queue
   * dies with it, so the only reclaim that can happen is the live worker's own
   * poll loop re-executing a job that is still running.
   */
  readonly extendLeaseWhileRunning?: boolean;
}

/**
 * Server that coordinates multiple workers and manages the job queue lifecycle.
 * Handles stuck job recovery, cleanup, and aggregates statistics.
 */
export class JobQueueServer<
  Input,
  Output,
  QueueJob extends Job<Input, Output> = Job<Input, Output>,
> {
  public readonly queueName: string;
  protected readonly messageQueue: IMessageQueue<JobStorageFormat<Input, Output>>;
  protected readonly jobStore: IJobStore<Input, Output>;
  protected readonly jobClass: JobClass<Input, Output>;
  public readonly limiter: ILimiter;
  protected readonly workerCount: number;
  protected readonly pollIntervalMs: number;
  protected readonly deleteAfterCompletionMs?: number;
  protected readonly deleteAfterFailureMs?: number;
  protected readonly deleteAfterDisabledMs?: number;
  protected readonly cleanupIntervalMs: number;
  protected readonly stopTimeoutMs?: number;
  protected readonly deadLetter: IMessageQueue<DeadLetter<Input>> | "discard";
  protected readonly prefetch: number;
  protected readonly leaseMs?: number;
  protected readonly extendLeaseWhileRunning?: boolean;

  protected readonly events = new EventEmitter<JobQueueServerEventListeners<Input, Output>>();
  protected readonly workers: JobQueueWorker<Input, Output, QueueJob>[] = [];
  protected readonly clients: Set<JobQueueClient<Input, Output>> = new Set();

  protected running = false;
  protected cleanupTimer: ReturnType<typeof setTimeout> | null = null;
  protected storageUnsubscribe: (() => void) | null = null;

  protected stats: JobQueueStats = {
    totalJobs: 0,
    completedJobs: 0,
    failedJobs: 0,
    abortedJobs: 0,
    retriedJobs: 0,
    disabledJobs: 0,
    lastUpdateTime: new Date(),
  };

  constructor(jobClass: JobClass<Input, Output>, options: JobQueueServerOptions<Input, Output>) {
    this.queueName = options.queueName;
    this.messageQueue = options.messageQueue;
    this.jobStore = options.jobStore;
    this.jobClass = jobClass;
    this.limiter = options.limiter ?? new NullLimiter();
    this.workerCount = options.workerCount ?? 1;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
    this.deleteAfterCompletionMs = options.deleteAfterCompletionMs;
    this.deleteAfterFailureMs = options.deleteAfterFailureMs;
    this.deleteAfterDisabledMs = options.deleteAfterDisabledMs;
    this.cleanupIntervalMs = options.cleanupIntervalMs ?? 10000;
    this.stopTimeoutMs = options.stopTimeoutMs;
    this.deadLetter = options.deadLetter ?? "discard";
    this.prefetch = Math.max(1, options.prefetch ?? 1);
    this.leaseMs = options.leaseMs;
    this.extendLeaseWhileRunning = options.extendLeaseWhileRunning;

    this.initializeWorkers();
  }

  /**
   * Start the server and all workers
   */
  public async start(): Promise<this> {
    if (this.running) {
      return this;
    }

    this.running = true;
    this.events.emit("server_start", this.queueName);

    // Warn when a process-scoped limiter is paired with a cluster-scoped
    // queue storage. The user almost certainly meant their configured limit
    // to be enforced cluster-wide; with a process-scoped limiter they get
    // N× the limit (one bucket per process).
    if (
      this.limiter.scope === "process" &&
      this.messageQueue.scope === "cluster" &&
      !(this.limiter instanceof NullLimiter)
    ) {
      getLogger().warn(
        "Process-scoped limiter on cluster-scoped queue storage — limit is enforced per-process, not cluster-wide. Use a cluster-scoped rate limiter storage (Postgres/Supabase) for global enforcement.",
        {
          queueName: this.queueName,
          limiterScope: this.limiter.scope,
          storage:
            (this.messageQueue as { backingStorageName?: string }).backingStorageName ??
            this.messageQueue.constructor.name,
        }
      );
    }

    // Subscribe to storage changes to wake workers when new work arrives.
    // - Cross-process deployments rely on this for wake-up.
    // - Same-process attached clients are also primarily woken by the direct
    //   `handleJobAdded` path on submit, but we keep the subscription as a
    //   correctness backstop: some async backends (e.g. fake-indexeddb under
    //   bun) have read-after-write visibility lag where a just-committed job
    //   isn't yet returned by `storage.next()`. The subscription fires only
    //   after the write is visible to readers, providing a guaranteed wake.
    // - Sqlite/Postgres throw here; the try/catch falls through and direct
    //   notify is the sole wake path on those backends.
    try {
      const sub = this.messageQueue.subscribeToChanges;
      if (!sub) throw new Error("messageQueue does not support subscribeToChanges");
      this.storageUnsubscribe = sub.call(
        this.messageQueue,
        (change: QueueChangePayload<Input, Output>) => {
          if (
            change.type === "INSERT" ||
            change.type === "RESYNC" ||
            (change.type === "UPDATE" && change.new?.status === JobStatus.PENDING)
          ) {
            this.notifyWorkers();
          }
        }
      );
    } catch (err) {
      // Storage doesn't support change subscriptions — workers will poll.
      // Logged at debug because Sqlite/Postgres throw here by design; an
      // unexpected throw on a storage that *should* support subscriptions
      // (e.g. misconfigured Supabase realtime) is otherwise silent.
      getLogger().debug("subscribeToChanges unsupported on this storage", {
        queueName: this.queueName,
        error: err,
      });
    }

    // Start all workers
    await Promise.all(this.workers.map((worker) => worker.start()));

    // Start cleanup loop only if at least one retention TTL is configured.
    if (this.hasRetentionTtls()) {
      this.startCleanupLoop();
    }

    return this;
  }

  /**
   * True if any delete-after-X TTL is set to a positive value.
   * When false, the cleanup loop would be a pure no-op and is skipped.
   */
  private hasRetentionTtls(): boolean {
    return (
      (this.deleteAfterCompletionMs !== undefined && this.deleteAfterCompletionMs > 0) ||
      (this.deleteAfterFailureMs !== undefined && this.deleteAfterFailureMs > 0) ||
      (this.deleteAfterDisabledMs !== undefined && this.deleteAfterDisabledMs > 0)
    );
  }

  /**
   * Stop the server and all workers
   */
  public async stop(): Promise<this> {
    if (!this.running) {
      return this;
    }

    this.running = false;

    if (this.storageUnsubscribe) {
      this.storageUnsubscribe();
      this.storageUnsubscribe = null;
    }

    if (this.cleanupTimer) {
      clearTimeout(this.cleanupTimer);
      this.cleanupTimer = null;
    }

    await Promise.all(this.workers.map((worker) => worker.stop()));

    this.events.emit("server_stop", this.queueName);
    return this;
  }

  /**
   * Get the current queue statistics
   */
  public getStats(): JobQueueStats {
    return { ...this.stats };
  }

  /** Get the message queue paired with this server. */
  public getMessageQueue(): IMessageQueue<JobStorageFormat<Input, Output>> {
    return this.messageQueue;
  }

  /** Get the job store paired with this server. */
  public getJobStore(): IJobStore<Input, Output> {
    return this.jobStore;
  }

  /**
   * Scale the number of workers
   */
  public async scaleWorkers(count: number): Promise<void> {
    if (count < 1) {
      throw new Error("Worker count must be at least 1");
    }

    const currentCount = this.workers.length;

    if (count > currentCount) {
      for (let i = currentCount; i < count; i++) {
        const worker = this.createWorker();
        this.workers.push(worker);
        if (this.running) {
          await worker.start();
        }
      }
    } else if (count < currentCount) {
      const toRemove = this.workers.splice(count);
      await Promise.all(toRemove.map((worker) => worker.stop()));
    }
  }

  /**
   * Check if the server is running
   */
  public isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of workers
   */
  public getWorkerCount(): number {
    return this.workers.length;
  }

  // ========================================================================
  // Client management
  // ========================================================================

  /**
   * Add a client for same-process event forwarding
   * @internal
   */
  public addClient(client: JobQueueClient<Input, Output>): void {
    this.clients.add(client);
  }

  /**
   * Remove a client
   * @internal
   */
  public removeClient(client: JobQueueClient<Input, Output>): void {
    this.clients.delete(client);
  }

  /**
   * Wake all idle workers so they check for new jobs immediately.
   * @internal
   */
  public notifyWorkers(): void {
    for (const worker of this.workers) {
      worker.notify();
    }
  }

  /**
   * Called by an attached client immediately after a job is inserted into storage,
   * so the worker can pick it up without waiting for the poll interval.
   * @internal
   */
  public handleJobAdded(_jobId: unknown): void {
    this.notifyWorkers();
  }

  /**
   * Fire the abort controller for the given job on whichever worker is running it.
   * Returns true if any worker handled the abort locally.
   * @internal
   */
  public abortJob(jobId: unknown): boolean {
    for (const worker of this.workers) {
      if (worker.requestAbort(jobId)) {
        return true;
      }
    }
    return false;
  }

  // ========================================================================
  // Event handling
  // ========================================================================

  public on<Event extends JobQueueServerEvents>(
    event: Event,
    listener: JobQueueServerEventListeners<Input, Output>[Event]
  ): void {
    this.events.on(event, listener);
  }

  public off<Event extends JobQueueServerEvents>(
    event: Event,
    listener: JobQueueServerEventListeners<Input, Output>[Event]
  ): void {
    this.events.off(event, listener);
  }

  // ========================================================================
  // Protected methods
  // ========================================================================

  /**
   * Initialize workers
   */
  protected initializeWorkers(): void {
    for (let i = 0; i < this.workerCount; i++) {
      const worker = this.createWorker();
      this.workers.push(worker);
    }
  }

  /**
   * Create a new worker and wire up event forwarding
   */
  protected createWorker(): JobQueueWorker<Input, Output, QueueJob> {
    const worker = new JobQueueWorker<Input, Output, QueueJob>(this.jobClass, {
      messageQueue: this.messageQueue,
      jobStore: this.jobStore,
      queueName: this.queueName,
      limiter: this.limiter,
      pollIntervalMs: this.pollIntervalMs,
      stopTimeoutMs: this.stopTimeoutMs,
      deadLetter: this.deadLetter,
      prefetch: this.prefetch,
      leaseMs: this.leaseMs,
      extendLeaseWhileRunning: this.extendLeaseWhileRunning,
      onStreamEvent: (jobId, event) => this.dispatchStreamToClients(jobId, event),
    });

    // Forward worker events to server and clients
    worker.on("job_start", (jobId) => {
      // job_start fires once per execution attempt, so totalJobs is
      // attempt-weighted (see JobQueueStats.totalJobs docs).
      this.stats = { ...this.stats, totalJobs: this.stats.totalJobs + 1 };
      this.events.emit("job_start", this.queueName, jobId);
      this.forwardToClients("handleJobStart", jobId);
    });

    worker.on("job_complete", (jobId, output) => {
      this.stats = { ...this.stats, completedJobs: this.stats.completedJobs + 1 };
      this.updateAverageProcessingTime();
      this.events.emit("job_complete", this.queueName, jobId, output);
      this.forwardToClients("handleJobComplete", jobId, output);

      // Immediate deletion when configured
      if (this.deleteAfterCompletionMs === 0) {
        this.jobStore.delete(jobId).catch((err) => {
          getLogger().error("Error deleting job after completion", {
            error: err,
            jobId,
            queueName: this.queueName,
          });
        });
      }

      // A concurrency slot freed up — wake idle workers
      this.notifyWorkers();
    });

    worker.on("job_error", (jobId, error, errorCode) => {
      this.stats = { ...this.stats, failedJobs: this.stats.failedJobs + 1 };
      this.events.emit("job_error", this.queueName, jobId, error, errorCode);
      this.forwardToClients("handleJobError", jobId, error, errorCode);

      // Immediate deletion when configured
      if (this.deleteAfterFailureMs === 0) {
        this.jobStore.delete(jobId).catch((err) => {
          getLogger().error("Error deleting job after error", {
            error: err,
            jobId,
            queueName: this.queueName,
          });
        });
      }

      // A concurrency slot freed up — wake idle workers
      this.notifyWorkers();
    });

    worker.on("job_disabled", (jobId) => {
      this.stats = { ...this.stats, disabledJobs: this.stats.disabledJobs + 1 };
      this.events.emit("job_disabled", this.queueName, jobId);
      this.forwardToClients("handleJobDisabled", jobId);

      // Immediate deletion when configured
      if (this.deleteAfterDisabledMs === 0) {
        this.jobStore.delete(jobId).catch((err) => {
          getLogger().error("Error deleting job after disabling", {
            error: err,
            jobId,
            queueName: this.queueName,
          });
        });
      }

      // A concurrency slot freed up — wake idle workers
      this.notifyWorkers();
    });

    worker.on("job_retry", (jobId, visibleAt) => {
      this.stats = { ...this.stats, retriedJobs: this.stats.retriedJobs + 1 };
      this.events.emit("job_retry", this.queueName, jobId, visibleAt);
      this.forwardToClients("handleJobRetry", jobId, visibleAt);
    });

    worker.on("job_progress", (jobId, progress, message, details) => {
      this.events.emit("job_progress", this.queueName, jobId, progress, message, details);
      this.forwardToClients("handleJobProgress", jobId, progress, message, details);
    });

    worker.on("job_stream", (jobId, event) => {
      // Observer fan-out only. Forwarding to attached CLIENTS is handled
      // awaitably via `onStreamEvent` below (`events.emit` cannot carry a
      // promise back to the worker that's pacing itself on it).
      this.events.emit("job_stream", this.queueName, jobId, event);
    });

    return worker;
  }

  /**
   * Direct, awaitable call path from a worker's `emitStreamEvent` to this
   * server's attached clients — injected into the worker as
   * {@link JobQueueWorkerOptions.onStreamEvent} so the worker can await
   * delivery without going through `events.emit` (which returns no promise).
   * Reuses the existing {@link clients} registry populated by
   * `JobQueueClient.attach`; never rejects.
   * @internal
   */
  private async dispatchStreamToClients(jobId: unknown, event: StreamEventLike): Promise<void> {
    if (this.clients.size === 0) return;
    await Promise.all(
      [...this.clients].map((client) =>
        client.handleJobStream(jobId, event).catch((err) => {
          getLogger().error("forwarding stream event to attached client failed", {
            jobId,
            queueName: this.queueName,
            error: err,
          });
        })
      )
    );
  }

  /**
   * Forward events to all attached clients
   */
  protected forwardToClients(method: "handleJobStart", jobId: unknown): void;
  protected forwardToClients(method: "handleJobComplete", jobId: unknown, output: Output): void;
  protected forwardToClients(
    method: "handleJobError",
    jobId: unknown,
    error: string,
    errorCode?: string
  ): void;
  protected forwardToClients(method: "handleJobDisabled", jobId: unknown): void;
  protected forwardToClients(method: "handleJobRetry", jobId: unknown, visibleAt: Date): void;
  protected forwardToClients(
    method: "handleJobProgress",
    jobId: unknown,
    progress: number,
    message: string,
    details: Record<string, unknown> | null
  ): void;
  protected forwardToClients(method: string, ...args: unknown[]): void {
    for (const client of this.clients) {
      const fn = (client as any)[method];
      if (typeof fn === "function") {
        fn.apply(client, args);
      }
    }
  }

  /**
   * Update average processing time from all workers
   */
  protected updateAverageProcessingTime(): void {
    const times: number[] = [];
    for (const worker of this.workers) {
      const avgTime = worker.getAverageProcessingTime();
      if (avgTime !== undefined) {
        times.push(avgTime);
      }
    }
    if (times.length > 0) {
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      this.stats = {
        ...this.stats,
        averageProcessingTime: avg,
        lastUpdateTime: new Date(),
      };
    }
  }

  /**
   * Start the cleanup loop
   */
  protected startCleanupLoop(): void {
    if (!this.running) return;

    // The loop reschedules whether or not the sweep succeeded, but a failure
    // used to reach nobody: `.finally()` re-raises the rejection into a chain
    // with no handler, so cleanup could fail every cycle in silence.
    this.cleanupJobs()
      .catch((error: unknown) => {
        getLogger().error("Job cleanup failed; the loop continues", { error });
      })
      .finally(() => {
        if (this.running) {
          this.cleanupTimer = setTimeout(() => this.startCleanupLoop(), this.cleanupIntervalMs);
        }
      });
  }

  /**
   * Clean up completed/failed jobs based on TTL settings
   */
  protected async cleanupJobs(): Promise<void> {
    try {
      if (this.deleteAfterCompletionMs !== undefined && this.deleteAfterCompletionMs > 0) {
        await this.jobStore.deleteByStatusAndAge(JobStatus.COMPLETED, this.deleteAfterCompletionMs);
      }

      if (this.deleteAfterFailureMs !== undefined && this.deleteAfterFailureMs > 0) {
        await this.jobStore.deleteByStatusAndAge(JobStatus.FAILED, this.deleteAfterFailureMs);
      }

      if (this.deleteAfterDisabledMs !== undefined && this.deleteAfterDisabledMs > 0) {
        await this.jobStore.deleteByStatusAndAge(JobStatus.DISABLED, this.deleteAfterDisabledMs);
      }
    } catch (error) {
      getLogger().error("Error in cleanup", { error, queueName: this.queueName });
    }
  }

  /**
   * Convert storage format to Job class
   */
  protected storageToClass(details: JobStorageFormat<Input, Output>): Job<Input, Output> {
    return storageToClass(details, this.jobClass);
  }
}
