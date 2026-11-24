/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ClaimFence,
  ClaimFinalizeFields,
  IQueueStorage,
  JobStorageFormat,
  PrefixColumn,
  QueueChangePayload,
  QueueFinalizeFields,
  QueueStorageOptions,
  QueueSubscribeOptions,
} from "@workglow/job-queue";
import { JobStatus, LeaseLostError, validateLeaseMs } from "@workglow/job-queue";
import type { Pool } from "@workglow/postgres/storage";
import {
  assertPrefixesSafe,
  buildPrefixInsertFragments,
  buildPrefixWhereClause,
  getPrefixColumnNames,
  getPrefixParamValues,
  PostgresDialect,
} from "@workglow/storage";
import { createServiceToken, getLogger, makeFingerprint, uuid4 } from "@workglow/util";
import { createHash } from "node:crypto";
import { PostgresMigrationRunner } from "../migrations/PostgresMigrationRunner";
import { postgresQueueMigrations } from "../migrations/postgresQueueMigrations";

export const POSTGRES_QUEUE_STORAGE = createServiceToken<IQueueStorage<any, any>>(
  "jobqueue.storage.postgres"
);

/**
 * Subset of pg.PoolClient that {@link PostgresQueueStorage.subscribeToChanges}
 * needs. Typed locally so we don't require `pg` types at the storage layer.
 */
interface ListenClient {
  query: (sql: string) => Promise<unknown>;
  release: () => void;
  removeAllListeners?: (event: string) => void;
  on: (event: string, listener: (...args: any[]) => void) => void;
}

/**
 * PostgreSQL implementation of a job queue.
 * Provides storage and retrieval for job execution states using PostgreSQL.
 */
export class PostgresQueueStorage<Input, Output> implements IQueueStorage<Input, Output> {
  public readonly scope = "cluster" as const;
  /** The prefix column definitions */
  protected readonly prefixes: readonly PrefixColumn[];
  /** The prefix values for filtering */
  protected readonly prefixValues: Readonly<Record<string, string | number>>;
  /** The table name for the job queue */
  protected readonly tableName: string;

  constructor(
    protected readonly db: Pool,
    public readonly queueName: string,
    options?: QueueStorageOptions
  ) {
    this.prefixes = options?.prefixes ?? [];
    this.prefixValues = options?.prefixValues ?? {};

    // Validate prefix column names to prevent SQL injection in DDL statements
    assertPrefixesSafe(this.prefixes);

    // Generate table name based on prefix configuration to avoid column conflicts
    if (this.prefixes.length > 0) {
      const prefixNames = this.prefixes.map((p) => p.name).join("_");
      this.tableName = `job_queue_${prefixNames}`;
    } else {
      this.tableName = "job_queue";
    }
  }

  /** WHERE-clause helper specialized for this instance's dialect + prefix values. */
  private buildPrefixWhereClause(startParam: number) {
    return buildPrefixWhereClause(PostgresDialect, this.prefixes, this.prefixValues, startParam);
  }

  /** Returns prefix values in column order. */
  private getPrefixParamValues(): Array<string | number> {
    return getPrefixParamValues(this.prefixes, this.prefixValues);
  }

  /**
   * Returns the versioned migrations that this storage's table layout depends
   * on. Callers can compose them with other storages' migrations under a
   * shared {@link PostgresMigrationRunner}; otherwise call {@link migrate}.
   */
  public getMigrations() {
    return postgresQueueMigrations(this.tableName, this.prefixes);
  }

  /**
   * Applies any pending migrations for this queue's table. Idempotent —
   * already-applied versions are recorded in `_storage_migrations` and
   * skipped on subsequent calls.
   */
  public async migrate(): Promise<void> {
    await new PostgresMigrationRunner(this.db).run(this.getMigrations());
  }

  /**
   * Channel name for this storage's LISTEN/NOTIFY. Mirrors the trigger's
   * computation so subscriber and notifier agree.
   */
  private notifyChannelName(): string {
    // md5() returns 32 hex chars; combined with the 7-char prefix this is well
    // under Postgres's 63-byte identifier limit.
    const tableAndQueue = `${this.tableName}${this.queueName}`;
    const hash = createHash("md5").update(tableAndQueue).digest("hex");
    return `wglw_q_${hash}`;
  }

