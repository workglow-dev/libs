/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_LIMITS,
  EventEmitter,
  SpanStatusCode,
  asText,
  getLogger,
  getTelemetryProvider,
  sleep,
  uuid4,
} from "@workglow/util";
import type { ILimiter } from "../limiter/ILimiter";
import { NullLimiter } from "../limiter/NullLimiter";
import type { IClaim } from "../queue-storage/IClaim";
import type { IJobStore } from "../queue-storage/IJobStore";
import type { IMessageQueue } from "../queue-storage/IMessageQueue";
import type { JobStorageFormat } from "../queue-storage/IQueueStorage";
import { JobStatus } from "../queue-storage/IQueueStorage";
import type { DeadLetter } from "./DeadLetter";
import type { Job, JobClass } from "./Job";
import {
  AbortSignalJobError,
  JobDisabledError,
  JobError,
  jobErrorPersistedCode,
  JobNotFoundError,
  PermanentJobError,
  RetryableJobError,
} from "./JobError";
import { withJobErrorDiagnostics } from "./JobErrorDiagnostics";
import type { StreamEventLike } from "./JobQueueEventListeners";
import { storageToClass } from "./JobStorageConverters";
import { isRetryableError } from "./Retryability";

/**
 * Minimum interval between {@link JobQueueWorker.processJobs} loop-error logs.
 * A persistent storage failure throws every iteration; without rate-limiting
 * that would flood the log at the poll rate. We still log the first occurrence
 * immediately so operators get a prompt signal.
 */
const LOOP_ERROR_LOG_INTERVAL_MS = 5_000;

/**
 * First backoff step used when the idle peek says the head of the queue is
 * already visible but the claim we just attempted came back empty. Doubles per
 * consecutive occurrence, capped at the poll interval — see
 * {@link JobQueueWorker.getIdleDelay}.
 */
const IDLE_READY_RETRY_BASE_MS = 5;

/**
 * Events emitted by JobQueueWorker
 */
export type JobQueueWorkerEventListeners<Input, Output> = {
  job_start: (jobId: unknown) => void;
  job_complete: (jobId: unknown, output: Output) => void;
  job_error: (jobId: unknown, error: string, errorCode?: string) => void;
  job_disabled: (jobId: unknown) => void;
  job_retry: (jobId: unknown, visibleAt: Date) => void;
  job_progress: (
    jobId: unknown,
    progress: number,
    message: string,
    details: Record<string, unknown> | null
  ) => void;
  job_stream: (jobId: unknown, event: StreamEventLike) => void;
  worker_start: () => void;
  worker_stop: () => void;
};

export type JobQueueWorkerEvents = keyof JobQueueWorkerEventListeners<unknown, unknown>;

/**
 * Options for creating a JobQueueWorker
 */
export interface JobQueueWorkerOptions<Input, Output> {
  readonly messageQueue: IMessageQueue<JobStorageFormat<Input, Output>>;
  readonly jobStore: IJobStore<Input, Output>;
  readonly queueName: string;
  readonly limiter?: ILimiter;
  readonly pollIntervalMs?: number;
  /**
   * Optional worker ID. If not provided, a random UUID will be generated.
   * Use a persistent ID if you want the worker to reclaim its own jobs after restart.
   */
  readonly workerId?: string | null;
  /**
   * Max time `stop()` waits for in-flight jobs to finish before forcing aborts.
   * Defaults to 30s. Set to 0 to abort immediately.
   */
  readonly stopTimeoutMs?: number;
  /**
   * If true, the worker will call extendLease periodically while a job is
   * executing. Extension interval is leaseMs * 0.5. Default: false.
   */
  readonly extendLeaseWhileRunning?: boolean;
  /**
   * How long (ms) the worker's lease on a claimed job lasts before another
   * worker may re-claim it. Must be long enough to cover the maximum
   * expected job duration if extendLeaseWhileRunning is false.
   * Defaults to max(DEFAULT_LIMITS.jobQueueLeaseFloorMs, pollIntervalMs * 60).
   */
  readonly leaseMs?: number;
  /**
   * Upper bound (ms) on {@link JobQueueWorker.getLimiterWakeDelay}. Prevents a
   * misconfigured or stuck limiter (e.g. one whose `getNextAvailableTime`
   * returns hours in the future) from making the worker unresponsive — it
   * wakes at least this often regardless of what the limiter says.
   * Defaults to {@link DEFAULT_LIMITS.jobQueueLimiterMaxWakeMs}.
   */
  readonly limiterMaxWakeMs?: number;
  /**
   * Size of the recent-window ring buffer feeding
   * {@link JobQueueWorker.getAverageProcessingTime}. Bounds memory and keeps
   * the reported average representative of recent throughput. Defaults to
   * {@link DEFAULT_LIMITS.jobQueueMaxProcessingTimeSamples}.
   */
  readonly maxProcessingTimeSamples?: number;
  /**
   * Dead-letter queue to forward exhausted jobs to, or "discard" to drop them.
   * Default: "discard".
   */
  readonly deadLetter?: IMessageQueue<DeadLetter<Input>> | "discard";
  /**
   * Number of claims to fetch per loop iteration. Default: 1.
   * With prefetch > 1, claims that cannot immediately acquire a limiter slot
   * are released back to PENDING via retry, so concurrency is still governed
   * by the limiter.
   */
  readonly prefetch?: number;
  /**
   * Direct, awaitable call path from {@link JobQueueWorker.emitStreamEvent} to
   * the owning `JobQueueServer`'s attached clients. `events.emit` cannot
   * carry a return value back to its caller, so a server injects this hook
   * (see `JobQueueServer.createWorker`) rather than the worker maintaining a
   * second client registry — it reuses the server's existing `clients` set.
   * Never rejects; a forwarding failure is the injected hook's own concern to
   * log.
   */
  readonly onStreamEvent?: (jobId: unknown, event: StreamEventLike) => Promise<void>;
}

/**
 * Worker that processes jobs from the queue.
 * Reports progress and completion back to storage.
 */
export class JobQueueWorker<
  Input,
  Output,
  QueueJob extends Job<Input, Output> = Job<Input, Output>,
