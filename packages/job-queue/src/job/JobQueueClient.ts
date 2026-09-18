/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_LIMITS, EventEmitter, asText, getLogger } from "@workglow/util";
import type { IJobStore } from "../queue-storage/IJobStore";
import type { IMessageQueue } from "../queue-storage/IMessageQueue";
import type { JobStorageFormat, QueueChangePayload } from "../queue-storage/IQueueStorage";
import { JobStatus } from "../queue-storage/IQueueStorage";
import { Job } from "./Job";
import {
  AbortSignalJobError,
  JobDisabledError,
  JobError,
  JobNotFoundError,
  PermanentJobError,
  RetryableJobError,
} from "./JobError";
import { applyPersistedDiagnosticsToStack } from "./JobErrorDiagnostics";
import { lookupErrorCodeReconstructor } from "./JobErrorRegistry";
import type {
  JobProgressListener,
  JobQueueEventListener,
  JobQueueEventListeners,
  JobQueueEventParameters,
  JobQueueEvents,
  JobStreamListener,
  StreamChunkRow,
  StreamEventLike,
} from "./JobQueueEventListeners";
import type { JobQueueServer } from "./JobQueueServer";
import { storageToClass } from "./JobStorageConverters";
import { StreamReassembler } from "./StreamReassembler";

/**
 * Grace window (ms) to keep a job's channel stream subscription open after the
 * job settles, so a trailing `finish`/`error` stream event still in flight on
 * an async carrier — which raced (and lost to) the storage-completion signal —
 * can still be delivered before teardown. The terminal stream event itself
 * tears down early, so this only elapses when a job settles without one ever
 * arriving (e.g. a crash), bounding the leak. Unref'd so it never holds the
 * process open.
 */
const STREAM_FINISH_GRACE_MS = 30_000;

/**
 * Handle returned when submitting a job, providing methods to interact with the job
 */
export interface JobHandle<Output> {
  readonly id: unknown;
  waitFor(): Promise<Output>;
  abort(): Promise<void>;
  onProgress(callback: JobProgressListener): () => void;
  /**
   * OPTIONAL — present only when this handle's transport can deliver stream
   * events: a same-process server-attached queue (the fast path), or a carrier
   * implementing BOTH halves of the stream channel. Absent on carriers with
   * neither, and on one implementing only half a channel — a subscription
   * there can never receive anything. Callers branch on
   * `typeof handle.onStream === "function"`.
   */
  onStream?(callback: JobStreamListener): () => void;
  /**
   * OPTIONAL — present only when the client was configured with an
   * `outputStreamResolver` (an output cache backing reachable from this
   * process). Awaits the job's completion, then streams the binary result
   * back out of the output cache without materializing it. `port` selects the
   * output port. Omitting it (portless discovery) requires a resolver built
   * WITH the task's output schema — `makeJobOutputStreamResolver(repo, schema)`
   * in `@workglow/task-graph` — so discovery enumerates only declared
   * streamable ports (a schema-less resolver rejects portless calls, and two+
   * refs across those ports is an error). Resolves `undefined` when there is
   * nothing binary to stream (or the cache entry was evicted).
   */
  outputStream?(port?: string): Promise<AsyncIterable<Uint8Array> | undefined>;
}

/**
 * Resolves a completed job's output value to a byte stream. Injected via
 * {@link JobQueueClientOptions.outputStreamResolver} because the cache layer
 * that understands output refs lives above this package in the dependency
 * graph (`@workglow/task-graph` exports `makeJobOutputStreamResolver` to
 * build one from a cache backing).
 */
export type JobOutputStreamResolver = (
  output: unknown,
  port?: string
) => Promise<AsyncIterable<Uint8Array> | undefined>;

/**
 * Options for creating a JobQueueClient
 */
export interface JobQueueClientOptions<Input, Output> {
  readonly messageQueue: IMessageQueue<JobStorageFormat<Input, Output>>;
  readonly jobStore: IJobStore<Input, Output>;
  readonly queueName: string;
  /**
   * OPTIONAL — enables `JobHandle.outputStream` on handles from this client.
   * Deployments whose output cache backing is reachable from this process
   * inject a resolver (see `makeJobOutputStreamResolver` in
   * `@workglow/task-graph`); without it, handles omit the method.
   */
  readonly outputStreamResolver?: JobOutputStreamResolver;
}

/**
 * Client for submitting jobs and monitoring their progress.
 * Connect to a JobQueueServer for same-process optimization,
 * or use storage subscriptions for cross-process communication.
 */
export class JobQueueClient<Input, Output> {
  public readonly queueName: string;
  protected readonly messageQueue: IMessageQueue<JobStorageFormat<Input, Output>>;
  protected readonly jobStore: IJobStore<Input, Output>;
  protected readonly events = new EventEmitter<JobQueueEventListeners<Input, Output>>();
  protected server: JobQueueServer<Input, Output> | null = null;
  protected storageUnsubscribe: (() => void) | null = null;
  protected readonly outputStreamResolver: JobOutputStreamResolver | undefined;

