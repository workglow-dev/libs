/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServiceToken } from "@workglow/util";
import type { StreamChunkRow, StreamEventLike } from "../job/JobQueueEventListeners";

export const QUEUE_STORAGE = createServiceToken<IQueueStorage<any, any>>("jobqueue.storage");

/**
 * The type of a prefix column.
 * - "uuid" maps to UUID in PostgreSQL/Supabase, TEXT in SQLite/IndexedDB/InMemory
 * - "number" maps to INTEGER in PostgreSQL/Supabase/SQLite, number in IndexedDB/InMemory
 */
export type PrefixColumnType = "uuid" | "number";

/**
 * Defines a prefix column for queue storage filtering.
 */
export interface PrefixColumn {
  readonly name: string;
  readonly type: PrefixColumnType;
}

/**
 * Options for configuring queue storage with prefix filters.
 */
export interface QueueStorageOptions {
  /** The prefix column definitions for this storage */
  readonly prefixes?: readonly PrefixColumn[];
  /** The values for each prefix column */
  readonly prefixValues?: Readonly<Record<string, string | number>>;
}

export type JobStatus = "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "DISABLED";
export const JobStatus = {
  PENDING: "PENDING",
  PROCESSING: "PROCESSING",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  DISABLED: "DISABLED",
} as const satisfies Record<JobStatus, JobStatus>;

/**
 * Type of change that occurred in the queue.
 *
 * `RESYNC` is a synthetic event emitted by some backends (e.g. Postgres
 * LISTEN/NOTIFY) after a (re)connect to indicate that arbitrary changes may
 * have happened during a disconnect window. Subscribers should treat it as a
 * "kick the workers, re-poll state" signal — `old` and `new` are both
 * undefined.
 */
export type QueueChangeType = "INSERT" | "UPDATE" | "DELETE" | "RESYNC";

/**
 * Payload describing a change to a job
 */
export interface QueueChangePayload<Input, Output> {
  readonly type: QueueChangeType;
  readonly old?: JobStorageFormat<Input, Output>;
  readonly new?: JobStorageFormat<Input, Output>;
}

/**
 * Options for subscribing to queue changes
 */
export interface QueueSubscribeOptions {
  /** Polling interval in milliseconds (used by implementations that rely on polling) */
  readonly pollingIntervalMs?: number;
  /**
   * Custom prefix filter for this subscription.
   *
   * - If not provided (undefined): Uses the storage instance's configured prefixValues
   * - If empty object ({}): Receives ALL changes across all prefix combinations
   * - If partial object: Receives changes matching the specified subset of prefixes
   *
   * @example
   * // Storage configured with prefixes: [{name: "user_id"}, {name: "project_id"}]
   * // and prefixValues: {user_id: "abc", project_id: "123"}
   *
   * // Subscribe to only this user+project (default behavior)
   * storage.subscribeToChanges(callback);
   *
   * // Subscribe to all projects for this user
   * storage.subscribeToChanges(callback, { prefixFilter: { user_id: "abc" } });
   *
   * // Subscribe to ALL jobs in this queue (admin/supervisor view)
   * storage.subscribeToChanges(callback, { prefixFilter: {} });
   */
  readonly prefixFilter?: Readonly<Record<string, string | number>>;
}

/**
 * Details about a job that reflect the structure in the database.
 */
export type JobStorageFormat<Input, Output> = {
  id?: unknown;
  job_run_id?: string;
  queue?: string;
  input: Input;
  output?: Output | null;
  error?: string | null;
  error_code?: string | null;
  fingerprint?: string;
  /**
   * Total attempt cap. A job with `max_attempts: 3` gets at most 3 executions total
   * (not 3 retries after the first attempt).
   */
  max_attempts?: number;
  status?: JobStatus;
  created_at?: string;
  deadline_at?: string | null;
  last_attempted_at?: string | null;
  visible_at: string | null;
  completed_at: string | null;
  attempts?: number;
  progress?: number;
  progress_message?: string;
  progress_details?: Record<string, any> | null;
  lease_owner?: string | null;
  abort_requested_at?: string | null;
  lease_expires_at?: string | null;
};

/**
 * Whether a queue storage's state is shared across processes.
 *
 * - `"process"` — in-memory / per-process state. Workers in the same process
 *   share it, but separate processes do not.
 * - `"cluster"` — state lives in shared external storage (Postgres, Supabase,
 *   etc.) visible to every process. Pairing a `"process"`-scoped limiter with
 *   a `"cluster"`-scoped queue almost always indicates a misconfiguration.
 */
