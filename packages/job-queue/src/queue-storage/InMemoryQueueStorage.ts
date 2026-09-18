/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createServiceToken,
  EventEmitter,
  getLogger,
  makeFingerprint,
  sleep,
  uuid4,
} from "@workglow/util";
import type { StreamChunkRow, StreamEventLike } from "../job/JobQueueEventListeners";
import type {
  IQueueStorage,
  JobStorageFormat,
  QueueChangePayload,
  QueueStorageOptions,
  QueueSubscribeOptions,
} from "./IQueueStorage";
import { JobStatus } from "./IQueueStorage";
import { validateLeaseMs } from "./validateLeaseMs";

/**
 * Event listeners for queue storage events
 */
type QueueEventListeners<Input, Output> = {
  change: (payload: QueueChangePayload<Input, Output>) => void;
};

export const IN_MEMORY_QUEUE_STORAGE = createServiceToken<IQueueStorage<any, any>>(
  "jobqueue.storage.inMemory"
);

/**
 * How long (ms) a job's stream log is retained after a terminal
 * `finish`/`error` event is published, so a late subscriber can still replay
 * the finished stream before the log is dropped. Kept equal to the client's
 * `STREAM_FINISH_GRACE_MS` (`JobQueueClient.ts`) — importing it would make the
 * storage layer depend on the client layer above it — so a client still inside
 * its post-completion grace window can always replay. Without this, a job
 * whose row outlives its stream (or that never had a row) would retain its log
 * forever.
 */
const STREAM_LOG_RETENTION_MS = 30_000;

/**
 * Cap on the bytes one job's replay log may retain.
 *
 * The log exists so a late subscriber can replay what it missed, and it was
 * appended to unconditionally — which for a streamed BODY means the whole
 * payload lives on the heap until the retention deadline. A multi-GB archive
 * fetched through the queue therefore cost a second copy of itself in memory,
 * measured at ~1 byte retained per byte downloaded, long after the graph that
 * consumed it had finished.
 *
 * Replay is worth memory proportional to a token stream, not to a file. Past
 * this cap the OLDEST rows are dropped (the newest are what a resuming
 * subscriber with a cursor still needs) and the drop is RECORDED, so a replay
 * that would have needed them fails loudly instead of handing back a body with
 * a hole in it — see {@link InMemoryQueueStorage.subscribeToStream}.
 */
const STREAM_LOG_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Bytes a row costs the log. Binary deltas are the only events whose size is
 * unbounded, so they are measured exactly; everything else is charged a flat
 * overhead, which keeps a long stream of tiny events bounded too.
 */
function streamRowBytes(event: StreamEventLike): number {
  const delta = (event as { binaryDelta?: unknown }).binaryDelta;
  if (ArrayBuffer.isView(delta)) return delta.byteLength + 64;
  if (delta instanceof ArrayBuffer) return delta.byteLength + 64;
  return 64;
}

/**
 * In-memory implementation of a job queue that manages asynchronous tasks.
 * Supports job scheduling, status tracking, result caching, and prefix-based filtering.
 */
export class InMemoryQueueStorage<Input, Output> implements IQueueStorage<Input, Output> {
  public readonly scope = "process" as const;
  /**
   * In-memory rows do not survive the process — declared so wrapper facades
   * and cloud adapters can detect the non-durable pairing.
   */
  public readonly durable = false;
  /** The prefix values for filtering jobs */
  protected readonly prefixValues: Readonly<Record<string, string | number>>;
  /** Event emitter for change notifications */
  protected readonly events = new EventEmitter<QueueEventListeners<Input, Output>>();