  /**
   * Map of job IDs to their pending promise resolvers
   */
  protected readonly activeJobPromises: Map<
    unknown,
    Array<{
      resolve: (value: Output) => void;
      reject: (err: JobError) => void;
    }>
  > = new Map();

  /**
   * Map of job IDs to their progress listeners
   */
  protected readonly jobProgressListeners: Map<unknown, Set<JobProgressListener>> = new Map();

  /**
   * Map of job IDs to their stream listeners
   */
  protected readonly jobStreamListeners: Map<unknown, Set<JobStreamListener>> = new Map();

  /** Active cross-process stream-channel unsubscribers, keyed by job id. */
  private readonly jobStreamUnsubscribers: Map<unknown, () => void> = new Map();

  /**
   * Highest in-order stream `seq` already delivered per job. Channel
   * deliveries record the row's real seq; fast-path deliveries (which carry no
   * seq) count one per event in emission order, matching the carrier's
   * assignment. Persisted across teardown/re-subscribe (unlike the
   * subscription itself) so a re-subscribe — e.g. a listener removed and
   * re-added while the job is still running — resumes from where it left off
   * instead of replaying the whole log and double-delivering every prior
   * event. Cleared when the job settles.
   */
  private readonly jobStreamCursor: Map<unknown, number> = new Map();

  /**
   * Grace-teardown timers for channel stream subscriptions whose job settled
   * before the terminal stream event arrived. Keyed by job id; cleared when the
   * terminal event lands (early teardown) or the timer fires.
   */
  private readonly jobStreamGraceTimers: Map<unknown, ReturnType<typeof setTimeout>> = new Map();

  /**
   * Last known progress state for each job
   */
  protected readonly lastKnownProgress: Map<
    unknown,
    {
      readonly progress: number;
      readonly message: string;
      readonly details: Record<string, unknown> | null;
    }
  > = new Map();

  constructor(options: JobQueueClientOptions<Input, Output>) {
    this.queueName = options.queueName;
    this.messageQueue = options.messageQueue;
    this.jobStore = options.jobStore;
    this.outputStreamResolver = options.outputStreamResolver;
  }

  /**
   * Attach to a local JobQueueServer for same-process event optimization.
   * When attached, events flow directly from server without storage polling.
   */
  public attach(server: JobQueueServer<Input, Output>): void {
    if (this.server) {
      this.detach();
    }
    this.server = server;
    server.addClient(this);

    // Channel stream subscriptions stay open across attach: while a job's
    // subscription is open the channel is authoritative and `handleJobStream`
    // suppresses the fast path for that job, so a job claimed by a worker in
    // ANOTHER process keeps streaming and nothing is delivered twice. Jobs
    // without a subscription (channel-less carrier) are served by the fast
    // path.

    // Unsubscribe from storage if we were using it
    if (this.storageUnsubscribe) {
      this.storageUnsubscribe();
      this.storageUnsubscribe = null;
    }
  }

  /**
   * Detach from the current server
   */
  public detach(): void {
    this.detachInternal(true);
  }

  private detachInternal(resubscribe: boolean): void {
    if (this.server) {
      this.server.removeClient(this);
      this.server = null;
    }
    if (!resubscribe) return;
    // No longer server-attached: (re-)open channel stream subscriptions for
    // jobs that still have listeners, so `onStream` keeps delivering via the
    // queue channel now that the fast path is gone. Idempotent for jobs whose
    // subscription is already open.
    for (const jobId of this.jobStreamListeners.keys()) {
      this.ensureStreamSubscription(jobId);
    }
  }

  /**
   * Connect to storage for cross-process communication (when no local server).
   * Uses storage subscriptions to receive job updates.
   */
  public connect(): void {
    if (this.server) {
      return; // Already connected via server
    }

    if (this.storageUnsubscribe) {
      return; // Already subscribed
    }

    const sub = this.messageQueue.subscribeToChanges;
    if (!sub) return; // backend doesn't support subscriptions
    this.storageUnsubscribe = sub.call(
      this.messageQueue,
      (change: QueueChangePayload<Input, Output>) => {
        this.handleStorageChange(change);
      }
    );
  }

  /**
   * Disconnect from storage subscriptions
   */
  public disconnect(): void {
    if (this.storageUnsubscribe) {
      this.storageUnsubscribe();
      this.storageUnsubscribe = null;
    }
    this.detachInternal(false);
    // After disconnect nothing can deliver a terminal stream event to this
    // client, so any retained stream state — channel subscriptions, listeners,
    // cursors, grace timers — would leak permanently. Finalize it all now
    // instead of re-subscribing the way a plain detach() does.
    const jobIds = new Set<unknown>([
      ...this.jobStreamUnsubscribers.keys(),
      ...this.jobStreamListeners.keys(),
      ...this.jobStreamCursor.keys(),
      ...this.jobStreamGraceTimers.keys(),
    ]);
    for (const jobId of jobIds) {
      this.finalizeStreamTeardown(jobId);
    }
  }