export type QueueStorageScope = "process" | "cluster";

/**
 * Interface defining the storage operations for a job queue
 */
export interface IQueueStorage<Input, Output> {
  /**
   * Whether this storage is shared across processes. In-memory / browser
   * backends MUST report `"process"`. Shared databases (Postgres, Supabase)
   * report `"cluster"`. Used by JobQueueServer to detect process-scoped
   * limiters paired with cluster-scoped queues.
   */
  readonly scope: QueueStorageScope;

  /**
   * Adds a job to the queue storage
   * @param job - The job to add to the queue storage
   * @returns The ID of the job
   */
  add(job: JobStorageFormat<Input, Output>): Promise<unknown>;

  /**
   * Gets a job from the queue storage by ID
   * @param id - The ID of the job to get
   * @returns The job with the given ID
   */
  get(id: unknown): Promise<JobStorageFormat<Input, Output> | undefined>;

  /**
   * Gets the next job from the queue storage. Claims PENDING jobs that are
   * ready, and also reclaims PROCESSING jobs whose lease has expired (crash
   * recovery). Sets `lease_expires_at = now + leaseMs` on the claimed row.
   * @param workerId - Worker ID to associate with the job (required)
   * @param opts - Optional options including leaseMs (default 30000)
   * @returns The next job from the queue storage
   */
  next(
    workerId: string,
    opts?: { leaseMs?: number }
  ): Promise<JobStorageFormat<Input, Output> | undefined>;

  /**
   * Extend the lease on a currently PROCESSING job. Guards: lease_owner must
   * match workerId and status must be PROCESSING. Throws if lease was lost.
   * @param id - The ID of the job to extend the lease for
   * @param workerId - Worker ID that must match the current lease owner
   * @param ms - Number of milliseconds to extend the lease by
   */
  extendLease(id: unknown, workerId: string, ms: number): Promise<void>;

  /**
   * Releases a job that was just claimed by {@link next} but won't be
   * processed (e.g. the worker was stopped mid-claim). Resets status to
   * PENDING and clears lease_owner WITHOUT incrementing attempts —
   * the worker never actually attempted execution, so the retry budget
   * must be preserved.
   * @param id - The id of the claimed job to release.
   */
  releaseClaim(id: unknown): Promise<void>;

  /**
   * Peeks at the next job(s) from the queue storage without removing them
   * @param status - The status of the jobs to peek at
   * @param num - The number of jobs to peek at
   * @returns The jobs with the given status
   */
  peek(status?: JobStatus, num?: number): Promise<Array<JobStorageFormat<Input, Output>>>;

  /**
   * Gets the size of the queue storage
   * @param status - The status of the jobs to get the size for
   * @returns The size of the queue storage
   */
  size(status?: JobStatus): Promise<number>;

  /**
   * Completes a job in the queue storage. Bumps `attempts` (legacy contract,
   * preserved for backward compatibility with code paths that rely on it,
   * such as PENDING-retry rescheduling).
   *
   * NEW callers (worker ack/fail paths) should prefer {@link finalize}, which
   * writes the terminal result fields WITHOUT touching `attempts` — a successful
   * ack must not consume a retry attempt that was already accounted for by
   * the lease-expiry reclaim or by the wrapper's retry path.
   *
   * Missing-id contract: if no row matches `job.id` (already deleted, foreign,
   * or concurrently reclaimed), implementations MUST silently no-op rather than
   * throw. The forgiving semantics are required because lease-expiry races can
   * legitimately make the target row disappear between claim and complete.
   * @param job - The job to complete
   */
  complete(job: JobStorageFormat<Input, Output>): Promise<void>;