  /**
   * Adds a new job to the queue.
   * @param job - The job to add
   * @returns The ID of the added job
   */
  public async add(job: JobStorageFormat<Input, Output>): Promise<unknown> {
    const now = new Date().toISOString();
    job.queue = this.queueName;
    job.job_run_id = job.job_run_id ?? uuid4();
    job.fingerprint = job.fingerprint ?? (await makeFingerprint(job.input));
    job.status = JobStatus.PENDING;
    job.progress = 0;
    job.progress_message = "";
    job.progress_details = null;
    job.created_at = now;
    // A caller-set future visible_at is a delayed send (delaySeconds) — keep it.
    job.visible_at = job.visible_at ?? now;

    const prefixColumnNames = getPrefixColumnNames(this.prefixes);
    const { columns: prefixColumnsInsert, placeholders: prefixParamPlaceholders } =
      buildPrefixInsertFragments(PostgresDialect, this.prefixes, 1);
    const prefixParamValues = this.getPrefixParamValues();
    const baseParamStart = prefixColumnNames.length + 1;

    const sql = `
      INSERT INTO ${this.tableName}(
        ${prefixColumnsInsert}queue,
        fingerprint,
        input,
        visible_at,
        created_at,
        deadline_at,
        max_attempts,
        job_run_id,
        progress,
        progress_message,
        progress_details
      )
      VALUES
        (${prefixParamPlaceholders}$${baseParamStart},$${baseParamStart + 1},$${baseParamStart + 2},$${baseParamStart + 3},$${baseParamStart + 4},$${baseParamStart + 5},$${baseParamStart + 6},$${baseParamStart + 7},$${baseParamStart + 8},$${baseParamStart + 9},$${baseParamStart + 10})
      RETURNING id`;
    const params = [
      ...prefixParamValues,
      job.queue,
      job.fingerprint,
      JSON.stringify(job.input),
      job.visible_at,
      job.created_at,
      job.deadline_at,
      job.max_attempts,
      job.job_run_id,
      job.progress,
      job.progress_message,
      job.progress_details ? JSON.stringify(job.progress_details) : null,
    ];
    let result: { rows: Array<{ id: unknown }> } | undefined;
    try {
      result = (await this.db.query(sql, params)) as { rows: Array<{ id: unknown }> } | undefined;
    } catch (err) {
      // Race-safety for fingerprint dedup. With the UNIQUE partial
      // index in place, two concurrent inserts for the same (queue,
      // fingerprint) where one row is PENDING/PROCESSING raise a 23505
      // unique_violation. We resolve the race by returning the winner's id
      // (the row that's already PENDING/PROCESSING). Any other error
      // re-throws.
      const e = err as { code?: string; constraint?: string; message?: string };
      const isUniqueViolation = e?.code === "23505";
      const involvesFingerprint =
        typeof e?.constraint === "string"
          ? e.constraint.includes("fingerprint")
          : typeof e?.message === "string"
            ? e.message.includes("fingerprint")
            : false;
      if (isUniqueViolation && involvesFingerprint && job.fingerprint) {
        const winner = await this.findActiveByFingerprint(job.fingerprint, this.queueName);
        if (winner?.id != null) {
          job.id = winner.id;
          return winner.id;
        }
      }
      throw err;
    }

    if (!result) throw new Error("Failed to add to queue");
    job.id = result.rows[0].id;
    return job.id;
  }

  /**
   * Retrieves a job by its ID.
   * @param id - The ID of the job to retrieve
   * @returns The job if found, undefined otherwise
   */
  public async get(id: unknown): Promise<JobStorageFormat<Input, Output> | undefined> {
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(3);
    const result = await this.db.query(
      `SELECT *
        FROM ${this.tableName}
        WHERE id = $1 AND queue = $2${prefixConditions}
        FOR UPDATE SKIP LOCKED
        LIMIT 1`,
      [id, this.queueName, ...prefixParams]
    );

    if (!result || result.rows.length === 0) return undefined;
    return result.rows[0];
  }

  /**
   * Retrieves a slice of jobs from the queue.
   * @param num - Maximum number of jobs to return
   * @returns An array of jobs
   */
  public async peek(
    status: JobStatus = JobStatus.PENDING,
    num: number = 100
  ): Promise<Array<JobStorageFormat<Input, Output>>> {
    num = Number(num) || 100;
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(4);
    const result = await this.db.query<JobStorageFormat<Input, Output>, Array<string | number>>(
      `
      SELECT *
        FROM ${this.tableName}
        WHERE queue = $1
        AND status = $2${prefixConditions}
        ORDER BY visible_at ASC
        LIMIT $3
        FOR UPDATE SKIP LOCKED`,
      [this.queueName, status, num, ...prefixParams]
    );
    if (!result) return [];
    return result.rows;
  }