  /**
   * Send a job to the queue
   */
  public async send(
    input: Input,
    options?: {
      readonly jobRunId?: string;
      readonly fingerprint?: string;
      readonly maxAttempts?: number;
      /** Delay in seconds before the job becomes visible for processing */
      readonly delaySeconds?: number;
      /** Timeout in seconds after which the job deadline is exceeded */
      readonly timeoutSeconds?: number;
    }
  ): Promise<JobHandle<Output>> {
    const job = this.buildJobBody(input, options);

    const id = await this.messageQueue.send(job, {
      fingerprint: options?.fingerprint,
      jobRunId: options?.jobRunId,
      maxAttempts: options?.maxAttempts,
      delaySeconds: options?.delaySeconds,
      timeoutSeconds: options?.timeoutSeconds,
    });

    // Same-process fast path: poke the worker directly so it doesn't have to
    // wait for the poll interval (crucial for Sqlite/Postgres, whose
    // subscribeToChanges throws).
    this.server?.handleJobAdded(id);

    return this.createJobHandle(id);
  }

  /**
   * Send multiple jobs to the queue in a single batched insert.
   *
   * Delegates to {@link IMessageQueue.sendBatch} so N jobs become one storage
   * round-trip and a single worker wake, instead of N inserts + N wakes.
   *
   * Per the {@link IMessageQueue.sendBatch} contract, a batch-wide
   * `fingerprint` is intentionally NOT accepted (it would dedup every body
   * against the first row); use {@link send} per job for fingerprinted dedup.
   * The other options — `jobRunId`, `maxAttempts`, `delaySeconds`,
   * `timeoutSeconds` — apply uniformly to every body and are forwarded (the
   * previous per-item loop silently dropped `delaySeconds`/`timeoutSeconds`).
   */
  public async sendBatch(
    inputs: readonly Input[],
    options?: {
      readonly jobRunId?: string;
      readonly maxAttempts?: number;
      /** Delay in seconds before every job becomes visible for processing */
      readonly delaySeconds?: number;
      /** Timeout in seconds after which every job's deadline is exceeded */
      readonly timeoutSeconds?: number;
    }
  ): Promise<readonly JobHandle<Output>[]> {
    if (inputs.length === 0) return [];

    const bodies = inputs.map((input) => this.buildJobBody(input, options));
    const ids = await this.messageQueue.sendBatch(bodies, {
      jobRunId: options?.jobRunId,
      maxAttempts: options?.maxAttempts,
      delaySeconds: options?.delaySeconds,
      timeoutSeconds: options?.timeoutSeconds,
    });

    // Single wake for the whole batch — avoids the N-wake thundering herd the
    // per-item loop caused.
    this.server?.handleJobAdded(ids[ids.length - 1]);

    return ids.map((id) => this.createJobHandle(id));
  }

  /**
   * Build a {@link JobStorageFormat} body from an input + send options. Shared
   * by {@link send} and {@link sendBatch} so both produce identical rows.
   */
  private buildJobBody(
    input: Input,
    options?: {
      readonly jobRunId?: string;
      readonly fingerprint?: string;
      readonly maxAttempts?: number;
      readonly delaySeconds?: number;
      readonly timeoutSeconds?: number;
    }
  ): JobStorageFormat<Input, Output> {
    return {
      queue: this.queueName,
      input,
      job_run_id: options?.jobRunId,
      fingerprint: options?.fingerprint,
      max_attempts: options?.maxAttempts ?? DEFAULT_LIMITS.jobMaxAttempts,
      visible_at:
        options?.delaySeconds != null
          ? new Date(Date.now() + options.delaySeconds * 1000).toISOString()
          : new Date().toISOString(),
      deadline_at:
        options?.timeoutSeconds != null
          ? new Date(Date.now() + options.timeoutSeconds * 1000).toISOString()
          : null,
      completed_at: null,
      status: JobStatus.PENDING,
    };
  }

  /**
   * Get a job by ID
   */
  public async getJob(id: unknown): Promise<Job<Input, Output> | undefined> {
    if (!id) throw new JobNotFoundError("Cannot get undefined job");
    const job = await this.jobStore.get(id);
    if (!job) return undefined;
    return this.storageToClass(job);
  }

  /**
   * Get jobs by run ID
   */
  public async getJobsByRunId(runId: string): Promise<readonly Job<Input, Output>[]> {
    if (!runId) throw new JobNotFoundError("Cannot get jobs by undefined runId");
    const jobs = await this.jobStore.getByRunId(runId);
    return jobs.map((job) => this.storageToClass(job));
  }

  /**
   * Peek at jobs in the queue
   */
  public async peek(status?: JobStatus, num?: number): Promise<readonly Job<Input, Output>[]> {
    const jobs = await this.jobStore.peek(status, num);
    return jobs.map((job) => this.storageToClass(job));
  }