  /**
   * Terminal write for a claim: persists the listed fields WITHOUT bumping
   * the `attempts` counter. A partial overwrite — fields not present in
   * `fields` are untouched.
   *
   * `attempts` is not bumped here because the lease-expiry reclaim already
   * charged this attempt at `next()` time; charging it again at `ack()`/
   * `fail()` time would double-count and roll a successful job into
   * MAX_ATTEMPTS_REACHED prematurely.
   *
   * The `lease_owner` / progress fields are also writable here so the
   * atomic `disable` path can release the lease and clear progress in the
   * same single write.
   *
   * `finalize` (plus {@link markDisabled}) is the REQUIRED terminal-write
   * primitive every backend must implement. The atomic conveniences
   * (`saveStatus` / `getMany` / `completeWithResult` / `failWithError`) are
   * declared as OPTIONAL members: a backend that can express them as one
   * native statement should implement them and the {@link wrapQueueStorage}
   * facade prefers them, while backends without them rely on the wrapper's
   * composition over `finalize`. Callers holding an `IQueueStorage` should
   * still reach the sugar via the wrapper's `IJobStore` rather than probing
   * the storage directly.
   *
   * @param id - The ID of the job to finalize
   * @param fields - Terminal fields to write
   */
  finalize(
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
      /**
       * Shift the PENDING `visible_at` forward to defer redelivery. Used by
       * the transient-enqueue path (markEnqueueDeferred) so a producer-side
       * failure does not lose the job — set visible_at + error_code, leave
       * status/attempts alone.
       */
      visible_at?: string | null;
    }
  ): Promise<void>;

  /**
   * Atomically writes the DISABLED terminal transition: status=DISABLED,
   * lease_owner=null, progress=0, progress_message="", progress_details=null,
   * and stamps completed_at (preserving any existing value). Does NOT touch
   * error/error_code — DISABLED is not an error transition.
   *
   * This is the storage-level primitive backing {@link IJobStore.markDisabled}.
   * Implementations must write all fields in a single operation so the row is
   * never observed in a partial DISABLED state with a stale lease_owner or
   * leftover progress.
   *
   * @param id - The id of the job to mark disabled.
   */
  markDisabled(id: unknown): Promise<void>;

  /**
   * Optional native fingerprint dedup lookup. Returns the active
   * (PENDING or PROCESSING) row for the given fingerprint within this
   * queue, if any. Backends with a partial unique index on
   * `(queue, fingerprint) WHERE status IN ('PENDING','PROCESSING')`
   * SHOULD implement this for O(1) lookup; the wrapper layer delegates
   * to it when present and falls back to a bounded peek-and-scan
   * otherwise. The scan fallback is O(N) in the active queue size
   * and bounded — see WrappedJobStore.findActiveByFingerprint.
   *
   * @param fingerprint - The fingerprint to look up
   * @param queueName - The queue name (storage is already scoped, used
   *                    for parity with the IJobStore signature)
   */
  findActiveByFingerprint?(
    fingerprint: string,
    queueName: string
  ): Promise<JobStorageFormat<Input, Output> | undefined>;

  /**
   * Name of the single queue this storage is scoped to. The
   * {@link wrapQueueStorage} facade reads it to enforce queue-scoping on
   * `findActiveByFingerprint`: asking about a different queue returns
   * undefined, matching the native SQL `WHERE queue = ?` lookups. Optional
   * only for custom stores; every built-in backend exposes it.
   */
  readonly queueName?: string;

  /**
   * Declared durability of this store's rows. `false` marks a store whose
   * rows do not survive the process (in-memory); leave undefined for stores
   * that persist. Cloud message-queue adapters warn when paired with a
   * non-durable store, since at-least-once delivery plus a process-local
   * store strands partial-failure rows.
   */
  readonly durable?: boolean;

  /**
   * Optional single-statement fast path: overwrite the status field without
   * bumping `attempts`. When present, the {@link wrapQueueStorage} facade
   * prefers it over its generic `finalize({ status })` composition. Declared
   * on the interface — like {@link findActiveByFingerprint} — so decorators
   * (e.g. TelemetryQueueStorage) forward it; a decorator that hid it would
   * silently downgrade the atomic write back to the generic composition.
   */
  saveStatus?(id: unknown, status: JobStatus): void | Promise<void>;

  /**
   * Optional batched lookup fast path: one query for N ids. The wrapper
   * falls back to a per-id `get()` fan-out when absent.
   */
  getMany?(
    ids: readonly unknown[]
  ): Promise<ReadonlyArray<JobStorageFormat<Input, Output> | undefined>>;

  /**
   * Optional atomic completion fast path: persist result + COMPLETED in one
   * statement. The wrapper's fallback composes it via {@link finalize}.
   */
  completeWithResult?(id: unknown, result: Output): Promise<void>;

  /**
   * Optional atomic failure fast path: persist error fields + FAILED in one
   * statement (SQL backends COALESCE `abort_requested_at` / `completed_at`
   * server-side). The wrapper's fallback is a read-then-write composition,
   * which a concurrent abort can race — implement this where the backend
   * can do it atomically.
   */
  failWithError?(
    id: unknown,
    opts: {
      readonly error?: string | null;
      readonly errorCode?: string | null;
      readonly abortRequested?: boolean;
    }
  ): Promise<void>;

  /**
   * Deletes all jobs from the queue storage
   */
  deleteAll(): Promise<void>;

  /**
   * Gets the output for a given input from the queue storage
   * @param input - The input to get the output for
   * @returns The output of the job
   */
  outputForInput(input: Input): Promise<Output | null>;

  /**
   * Aborts a job in the queue storage
   * @param id - The ID of the job to abort
   */
  abort(id: unknown): Promise<void>;

  /**
   * Gets the jobs by job run ID from the queue storage
   * @param runId - The job run ID of the jobs to get
   * @returns The jobs with the given job run ID
   */
  getByRunId(runId: string): Promise<Array<JobStorageFormat<Input, Output>>>;

  /**
   * Saves progress updates for a job in the queue storage.
   *
   * Missing-id contract: if no row matches `id` (already finalized, deleted,
   * or foreign), implementations MUST silently no-op rather than throw —
   * progress is best-effort and a finalized/lost job must not turn a progress
   * report into an exception. Matches {@link complete}'s forgiving semantics.
   * @param id - The ID of the job to save the progress for
   * @param progress - The progress of the job
   * @param message - The message of the job
   * @param details - The details of the job
   */
  saveProgress(
    id: unknown,
    progress: number,
    message: string,
    details: Record<string, any> | null
  ): Promise<void>;

  /**
   * Deletes a job by its ID from the queue storage
   * @param id - The ID of the job to delete
   */
  delete(id: unknown): Promise<void>;

  /**
   * Deletes jobs from the queue storage that are of a specific status and older than the specified time
   * @param status - The status of the jobs to delete
   * @param olderThanMs - The time in milliseconds that the jobs must be older than to be deleted
   */
  deleteJobsByStatusAndAge(status: JobStatus, olderThanMs: number): Promise<void>;

  /**
   * Applies any pending migrations for this queue's tables.
   *
   * The single schema-setup entry point for every queue backend. SQL
   * backends run real DDL through their `MigrationRunner`; in-memory and
   * IndexedDB backends do whatever lazy initialisation they need (object
   * stores for IDB, no-op for in-memory).
   *
   * For progress reporting, telemetry, or composing migrations across
   * multiple storages under a single transaction, drive a `MigrationRunner`
   * directly with {@link getMigrations}.
   */
  migrate(): Promise<void>;

  /**
   * Returns this storage's versioned migrations as opaque, runnable units
   * so callers can compose migrations across storages under a single
   * `MigrationRunner` (and pass `{ onProgress }` when they need it).
   * Returns an empty array on backends that don't have a versioned schema
   * (in-memory).
   */
  getMigrations(): ReadonlyArray<unknown>;

  /**
   * Subscribes to changes in the queue (including remote changes).
   * @param callback - Function called when a change occurs
   * @param options - Optional subscription options (e.g., polling interval)
   * @returns Unsubscribe function
   */
  subscribeToChanges(
    callback: (change: QueueChangePayload<Input, Output>) => void,
    options?: QueueSubscribeOptions
  ): () => void;
  /**
   * OPTIONAL — append a live stream event to job `jobId`'s ordered side-stream;
   * the storage assigns the monotonic per-job `seq`. See
   * {@link IMessageQueue.publishStreamChunk}. Absent on backends that cannot
   * carry a job's live stream out of process.
   */
  publishStreamChunk?(jobId: unknown, event: StreamEventLike): Promise<void>;
  /**
   * OPTIONAL — subscribe to a job's stream side-stream, replaying rows with
   * `seq > sinceSeq` before live delivery. See
   * {@link IMessageQueue.subscribeToStream}.
   *
   * A carrier that delivers SYNCHRONOUSLY from a live producer — an
   * in-process one, whose publish runs inside the emitting job's own awaited
   * dispatch — must await what `callback` returns, so the consumer paces the
   * producer. Without that the producer is paced only by the append and a
   * slow consumer's queue grows with the whole stream. A carrier replaying
   * rows published earlier has no producer to pace and may ignore it.
   */
  subscribeToStream?(
    jobId: unknown,
    sinceSeq: number,
    callback: (row: StreamChunkRow) => void | Promise<void>
  ): () => void;
}