  /**
   * Retrieves the next available job that is ready to be processed.
   * Claims PENDING jobs ready to run, and also reclaims PROCESSING jobs whose
   * lease has expired (crash recovery). Sets lease_expires_at on the claimed row.
   * @param workerId - Worker ID to associate with the job (required)
   * @param opts - Optional options including leaseMs (default 30000)
   * @returns The next job or undefined if no job is available
   */
  public async next(
    workerId: string,
    opts?: { leaseMs?: number }
  ): Promise<JobStorageFormat<Input, Output> | undefined> {
    const leaseMs = opts?.leaseMs ?? 30000;
    validateLeaseMs(leaseMs, "leaseMs");
    // Parameters: $1=PROCESSING, $2=now+leaseMs interval, $3=queue, $4=workerId, $5=PENDING, $6=PROCESSING, $7+=prefix params
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(7);
    const result = await this.db.query<
      JobStorageFormat<Input, Output>,
      Array<string | number | null>
    >(
      `
      UPDATE ${this.tableName}
      SET status = $1,
          last_attempted_at = NOW() AT TIME ZONE 'UTC',
          lease_owner = $4,
          lease_expires_at = NOW() AT TIME ZONE 'UTC' + ($2 * INTERVAL '1 millisecond'),
          -- A reclaimed PROCESSING row was claimed by a now-crashed worker;
          -- that constitutes one used-up attempt against max_attempts.
          -- PENDING claims must not be charged here — JobQueueWorker's
          -- existing validateJobState() will FAIL the job in the next-step
          -- branch when attempts >= max_attempts.
          attempts = CASE WHEN status = $6 THEN attempts + 1 ELSE attempts END,
          -- Always clear any stale abort_requested_at on (re)claim. A PROCESSING
          -- row may have had abort_requested_at set before the worker crashed;
          -- the new owner must start with a clean slate or the worker will see
          -- the abort flag immediately and never run user code.
          abort_requested_at = NULL
      WHERE id = (
        SELECT id
        FROM ${this.tableName}
        WHERE queue = $3
        AND (
          (status = $5 AND visible_at <= NOW() AT TIME ZONE 'UTC')
          OR (status = $6 AND (lease_expires_at IS NULL OR lease_expires_at < NOW() AT TIME ZONE 'UTC'))
        )
        ${prefixConditions}
        ORDER BY visible_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *`,
      [
        JobStatus.PROCESSING,
        leaseMs,
        this.queueName,
        workerId,
        JobStatus.PENDING,
        JobStatus.PROCESSING,
        ...prefixParams,
      ]
    );

    return result?.rows?.[0] ?? undefined;
  }

  /**
   * Extend the lease on a currently PROCESSING job.
   * @param id - The ID of the job to extend the lease for
   * @param workerId - Worker ID that must match the current lease owner (lease_owner)
   * @param ms - Number of milliseconds to extend the lease by
   */
  public async extendLease(
    id: unknown,
    workerId: string,
    ms: number,
    attempts?: number
  ): Promise<void> {
    validateLeaseMs(ms, "ms");
    const fenceAttempts = attempts !== undefined;
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(
      fenceAttempts ? 6 : 5
    );
    const result = await this.db.query(
      `UPDATE ${this.tableName}
         SET lease_expires_at = NOW() AT TIME ZONE 'UTC' + ($1 * INTERVAL '1 millisecond')
         WHERE id = $2 AND queue = $3 AND lease_owner = $4 AND status = 'PROCESSING'${
           fenceAttempts ? " AND COALESCE(attempts, 0) = $5" : ""
         }${prefixConditions}`,
      fenceAttempts
        ? [ms, id, this.queueName, workerId, attempts, ...prefixParams]
        : [ms, id, this.queueName, workerId, ...prefixParams]
    );
    if (!result || result.rowCount === 0) {
      throw new LeaseLostError(
        `extendLease failed: job ${String(id)} is not PROCESSING or lease is not owned by worker ${workerId}`
      );
    }
  }

  /**
   * Retrieves the number of jobs in the queue with a specific status.
   * @param status - The status of the jobs to count
   * @returns The count of jobs with the specified status
   */
  public async size(status = JobStatus.PENDING): Promise<number> {
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(3);
    const result = await this.db.query<{ count: string }, Array<string | number>>(
      `
      SELECT COUNT(*) as count
        FROM ${this.tableName}
        WHERE queue = $1
        AND status = $2${prefixConditions}`,
      [this.queueName, status, ...prefixParams]
    );
    if (!result) return 0;
    return parseInt(result.rows[0].count, 10);
  }