  /** Per-job ordered append log of published stream rows (existence + replay). */
  private readonly streamLog = new Map<string, StreamChunkRow[]>();
  /**
   * Per-job retention deadline (epoch ms) stamped when a terminal
   * `finish`/`error` event is published; the log is dropped lazily once the
   * deadline passes. See {@link STREAM_LOG_RETENTION_MS}.
   */
  private readonly streamLogExpiry = new Map<string, number>();
  /** Per-job bytes currently retained in {@link streamLog}. */
  private readonly streamLogBytes = new Map<string, number>();
  /**
   * Per-job highest `seq` dropped from the log to stay under
   * {@link STREAM_LOG_MAX_BYTES}. A subscriber asking to replay from at or
   * after this point lost nothing; one asking from before it cannot be served.
   */
  private readonly streamLogDroppedThrough = new Map<string, number>();
  /** Per-job live stream subscribers. */
  private readonly streamSubscribers = new Map<string, Set<(row: StreamChunkRow) => unknown>>();
  /**
   * Per-job monotonic stream `seq` counter. The carrier owns it (not the
   * worker) so the sequence is continuous across attempts: a retry claimed by a
   * different worker continues the same job's sequence rather than restarting at
   * 1. Persists across retries; evicted with the job's stream on row deletion.
   */
  private readonly streamSeq = new Map<string, number>();

  /**
   * Creates a new in-memory job queue
   * @param queueName - Name of the queue
   * @param options - Optional configuration including prefix filters
   */
  constructor(
    public readonly queueName: string,
    options?: QueueStorageOptions
  ) {
    this.jobQueue = [];
    this.prefixValues = options?.prefixValues ?? {};
  }

  /** Internal array storing all jobs */
  public jobQueue: Array<JobStorageFormat<Input, Output> & Record<string, unknown>>;