  /**
   * Get the size of the queue
   */
  public async size(status?: JobStatus): Promise<number> {
    return this.jobStore.size(status);
  }

  /**
   * Get the output for an input (if job completed)
   */
  public async outputForInput(input: Input): Promise<Output | null> {
    if (!input) throw new JobNotFoundError("Cannot get output for undefined input");
    return this.jobStore.outputForInput(input);
  }

  /**
   * Wait for a job to complete.
   *
   * Registers the resolver BEFORE reading storage so that a `handleJobError`
   * / `handleJobComplete` event fired during the storage read isn't dropped
   * on the floor. The previous order (read first, register after) had a
   * TOCTOU window where a fast same-process abort could complete between the
   * read and the registration, leaving `waitFor` to register against an
   * already-finished job and hang forever.
   */
  public async waitFor(jobId: unknown): Promise<Output> {
    if (!jobId) throw new JobNotFoundError("Cannot wait for undefined job");

    const { promise, resolve, reject } = Promise.withResolvers<Output>();
    promise.catch(() => {}); // Prevent unhandled rejection

    const promises = this.activeJobPromises.get(jobId) || [];
    promises.push({ resolve, reject });
    this.activeJobPromises.set(jobId, promises);

    // Now check storage — if the job is already terminal (raced us to it),
    // settle the promise ourselves and clean up the registration. The
    // handler paths (handleJobComplete/Error/Disabled) are idempotent on
    // already-settled promises.
    const job = await this.getJob(jobId);
    if (!job) {
      this.removePromise(jobId, resolve, reject);
      throw new JobNotFoundError(`Job ${asText(jobId)} not found`);
    }
    if (job.status === JobStatus.COMPLETED) {
      this.removePromise(jobId, resolve, reject);
      return job.output as Output;
    }
    if (job.status === JobStatus.DISABLED) {
      this.removePromise(jobId, resolve, reject);
      throw new JobDisabledError(`Job ${asText(jobId)} was disabled`);
    }
    if (job.status === JobStatus.FAILED) {
      this.removePromise(jobId, resolve, reject);
      throw this.buildErrorFromJob(job);
    }

    return promise;
  }

  private removePromise(
    jobId: unknown,
    resolve: (output: Output) => void,
    reject: (err: unknown) => void
  ): void {
    const list = this.activeJobPromises.get(jobId);
    if (!list) return;
    const idx = list.findIndex((p) => p.resolve === resolve && p.reject === reject);
    if (idx !== -1) list.splice(idx, 1);
    if (list.length === 0) this.activeJobPromises.delete(jobId);
  }

  /**
   * Abort a job.
   *
   * Same-process path: fires the in-memory abort controller on the attached
   * server — `handleAbort` will write FAILED directly, so we skip the
   * `storage.abort(…)` write. Writing both would race (last-writer-wins) and
   * can leave the row in an inconsistent state on async storages.
   *
   * Cross-process path (or job not currently running on any local worker):
   * write abort_requested_at to storage so the remote worker's poll picks it
   * up (or mark FAILED immediately if the job is still PENDING).
   *
   * Crash window: if the process dies after the in-memory abort fires but
   * before `failJob` writes FAILED, the row stays PROCESSING. Lease expiry
   * in `next()` will re-claim it on the next start so the job will re-run.
   * Make handlers idempotent if that's not acceptable.
   */
  public async abort(jobId: unknown): Promise<void> {
    if (!jobId) throw new JobNotFoundError("Cannot abort undefined job");
    const firedLocally = this.server?.abortJob(jobId) ?? false;
    if (!firedLocally) {
      try {
        await this.jobStore.abort(jobId);
      } finally {
        this.events.emit("job_aborting", this.queueName, jobId);
      }
      return;
    }
    this.events.emit("job_aborting", this.queueName, jobId);
  }

  /**
   * Abort all jobs in a job run
   */
  public async abortJobRun(jobRunId: string): Promise<void> {
    if (!jobRunId) throw new JobNotFoundError("Cannot abort job run with undefined jobRunId");
    const jobs = await this.getJobsByRunId(jobRunId);
    // Filtered before the map rather than returning `undefined` from inside
    // it: the aggregator then receives promises and only promises, which is
    // what it is for, and "which jobs are abortable" is stated once instead of
    // being implied by the shape of the array.
    await Promise.allSettled(
      jobs
        .filter((job) => job.status === JobStatus.PROCESSING || job.status === JobStatus.PENDING)
        .map((job) => this.abort(job.id))
    );
  }