  /**
   * Marks a job as complete with its output or error.
   * Enhanced error handling:
   * - For a retryable error, increments attempts and updates visible_at.
   * - Marks a job as FAILED immediately for permanent or generic errors.
   */
  public async complete(jobDetails: JobStorageFormat<Input, Output>): Promise<void> {
    const prefixParams = this.getPrefixParamValues();

    if (jobDetails.status === JobStatus.DISABLED) {
      const { conditions: prefixConditions } = this.buildPrefixWhereClause(4);
      await this.db.query(
        `UPDATE ${this.tableName} 
          SET 
            status = $1, 
            progress = 100,
            progress_message = '',
            progress_details = NULL,
            completed_at = NOW() AT TIME ZONE 'UTC'
          WHERE id = $2 AND queue = $3${prefixConditions}`,
        [jobDetails.status, jobDetails.id, this.queueName, ...prefixParams]
      );
    } else if (jobDetails.status === JobStatus.PENDING) {
      const { conditions: prefixConditions } = this.buildPrefixWhereClause(7);
      // PENDING-retry branch: the worker hit a retryable error and the row is
      // returning to PENDING for another attempt. Clear abort_requested_at so
      // an abort that was requested DURING the previous attempt does not
      // immediately cancel the retry.
      await this.db.query(
        `UPDATE ${this.tableName}
          SET
            error = $1,
            error_code = $2,
            status = $3,
            visible_at = $4,
            progress = 0,
            progress_message = '',
            progress_details = NULL,
            attempts = attempts + 1,
            last_attempted_at = NOW() AT TIME ZONE 'UTC',
            abort_requested_at = NULL
          WHERE id = $5 AND queue = $6${prefixConditions}`,
        [
          jobDetails.error,
          jobDetails.error_code,
          jobDetails.status,
          jobDetails.visible_at,
          jobDetails.id,
          this.queueName,
          ...prefixParams,
        ]
      );
    } else {
      const { conditions: prefixConditions } = this.buildPrefixWhereClause(7);
      await this.db.query(
        `
          UPDATE ${this.tableName} 
            SET 
              output = $1, 
              error = $2, 
              error_code = $3,
              status = $4, 
              progress = 100,
              progress_message = '',
              progress_details = NULL,
              attempts = attempts + 1,
              completed_at = NOW() AT TIME ZONE 'UTC',
              last_attempted_at = NOW() AT TIME ZONE 'UTC'
          WHERE id = $5 AND queue = $6${prefixConditions}`,
        [
          jobDetails.output ? JSON.stringify(jobDetails.output) : null,
          jobDetails.error ?? null,
          jobDetails.error_code ?? null,
          jobDetails.status,
          jobDetails.id,
          this.queueName,
          ...prefixParams,
        ]
      );
    }
  }

  /**
   * Terminal write that does NOT bump `attempts`. See IQueueStorage.finalize
   * for the rationale (avoids double-counting on ack/fail because the lease
   * reclaim path already charged the attempt at next() time).
   */
  public async finalize(id: unknown, fields: QueueFinalizeFields<Output>): Promise<void> {
    await this.writeFinalize(id, fields, undefined);
  }

  /**
   * {@link finalize} fenced to one claim: the ownership predicate is part of
   * the UPDATE's WHERE clause, so a reclaim can never interleave between the
   * check and the write.
   */
  public async finalizeClaim(
    id: unknown,
    fence: ClaimFence,
    fields: ClaimFinalizeFields<Output>
  ): Promise<boolean> {
    return (await this.writeFinalize(id, fields, fence)) > 0;
  }