  /**
   * Checks if a job matches the current prefix values
   */
  private matchesPrefixes(job: JobStorageFormat<Input, Output> & Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(this.prefixValues)) {
      if (job[key] !== value) {
        return false;
      }
    }
    return true;
  }

  /**
   * Adds a new job to the queue
   * Generates an ID and fingerprint if not provided
   */
  public async add(job: JobStorageFormat<Input, Output>): Promise<unknown> {
    await sleep(0);
    const now = new Date().toISOString();
    const jobWithPrefixes = job as JobStorageFormat<Input, Output> & Record<string, unknown>;
    jobWithPrefixes.id = jobWithPrefixes.id ?? uuid4();
    jobWithPrefixes.job_run_id = jobWithPrefixes.job_run_id ?? uuid4();
    jobWithPrefixes.queue = this.queueName;
    jobWithPrefixes.fingerprint =
      jobWithPrefixes.fingerprint ?? (await makeFingerprint(jobWithPrefixes.input));
    jobWithPrefixes.status = JobStatus.PENDING;
    jobWithPrefixes.progress = 0;
    jobWithPrefixes.progress_message = "";
    jobWithPrefixes.progress_details = null;
    jobWithPrefixes.created_at = now;
    // A caller-set future visible_at is a delayed send (delaySeconds) — keep it.
    jobWithPrefixes.visible_at = jobWithPrefixes.visible_at ?? now;

    for (const [key, value] of Object.entries(this.prefixValues)) {
      jobWithPrefixes[key] = value;
    }

    this.jobQueue.push(jobWithPrefixes);
    this.events.emit("change", { type: "INSERT", new: jobWithPrefixes });
    return jobWithPrefixes.id;
  }

  /**
   * Retrieves a job from the queue by its id.
   * @param id - The id of the job to retrieve.
   * @returns A promise that resolves to the job or undefined if the job is not found.
   */
  public async get(id: unknown): Promise<JobStorageFormat<Input, Output> | undefined> {
    await sleep(0);
    const job = this.jobQueue.find((j) => j.id === id);
    if (job && this.matchesPrefixes(job)) {
      return job;
    }
    return undefined;
  }

  /**
   * Retrieves a slice of jobs from the queue.
   * @param status - The status of the jobs to retrieve.
   * @param num - The number of jobs to retrieve.
   * @returns A promise that resolves to an array of jobs.
   */
  public async peek(
    status: JobStatus = JobStatus.PENDING,
    num: number = 100
  ): Promise<Array<JobStorageFormat<Input, Output>>> {
    await sleep(0);
    num = Number(num) || 100;
    return this.jobQueue
      .filter((j) => this.matchesPrefixes(j))
      .sort((a, b) => (a.visible_at || "").localeCompare(b.visible_at || ""))
      .filter((j) => j.status === status)
      .slice(0, num);
  }

  /**
   * Retrieves the next available job that is ready to be processed.
   * Claims PENDING jobs ready to run, and also reclaims PROCESSING jobs whose
   * lease has expired (crash recovery). Sets lease_expires_at on the claimed row.
   * @param workerId - Worker ID to associate with the job
   * @param opts - Optional options including leaseMs (default 30000)
   * @returns The next job or undefined if no job is available
   */
  public async next(
    workerId: string,
    opts?: { leaseMs?: number }
  ): Promise<JobStorageFormat<Input, Output> | undefined> {
    await sleep(0);
    const leaseMs = opts?.leaseMs ?? 30000;
    validateLeaseMs(leaseMs, "leaseMs");
    const now = new Date().toISOString();
    const leaseExpiry = new Date(Date.now() + leaseMs).toISOString();

    // First look for a normal PENDING job ready to run
    const pending = this.jobQueue
      .filter((job) => this.matchesPrefixes(job))
      .filter((job) => job.status === JobStatus.PENDING)
      .filter((job) => !job.visible_at || job.visible_at <= now)
      .sort((a, b) => (a.visible_at || "").localeCompare(b.visible_at || ""));

    // Also look for PROCESSING jobs with expired leases
    const expiredLease = this.jobQueue
      .filter((job) => this.matchesPrefixes(job))
      .filter((job) => job.status === JobStatus.PROCESSING)
      .filter((job) => !job.lease_expires_at || job.lease_expires_at < now)
      .sort((a, b) => (a.visible_at || "").localeCompare(b.visible_at || ""));

    const job = pending[0] ?? expiredLease[0];
    if (job) {
      const oldJob = { ...job };
      // Lease-expiry reclaim (job was PROCESSING with expired lease) consumes
      // one attempt against max_attempts; a fresh PENDING claim does not.
      const isLeaseExpiryReclaim = job.status === JobStatus.PROCESSING;
      job.status = JobStatus.PROCESSING;
      job.last_attempted_at = now;
      job.lease_owner = workerId;
      job.lease_expires_at = leaseExpiry;
      if (isLeaseExpiryReclaim) {
        job.attempts = (job.attempts ?? 0) + 1;
      }
      // Always clear stale abort_requested_at on (re)claim so a flag set by
      // an earlier worker does not immediately abort the new lease.
      (job as unknown as Record<string, unknown>).abort_requested_at = null;
      this.events.emit("change", { type: "UPDATE", old: oldJob, new: job });
      return job;
    }
  }

  /**
   * Extend the lease on a currently PROCESSING job.
   * @param id - The ID of the job to extend the lease for
   * @param workerId - Worker ID that must match the current lease owner (lease_owner)
   * @param ms - Number of milliseconds to extend the lease by
   */
  public async extendLease(id: unknown, workerId: string, ms: number): Promise<void> {
    validateLeaseMs(ms, "ms");
    await sleep(0);
    const job = this.jobQueue.find((j) => j.id === id && this.matchesPrefixes(j));
    if (!job || job.status !== JobStatus.PROCESSING || job.lease_owner !== workerId) {
      throw new Error(
        `extendLease failed: job ${String(id)} is not PROCESSING or lease is not owned by worker ${workerId}`
      );
    }
    const oldJob = { ...job };
    job.lease_expires_at = new Date(Date.now() + ms).toISOString();
    this.events.emit("change", { type: "UPDATE", old: oldJob, new: job });
  }

  /**
   * Retrieves the size of the queue for a given status
   * @param status - The status of the jobs to retrieve.
   * @returns A promise that resolves to the number of jobs.
   */
  public async size(status: JobStatus = JobStatus.PENDING): Promise<number> {
    await sleep(0);
    return this.jobQueue.filter((j) => this.matchesPrefixes(j) && j.status === status).length;
  }

  /**
   * Saves the progress of a job
   * @param jobId - The id of the job to save the progress for.
   * @param progress - The progress of the job.
   * @param message - The message of the job.
   * @param details - The details of the job.
   */
  public async saveProgress(
    id: unknown,
    progress: number,
    message: string,
    details: Record<string, any> | null
  ): Promise<void> {
    await sleep(0);
    const job = this.jobQueue.find((j) => j.id === id && this.matchesPrefixes(j));
    if (!job) {
      // Job not found - this can happen if the job was already completed/removed
      // or if there's a race condition. Silently ignore progress updates for missing jobs.
      const jobWithAnyPrefix = this.jobQueue.find((j) => j.id === id);
      getLogger().warn("Job not found for progress update", {
        id,
        reason: jobWithAnyPrefix ? "prefix_mismatch" : "missing",
        existingStatus: jobWithAnyPrefix?.status,
        queueName: this.queueName,
        prefixValues: this.prefixValues,
      });
      return;
    }

    // Skip progress updates for jobs that are already completed or failed
    // to avoid unnecessary updates and potential race conditions
    if (job.status === JobStatus.COMPLETED || job.status === JobStatus.FAILED) {
      getLogger().warn("Job already completed or failed for progress update", {
        id,
        status: job.status,
        completedAt: job.completed_at,
        error: job.error,
      });
      return;
    }

    const oldJob = { ...job };
    job.progress = progress;
    job.progress_message = message;
    job.progress_details = details;
    this.events.emit("change", { type: "UPDATE", old: oldJob, new: job });
  }

  /**
   * Marks a job as complete with its output or error
   * Handles attempts for failed jobs and triggers completion callbacks
   * @param id - ID of the job to complete
   * @param output - Result of the job execution
   * @param error - Optional error message if job failed
   */
  public async complete(job: JobStorageFormat<Input, Output>) {
    await sleep(0);
    const jobWithPrefixes = job as JobStorageFormat<Input, Output> & Record<string, unknown>;
    const index = this.jobQueue.findIndex((j) => j.id === job.id && this.matchesPrefixes(j));
    if (index !== -1) {
      const existing = this.jobQueue[index];
      const currentAttempts = existing?.attempts ?? 0;
      jobWithPrefixes.attempts = currentAttempts + 1;
      // PENDING-retry / terminal completion: clear abort_requested_at so an
      // abort that was requested during the previous attempt does not
      // immediately cancel the retry. Terminal statuses get a harmless
      // cleanup of the same field.
      jobWithPrefixes.abort_requested_at = null;
      for (const [key, value] of Object.entries(this.prefixValues)) {
        jobWithPrefixes[key] = value;
      }
      this.jobQueue[index] = jobWithPrefixes;
      this.events.emit("change", { type: "UPDATE", old: existing, new: jobWithPrefixes });
    }
  }

  /**
   * Releases a claimed job back to PENDING without incrementing attempts.
   * @param id - The id of the claimed job to release.
   */
  public async releaseClaim(id: unknown): Promise<void> {
    await sleep(0);
    const job = this.jobQueue.find((j) => j.id === id && this.matchesPrefixes(j));
    if (job) {
      const oldJob = { ...job };
      job.status = JobStatus.PENDING;
      job.lease_owner = null;
      job.progress = 0;
      job.progress_message = "";
      job.progress_details = null;
      // Clear stale abort_requested_at — an abort flag set during the previous
      // claim must not survive the release and immediately cancel the next claim.
      (job as unknown as Record<string, unknown>).abort_requested_at = null;
      this.events.emit("change", { type: "UPDATE", old: oldJob, new: job });
    }
  }

  /**
   * Aborts a job.
   * - If PENDING: immediately mark as FAILED with abort_requested_at set.
   * - If PROCESSING: set abort_requested_at only (leave status as PROCESSING).
   * - Otherwise: no-op.
   * @param id - The id of the job to abort.
   */
  public async abort(id: unknown): Promise<void> {
    await sleep(0);
    const job = this.jobQueue.find((j) => j.id === id && this.matchesPrefixes(j));
    if (!job) return;
    const oldJob = { ...job };
    const now = new Date().toISOString();
    if (job.status === JobStatus.PENDING) {
      job.status = JobStatus.FAILED;
      job.abort_requested_at = now;
      job.completed_at = now;
    } else if (job.status === JobStatus.PROCESSING) {
      job.abort_requested_at = now;
    } else {
      return;
    }
    this.events.emit("change", { type: "UPDATE", old: oldJob, new: job });
  }

  /**
   * Terminal write that does NOT bump `attempts`. See IQueueStorage.finalize
   * for the rationale.
   */
  public async finalize(
    id: unknown,
    fields: {
      output?: Output | null;
      error?: string | null;
      error_code?: string | null;
      status?: JobStatus;
      completed_at?: string | null;
      abort_requested_at?: string | null;
      lease_owner?: string | null;
      progress?: number;
      progress_message?: string;
      progress_details?: Record<string, any> | null;
      visible_at?: string | null;
    }
  ): Promise<void> {
    await sleep(0);
    const job = this.jobQueue.find((j) => j.id === id && this.matchesPrefixes(j));
    if (!job) return;
    const oldJob = { ...job };
    const target = job as JobStorageFormat<Input, Output> & Record<string, unknown>;
    if ("output" in fields) target.output = (fields.output ?? null) as Output | null;
    if ("error" in fields) target.error = fields.error ?? null;
    if ("error_code" in fields) target.error_code = fields.error_code ?? null;
    if ("status" in fields && fields.status !== undefined) target.status = fields.status;
    if ("completed_at" in fields) target.completed_at = fields.completed_at ?? null;
    if ("abort_requested_at" in fields)
      target.abort_requested_at = fields.abort_requested_at ?? null;
    if ("lease_owner" in fields) target.lease_owner = fields.lease_owner ?? null;
    if ("progress" in fields) target.progress = fields.progress ?? 0;
    if ("progress_message" in fields) target.progress_message = fields.progress_message ?? "";
    if ("progress_details" in fields) target.progress_details = fields.progress_details ?? null;
    if ("visible_at" in fields) target.visible_at = fields.visible_at ?? null;
    this.events.emit("change", { type: "UPDATE", old: oldJob, new: job });
  }

  /**
   * Force-overwrite status without incrementing attempts. Standardized name —
   * the legacy `updateJobStatus` alias was removed in favour of this name
   * which mirrors `IJobStore.saveStatus` (the caller).
   */
  public async saveStatus(id: unknown, status: JobStatus): Promise<void> {
    await this.finalize(id, { status });
  }

  /**
   * Retrieves all jobs by their job_run_id.
   * @param job_run_id - The job_run_id of the jobs to retrieve.
   * @returns A promise that resolves to an array of jobs.
   */
  public async getByRunId(runId: string): Promise<Array<JobStorageFormat<Input, Output>>> {
    await sleep(0);
    return this.jobQueue.filter((job) => this.matchesPrefixes(job) && job.job_run_id === runId);
  }

  /**
   * Deletes all jobs from the queue that match the current prefix values.
   */
  public async deleteAll(): Promise<void> {
    await sleep(0);
    const deletedJobs = this.jobQueue.filter((job) => this.matchesPrefixes(job));
    this.jobQueue = this.jobQueue.filter((job) => !this.matchesPrefixes(job));
    for (const job of deletedJobs) {
      this.events.emit("change", { type: "DELETE", old: job });
      this.evictStream(job.id);
    }
  }

  /**
   * Looks up cached output for a given input
   * Uses input fingerprinting for efficient matching
   * @param input - The input to look up the cached output for.
   * @returns The cached output or null if not found
   */
  public async outputForInput(input: Input): Promise<Output | null> {
    await sleep(0);
    const fingerprint = await makeFingerprint(input);
    return (
      this.jobQueue.find(
        (j) =>
          this.matchesPrefixes(j) &&
          j.fingerprint === fingerprint &&
          j.status === JobStatus.COMPLETED
      )?.output ?? null
    );
  }

  /**
   * Deletes a job by its ID
   */
  public async delete(id: unknown): Promise<void> {
    await sleep(0);
    const deletedJob = this.jobQueue.find((job) => job.id === id && this.matchesPrefixes(job));
    this.jobQueue = this.jobQueue.filter((job) => !(job.id === id && this.matchesPrefixes(job)));
    if (deletedJob) {
      this.events.emit("change", { type: "DELETE", old: deletedJob });
    }
    // Evict unconditionally: deleting a job id drops its stream channel whether
    // or not a row still matched.
    this.evictStream(id);
  }

  /**
   * Delete jobs with a specific status older than a cutoff date
   * @param status - Status of jobs to delete
   * @param olderThanMs - Delete jobs completed more than this many milliseconds ago
   */
  public async deleteJobsByStatusAndAge(status: JobStatus, olderThanMs: number): Promise<void> {
    await sleep(0);
    const cutoffDate = new Date(Date.now() - olderThanMs).toISOString();
    const deletedJobs = this.jobQueue.filter(
      (job) =>
        this.matchesPrefixes(job) &&
        job.status === status &&
        job.completed_at &&
        job.completed_at <= cutoffDate
    );
    this.jobQueue = this.jobQueue.filter(
      (job) =>
        !this.matchesPrefixes(job) ||
        job.status !== status ||
        !job.completed_at ||
        job.completed_at > cutoffDate
    );
    for (const job of deletedJobs) {
      this.events.emit("change", { type: "DELETE", old: job });
      this.evictStream(job.id);
    }
  }

  /**
   * Find an active (PENDING or PROCESSING) record by fingerprint.
   * Used by IJobStore.findActiveByFingerprint for cloud-queue dedup.
   */
  public async findActiveByFingerprint(
    fingerprint: string
  ): Promise<JobStorageFormat<Input, Output> | undefined> {
    await sleep(0);
    return this.jobQueue.find(
      (j) =>
        this.matchesPrefixes(j) &&
        j.fingerprint === fingerprint &&
        (j.status === JobStatus.PENDING || j.status === JobStatus.PROCESSING)
    );
  }

  /**
   * Batch read by id. Returns results in the same order as `ids`, with
   * `undefined` for ids that don't exist or don't match prefixes.
   */
  public async getMany(
    ids: readonly unknown[]
  ): Promise<readonly (JobStorageFormat<Input, Output> | undefined)[]> {
    await sleep(0);
    const byId = new Map<unknown, JobStorageFormat<Input, Output>>();
    for (const j of this.jobQueue) {
      if (this.matchesPrefixes(j) && j.id !== undefined) {
        byId.set(j.id, j);
      }
    }
    return ids.map((id) => byId.get(id));
  }

  /**
   * Atomically write `output` and set status to COMPLETED in one mutation.
   */
  public async completeWithResult(id: unknown, output: Output): Promise<void> {
    await this.finalize(id, {
      output,
      error: null,
      error_code: null,
      status: JobStatus.COMPLETED,
      completed_at: new Date().toISOString(),
    });
  }

  /**
   * Atomically write status=DISABLED, release the lease, clear progress
   * fields, and stamp `completed_at` in one mutation. Does NOT write
   * error/error_code — DISABLED is not an error transition.
   */
  public async markDisabled(id: unknown): Promise<void> {
    const job = this.jobQueue.find((j) => j.id === id && this.matchesPrefixes(j));
    const completedAt = job?.completed_at ?? new Date().toISOString();
    await this.finalize(id, {
      status: JobStatus.DISABLED,
      completed_at: completedAt,
      lease_owner: null,
      progress: 0,
      progress_message: "",
      progress_details: null,
    });
  }

  /**
   * Atomically write error fields and set status to FAILED in one mutation.
   */
  public async failWithError(
    id: unknown,
    opts: {
      readonly error?: string | null;
      readonly errorCode?: string | null;
      readonly abortRequested?: boolean;
    }
  ): Promise<void> {
    const job = this.jobQueue.find((j) => j.id === id && this.matchesPrefixes(j));
    const now = new Date().toISOString();
    const abortRequestedAt =
      opts.abortRequested === true
        ? (job?.abort_requested_at ?? now)
        : (job?.abort_requested_at ?? null);
    await this.finalize(id, {
      ...("error" in opts ? { error: opts.error ?? null } : {}),
      ...("errorCode" in opts ? { error_code: opts.errorCode ?? null } : {}),
      abort_requested_at: abortRequestedAt,
      status: JobStatus.FAILED,
      completed_at: job?.completed_at ?? now,
    });
  }

  /**
   * No-op — in-memory storage has no schema to migrate.
   */
  public async migrate(): Promise<void> {
    // intentional no-op
  }

  /** No versioned schema for in-memory storage. */
  public getMigrations(): ReadonlyArray<unknown> {
    return [];
  }

  /**
   * Checks if a job matches the specified prefix filter
   * @param job - The job to check
   * @param prefixFilter - The prefix filter (undefined = use instance prefixes, {} = no filter)
   */
  private matchesPrefixFilter(
    job: JobStorageFormat<Input, Output>,
    prefixFilter?: Readonly<Record<string, string | number>>
  ): boolean {
    // If prefixFilter is explicitly an empty object, no prefix filtering
    if (prefixFilter && Object.keys(prefixFilter).length === 0) {
      return true;
    }

    // Use provided prefixFilter or fall back to instance's prefixValues
    const filterValues = prefixFilter ?? this.prefixValues;

    // If no filter values, match all
    if (Object.keys(filterValues).length === 0) {
      return true;
    }

    // Check each filter value
    const jobWithPrefixes = job as JobStorageFormat<Input, Output> & Record<string, unknown>;
    for (const [key, value] of Object.entries(filterValues)) {
      if (jobWithPrefixes[key] !== value) {
        return false;
      }
    }
    return true;
  }

  public async publishStreamChunk(jobId: unknown, event: StreamEventLike): Promise<void> {
    this.sweepExpiredStreamLogs();
    const key = String(jobId);
    const seq = (this.streamSeq.get(key) ?? 0) + 1;
    this.streamSeq.set(key, seq);
    const row: StreamChunkRow = { jobId, seq, event };
    // Always append — even with no subscribers — the documented contract is
    // that a late subscriber replays rows published before it attached.
    const log = this.streamLog.get(key);
    if (log) log.push(row);
    else this.streamLog.set(key, [row]);
    this.streamLogBytes.set(key, (this.streamLogBytes.get(key) ?? 0) + streamRowBytes(event));
    this.trimStreamLog(key);
    // A terminal event bounds the log's lifetime: stamp (or extend) the
    // retention deadline so the finished stream stays replayable for the
    // grace window and is then dropped by the lazy sweep.
    if (event.type === "finish" || event.type === "error") {
      this.streamLogExpiry.set(key, Date.now() + STREAM_LOG_RETENTION_MS);
    }
    // Awaited, not fired and forgotten: this publish runs inside the emitting
    // job's own awaited dispatch, so a subscriber that returns a promise is
    // the only thing that can pace the producer. Resolving as soon as the row
    // is appended lets a fast producer outrun a slow consumer and pile the
    // whole stream up in the consumer's queue. A subscriber's failure is
    // isolated — one bad consumer never fails the producing job.
    const subs = this.streamSubscribers.get(key);
    if (subs && subs.size > 0) {
      await Promise.all(
        [...subs].map(async (cb) => {
          try {
            await cb(row);
          } catch {
            // A subscriber's own failure is its business; delivery to the
            // rest, and the job, carry on.
          }
        })
      );
    }
  }

  public subscribeToStream(
    jobId: unknown,
    sinceSeq: number,
    callback: (row: StreamChunkRow) => unknown
  ): () => void {
    this.sweepExpiredStreamLogs();
    const key = String(jobId);
    let subs = this.streamSubscribers.get(key);
    if (!subs) {
      subs = new Set();
      this.streamSubscribers.set(key, subs);
    }
    subs.add(callback);
    // Replay already-published rows after registering; a row published during
    // replay (impossible in this single-threaded impl) would arrive live and the
    // consumer's reassembler dedups by seq. An expired log was swept above, so
    // it replays as if empty.
    // A replay the log can no longer serve is reported, never approximated:
    // the rows below `droppedThrough` were evicted for size, and delivering
    // the surviving suffix would splice a body back together across the hole
    // and present it as complete. An error at the next expected seq reaches
    // the consumer in order and surfaces as a throw.
    const droppedThrough = this.streamLogDroppedThrough.get(key) ?? 0;
    if (sinceSeq < droppedThrough) {
      // Not awaited: this method is synchronous by contract (it returns the
      // unsubscribe function), and replay has no live producer to pace —
      // unlike `publishStreamChunk`, where awaiting the subscriber is the only
      // backpressure there is. What replay delivers is bounded by the log cap.
      callback({
        jobId,
        seq: sinceSeq + 1,
        event: {
          type: "error",
          error: {
            message:
              `Stream replay unavailable for job ${key}: rows through seq ${droppedThrough} ` +
              `were dropped after the replay log passed ${STREAM_LOG_MAX_BYTES} bytes. ` +
              `Subscribe before the body streams, or consume it as it arrives.`,
          },
        },
      });
      return () => {
        const s = this.streamSubscribers.get(key);
        if (!s) return;
        s.delete(callback);
        if (s.size === 0) this.streamSubscribers.delete(key);
      };
    }
    const log = this.streamLog.get(key);
    // Not awaited, for the same reason as the refusal above: replay is a
    // bounded catch-up with nothing live behind it to slow down.
    if (log) for (const r of log) if (r.seq > sinceSeq) callback(r);
    return () => {
      const s = this.streamSubscribers.get(key);
      if (!s) return;
      s.delete(callback);
      if (s.size === 0) this.streamSubscribers.delete(key);
    };
  }

  /**
   * Lazily drop stream logs whose post-terminal retention deadline has passed.
   * Called from the channel entry points instead of a timer so an idle process
   * holds no timers; the seq counter survives so a late publish continues the
   * job's sequence rather than restarting at 1.
   */
  private sweepExpiredStreamLogs(): void {
    if (this.streamLogExpiry.size === 0) return;
    const now = Date.now();
    for (const [key, deadline] of this.streamLogExpiry) {
      if (deadline <= now) {
        this.streamLogExpiry.delete(key);
        this.streamLog.delete(key);
        this.streamLogBytes.delete(key);
        this.streamLogDroppedThrough.delete(key);
      }
    }
  }

  /** Drop a job's stream log + subscribers + seq counter (rides row deletion). */
  private evictStream(jobId: unknown): void {
    const key = String(jobId);
    this.streamLog.delete(key);
    this.streamLogExpiry.delete(key);
    this.streamLogBytes.delete(key);
    this.streamLogDroppedThrough.delete(key);
    this.streamSubscribers.delete(key);
    this.streamSeq.delete(key);
  }

  /**
   * Evict the oldest rows until the job's log is back under
   * {@link STREAM_LOG_MAX_BYTES}, recording how far the eviction reached.
   *
   * The row just appended is never evicted, so a single event larger than the
   * cap still delivers and the log simply holds that one row: a cap is a
   * memory bound, not a reason to lose the event a subscriber is waiting on.
   */
  private trimStreamLog(key: string): void {
    let bytes = this.streamLogBytes.get(key) ?? 0;
    if (bytes <= STREAM_LOG_MAX_BYTES) return;
    const log = this.streamLog.get(key);
    if (!log) return;
    let dropped = this.streamLogDroppedThrough.get(key) ?? 0;
    let cut = 0;
    while (cut < log.length - 1 && bytes > STREAM_LOG_MAX_BYTES) {
      bytes -= streamRowBytes(log[cut]!.event);
      dropped = log[cut]!.seq;
      cut++;
    }
    if (cut > 0) {
      log.splice(0, cut);
      this.streamLogDroppedThrough.set(key, dropped);
    }
    this.streamLogBytes.set(key, bytes);
  }

  /**
   * Subscribes to changes in the queue.
   * Since InMemory is both client and server, changes are detected via local events.
   *
   * @param callback - Function called when a change occurs
   * @param options - Subscription options including prefix filter
   * @returns Unsubscribe function
   */
  public subscribeToChanges(
    callback: (change: QueueChangePayload<Input, Output>) => void,
    options?: QueueSubscribeOptions
  ): () => void {
    const prefixFilter = options?.prefixFilter;

    const filteredCallback = (change: QueueChangePayload<Input, Output>) => {
      const newMatches = change.new ? this.matchesPrefixFilter(change.new, prefixFilter) : false;
      const oldMatches = change.old ? this.matchesPrefixFilter(change.old, prefixFilter) : false;

      if (!newMatches && !oldMatches) {
        return;
      }

      callback(change);
    };

    return this.events.subscribe("change", filteredCallback);
  }
}