> {
  public readonly queueName: string;
  public readonly workerId: string;
  protected readonly messageQueue: IMessageQueue<JobStorageFormat<Input, Output>>;
  protected readonly jobStore: IJobStore<Input, Output>;
  protected readonly jobClass: JobClass<Input, Output>;
  protected readonly limiter: ILimiter;
  protected readonly pollIntervalMs: number;
  protected readonly stopTimeoutMs: number;
  protected readonly extendLeaseWhileRunning: boolean;
  protected readonly leaseMs: number;
  protected readonly limiterMaxWakeMs: number;
  protected readonly maxProcessingTimeSamples: number;
  protected readonly events = new EventEmitter<JobQueueWorkerEventListeners<Input, Output>>();
  protected readonly deadLetter: IMessageQueue<DeadLetter<Input>> | "discard";
  protected readonly prefetch: number;
  protected readonly onStreamEvent:
    | ((jobId: unknown, event: StreamEventLike) => Promise<void>)
    | undefined;

  protected running = false;

  /**
   * Tracks in-flight job executions for drain-on-stop.
   * Each entry's promise resolves (never rejects) when the job settles
   * (complete / fail / retry / abort).
   */
  private readonly inFlight: Map<unknown, Promise<void>> = new Map();

  /**
   * Active claims for jobs currently being processed. Used to drive
   * ack/retry/fail/extendLease in completion paths.
   */
  private readonly activeClaims: Map<unknown, IClaim<JobStorageFormat<Input, Output>>> = new Map();

  /**
   * Resolve function for the idle wait promise.
   * When set, the worker is idle and waiting for either a notification or poll timeout.
   */
  private wakeResolve: (() => void) | null = null;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Set when {@link notify} fires while the worker is not yet idle. The next
   * {@link waitForWakeOrTimeout} call consumes it and returns immediately
   * instead of sleeping. Without this flag, a notify that arrives during
   * `processJobs`'s pre-idle awaits (e.g. while `storage.next` and
   * `storage.peek` are in flight) would be dropped on the floor and the
   * worker would sleep for the full poll interval despite there being work
   * to do — observed under load on IndexedDb.
   */
  private wakePending = false;

  /**
   * Consecutive idle iterations that found a ready (already-visible) job at the
   * head of the queue without being able to claim it. Drives the backoff in
   * {@link getIdleDelay}; reset whenever a claim succeeds or the queue is
   * genuinely idle.
   */
  private readyRetryStreak = 0;

  /**
   * Promise for the running `processJobs` loop. Captured in {@link start} so
   * {@link stop} can await actual loop exit instead of returning while the
   * loop is still suspended mid-iteration. Without this, a loop parked in
   * `await this.next()` could resume after stop returned and claim a job
   * that was submitted after stop — starting `processSingleJob` on a worker
   * that's no longer running.
   */
  private loopPromise: Promise<void> | null = null;

  /**
   * Abort controllers for active jobs
   */
  protected readonly activeJobAbortControllers: Map<unknown, AbortController> = new Map();

  /**
   * Per-job promise chains serializing stream-chunk publishes — see
   * {@link emitStreamEvent}. Entries are dropped in {@link cleanupJob}; a
   * still-pending tail publish settles on its own.
   */
  private readonly streamPublishChains: Map<unknown, Promise<void>> = new Map();

  /**
   * Per-job lease-renewal timers armed by {@link armStreamClaimHeartbeat}.
   * Cleared when the job's `executeJob` returns and again in
   * {@link cleanupJob}, so a late fire-and-forget emit cannot leave one behind.
   */
  private readonly streamClaimHeartbeats: Map<unknown, ReturnType<typeof setInterval>> = new Map();

  /**
   * Recent per-job processing durations (ms) used for
   * {@link getAverageProcessingTime}. Bounded to the most recent
   * {@link JobQueueWorker.maxProcessingTimeSamples} entries so a long-lived worker doesn't
   * accumulate one entry per distinct job id forever, and so the reported
   * average reflects a recent window rather than all-time.
   */
  protected readonly processingTimes: number[] = [];

  /**
   * Timestamp (ms) of the last loop-error log, used to rate-limit the
   * {@link processJobs} catch-path logging. See {@link LOOP_ERROR_LOG_INTERVAL_MS}.
   */
  private lastLoopErrorLogAt = 0;

  constructor(jobClass: JobClass<Input, Output>, options: JobQueueWorkerOptions<Input, Output>) {
    this.queueName = options.queueName;
    this.workerId = options.workerId ?? uuid4();
    this.messageQueue = options.messageQueue;
    this.jobStore = options.jobStore;
    this.jobClass = jobClass;
    this.limiter = options.limiter ?? new NullLimiter();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_LIMITS.jobQueuePollIntervalMs;
    this.stopTimeoutMs = options.stopTimeoutMs ?? 30_000;
    this.extendLeaseWhileRunning = options.extendLeaseWhileRunning ?? false;
    this.leaseMs =
      options.leaseMs ?? Math.max(DEFAULT_LIMITS.jobQueueLeaseFloorMs, this.pollIntervalMs * 60);
    this.limiterMaxWakeMs = options.limiterMaxWakeMs ?? DEFAULT_LIMITS.jobQueueLimiterMaxWakeMs;
    this.maxProcessingTimeSamples =
      options.maxProcessingTimeSamples ?? DEFAULT_LIMITS.jobQueueMaxProcessingTimeSamples;
    this.deadLetter = options.deadLetter ?? "discard";
    this.prefetch = Math.max(1, options.prefetch ?? 1);
    this.onStreamEvent = options.onStreamEvent;
  }

  /**
   * Start the worker processing loop
   */
  public async start(): Promise<this> {
    if (this.running) {
      return this;
    }
    this.running = true;
    this.events.emit("worker_start");
    this.loopPromise = this.processJobs();
    return this;
  }

  /**
   * If this worker is currently processing the given job, fire its abort controller
   * immediately and return true. Returns false if the job isn't active on this worker.
   * @internal
   */
  public requestAbort(jobId: unknown): boolean {
    const controller = this.activeJobAbortControllers.get(jobId);
    if (controller && !controller.signal.aborted) {
      controller.abort();
      return true;
    }
    return false;
  }

  /**
   * Wake the worker from idle sleep so it checks for jobs immediately.
   * If the worker is not yet idle, latches a pending-wake flag that the next
   * {@link waitForWakeOrTimeout} call consumes — so wake notifications that
   * race with worker startup or mid-iteration awaits are not lost.
   */
  public notify(): void {
    this.wakePending = true;
    if (this.wakeResolve) {
      if (this.wakeTimer) {
        clearTimeout(this.wakeTimer);
        this.wakeTimer = null;
      }
      const resolve = this.wakeResolve;
      this.wakeResolve = null;
      resolve();
    }
  }

  /**
   * Stop the worker, draining in-flight jobs up to {@link stopTimeoutMs}
   * before aborting anything still running.
   */
  public async stop(): Promise<this> {
    if (!this.running) {
      return this;
    }
    this.running = false;

    // Wake from idle sleep so the processing loop can exit.
    this.notify();

    // Wait for the processJobs loop to actually exit. Without this, a loop
    // suspended mid-iteration (e.g. inside `await this.next()`) could resume
    // after stop returned and claim/start a freshly-submitted job — leaving
    // a "stopped" worker running PROCESSING jobs.
    const loopPromise = this.loopPromise;
    this.loopPromise = null;
    if (loopPromise) {
      await loopPromise;
    }

    // Phase 1 — graceful drain.
    if (this.stopTimeoutMs > 0 && this.inFlight.size > 0) {
      const drain = Promise.allSettled([...this.inFlight.values()]);
      await Promise.race([drain, sleep(this.stopTimeoutMs)]);
    }

    // Phase 2 — anything still running gets aborted.
    if (this.inFlight.size > 0) {
      for (const controller of this.activeJobAbortControllers.values()) {
        if (!controller.signal.aborted) {
          controller.abort();
        }
      }
      const abortDrain = Promise.allSettled([...this.inFlight.values()]);
      await Promise.race([abortDrain, sleep(1000)]);
    }

    this.events.emit("worker_stop");
    return this;
  }

  /**
   * Process a single job manually (useful for testing or manual control).
   *
   * Uses the atomic claim->acquire->release pattern: claim a job, then atomically
   * reserve a limiter slot. If the limiter rejects (e.g. raced another worker
   * to the last slot), the claimed job is released back to PENDING.
   */
  public async processNext(): Promise<boolean> {
    const job = await this.next();
    if (!job) {
      return false;
    }
    const limiterToken = await this.limiter.tryAcquire();
    if (limiterToken === null || limiterToken === undefined) {
      await this.releaseClaimedJob(job);
      return false;
    }
    await this.processSingleJob(job, limiterToken);
    return true;
  }

  /**
   * Check if the worker is currently running
   */
  public isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the number of active jobs being processed
   */
  public getActiveJobCount(): number {
    return this.activeJobAbortControllers.size;
  }

  /**
   * Average processing time over the most recent
   * {@link JobQueueWorker.maxProcessingTimeSamples} completed jobs (a recent window, not
   * the worker's all-time history). Returns undefined until at least one job
   * has completed.
   */
  public getAverageProcessingTime(): number | undefined {
    const times = this.processingTimes;
    if (times.length === 0) return undefined;
    return times.reduce((a, b) => a + b, 0) / times.length;
  }

  // ========================================================================
  // Event handling
  // ========================================================================

  public on<Event extends JobQueueWorkerEvents>(
    event: Event,
    listener: JobQueueWorkerEventListeners<Input, Output>[Event]
  ): void {
    this.events.on(event, listener);
  }

  public off<Event extends JobQueueWorkerEvents>(
    event: Event,
    listener: JobQueueWorkerEventListeners<Input, Output>[Event]
  ): void {
    this.events.off(event, listener);
  }

  // ========================================================================
  // Protected methods
  // ========================================================================

  /**
   * Get the next job from the queue (always fetches a single claim).
   * Used by {@link processNext} and the single-claim path of {@link processJobs}.
   */
  protected async next(): Promise<QueueJob | undefined> {
    const claims = await this.messageQueue.receive({
      workerId: this.workerId,
      leaseMs: this.leaseMs,
      max: 1,
    });
    const claim = claims[0];
    if (!claim) return undefined;
    const job = this.storageToClass(claim.body) as QueueJob;
    if (job.id != null) {
      this.activeClaims.set(job.id, claim);
    }
    return job;
  }

  /**
   * Fetch up to `this.prefetch` claims from the queue. Returned claims are
   * not yet registered in {@link activeClaims}; {@link processClaims} does
   * that as it consumes the batch.
   */
  private async nextBatch(): Promise<readonly IClaim<JobStorageFormat<Input, Output>>[]> {
    return await this.messageQueue.receive({
      workerId: this.workerId,
      leaseMs: this.leaseMs,
      max: this.prefetch,
    });
  }

  /**
   * Drive a pre-fetched batch of claims through the dispatch pipeline.
   *
   * Settles every claim before resolving: each claim is either dispatched via
   * {@link processSingleJob} (which owns its terminal ack/fail/retry), or
   * released back to PENDING via {@link releaseClaimedJob} when shutdown
   * fires mid-batch or the limiter has no slot available. This is critical
   * for push-only transports (e.g. Cloudflare Queues' `queue()` handler)
   * where any unacked claim left in flight when the handler returns is
   * redelivered.
   *
   * Exposed as `public` so external drivers can feed claims they received
   * out-of-band (CFQ adapter, tests) through the same pipeline the internal
   * loop uses.
   */
  public async processClaims(
    claims: readonly IClaim<JobStorageFormat<Input, Output>>[]
  ): Promise<void> {
    // Public callers (push-only transports like Cloudflare Queues' queue()
    // handler) MUST observe full settlement before returning so the runtime
    // doesn't redeliver still-in-flight claims. Pass awaitAll=true to block
    // until every dispatched job's processSingleJob promise settles.
    await this.processClaimsInternal(claims, true);
  }

  /**
   * Internal variant of {@link processClaims} that returns counts useful for
   * the polling loop's idle/backoff logic. Public callers go through
   * {@link processClaims}; the loop calls this directly so it can detect
   * the "limiter full for every claim" case without racing the async
   * lifetime of {@link processSingleJob}.
   *
   * @param awaitAll - When true, wait for every dispatched processSingleJob
   *   to settle before resolving. The polling-loop caller passes false because
   *   it intentionally fires jobs in the background and reschedules on the
   *   next loop iteration; the public {@link processClaims} caller passes
   *   true to satisfy the "settle every claim before resolving" contract
   *   that push-only transports depend on.
   */
  private async processClaimsInternal(
    claims: readonly IClaim<JobStorageFormat<Input, Output>>[],
    awaitAll: boolean = false
  ): Promise<{ dispatched: number; limiterFull: boolean }> {
    let dispatched = 0;
    let limiterFull = false;
    // Track each dispatched job alongside its promise so awaitAll can inspect
    // settled results and log rejections with jobId context, instead of a
    // swallowing .catch losing all observability.
    const inflight: { job: QueueJob; promise: Promise<void> }[] = [];

    for (const claim of claims) {
      const job = this.storageToClass(claim.body) as QueueJob;
      if (job.id != null) {
        this.activeClaims.set(job.id, claim);
      }

      if (!this.running) {
        // Stopped during the batch. Release all remaining claims back to PENDING.
        await this.releaseClaimedJob(job);
        continue;
      }

      const limiterToken = await this.limiter.tryAcquire();
      if (limiterToken === null || limiterToken === undefined) {
        // No limiter slot available — release the claim back so another
        // worker (or this one on a later iteration) can pick it up.
        await this.releaseClaimedJob(job);
        limiterFull = true;
        continue;
      }

      if (!this.running) {
        // Stop fired while tryAcquire was in flight.
        try {
          await this.limiter.release(limiterToken);
        } catch {
          // best-effort
        }
        await this.releaseClaimedJob(job);
        continue;
      }

      // Dispatch in background to allow concurrent jobs. processSingleJob owns
      // the terminal ack/fail/retry for this claim and its own error handling,
      // so anything reaching this layer as a rejection is unexpected and worth
      // logging.
      const promise = this.processSingleJob(job, limiterToken);
      if (!awaitAll) {
        // Background dispatch (polling-loop caller): the promise is fire-and-
        // forget, so attach a swallow+log .catch to prevent unhandled rejection
        // warnings while still surfacing the failure to operators.
        promise.catch((err) => {
          getLogger().error("processSingleJob unexpectedly rejected", {
            jobId: job.id,
            error: err,
          });
        });
      }
      inflight.push({ job, promise });
      dispatched++;
    }

    if (awaitAll && inflight.length > 0) {
      // Wait for every dispatched job to settle before returning. Required by
      // public callers driving push-only transports — see processClaims doc.
      // Inspect the settled results so unexpected rejections (which would
      // otherwise be invisible without an unhandled-rejection handler) are
      // logged with jobId context.
      const results = await Promise.allSettled(inflight.map((i) => i.promise));
      for (let i = 0; i < results.length; i++) {
        const r = results[i]!;
        if (r.status === "rejected") {
          getLogger().error("processSingleJob unexpectedly rejected", {
            jobId: inflight[i]!.job.id,
            error: r.reason,
          });
        }
      }
    }

    return { dispatched, limiterFull };
  }

  /**
   * Main job processing loop.
   *
   * Runs as a tight `while` loop (no recursive `setTimeout`) so that
   * back-to-back jobs are picked up with minimal inter-job latency.
   *
   * When no jobs are available the worker sleeps until either:
   * - {@link notify} is called (e.g. because the server saw a new job inserted
   *   or a running job completed and freed a concurrency slot), or
   * - the poll-interval timeout expires (fallback for storages without push
   *   events).
   */
  protected async processJobs(): Promise<void> {
    while (this.running) {
      try {
        await this.checkForAbortingJobs();

        // Claim first, then atomically reserve a limiter slot. Doing the claim
        // before the acquire avoids a race window: with the previous "check
        // canProceed -> claim -> recordJobStart" sequence, two workers could
        // both observe count < max, both claim, and both then increment —
        // overshooting the configured limit by exactly the worker concurrency.
        // The atomic tryAcquire guarantees only one of N concurrent acquirers
        // succeeds when there's one slot left.
        //
        // With prefetch > 1, we claim up to `prefetch` jobs at once and do a
        // non-blocking tryAcquire for each. Jobs that can't immediately get a
        // limiter slot are released back to PENDING so other workers can pick
        // them up. With prefetch == 1 the behavior is identical to before.
        const claims = await this.nextBatch();
        if (claims.length === 0) {
          // Queue is empty — sleep until notified of new work or until the
          // next deferred job becomes ready.
          const delay = await this.getIdleDelay();
          await this.waitForWakeOrTimeout(delay);
          continue;
        }

        this.readyRetryStreak = 0;

        const { dispatched, limiterFull } = await this.processClaimsInternal(claims);

        if (!this.running) {
          return;
        }

        // If the limiter was full for every claim we fetched, back off before
        // retrying so we don't busy-loop hammering the queue.
        if (dispatched === 0 && limiterFull) {
          await this.waitForWakeOrTimeout(await this.getLimiterWakeDelay());
        }
      } catch (err) {
        // Don't let transient errors kill the loop, but never swallow them
        // silently — a persistent storage failure (lost connection, schema
        // mismatch, serialization error) would otherwise sleep-loop forever
        // producing no work and no diagnostics. Rate-limit the log so a hot
        // failure doesn't flood while still surfacing the problem.
        const now = Date.now();
        if (now - this.lastLoopErrorLogAt >= LOOP_ERROR_LOG_INTERVAL_MS) {
          this.lastLoopErrorLogAt = now;
          getLogger().error("JobQueueWorker processing loop error", {
            error: err,
            queueName: this.queueName,
            workerId: this.workerId,
          });
        }
        await sleep(this.pollIntervalMs);
      }
    }
  }

  /**
   * How long to sleep when the limiter rejected an acquire. Reads the limiter's
   * own next-available time so we wake exactly when capacity opens, instead of
   * polling every {@link pollIntervalMs}. Clamped to {@link pollIntervalMs}
   * (lower bound) and {@link JobQueueWorker.limiterMaxWakeMs} (upper bound) so a
   * misconfigured/stuck limiter still wakes occasionally.
   */
  private async getLimiterWakeDelay(): Promise<number> {
    try {
      const next = await this.limiter.getNextAvailableTime();
      const delay = next.getTime() - Date.now();
      if (delay <= 0) return this.pollIntervalMs;
      return Math.min(Math.max(delay, this.pollIntervalMs), this.limiterMaxWakeMs);
    } catch {
      return this.pollIntervalMs;
    }
  }

  /**
   * Determine how long to sleep when idle.
   *
   * Peeks at the earliest PENDING job: if it has a future `visible_at`,
   * returns the time until it becomes ready (clamped to `pollIntervalMs`); an
   * empty queue returns `pollIntervalMs`.
   *
   * A head job that is *already* visible means the claim attempt that just
   * came back empty raced its `visible_at` deadline — the claim ran before the
   * deadline and this peek resolved after it, which is routine when a
   * short-deferred submit lands on a storage whose round trips are slower than
   * the deferral. Sleeping the full poll interval there strands ready work for
   * the whole interval (60s in the fast-wake tests), so retry promptly instead.
   * The retry backs off exponentially per consecutive occurrence, up to the
   * poll interval, so the pathological version of this — a head job that stays
   * visible-but-unclaimable, e.g. under clock skew between the worker and the
   * storage — degrades to plain polling rather than spinning on the backend.
   */
  private async getIdleDelay(): Promise<number> {
    try {
      const pending = await this.jobStore.peek(JobStatus.PENDING, 1);
      if (pending.length > 0) {
        const visibleAt = pending[0].visible_at;
        const delay = visibleAt ? new Date(visibleAt).getTime() - Date.now() : 0;
        if (delay > 0) {
          this.readyRetryStreak = 0;
          return Math.min(delay, this.pollIntervalMs);
        }
        const step = IDLE_READY_RETRY_BASE_MS * 2 ** this.readyRetryStreak;
        if (step < this.pollIntervalMs) {
          this.readyRetryStreak++;
        }
        return Math.min(step, this.pollIntervalMs);
      }
      this.readyRetryStreak = 0;
    } catch {
      // If peek fails, fall back to default
    }
    return this.pollIntervalMs;
  }

  /**
   * Wait for either a {@link notify} call or the given timeout,
   * whichever comes first. Consumes any pending wake latched while the worker
   * was not yet idle (see {@link wakePending}) — returns immediately in that
   * case rather than sleeping.
   */
  private waitForWakeOrTimeout(timeoutMs: number): Promise<void> {
    if (this.wakePending) {
      this.wakePending = false;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.wakeTimer = setTimeout(() => {
        this.wakeTimer = null;
        this.wakeResolve = null;
        this.wakePending = false;
        resolve();
      }, timeoutMs);

      this.wakeResolve = () => {
        this.wakePending = false;
        resolve();
      };
    });
  }

  /**
   * Check for in-process jobs that have abort_requested_at set and trigger
   * their abort controllers. Only relevant for jobs running on THIS worker
   * (we have an abort controller registered for them). When no jobs are active,
   * the peek result is irrelevant — skip the storage round-trip entirely.
   * Important for battery life on same-process deployments (browser/mobile)
   * where workers spend most time idle.
   */
  protected async checkForAbortingJobs(): Promise<void> {
    if (this.activeJobAbortControllers.size === 0) {
      return;
    }
    const processingJobs = await this.jobStore.peek(JobStatus.PROCESSING);
    for (const jobData of processingJobs) {
      if (!jobData.abort_requested_at) continue;
      const controller = this.activeJobAbortControllers.get(jobData.id);
      if (controller && !controller.signal.aborted) {
        controller.abort();
      }
    }
  }

  /**
   * Process a single job
   */
  protected async processSingleJob(job: Job<Input, Output>, limiterToken: unknown): Promise<void> {
    if (!job || !job.id) {
      throw new JobNotFoundError("Invalid job provided for processing");
    }

    const { promise: inFlightPromise, resolve: resolveInFlight } = Promise.withResolvers<void>();
    this.inFlight.set(job.id, inFlightPromise);

    const startTime = Date.now();

    const telemetry = getTelemetryProvider();
    const span = telemetry.isEnabled
      ? telemetry.startSpan("workglow.job.process", {
          attributes: {
            "workglow.job.id": asText(job.id),
            "workglow.job.queue": this.queueName,
            "workglow.job.lease_owner": this.workerId,
            "workglow.job.attempt": job.attempts,
            "workglow.job.max_attempts": job.maxAttempts,
          },
        })
      : undefined;

    let limiterReleased = false;
    try {
      // The limiter slot was already atomically reserved by tryAcquire() in
      // the main loop (or processNext). We register the abort controller
      // BEFORE validateJobState so the controller is observable from inside
      // validateJobState (which checks activeJobAbortControllers for a
      // pre-execute abort flag) — the abort-before-execute branch depends on
      // that ordering.
      const abortController = this.createAbortController(job.id);

      try {
        await this.validateJobState(job);
      } catch (validationErr) {
        // RateLimiter.complete() is a no-op on the success/error paths
        // (the slot only ages out of the window naturally) — so on a
        // validation failure here we MUST call release() to actually free
        // the slot. Without this, a DEADLINE-EXCEEDED or pre-aborted job
        // permanently consumed a RateLimiter window slot. The
        // limiterReleased flag gates the outer finally's complete() call so
        // we don't double-handle the slot.
        await this.limiter.release(limiterToken);
        limiterReleased = true;
        throw validationErr;
      }

      this.events.emit("job_start", job.id);

      let leaseInterval: ReturnType<typeof setInterval> | undefined;
      if (this.extendLeaseWhileRunning) {
        leaseInterval = setInterval(() => {
          const claim = this.activeClaims.get(job.id);
          if (!claim) return;
          claim.extendLease(this.leaseMs).catch((err) => {
            getLogger().error("extendLease failed during job execution:", {
              error: err,
              jobId: job.id,
            });
          });
        }, this.leaseMs * 0.5);
      }

      let output: Output;
      try {
        output = await this.executeJob(job, abortController.signal);
      } finally {
        if (leaseInterval !== undefined) {
          clearInterval(leaseInterval);
        }
        this.clearStreamClaimHeartbeat(job.id);
      }
      await this.completeJob(job, output);

      const elapsed = Date.now() - startTime;
      this.processingTimes.push(elapsed);
      if (this.processingTimes.length > this.maxProcessingTimeSamples) {
        this.processingTimes.shift();
      }

      if (span) {
        span.setAttributes({ "workglow.job.duration_ms": elapsed });
        span.setStatus(SpanStatusCode.OK);
      }
    } catch (err: unknown) {
      const error = this.normalizeError(err);
      let spanErrorMessage = error.message;
      if (isRetryableError(error)) {
        const currentJob = await this.getJob(job.id);
        if (!currentJob) {
          throw new JobNotFoundError(`Job ${asText(job.id)} not found`);
        }

        if (currentJob.attempts + 1 >= currentJob.maxAttempts) {
          spanErrorMessage = "Max attempts reached";
          // Forward to dead-letter queue before marking as failed
          if (this.deadLetter !== "discard") {
            try {
              await this.deadLetter.send({
                original: currentJob.input,
                error: error.message,
                errorCode: jobErrorPersistedCode(error),
                attempts: currentJob.attempts,
                queueName: this.queueName,
                jobRunId: currentJob.jobRunId,
              });
            } catch (dlqErr) {
              getLogger().error("Dead-letter queue send failed:", { error: dlqErr });
            }
          }
          await this.failJob(currentJob, new PermanentJobError(spanErrorMessage));
          span?.setStatus(SpanStatusCode.ERROR, spanErrorMessage);
        } else {
          // Only delete the abort controller (not the claim) so rescheduleJob
          // can still call claim.retry(). rescheduleJob's finally block drops
          // the claim from activeClaims after it has been settled.
          this.activeJobAbortControllers.delete(job.id);
          // Only `RetryableJobError` carries a requested time; an error that
          // declared the flag some other way is rescheduled on the backoff.
          const retryDate = error instanceof RetryableJobError ? error.retryDate : undefined;
          await this.rescheduleJob(currentJob, retryDate);
          span?.addEvent("workglow.job.retry", {
            "workglow.job.attempt": currentJob.attempts,
          });
          span?.setStatus(SpanStatusCode.UNSET);
        }
      } else if (error instanceof JobDisabledError) {
        // Route through disableJob so the row transitions to DISABLED
        // (not FAILED). Without this branch, attempting to disable a job
        // mid-flight clobbered the DISABLED status with FAILED and the
        // atomic-disable code path was unreachable.
        await this.disableJob(job);
        span?.setStatus(SpanStatusCode.UNSET);
      } else {
        await this.failJob(job, error);
        span?.setStatus(SpanStatusCode.ERROR, error.message);
      }
      span?.setAttributes({ "workglow.job.error": spanErrorMessage });
    } finally {
      if (!limiterReleased) {
        await this.limiter.complete(limiterToken);
      }
      span?.end();
      // Guard against a concurrent processSingleJob for the same jobId (which
      // can start before this finally block runs, e.g. after a reschedule).
      // Only delete our own inFlight entry; if another invocation already
      // replaced it, leave that entry alone.
      if (this.inFlight.get(job.id) === inFlightPromise) {
        this.inFlight.delete(job.id);
      }
      resolveInFlight();
    }
  }

  /**
   * Execute a job with the provided abort signal
   */
  protected async executeJob(job: Job<Input, Output>, signal: AbortSignal): Promise<Output> {
    if (!job) throw new JobNotFoundError("Cannot execute null or undefined job");
    return await job.execute(job.input, {
      signal,
      updateProgress: this.updateProgress.bind(this, job.id),
      emitStreamEvent: (event) => this.emitStreamEvent(job.id, event),
    });
  }

  /**
   * Update progress for a job.
   *
   * Mid-job progress is delivered in-memory via the `job_progress` event;
   * storage is only touched at terminal transitions (complete / fail / retry).
   * Cross-process observers therefore see state transitions but not fine-grained
   * progress — subscribe to an attached `JobQueueClient` for that.
   */
  protected async updateProgress(
    jobId: unknown,
    progress: number,
    message: string = "",
    details: Record<string, unknown> | null = null
  ): Promise<void> {
    progress = Math.max(0, Math.min(100, progress));
    this.events.emit("job_progress", jobId, progress, message, details);
  }

  /**
   * Emit a stream event for a job, both in-memory to the owning server's
   * attached clients and best-effort across processes via the message
   * queue's publish chain.
   *
   * The returned promise settles once BOTH halves have delivered:
   *
   * - the direct, awaitable dispatch to attached clients via
   *   {@link JobQueueWorkerOptions.onStreamEvent} — injected by the server
   *   because `this.events.emit` below cannot carry a return value back to
   *   this caller; and
   * - the cross-process publish chain (unchanged from before).
   *
   * Neither half can reject the returned promise — a forwarding failure or a
   * publish failure is logged and swallowed — so a slow or misbehaving
   * consumer paces the producing job without ever failing it.
   *
   * Emitting is also what makes this job's remaining runtime consumer-paced,
   * so it is where the claim starts being renewed — see
   * {@link armStreamClaimHeartbeat}.
   */
  protected emitStreamEvent(jobId: unknown, event: StreamEventLike): Promise<void> {
    this.armStreamClaimHeartbeat(jobId);

    // In-memory fan-out for worker-level observers (mirrored again at the
    // server level) — fire-and-forget, unrelated to the awaitable dispatch
    // below.
    this.events.emit("job_stream", jobId, event);

    const dispatches: Promise<void>[] = [];

    // Direct call path to the owning server's attached clients. This is the
    // in-process half of the returned promise: without it, a job on a
    // backend with no `publishStreamChunk` (SQLite, Postgres, Supabase,
    // IndexedDB) would await nothing and could outrun its consumer without
    // bound.
    if (this.onStreamEvent) {
      dispatches.push(
        this.onStreamEvent(jobId, event).catch((err) => {
          getLogger().error("stream event dispatch to attached clients failed", {
            jobId,
            error: err,
          });
        })
      );
    }

    // Cross-process side-channel (best-effort). The CARRIER assigns the per-job
    // `seq` from a counter it owns, so the sequence is continuous across
    // attempts: a retry claimed by a different worker continues the same job's
    // sequence instead of restarting at 1 and colliding with the prior
    // attempt's events (which the subscriber's reassembler would then drop). A
    // publish failure must never fail the job.
    //
    // Publishes are serialized per job: the carrier contract permits ASYNC seq
    // assignment, so firing publishes concurrently could let a later event
    // claim an earlier seq and arrive permanently out of order. Chaining each
    // publish after the previous one settles guarantees seqs are assigned in
    // emission order.
    const publish = this.messageQueue.publishStreamChunk;
    if (typeof publish === "function") {
      const chain = (this.streamPublishChains.get(jobId) ?? Promise.resolve())
        .then(() => publish.call(this.messageQueue, jobId, event))
        .catch((err) => {
          getLogger().error("publishStreamChunk failed", { jobId, error: err });
        });
      this.streamPublishChains.set(jobId, chain);
      dispatches.push(chain);
    }

    if (dispatches.length === 0) return Promise.resolve();
    return Promise.all(dispatches).then(() => undefined);
  }

  /**
   * Start renewing this job's claim, once, on its first stream event.
   *
   * {@link emitStreamEvent} resolves only after every `onStream` listener has
   * taken the event, and a graph consumer's listener resolves only when the
   * consumer pulls — so a slow sink parks the job mid-body for as long as it
   * likes. Nothing else renews the claim while it is parked: `updateProgress`
   * deliberately never touches storage, and the only remaining writes are the
   * terminal ones. A storage that reclaims PROCESSING rows with an expired
   * lease (`InMemoryQueueStorage.next` and every durable backend that follows
   * the same `IQueueStorage.next` contract) then hands the job to the
   * next `next()` caller — this worker's own poll loop included — and the
   * re-execution replays the whole body onto the subscription still parked on
   * the first one, concatenating two copies of the payload. That is the
   * corruption the stream retry ban exists to prevent, arriving by a path the
   * ban does not cover; the reclaim also burns an attempt each time, so a
   * parked job can exhaust `maxAttempts` while its first execution is still
   * running.
   *
   * Renewal starts at the first event rather than for every job because that
   * emit is the moment the job's remaining runtime stops being bounded by its
   * own work. `extendLeaseWhileRunning` already renews for the whole
   * execution, so it is left to do the job when enabled.
   */
  private armStreamClaimHeartbeat(jobId: unknown): void {
    if (this.extendLeaseWhileRunning) return;
    if (this.streamClaimHeartbeats.has(jobId)) return;
    // No claim means no lease to hold: the emit is arriving outside the
    // claimed window (a fire-and-forget event landing after the terminal
    // write) and a timer here would have nothing to clear it.
    if (!this.activeClaims.has(jobId)) return;
    const period = Math.max(1, Math.floor(this.leaseMs * 0.5));
    const timer = setInterval(() => {
      const claim = this.activeClaims.get(jobId);
      if (!claim) return;
      claim.extendLease(this.leaseMs).catch((err) => {
        getLogger().error("extendLease failed while a stream event was in flight:", {
          error: err,
          jobId,
        });
      });
    }, period);
    this.streamClaimHeartbeats.set(jobId, timer);
  }

  /** Stop renewing a job's claim. Idempotent. */
  private clearStreamClaimHeartbeat(jobId: unknown): void {
    const timer = this.streamClaimHeartbeats.get(jobId);
    if (timer === undefined) return;
    clearInterval(timer);
    this.streamClaimHeartbeats.delete(jobId);
  }

  /** Internal — resolve the active claim for a job id, throw if missing. */
  private getClaim(jobId: unknown): IClaim<JobStorageFormat<Input, Output>> | undefined {
    return this.activeClaims.get(jobId);
  }

  /**
   * Mark a job as completed
   */
  protected async completeJob(job: Job<Input, Output>, output?: Output): Promise<void> {
    try {
      job.status = JobStatus.COMPLETED;
      job.progress = 100;
      job.progressMessage = "";
      job.progressDetails = null;
      job.completedAt = new Date();
      job.output = output ?? null;
      job.error = null;
      job.errorCode = null;

      // Atomic ack: hand the result directly to claim.ack() so result +
      // COMPLETED status land in a single storage write. If we crash here
      // — anywhere between this call site and the storage layer's commit —
      // the row stays PROCESSING, the lease expires, the next worker
      // reclaims it, and no `job_complete` is ever emitted.
      const claim = this.getClaim(job.id);
      if (claim) {
        await claim.ack(output ?? null);
      } else {
        // No active claim (rare path — e.g. abort beat us to it). Write
        // result + COMPLETED status atomically via the job store.
        await this.jobStore.completeWithResult(job.id, (output ?? null) as Output);
      }
      this.events.emit("job_complete", job.id, output as Output);
    } catch (err) {
      getLogger().error("completeJob errored:", { error: err });
    } finally {
      this.cleanupJob(job.id);
    }
  }

  /**
   * Mark a job as failed
   */
  protected async failJob(job: Job<Input, Output>, error: JobError): Promise<void> {
    try {
      const persistedCode = jobErrorPersistedCode(error);
      job.status = JobStatus.FAILED;
      job.progress = 100;
      job.completedAt = new Date();
      job.progressMessage = "";
      job.progressDetails = null;
      job.error = error.message;
      job.errorCode = persistedCode;

      // Atomic fail: hand error/errorCode/abortRequested directly to
      // claim.fail() so they land in a single storage write together with
      // status=FAILED.
      const abortRequested = error instanceof AbortSignalJobError;
      const claim = this.getClaim(job.id);
      if (claim) {
        await claim.fail({
          error: error.message,
          errorCode: persistedCode,
          abortRequested,
        });
      } else {
        // No active claim (e.g. lease lost or abort path).
        await this.jobStore.failWithError(job.id, {
          error: error.message,
          errorCode: persistedCode,
          abortRequested,
        });
      }
      this.events.emit("job_error", job.id, error.message, persistedCode);
    } catch (err) {
      getLogger().error("failJob errored:", { error: err });
    } finally {
      this.cleanupJob(job.id);
    }
  }

  /**
   * Mark a job as disabled
   */
  protected async disableJob(job: Job<Input, Output>): Promise<void> {
    try {
      job.status = JobStatus.DISABLED;
      job.progress = 100;
      job.completedAt = new Date();
      job.progressMessage = "";
      job.progressDetails = null;

      // Atomic disable: a single storage write sets status=DISABLED,
      // releases the lease, and clears progress fields.
      const claim = this.getClaim(job.id);
      if (claim) {
        await claim.disable();
      } else {
        // No active claim (lease lost / aborted). Use markDisabled, not
        // saveStatus, so the no-claim path produces the same row state as
        // claim.disable() (lease_owner=null, progress cleared, completed_at set).
        await this.jobStore.markDisabled(job.id);
      }
      this.events.emit("job_disabled", job.id);
    } catch (err) {
      getLogger().error("disableJob errored:", { error: err });
    } finally {
      this.cleanupJob(job.id);
    }
  }

  /**
   * Release a job that {@link next} just claimed but that we won't process
   * because the worker was stopped mid-claim. Resets the row to PENDING so
   * the next started worker can pick it up. Lease expiry in `next()` would
   * otherwise reclaim it after the lease expires.
   *
   * Uses `storage.releaseClaim()` rather than `storage.complete()` so the retry
   * budget isn't burned: the worker never actually attempted execution.
   */
  protected async releaseClaimedJob(job: Job<Input, Output>): Promise<void> {
    try {
      // Prefer driving the claim's release path so any per-claim cleanup
      // (e.g. transient buffers) is consistent with regular settlement.
      const claim = this.activeClaims.get(job.id);
      if (claim) {
        await this.messageQueue.releaseClaim(claim.id);
      } else {
        await this.messageQueue.releaseClaim(job.id);
      }
    } catch (err) {
      getLogger().error("releaseClaimedJob errored:", { error: err });
    } finally {
      this.activeClaims.delete(job.id);
    }
  }

  /**
   * Reschedule a job for retry
   */
  protected async rescheduleJob(job: Job<Input, Output>, retryDate?: Date): Promise<void> {
    try {
      job.status = JobStatus.PENDING;
      const nextAvailableTime = await this.limiter.getNextAvailableTime();
      // `instanceof Date` alone is a type check wearing a validity check's
      // clothes: an Invalid Date passes it, its NaN reaches `delaySeconds`
      // below, and `claim.retry` throws a RangeError out of `toISOString()` —
      // caught here, so the job is silently never rescheduled at all. The
      // date comes from a job, provider or third-party error object, any of
      // which can construct one. No clamping happens here: whatever parses
      // the remote hint owns the retry-delay policy; this worker only refuses
      // the impossible.
      const usableRetryDate =
        retryDate instanceof Date && Number.isFinite(retryDate.getTime()) ? retryDate : undefined;
      job.visibleAt = usableRetryDate ?? nextAvailableTime;
      job.progress = 0;
      job.progressMessage = "";
      job.progressDetails = null;
      // Increment attempts to keep in-memory object in sync with storage
      // The storage layer will read from DB and increment, so this keeps them aligned
      job.attempts = (job.attempts ?? 0) + 1;

      const claim = this.getClaim(job.id);
      const delaySeconds = Math.max(0, (job.visibleAt.getTime() - Date.now()) / 1000);
      if (claim) {
        await claim.retry({ delaySeconds });
      }
      this.events.emit("job_retry", job.id, job.visibleAt);
    } catch (err) {
      getLogger().error("rescheduleJob errored:", { error: err });
    } finally {
      // rescheduleJob is called from the catch branch in processSingleJob,
      // which already calls cleanupJob via this method's path; ensure the
      // claim ref is dropped too.
      this.activeClaims.delete(job.id);
    }
  }

  /**
   * Create an abort controller for a job.
   *
   * The job MUST already be registered in {@link inFlight} — this enforces
   * the invariant that `activeJobAbortControllers ⊆ inFlight`, which
   * {@link handleAbort} relies on to decide whether `processSingleJob` is
   * still on the hook for the terminal write. Calling this from any path
   * other than `processSingleJob` (which registers `inFlight` first) is a
   * programming error.
   */
  protected createAbortController(jobId: unknown): AbortController {
    if (!jobId) throw new JobNotFoundError("Cannot create abort controller for undefined job");

    if (!this.inFlight.has(jobId)) {
      throw new Error(
        `createAbortController invariant violated: jobId ${asText(jobId)} is not in inFlight. ` +
          `Abort controllers must only be created from within processSingleJob.`
      );
    }

    if (this.activeJobAbortControllers.has(jobId)) {
      return this.activeJobAbortControllers.get(jobId)!;
    }

    const abortController = new AbortController();
    abortController.signal.addEventListener("abort", () => this.handleAbort(jobId));
    this.activeJobAbortControllers.set(jobId, abortController);
    return abortController;
  }

  /**
   * Handle job abort.
   *
   * Two callers fire the controller and reach this listener:
   *   1. `requestAbort` — same-process abort while the job is in flight here.
   *   2. `checkForAbortingJobs` — cross-process abort observed via storage poll.
   *
   * In both cases, if processSingleJob is still running this job locally,
   * the abort signal will propagate into the user task and processSingleJob's
   * own catch path will write the terminal state. We must not race it: doing
   * so duplicates the `job_error` emit and, worse, can clobber a successful
   * `completeJob` that won the race (the COMPLETED→FAILED overwrite bug).
   *
   * If the job is no longer in flight here, it has already settled — recheck
   * storage and only write FAILED for non-terminal states (i.e. a PROCESSING
   * row left over from a cross-process abort that this worker never picked up).
   */
  protected async handleAbort(jobId: unknown): Promise<void> {
    if (this.inFlight.has(jobId)) {
      return;
    }
    const job = await this.getJob(jobId);
    if (!job) {
      getLogger().error("handleAbort: job not found", { jobId });
      return;
    }
    if (
      job.status === JobStatus.COMPLETED ||
      job.status === JobStatus.FAILED ||
      job.status === JobStatus.DISABLED
    ) {
      return;
    }
    await this.failJob(job, new AbortSignalJobError("Job Aborted"));
  }

  /**
   * Get a job by ID
   */
  protected async getJob(id: unknown): Promise<Job<Input, Output> | undefined> {
    const job = await this.jobStore.get(id);
    if (!job) return undefined;
    return this.storageToClass(job);
  }

  /**
   * Validate job state before processing
   */
  protected async validateJobState(job: Job<Input, Output>): Promise<void> {
    if (job.status === JobStatus.COMPLETED) {
      throw new PermanentJobError(`Job ${String(job.id)} is already completed`);
    }
    if (job.status === JobStatus.FAILED) {
      throw new PermanentJobError(`Job ${String(job.id)} has failed`);
    }
    if (this.activeJobAbortControllers.get(job.id)?.signal.aborted) {
      throw new AbortSignalJobError(`Job ${String(job.id)} is being aborted`);
    }
    if (job.deadlineAt && job.deadlineAt < new Date()) {
      throw new PermanentJobError(`Job ${String(job.id)} has exceeded its deadline`);
    }
    if (job.status === JobStatus.DISABLED) {
      throw new JobDisabledError(`Job ${String(job.id)} has been disabled`);
    }
  }

  /**
   * Normalize errors into JobError instances
   */
  protected normalizeError(err: unknown): JobError {
    if (err instanceof JobError) {
      return err;
    }
    if (err instanceof Error) {
      // An error that declares itself retryable keeps that answer through the
      // wrapping. This is the boundary a worker-thrown error arrives at with
      // its class already gone, so wrapping unconditionally in
      // `PermanentJobError` is what silently turned a rate limit into a
      // terminal failure.
      const message = withJobErrorDiagnostics(err.message, err);
      return isRetryableError(err)
        ? new RetryableJobError(message)
        : new PermanentJobError(message);
    }
    return new PermanentJobError(String(err));
  }

  /**
   * Clean up job state after completion/failure
   */
  protected cleanupJob(jobId: unknown): void {
    this.activeJobAbortControllers.delete(jobId);
    this.activeClaims.delete(jobId);
    this.streamPublishChains.delete(jobId);
    this.clearStreamClaimHeartbeat(jobId);
  }

  /**
   * Convert storage format to Job class
   */
  protected storageToClass(details: JobStorageFormat<Input, Output>): Job<Input, Output> {
    return storageToClass(details, this.jobClass);
  }
}