  /**
   * One partial-overwrite UPDATE covering only the fields the caller supplied.
   * Everything else (in particular `attempts`, `visible_at`,
   * `lease_expires_at`) is untouched unless `fields` names it. Resolves the
   * number of rows written.
   */
  private async writeFinalize(
    id: unknown,
    fields: ClaimFinalizeFields<Output>,
    fence: ClaimFence | undefined
  ): Promise<number> {
    const sets: string[] = [];
    const params: Array<unknown> = [];
    const param = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    const push = (col: string, value: unknown): void => {
      sets.push(`${col} = ${param(value)}`);
    };
    if ("output" in fields) {
      push("output", fields.output != null ? JSON.stringify(fields.output) : null);
    }
    if ("error" in fields) push("error", fields.error ?? null);
    if ("error_code" in fields) push("error_code", fields.error_code ?? null);
    if ("status" in fields) push("status", fields.status);
    if ("completed_at" in fields) push("completed_at", fields.completed_at ?? null);
    if ("abort_requested_at" in fields) {
      push("abort_requested_at", fields.abort_requested_at ?? null);
    }
    if ("lease_owner" in fields) push("lease_owner", fields.lease_owner ?? null);
    if ("progress" in fields) push("progress", fields.progress ?? 0);
    if ("progress_message" in fields) push("progress_message", fields.progress_message ?? "");
    if ("progress_details" in fields) {
      push(
        "progress_details",
        fields.progress_details != null ? JSON.stringify(fields.progress_details) : null
      );
    }
    if ("visible_at" in fields) push("visible_at", fields.visible_at ?? null);
    if (fence) {
      if ("lease_expires_at" in fields) push("lease_expires_at", fields.lease_expires_at ?? null);
      if (fields.incrementAttempts === true) sets.push("attempts = COALESCE(attempts, 0) + 1");
      // An empty write still has to answer whether the claim holds the row.
      if (sets.length === 0) sets.push("id = id");
    }
    if (sets.length === 0) return 0; // nothing to write
    const where = [`id = ${param(id)}`, `queue = ${param(this.queueName)}`];
    if (fence) {
      where.push(
        `status = 'PROCESSING'`,
        `lease_owner = ${param(fence.leaseOwner)}`,
        `COALESCE(attempts, 0) = ${param(fence.attempts)}`
      );
    }
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(
      params.length + 1
    );
    const result = await this.db.query(
      `UPDATE ${this.tableName}
         SET ${sets.join(", ")}
         WHERE ${where.join(" AND ")}${prefixConditions}`,
      [...params, ...prefixParams]
    );
    return result?.rowCount ?? 0;
  }

  /**
   * Clears all jobs from the queue.
   */
  public async deleteAll(): Promise<void> {
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(2);
    await this.db.query(
      `
      DELETE FROM ${this.tableName}
        WHERE queue = $1${prefixConditions}`,
      [this.queueName, ...prefixParams]
    );
  }

  /**
   * Looks up cached output for a given input
   * Uses input fingerprinting for efficient matching
   * @returns The cached output or null if not found
   */
  public async outputForInput(input: Input): Promise<Output | null> {
    const fingerprint = await makeFingerprint(input);
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(3);
    const result = await this.db.query(
      `
      SELECT output
        FROM ${this.tableName}
        WHERE fingerprint = $1 AND queue = $2 AND status = 'COMPLETED'${prefixConditions}`,
      [fingerprint, this.queueName, ...prefixParams]
    );
    if (!result || result.rows.length === 0) return null;
    return result.rows[0].output;
  }

  /**
   * Aborts a job.
   * - If PENDING: immediately mark as FAILED with abort_requested_at set.
   * - If PROCESSING: set abort_requested_at only (leave status as PROCESSING).
   * - Otherwise: no-op.
   */
  public async abort(jobId: unknown): Promise<void> {
    // Abort PENDING → FAILED immediately
    {
      const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(4);
      await this.db.query(
        `UPDATE ${this.tableName}
           SET status = 'FAILED',
               abort_requested_at = NOW() AT TIME ZONE 'UTC',
               completed_at = NOW() AT TIME ZONE 'UTC'
           WHERE id = $1 AND queue = $2 AND status = $3${prefixConditions}`,
        [jobId, this.queueName, JobStatus.PENDING, ...prefixParams]
      );
    }
    // Abort PROCESSING → set abort_requested_at only
    {
      const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(4);
      await this.db.query(
        `UPDATE ${this.tableName}
           SET abort_requested_at = NOW() AT TIME ZONE 'UTC'
           WHERE id = $1 AND queue = $2 AND status = $3${prefixConditions}`,
        [jobId, this.queueName, JobStatus.PROCESSING, ...prefixParams]
      );
    }
  }

  /**
   * Releases a claimed job back to PENDING without incrementing attempts.
   * @param jobId - The id of the claimed job to release.
   */
  public async releaseClaim(jobId: unknown): Promise<void> {
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(3);
    // releaseClaim returns the row to PENDING without consuming an attempt.
    // Clear abort_requested_at so an abort that was requested mid-claim does
    // not survive the release and cancel the next worker that picks the row up.
    await this.db.query(
      `
      UPDATE ${this.tableName}
        SET status = 'PENDING',
            lease_owner = NULL,
            progress = 0,
            progress_message = '',
            progress_details = NULL,
            abort_requested_at = NULL
        WHERE id = $1 AND queue = $2${prefixConditions}`,
      [jobId, this.queueName, ...prefixParams]
    );
  }