  /**
   * Subscribe to progress updates for a specific job
   */
  public onJobProgress(jobId: unknown, listener: JobProgressListener): () => void {
    if (!this.jobProgressListeners.has(jobId)) {
      this.jobProgressListeners.set(jobId, new Set());
    }
    const listeners = this.jobProgressListeners.get(jobId)!;
    listeners.add(listener);

    return () => {
      const listeners = this.jobProgressListeners.get(jobId);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.jobProgressListeners.delete(jobId);
        }
      }
    };
  }

  /**
   * Subscribe to stream events for a specific job
   */
  public onJobStream(jobId: unknown, listener: JobStreamListener): () => void {
    if (!this.jobStreamListeners.has(jobId)) {
      this.jobStreamListeners.set(jobId, new Set());
    }
    const listeners = this.jobStreamListeners.get(jobId)!;
    listeners.add(listener);
    this.ensureStreamSubscription(jobId);

    return () => {
      const listeners = this.jobStreamListeners.get(jobId);
      if (listeners) {
        listeners.delete(listener);
        if (listeners.size === 0) {
          this.jobStreamListeners.delete(jobId);
          this.teardownStreamSubscription(jobId);
        }
      }
    };
  }

  /**
   * Whether the carrier gives us a usable cross-process stream channel.
   *
   * The channel is a matched pair. A carrier that can replay a stream but
   * never receives one (no `publishStreamChunk`) can neither deliver a
   * remotely-processed job's events NOR ever supersede the fast path —
   * subscribing would instead PERMANENTLY suppress {@link handleJobStream}
   * for that job, with nothing to replace it. Every channel-capable backend
   * today implements both halves together; treat one without the other as
   * "no channel" rather than "half a channel that blacks out delivery".
   *
   * This is the single predicate behind BOTH the capability advertised on a
   * {@link JobHandle} and the subscription that backs it. Splitting them is
   * what let a half-channel carrier hand out an `onStream` whose listener
   * could never fire: `createJobHandle` advertised on the read half alone
   * while this gate refused, so nothing ever delivered and callers that probe
   * `typeof handle.onStream === "function"` read the queue as stream-capable.
   */
  private hasStreamChannel(): boolean {
    return (
      typeof this.messageQueue.subscribeToStream === "function" &&
      typeof this.messageQueue.publishStreamChunk === "function"
    );
  }

  /**
   * On a channel-capable queue, open a stream subscription for `jobId` and
   * feed rows through a {@link StreamReassembler} into the same dispatch path
   * the same-process fast path uses. Server-attached clients subscribe too —
   * on a shared queue the job may be claimed by a worker in another process,
   * which the fast path can never observe — and while a job's subscription is
   * open {@link handleJobStream} suppresses the fast path for it, so nothing
   * is delivered twice. Channel-less carriers stay fast-path only.
   */
  private ensureStreamSubscription(jobId: unknown): void {
    if (!this.hasStreamChannel()) return;
    // Proven a function by the gate above; the local read cannot narrow
    // through the call.
    const subscribe = this.messageQueue.subscribeToStream!;
    if (this.jobStreamUnsubscribers.has(jobId)) return;
    // Resume from the last seq already delivered so a re-subscribe replays only
    // the gap, not the whole log.
    const sinceSeq = this.jobStreamCursor.get(jobId) ?? 0;
    // Filled by the dispatch callback below during a `push`, drained by the
    // subscriber that drove it. One push can dispatch several events (a row
    // that closes a gap flushes its contiguous successors), so it is a list.
    let dispatched: Promise<void>[] = [];
    const reassembler = new StreamReassembler((event: StreamEventLike, seq: number) => {
      // The cursor takes the row's REAL seq, not a local dispatch count: a
      // gap-skip jumps `seq` past dropped rows, and a counted cursor would lag
      // behind the true position forever (re-replaying the skipped range on
      // every re-subscribe).
      this.jobStreamCursor.set(jobId, seq);
      // Collected rather than fired and forgotten, so the carrier can await
      // it. An IN-PROCESS carrier publishes inside the emitting job's own
      // awaited dispatch, which makes this path the live producer's only
      // pacing signal — dropping the promise there let a fetch outrun its
      // consumer and queue the entire body in `pending`. A carrier replaying
      // already-published rows has no producer to pace and ignores it, which
      // is the case this was originally written for. Still caught so a
      // dispatch failure never becomes an unhandled rejection.
      dispatched.push(
        this.dispatchStreamEvent(jobId, event).catch((err) => {
          getLogger().error("channel stream dispatch failed", { jobId, error: err });
        })
      );
      // A terminal stream event means the stream is genuinely done: tear the
      // channel subscription down now (this is the normal teardown path, driven
      // by the stream itself rather than the racy job-completion signal) and
      // cancel any grace timer a completion may have scheduled.
      if (event.type === "finish" || event.type === "error") {
        this.finalizeStreamTeardown(jobId);
      }
    }, sinceSeq);
    // Register a placeholder BEFORE subscribing: a terminal event already in
    // the log is replayed SYNCHRONOUSLY inside `subscribeToStream`, and the
    // `finalizeStreamTeardown` it triggers deletes this entry — making that
    // mid-call teardown detectable once subscribe returns.
    const preRegistered = () => {};
    this.jobStreamUnsubscribers.set(jobId, preRegistered);
    const unsub = subscribe.call(this.messageQueue, jobId, sinceSeq, (row: StreamChunkRow) => {
      dispatched = [];
      reassembler.push(row);
      if (dispatched.length === 0) return;
      const awaiting = dispatched;
      dispatched = [];
      return awaiting.length === 1 ? awaiting[0] : Promise.all(awaiting).then(() => undefined);
    });
    if (this.jobStreamUnsubscribers.get(jobId) !== preRegistered) {
      // Teardown fired during the synchronous replay. The stream state is
      // already finalized; registering `unsub` now would create a zombie
      // subscription that blocks every later onStream subscription for this
      // job (and permanently suppresses its fast path). Close the just-created
      // subscription instead.
      unsub();
      return;
    }
    this.jobStreamUnsubscribers.set(jobId, unsub);
  }

  private teardownStreamSubscription(jobId: unknown): void {
    const unsub = this.jobStreamUnsubscribers.get(jobId);
    if (unsub) {
      unsub();
      this.jobStreamUnsubscribers.delete(jobId);
    }
  }

  /**
   * When a job settles while a channel stream subscription is still open, defer
   * stream teardown by a grace window instead of tearing down immediately: the
   * terminal `finish`/`error` stream event may still be in flight on an async
   * carrier (the completion signal and the stream channel are independent
   * transports). The terminal-event handler finalizes early; this timer is only
   * reached when no terminal event ever arrives, bounding the leak.
   */
  private scheduleStreamGraceTeardown(jobId: unknown): void {
    if (this.jobStreamGraceTimers.has(jobId)) return;
    const timer = setTimeout(() => this.finalizeStreamTeardown(jobId), STREAM_FINISH_GRACE_MS);
    (timer as { unref?: () => void }).unref?.();
    this.jobStreamGraceTimers.set(jobId, timer);
  }

  /** Tear down a job's stream subscription, listeners, cursor, and grace timer. */
  private finalizeStreamTeardown(jobId: unknown): void {
    const timer = this.jobStreamGraceTimers.get(jobId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.jobStreamGraceTimers.delete(jobId);
    }
    this.teardownStreamSubscription(jobId);
    this.jobStreamListeners.delete(jobId);
    this.jobStreamCursor.delete(jobId);
  }

  // ========================================================================
  // Event handling
  // ========================================================================

  public on<Event extends JobQueueEvents>(
    event: Event,
    listener: JobQueueEventListener<Event>
  ): void {
    this.events.on(event, listener);
  }

  public off<Event extends JobQueueEvents>(
    event: Event,
    listener: JobQueueEventListener<Event>
  ): void {
    this.events.off(event, listener);
  }

  public once<Event extends JobQueueEvents>(
    event: Event,
    listener: JobQueueEventListener<Event>
  ): void {
    this.events.once(event, listener);
  }

  public waitOn<Event extends JobQueueEvents>(
    event: Event
  ): Promise<JobQueueEventParameters<Event, Input, Output>> {
    return this.events.waitOn(event) as Promise<JobQueueEventParameters<Event, Input, Output>>;
  }

  /**
   * Subscribes to an event and returns a function to unsubscribe
   * @param event - The event name to subscribe to
   * @param listener - The listener function to add
   * @returns a function to unsubscribe from the event
   */
  public subscribe<Event extends JobQueueEvents>(
    event: Event,
    listener: JobQueueEventListener<Event>
  ): () => void {
    return this.events.subscribe(event, listener);
  }

  // ========================================================================
  // Internal methods called by JobQueueServer for same-process optimization
  // ========================================================================

  /**
   * Called by server when a job starts processing
   * @internal
   */
  public handleJobStart(jobId: unknown): void {
    this.lastKnownProgress.set(jobId, {
      progress: 0,
      message: "",
      details: null,
    });
    this.events.emit("job_start", this.queueName, jobId);
  }

  /**
   * Called by server when a job completes
   * @internal
   */
  public handleJobComplete(jobId: unknown, output: Output): void {
    this.events.emit("job_complete", this.queueName, jobId, output);

    const promises = this.activeJobPromises.get(jobId);
    if (promises) {
      promises.forEach(({ resolve }) => resolve(output));
    }
    this.cleanupJob(jobId);
  }

  /**
   * Called by server when a job fails
   * @internal
   */
  public handleJobError(jobId: unknown, error: string, errorCode?: string): void {
    this.events.emit("job_error", this.queueName, jobId, error, errorCode);

    const promises = this.activeJobPromises.get(jobId);
    if (promises) {
      const jobError = this.buildErrorFromCode(error, errorCode);
      promises.forEach(({ reject }) => reject(jobError));
    }
    this.cleanupJob(jobId);
  }

  /**
   * Called by server when a job is disabled
   * @internal
   */
  public handleJobDisabled(jobId: unknown): void {
    this.events.emit("job_disabled", this.queueName, jobId);

    const promises = this.activeJobPromises.get(jobId);
    if (promises) {
      promises.forEach(({ reject }) => reject(new JobDisabledError("Job was disabled")));
    }
    this.cleanupJob(jobId);
  }

  /**
   * Called by server when a job is retried
   * @internal
   */
  public handleJobRetry(jobId: unknown, visibleAt: Date): void {
    this.events.emit("job_retry", this.queueName, jobId, visibleAt);
  }

  /**
   * Called by server when job progress updates
   * @internal
   */
  public handleJobProgress(
    jobId: unknown,
    progress: number,
    message: string,
    details: Record<string, unknown> | null
  ): void {
    this.lastKnownProgress.set(jobId, { progress, message, details });
    this.events.emit("job_progress", this.queueName, jobId, progress, message, details);

    const listeners = this.jobProgressListeners.get(jobId);
    if (listeners) {
      for (const listener of listeners) {
        listener(progress, message, details);
      }
    }
  }

  /**
   * Called by server when a job emits a stream event (the same-process fast
   * path). Returns a promise that settles once every `onStream` listener for
   * this job has been awaited — this is the direct, awaitable call path a
   * server-attached worker paces itself on; it never rejects (see
   * {@link dispatchStreamEvent}).
   * @internal
   */
  public async handleJobStream(jobId: unknown, event: StreamEventLike): Promise<void> {
    // While a channel subscription is open for this job the channel is
    // authoritative (it replays, orders, and de-dupes by seq): suppress the
    // fast path so events aren't delivered twice. Channel-less carriers never
    // open a subscription, so their fast-path delivery is unaffected.
    if (this.jobStreamUnsubscribers.has(jobId)) return;
    // No carrier seq on the fast path: advance the cursor by one per event in
    // emission order, matching the synchronous carrier's seq assignment, so a
    // later detach()/re-subscribe resumes from the true position instead of
    // replaying the whole log.
    this.jobStreamCursor.set(jobId, (this.jobStreamCursor.get(jobId) ?? 0) + 1);
    await this.dispatchStreamEvent(jobId, event);
  }

  /**
   * Fan a stream event out to the `job_stream` emitter and this job's
   * listeners, awaiting every listener before resolving — the producing job
   * is paced by the slowest one. Listener rejections (and throws) are
   * isolated per-listener — one misbehaving subscriber never fails the job
   * or blocks delivery to the rest.
   *
   * The `job_stream` emitter fan-out is for OBSERVERS, not consumers: it
   * stays fire-and-forget and unawaited so an observer can never pace the
   * producer.
   */
  private async dispatchStreamEvent(jobId: unknown, event: StreamEventLike): Promise<void> {
    this.events.emit("job_stream", this.queueName, jobId, event);

    const listeners = this.jobStreamListeners.get(jobId);
    if (!listeners) return;
    await Promise.all(
      [...listeners].map(async (listener) => {
        try {
          await listener(event);
        } catch (err) {
          getLogger().error("JobHandle.onStream listener threw", {
            jobId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      })
    );
  }

  // ========================================================================
  // Private helpers
  // ========================================================================

  private createJobHandle(id: unknown): JobHandle<Output> {
    const handle: JobHandle<Output> = {
      id,
      waitFor: () => this.waitFor(id),
      abort: () => this.abort(id),
      onProgress: (callback: JobProgressListener) => this.onJobProgress(id, callback),
    };
    // Stream delivery requires either a same-process server-attached transport
    // (direct in-memory fast path) or a carrier implementing BOTH halves of the
    // stream channel (the cross-process side-stream — see
    // {@link hasStreamChannel}). Backends with neither omit `onStream`, so
    // callers branch on `typeof handle.onStream === "function"`.
    //
    // The server half remains a *possibility* of delivery rather than a
    // guarantee: on a durable queue shared with other processes, a job this
    // client sent may be claimed by a worker the attached server does not own,
    // and the fast path can never observe that. Which process claims a job is
    // not knowable at send time, so the alternative — withholding `onStream`
    // from every durable-storage queue — would refuse streaming for the
    // ordinary single-process deployment that works today.
    //
    // That gap is closed at drain time instead, where the answer is observable:
    // a locally-claimed job always publishes a terminal `finish` marker, so a
    // consumer whose delivery is mandatory (`FetchUrlTask`'s
    // `consumeJobStream`, under `requireStreamDelivery`) fails a stream that
    // settled successfully without ever producing one, rather than reporting an
    // empty body as a successful read.
    if (this.server || this.hasStreamChannel()) {
      handle.onStream = (callback: JobStreamListener) => this.onJobStream(id, callback);
    }
    // Streaming result reads require a cache backing reachable from this
    // process; the injected resolver is the capability signal.
    const resolver = this.outputStreamResolver;
    if (resolver) {
      handle.outputStream = async (port?: string) => resolver(await this.waitFor(id), port);
    }
    return handle;
  }

  private cleanupJob(jobId: unknown): void {
    this.activeJobPromises.delete(jobId);
    this.lastKnownProgress.delete(jobId);
    this.jobProgressListeners.delete(jobId);
    if (this.jobStreamUnsubscribers.has(jobId)) {
      // A channel stream subscription is still open: the terminal stream event
      // may lag the completion signal on an async carrier. Defer stream teardown
      // (listeners + subscription + cursor) a grace window so it can arrive; the
      // terminal-event handler finalizes early when it does.
      this.scheduleStreamGraceTeardown(jobId);
    } else {
      // No channel subscription (same-process fast path already delivered the
      // terminal event before completion): clear stream state immediately.
      this.jobStreamListeners.delete(jobId);
      this.jobStreamCursor.delete(jobId);
    }
  }

  private handleStorageChange(change: QueueChangePayload<Input, Output>): void {
    if (!change.new && !change.old) return;

    const jobId = change.new?.id ?? change.old?.id;
    if (!jobId) return;

    // Only process changes for our queue
    const queueName = change.new?.queue ?? change.old?.queue;
    if (queueName !== this.queueName) return;

    if (change.type === "UPDATE" && change.new) {
      const newStatus = change.new.status;
      const oldStatus = change.old?.status;

      if (newStatus === JobStatus.PROCESSING && oldStatus === JobStatus.PENDING) {
        this.handleJobStart(jobId);
      } else if (newStatus === JobStatus.COMPLETED) {
        this.handleJobComplete(jobId, change.new.output as Output);
      } else if (newStatus === JobStatus.FAILED) {
        this.handleJobError(
          jobId,
          change.new.error ?? "Job failed",
          change.new.error_code ?? undefined
        );
      } else if (newStatus === JobStatus.DISABLED) {
        this.handleJobDisabled(jobId);
      } else if (newStatus === JobStatus.PENDING && oldStatus === JobStatus.PROCESSING) {
        // Retry
        const visibleAt = change.new.visible_at ? new Date(change.new.visible_at) : new Date();
        this.handleJobRetry(jobId, visibleAt);
      }

      // Progress update
      if (
        change.new.progress !== change.old?.progress ||
        change.new.progress_message !== change.old?.progress_message
      ) {
        this.handleJobProgress(
          jobId,
          change.new.progress ?? 0,
          change.new.progress_message ?? "",
          change.new.progress_details ?? null
        );
      }
    }
  }

  protected storageToClass(details: JobStorageFormat<Input, Output>): Job<Input, Output> {
    return storageToClass(details, Job);
  }

  protected buildErrorFromJob(job: Job<Input, Output>): JobError {
    return this.buildErrorFromCode(job.error || "Job failed", job.errorCode ?? undefined);
  }

  protected buildErrorFromCode(message: string, errorCode?: string): JobError {
    // Built-in codes take precedence over the {@link JobErrorRegistry} so a
    // registered prefix can never accidentally intercept core types
    // (e.g. a `"P"` prefix shadowing `PermanentJobError`). Only after the
    // built-in switch fails do we consult the registry for domain-specific
    // codes (e.g. FETCH_*, LLM_*, FILE_*). See `JobErrorRegistry.ts` for
    // the contract.
    if (errorCode === "PermanentJobError") {
      const err = new PermanentJobError(message);
      applyPersistedDiagnosticsToStack(err, message);
      return err;
    }
    if (errorCode === "RetryableJobError") {
      const err = new RetryableJobError(message);
      applyPersistedDiagnosticsToStack(err, message);
      return err;
    }
    if (errorCode === "AbortSignalJobError") {
      const err = new AbortSignalJobError(message);
      applyPersistedDiagnosticsToStack(err, message);
      return err;
    }
    if (errorCode === "JobDisabledError") {
      const err = new JobDisabledError(message);
      applyPersistedDiagnosticsToStack(err, message);
      return err;
    }
    if (errorCode) {
      const reconstructor = lookupErrorCodeReconstructor(errorCode);
      if (reconstructor) {
        try {
          const err = reconstructor(errorCode, message);
          // Reconstructors MUST set `code` per the registry contract, but
          // defend against forgetful implementations so downstream branching
          // on `err.code` still works. Mismatches are likely bugs in the
          // reconstructor — warn so they're visible.
          if (err.code !== errorCode) {
            if (err.code) {
              getLogger().warn("error-code reconstructor returned mismatched code; overriding", {
                errorCode,
                reconstructorCode: err.code,
              });
            }
            err.code = errorCode;
          }
          applyPersistedDiagnosticsToStack(err, message);
          return err;
        } catch (reconstructorError) {
          // A throwing reconstructor must not break job-result delivery —
          // fall through to the generic `JobError` path with `code`
          // preserved so callers can still branch on the persisted code.
          getLogger().warn("error-code reconstructor threw", {
            errorCode,
            error: reconstructorError,
          });
        }
      }
    }
    const err = new JobError(message);
    if (errorCode) {
      err.code = errorCode;
    }
    applyPersistedDiagnosticsToStack(err, message);
    return err;
  }
}