  /** Force-overwrite status without touching attempts (used to persist DISABLED after lease release). */
  public async saveStatus(jobId: unknown, status: string): Promise<void> {
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(3);
    await this.db.query(
      `UPDATE ${this.tableName} SET status = $1 WHERE id = $2 AND queue = $3${prefixConditions}`,
      [status, jobId, this.queueName, ...prefixParams]
    );
  }

  /**
   * Retrieves all jobs for a given job run ID.
   * @param job_run_id - The ID of the job run to retrieve
   * @returns An array of jobs
   */
  public async getByRunId(job_run_id: string): Promise<Array<JobStorageFormat<Input, Output>>> {
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(3);
    const result = await this.db.query(
      `
      SELECT * FROM ${this.tableName} WHERE job_run_id = $1 AND queue = $2${prefixConditions}`,
      [job_run_id, this.queueName, ...prefixParams]
    );
    if (!result) return [];
    return result.rows;
  }

  /**
   * Implements the abstract saveProgress method from JobQueue
   */
  public async saveProgress(
    jobId: unknown,
    progress: number,
    message: string,
    details: Record<string, any> | null
  ): Promise<void> {
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(6);
    await this.db.query(
      `
      UPDATE ${this.tableName} 
      SET progress = $1,
          progress_message = $2,
          progress_details = $3
      WHERE id = $4 AND queue = $5${prefixConditions}`,
      [
        progress,
        message,
        details ? JSON.stringify(details) : null,
        jobId,
        this.queueName,
        ...prefixParams,
      ]
    );
  }

  /**
   * Deletes a job by its ID
   */
  public async delete(jobId: unknown): Promise<void> {
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(3);
    await this.db.query(
      `DELETE FROM ${this.tableName} WHERE id = $1 AND queue = $2${prefixConditions}`,
      [jobId, this.queueName, ...prefixParams]
    );
  }

  /**
   * Finds the most recent active (PENDING or PROCESSING) job with the given fingerprint in this queue.
   * Uses the partial index idx_<table>_fingerprint_active for O(1) lookup.
   */
  public async findActiveByFingerprint(
    fingerprint: string,
    queueName: string
  ): Promise<JobStorageFormat<Input, Output> | undefined> {
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(3);
    const result = await this.db.query<JobStorageFormat<Input, Output>>(
      `SELECT * FROM ${this.tableName}
        WHERE fingerprint = $1 AND queue = $2
          AND status IN ('PENDING','PROCESSING')${prefixConditions}
        ORDER BY created_at DESC
        LIMIT 1`,
      [fingerprint, queueName, ...prefixParams]
    );
    if (!result || result.rows.length === 0) return undefined;
    return result.rows[0];
  }

  /**
   * Retrieves multiple jobs by their IDs in a single query.
   * Returns results in the same order as the input ids array, with undefined for missing ids.
   */
  public async getMany(
    ids: readonly unknown[]
  ): Promise<Array<JobStorageFormat<Input, Output> | undefined>> {
    if (ids.length === 0) return [];
    // Filter to only integer-coercible IDs — Postgres SERIAL IDs are integers.
    // Non-integer ids (e.g. UUIDs passed from tests) will never match a row.
    const numericIds = ids.map((id) => Number(id)).filter((n) => Number.isInteger(n) && n > 0);
    if (numericIds.length === 0) return ids.map(() => undefined);
    // $1 = ids array, $2 = queue, $3+ = prefix params
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(3);
    const result = await this.db.query<JobStorageFormat<Input, Output>>(
      `SELECT * FROM ${this.tableName}
        WHERE id = ANY($1::int[]) AND queue = $2${prefixConditions}`,
      [numericIds, this.queueName, ...prefixParams]
    );
    if (!result) return ids.map(() => undefined);
    const map = new Map<number, JobStorageFormat<Input, Output>>();
    for (const row of result.rows) {
      map.set(Number(row.id), row);
    }
    return ids.map((id) => map.get(Number(id)));
  }

  /**
   * Atomically writes output and sets status=COMPLETED.
   */
  public async completeWithResult(id: unknown, result: Output): Promise<void> {
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(3);
    await this.db.query(
      `UPDATE ${this.tableName}
          SET output = $1,
              status = 'COMPLETED',
              progress = 100,
              progress_message = '',
              progress_details = NULL,
              completed_at = NOW() AT TIME ZONE 'UTC'
        WHERE id = $2 AND queue = $3${prefixConditions}`,
      [result != null ? JSON.stringify(result) : null, id, this.queueName, ...prefixParams]
    );
  }

  /**
   * Atomically writes error fields and sets status=FAILED.
   * COALESCEs preserve existing error/error_code when opts fields are absent.
   */
  public async failWithError(
    id: unknown,
    opts: {
      readonly error?: string | null;
      readonly errorCode?: string | null;
      readonly abortRequested?: boolean;
    }
  ): Promise<void> {
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(5);
    await this.db.query(
      `UPDATE ${this.tableName}
          SET error = COALESCE($1, error),
              error_code = COALESCE($2, error_code),
              abort_requested_at = CASE WHEN $3 THEN NOW() AT TIME ZONE 'UTC' ELSE abort_requested_at END,
              status = 'FAILED',
              completed_at = COALESCE(completed_at, NOW() AT TIME ZONE 'UTC')
        WHERE id = $4 AND queue = $5${prefixConditions}`,
      [
        "error" in opts ? (opts.error ?? null) : null,
        "errorCode" in opts ? (opts.errorCode ?? null) : null,
        opts.abortRequested === true,
        id,
        this.queueName,
        ...prefixParams,
      ]
    );
  }

  /**
   * Atomically writes status=DISABLED, releases the lease, clears progress
   * fields, and stamps `completed_at`. Does NOT write error/error_code —
   * DISABLED is not an error transition.
   */
  public async markDisabled(id: unknown): Promise<void> {
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(2);
    await this.db.query(
      `UPDATE ${this.tableName}
          SET status = 'DISABLED',
              completed_at = COALESCE(completed_at, NOW() AT TIME ZONE 'UTC'),
              lease_owner = NULL,
              progress = 0,
              progress_message = '',
              progress_details = NULL
        WHERE id = $1 AND queue = $2${prefixConditions}`,
      [id, this.queueName, ...prefixParams]
    );
  }

  /**
   * Delete jobs with a specific status older than a cutoff date
   * @param status - Status of jobs to delete
   * @param olderThanMs - Delete jobs completed more than this many milliseconds ago
   */
  public async deleteJobsByStatusAndAge(status: JobStatus, olderThanMs: number): Promise<void> {
    const cutoffDate = new Date(Date.now() - olderThanMs).toISOString();
    const { conditions: prefixConditions, params: prefixParams } = this.buildPrefixWhereClause(4);
    await this.db.query(
      `DELETE FROM ${this.tableName} 
       WHERE queue = $1 
       AND status = $2 
       AND completed_at IS NOT NULL 
       AND completed_at <= $3${prefixConditions}`,
      [this.queueName, status, cutoffDate, ...prefixParams]
    );
  }

  /**
   * Subscribe to INSERT/UPDATE notifications via PostgreSQL LISTEN/NOTIFY.
   * Replaces 100ms-poll fallback for cluster Postgres deployments — workers
   * wake within network-latency of an actual change rather than on a timer.
   *
   * Acquires a dedicated client from the pool (LISTEN occupies a connection
   * for its lifetime). On unsubscribe, runs UNLISTEN and releases the client.
   * On connection loss, attempts to reconnect with bounded backoff and
   * re-LISTEN. After every successful (re)connect — including the initial
   * one — emits a synthetic `{ type: "RESYNC" }` event so subscribers can
   * re-poll state and pick up any rows inserted during the disconnect window
   * (or between subscribe and the first NOTIFY landing).
   *
   * Throws synchronously when the underlying pool lacks `connect()`
   * (single-connection wrappers like PGLite) so the caller's try/catch can
   * fall back to polling. JobQueueServer.start does this and logs at debug.
   *
   * `options.prefixFilter` follows {@link QueueSubscribeOptions.prefixFilter}:
   * `undefined` means "use the storage instance's configured prefixValues",
   * `{}` means "receive all changes regardless of prefix".
   */
  public subscribeToChanges(
    callback: (change: QueueChangePayload<Input, Output>) => void,
    options?: QueueSubscribeOptions
  ): () => void {
    type PoolWithConnect = { connect: () => Promise<ListenClient> };
    const poolMaybe = this.db as unknown as Partial<PoolWithConnect>;
    if (typeof poolMaybe.connect !== "function") {
      // Detect synchronously so callers can catch and fall back to polling
      // without leaving a dangling unhandled promise rejection behind.
      throw new Error(
        "PostgresQueueStorage.subscribeToChanges requires a pg.Pool (got a single-connection wrapper)"
      );
    }
    const pool = poolMaybe as PoolWithConnect;

    const channel = this.notifyChannelName();
    // undefined -> default to instance prefixValues; {} -> no filtering;
    // partial -> filter by the provided subset (matches QueueSubscribeOptions docs).
    const effectivePrefixFilter: Readonly<Record<string, string | number>> | null =
      options?.prefixFilter === undefined
        ? this.prefixes.length > 0
          ? this.prefixValues
          : null
        : Object.keys(options.prefixFilter).length === 0
          ? null
          : options.prefixFilter;

    let unsubscribed = false;
    let activeClient: ListenClient | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let backoffMs = 250;

    const dispatch = (change: QueueChangePayload<Input, Output>): void => {
      try {
        callback(change);
      } catch (err) {
        // Never let user callbacks tear down the listener loop.
        getLogger().debug("PostgresQueueStorage subscribe callback threw", {
          channel,
          changeType: change.type,
          error: err,
        });
      }
    };

    const matchesPrefix = (
      change: QueueChangePayload<Input, Output>,
      filter: Readonly<Record<string, string | number>>
    ): boolean => {
      const row = (change.new ?? change.old) as Record<string, unknown> | undefined;
      if (!row) return false;
      for (const [k, v] of Object.entries(filter)) {
        if (row[k] !== v) return false;
      }
      return true;
    };

    // Hydrate the row referenced by a notification. Postgres NOTIFY is capped
    // at 8 KB so we ship only {id, queue, status} in the payload and fetch the
    // full row here — keeps subscriber payloads consistent with other backends
    // (e.g. Supabase realtime, IndexedDb) and lets prefixFilter inspect the
    // prefix columns the row actually has.
    const hydrate = async (id: unknown): Promise<JobStorageFormat<Input, Output> | undefined> => {
      try {
        return await this.get(id);
      } catch {
        return undefined;
      }
    };

    const handleNotification = (msg: { channel: string; payload?: string }): void => {
      if (msg.channel !== channel || !msg.payload) return;
      let parsed: { op: string; id: number; queue: string; status: string };
      try {
        parsed = JSON.parse(msg.payload);
      } catch {
        return;
      }
      void (async () => {
        const op = parsed.op;
        const fallback = {
          id: parsed.id,
          queue: parsed.queue,
          status: parsed.status,
        } as unknown as JobStorageFormat<Input, Output>;
        const fullRow = op === "DELETE" ? undefined : await hydrate(parsed.id);
        const change: QueueChangePayload<Input, Output> = {
          type: op === "INSERT" ? "INSERT" : op === "DELETE" ? "DELETE" : "UPDATE",
          new: op === "DELETE" ? undefined : (fullRow ?? fallback),
          old: op === "DELETE" ? fallback : undefined,
        };
        if (effectivePrefixFilter && !matchesPrefix(change, effectivePrefixFilter)) return;
        dispatch(change);
      })();
    };

    const connect = async (): Promise<void> => {
      if (unsubscribed) return;
      try {
        const client = await pool.connect();
        if (unsubscribed) {
          client.release();
          return;
        }
        activeClient = client;
        client.on("notification", handleNotification);
        client.on("error", () => scheduleReconnect());
        await client.query(`LISTEN ${channel}`);
        backoffMs = 250; // reset on successful (re)connect
        // Synthetic resync: any rows inserted between subscribe and LISTEN
        // landing (or during a reconnect window) have no NOTIFY backing.
        // Fire a no-payload event so subscribers can re-poll state.
        dispatch({ type: "RESYNC" });
      } catch {
        scheduleReconnect();
      }
    };

    const scheduleReconnect = (): void => {
      if (unsubscribed || reconnectTimer) return;
      const c = activeClient;
      activeClient = null;
      try {
        c?.removeAllListeners?.("notification");
        c?.removeAllListeners?.("error");
        c?.release();
      } catch {
        // best-effort
      }
      const delay = Math.min(backoffMs, 30_000);
      backoffMs = Math.min(backoffMs * 2, 30_000);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    };

    void connect();

    return () => {
      unsubscribed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      const c = activeClient;
      activeClient = null;
      if (c) {
        // Best-effort UNLISTEN; ignore errors (connection may already be dead).
        c.query(`UNLISTEN ${channel}`)
          .catch(() => {})
          .finally(() => {
            try {
              c.removeAllListeners?.("notification");
              c.removeAllListeners?.("error");
              c.release();
            } catch {
              // best-effort
            }
          });
      }
    };
  }
}
