/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";
import type {
  ClaimFence,
  ClaimFinalizeFields,
  IQueueStorage,
  JobStorageFormat,
  PrefixColumn,
  QueueChangePayload,
  QueueChangeType,
  QueueFinalizeFields,
  QueueStorageOptions,
  QueueSubscribeOptions,
} from "@workglow/job-queue";
import { JobStatus, LeaseLostError, validateLeaseMs } from "@workglow/job-queue";
import {
  buildPrefixColumnsSql,
  getPrefixIndexPrefix,
  getPrefixIndexSuffix,
  PollingSubscriptionManager,
  PostgresDialect,
} from "@workglow/storage";
import { createServiceToken, deepEqual, getLogger, makeFingerprint, uuid4 } from "@workglow/util";
import { isExecSqlUnavailable, isMissingRelationError } from "../supabasePostgrest";

export const SUPABASE_QUEUE_STORAGE = createServiceToken<IQueueStorage<any, any>>(
  "jobqueue.storage.supabase"
);

/**
 * Supabase implementation of a job queue.
 * Provides storage and retrieval for job execution states using Supabase.
 */
export class SupabaseQueueStorage<Input, Output> implements IQueueStorage<Input, Output> {
  public readonly scope = "cluster" as const;
  protected readonly client: SupabaseClient;
  protected readonly prefixes: readonly PrefixColumn[];
  protected readonly prefixValues: Readonly<Record<string, string | number>>;
  protected readonly tableName: string;
  private realtimeChannel: RealtimeChannel | null = null;
  private pollingManager: PollingSubscriptionManager<
    JobStorageFormat<Input, Output>,
    unknown,
    QueueChangePayload<Input, Output>
  > | null = null;

  constructor(
    client: SupabaseClient,
    public readonly queueName: string,
    options?: QueueStorageOptions
  ) {
    this.client = client as SupabaseClient;
    this.prefixes = options?.prefixes ?? [];
    this.prefixValues = options?.prefixValues ?? {};
    // Generate table name based on prefix configuration to avoid column conflicts
    if (this.prefixes.length > 0) {
      const prefixNames = this.prefixes.map((p) => p.name).join("_");
      this.tableName = `job_queue_${prefixNames}`;
    } else {
      this.tableName = "job_queue";
    }
  }

  /**
   * Applies prefix filters to a Supabase query builder
   */
  private applyPrefixFilters<T>(query: T): T {
    let result = query as any;
    for (const prefix of this.prefixes) {
      result = result.eq(prefix.name, this.prefixValues[prefix.name]);
    }
    return result as T;
  }

  /**
   * Gets prefix values as an object for inserts
   */
  private getPrefixInsertValues(): Record<string, string | number> {
    const values: Record<string, string | number> = {};
    for (const prefix of this.prefixes) {
      values[prefix.name] = this.prefixValues[prefix.name];
    }
    return values;
  }

  /**
   * Builds WHERE clause conditions for prefix filtering with inline values (for raw SQL)
   * @returns SQL conditions string with values inlined
   */
  private buildPrefixWhereSql(): string {
    if (this.prefixes.length === 0) {
      return "";
    }
    const conditions = this.prefixes
      .map((p) => {
        const value = this.prefixValues[p.name];
        if (p.type === "uuid") {
          const validated = this.validateSqlValue(String(value), `prefix "${p.name}"`);
          return `${p.name} = '${this.escapeSqlString(validated)}'`;
        }
        const numValue = Number(value ?? 0);
        if (!Number.isFinite(numValue)) {
          throw new Error(`Invalid numeric prefix value for "${p.name}": ${value}`);
        }
        return `${p.name} = ${numValue}`;
      })
      .join(" AND ");
    return " AND " + conditions;
  }

  /**
   * Regex for validating SQL literal-safe strings.
   * Used for quoted values (e.g. queue names/IDs) and only allows alphanumeric
   * characters, underscores, hyphens, colons, and periods.
   */
  private static readonly SAFE_SQL_VALUE_RE = /^[\w\-.:]+$/;

  /**
   * Validates that a string value is safe for use as a quoted SQL literal.
   * Throws an error if the value contains characters outside SAFE_SQL_VALUE_RE.
   */
  private validateSqlValue(value: string, context: string): string {
    if (!SupabaseQueueStorage.SAFE_SQL_VALUE_RE.test(value)) {
      throw new Error(
        `Unsafe value for ${context}: "${value}". Values must match /^[a-zA-Z0-9_\\-.:]+$/.`
      );
    }
    return value;
  }

  /**
   * Escapes a string value for use in SQL
   */
  private escapeSqlString(value: string): string {
    return value.replace(/'/g, "''");
  }

  /**
   * Verifies the Supabase queue table exists. Production schema should come
   * from Supabase migrations; when the table is missing we optionally bootstrap
   * via `exec_sql` if the project exposes that RPC (PGlite test mock / local dev).
   */
  public async migrate(): Promise<void> {
    const probeError = await this.probeQueueTable();
    if (!probeError) return;

    if (isMissingRelationError(probeError)) {
      const bootstrapped = await this.tryBootstrapQueueViaExecSql();
      if (bootstrapped) {
        const after = await this.probeQueueTable();
        if (!after) return;
        if (isMissingRelationError(after)) {
          throw this.missingQueueTableError(after);
        }
        throw after;
      }
      throw this.missingQueueTableError(probeError);
    }
    throw probeError;
  }

  private missingQueueTableError(error: { code?: string; message?: string }): Error {
    return new Error(
      `Supabase queue table "${this.tableName}" is missing. Run Supabase migrations to create the queue schema (table + job_status enum + indexes) before initializing the queue. (PostgREST: ${error.code ?? "?"} ${error.message})`
    );
  }

  private async probeQueueTable(): Promise<{ code?: string; message?: string } | null> {
    const { error } = await this.client
      .from(this.tableName)
      .select("*", { head: true, count: "exact" })
      .limit(0);
    return error ?? null;
  }

  private async tryBootstrapQueueViaExecSql(): Promise<boolean> {
    const enumValues = [...Object.values(JobStatus), "ABORTING"]
      .filter((v, i, a) => a.indexOf(v) === i)
      .map((v) => `'${v}'`)
      .join(",");
    const createTypeSql = `CREATE TYPE job_status AS ENUM (${enumValues})`;

    const { error: typeError } = await this.client.rpc("exec_sql", { query: createTypeSql });
    if (typeError) {
      if (typeError.code === "42710") {
        // type already exists
      } else if (isExecSqlUnavailable(typeError)) {
        return false;
      } else {
        throw typeError;
      }
    }

    const prefixColumnsSql = buildPrefixColumnsSql(PostgresDialect, this.prefixes);
    const prefixIndexPrefix = getPrefixIndexPrefix(this.prefixes);
    const indexSuffix = getPrefixIndexSuffix(this.prefixes);

    const createTableSql = `
    CREATE TABLE IF NOT EXISTS ${this.tableName} (
      id SERIAL NOT NULL,
      ${prefixColumnsSql}fingerprint text NOT NULL,
      queue text NOT NULL,
      job_run_id text NOT NULL,
      status job_status NOT NULL default 'PENDING',
      input jsonb NOT NULL,
      output jsonb,
      attempts integer default 0,
      max_attempts integer default 10,
      visible_at timestamp with time zone DEFAULT now(),
      last_attempted_at timestamp with time zone,
      created_at timestamp with time zone DEFAULT now(),
      deadline_at timestamp with time zone,
      completed_at timestamp with time zone,
      error text,
      error_code text,
      progress real DEFAULT 0,
      progress_message text DEFAULT '',
      progress_details jsonb,
      lease_owner text,
      abort_requested_at timestamp with time zone,
      lease_expires_at timestamp with time zone
    )`;

    const { error: tableError } = await this.client.rpc("exec_sql", { query: createTableSql });
    if (tableError) {
      if (isExecSqlUnavailable(tableError)) return false;
      if (tableError.code !== "42P07" && !tableError.message?.includes("already exists")) {
        throw tableError;
      }
    }

    const indexes = [
      `CREATE INDEX IF NOT EXISTS job_fetcher${indexSuffix}_idx ON ${this.tableName} (${prefixIndexPrefix}id, status, visible_at)`,
      `CREATE INDEX IF NOT EXISTS job_queue_fetcher${indexSuffix}_idx ON ${this.tableName} (${prefixIndexPrefix}queue, status, visible_at)`,
      `CREATE INDEX IF NOT EXISTS jobs_fingerprint${indexSuffix}_unique_idx ON ${this.tableName} (${prefixIndexPrefix}queue, fingerprint, status)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_${this.tableName}_fingerprint_active ON ${this.tableName} (${prefixIndexPrefix}queue, fingerprint) WHERE status IN ('PENDING','PROCESSING')`,
    ];

    for (const indexSql of indexes) {
      const { error: idxError } = await this.client.rpc("exec_sql", { query: indexSql });
      if (!idxError) continue;
      if (isExecSqlUnavailable(idxError)) return false;
      if (idxError.code === "42P07" || idxError.message?.includes("already exists")) continue;
      throw idxError;
    }

    return true;
  }

  /** Supabase queue runs DDL via `exec_sql`, not via the migration runner. */
  public getMigrations(): ReadonlyArray<unknown> {
    return [];
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

    const prefixInsertValues = this.getPrefixInsertValues();

    const { data, error } = await this.client
      .from(this.tableName)
      .insert({
        ...prefixInsertValues,
        queue: job.queue,
        fingerprint: job.fingerprint,
        input: job.input,
        visible_at: job.visible_at,
        created_at: job.created_at,
        deadline_at: job.deadline_at,
        max_attempts: job.max_attempts,
        job_run_id: job.job_run_id,
        progress: job.progress,
        progress_message: job.progress_message,
        progress_details: job.progress_details,
      })
      .select("id")
      .single();

    if (error) {
      // Race-safety for fingerprint dedup. Supabase surfaces Postgres
      // unique_violation as `code === "23505"` on the PostgREST error shape.
      // When the partial UNIQUE index on (queue, fingerprint) WHERE status
      // IN ('PENDING','PROCESSING') fires, resolve the race by returning
      // the winner's id instead of bubbling the error up.
      const e = error as { code?: string; details?: string; message?: string };
      const isUniqueViolation = e?.code === "23505";
      const involvesFingerprint =
        (typeof e?.details === "string" && /fingerprint/i.test(e.details)) ||
        (typeof e?.message === "string" && /fingerprint/i.test(e.message));
      if (isUniqueViolation && involvesFingerprint && job.fingerprint) {
        const winner = await this.findActiveByFingerprint(job.fingerprint, this.queueName);
        if (winner?.id != null) {
          job.id = winner.id;
          return winner.id;
        }
      }
      throw error;
    }
    if (!data) throw new Error("Failed to add to queue");

    job.id = data.id;
    return job.id;
  }

  /**
   * Retrieves a job by its ID.
   * @param id - The ID of the job to retrieve
   * @returns The job if found, undefined otherwise
   */
  public async get(id: unknown): Promise<JobStorageFormat<Input, Output> | undefined> {
    let query = this.client
      .from(this.tableName)
      .select("*")
      .eq("id", id)
      .eq("queue", this.queueName);

    query = this.applyPrefixFilters(query);

    const { data, error } = await query.single();

    if (error) {
      if (error.code === "PGRST116") return undefined; // Not found
      throw error;
    }

    return data as JobStorageFormat<Input, Output> | undefined;
  }

  /**
   * Retrieves a slice of jobs from the queue.
   * @param status - The status to filter by
   * @param num - Maximum number of jobs to return
   * @returns An array of jobs
   */
  public async peek(
    status: JobStatus = JobStatus.PENDING,
    num: number = 100
  ): Promise<JobStorageFormat<Input, Output>[]> {
    num = Number(num) || 100;

    let query = this.client
      .from(this.tableName)
      .select("*")
      .eq("queue", this.queueName)
      .eq("status", status);

    query = this.applyPrefixFilters(query);

    const { data, error } = await query.order("visible_at", { ascending: true }).limit(num);

    if (error) throw error;
    return (data as JobStorageFormat<Input, Output>[]) ?? [];
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
    const prefixConditions = this.buildPrefixWhereSql();
    const validatedQueueName = this.validateSqlValue(this.queueName, "queueName");
    const validatedWorkerId = this.validateSqlValue(workerId, "workerId");
    const escapedQueueName = this.escapeSqlString(validatedQueueName);
    const escapedWorkerId = this.escapeSqlString(validatedWorkerId);

    const sql = `
      UPDATE ${this.tableName}
      SET status = '${JobStatus.PROCESSING}',
          last_attempted_at = NOW() AT TIME ZONE 'UTC',
          lease_owner = '${escapedWorkerId}',
          lease_expires_at = NOW() AT TIME ZONE 'UTC' + (${Number(leaseMs)} * INTERVAL '1 millisecond'),
          -- Lease-expiry reclaim consumes one attempt against max_attempts;
          -- PENDING claims do not (the worker's validateJobState will FAIL
          -- the job when attempts >= max_attempts at next-step time).
          attempts = CASE WHEN status = '${JobStatus.PROCESSING}' THEN attempts + 1 ELSE attempts END,
          -- Always clear stale abort_requested_at on (re)claim so a flag set
          -- by an earlier worker doesn't immediately abort the new lease.
          abort_requested_at = NULL
      WHERE id = (
        SELECT id
        FROM ${this.tableName}
        WHERE queue = '${escapedQueueName}'
        AND (
          (status = '${JobStatus.PENDING}' AND visible_at <= NOW() AT TIME ZONE 'UTC')
          OR (status = '${JobStatus.PROCESSING}' AND (lease_expires_at IS NULL OR lease_expires_at < NOW() AT TIME ZONE 'UTC'))
        )
        ${prefixConditions}
        ORDER BY visible_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
      )
      RETURNING *`;

    const { data, error } = await this.client.rpc("exec_sql", { query: sql });

    if (error) throw error;

    // exec_sql returns result rows as an array
    if (!data || !Array.isArray(data) || data.length === 0) {
      return undefined;
    }

    return data[0] as JobStorageFormat<Input, Output>;
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
    // Validate lease arg FIRST so callers get a consistent RangeError across
    // backends regardless of whether the id happens to be invalid too.
    validateLeaseMs(ms, "ms");
    const validatedWorkerId = this.validateSqlValue(workerId, "workerId");
    const escapedWorkerId = this.escapeSqlString(validatedWorkerId);
    const numericId = Number(id);
    if (!Number.isFinite(numericId)) {
      throw new Error(`Invalid job id: ${String(id)}`);
    }

    const prefixConditions = this.buildPrefixWhereSql();
    if (attempts !== undefined && !Number.isSafeInteger(attempts)) {
      throw new Error(`Invalid attempts: ${String(attempts)}`);
    }
    const attemptsCondition =
      attempts === undefined ? "" : `AND COALESCE(attempts, 0) = ${Number(attempts)}`;

    const sql = `
      UPDATE ${this.tableName}
        SET lease_expires_at = NOW() AT TIME ZONE 'UTC' + (${Number(ms)} * INTERVAL '1 millisecond')
        WHERE id = ${numericId}
          AND queue = '${this.escapeSqlString(this.validateSqlValue(this.queueName, "queueName"))}'
          AND lease_owner = '${escapedWorkerId}'
          AND status = '${JobStatus.PROCESSING}'
          ${attemptsCondition}
          ${prefixConditions}
        RETURNING id`;

    const { data, error } = await this.client.rpc("exec_sql", { query: sql });
    if (error) throw error;

    // exec_sql returns affected rows; if empty, the lease was lost
    if (!data || !Array.isArray(data) || data.length === 0) {
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
    let query = this.client
      .from(this.tableName)
      .select("*", { count: "exact", head: true })
      .eq("queue", this.queueName)
      .eq("status", status);

    query = this.applyPrefixFilters(query);

    const { count, error } = await query;

    if (error) throw error;
    return count ?? 0;
  }

  /**
   * Gets all jobs from the queue that match the current prefix values.
   * Used internally for polling-based subscriptions.
   *
   * @returns An array of jobs
   */
  private async getAllJobs(): Promise<Array<JobStorageFormat<Input, Output>>> {
    let query = this.client.from(this.tableName).select("*").eq("queue", this.queueName);

    query = this.applyPrefixFilters(query);

    const { data, error } = await query;

    if (error) throw error;
    return (data ?? []) as Array<JobStorageFormat<Input, Output>>;
  }

  /**
   * Marks a job as complete with its output or error.
   * Enhanced error handling:
   * - For a retryable error, increments attempts and updates visible_at.
   * - Marks a job as FAILED immediately for permanent or generic errors.
   */
  public async complete(jobDetails: JobStorageFormat<Input, Output>): Promise<void> {
    const now = new Date().toISOString();

    // Handle disabled without changing attempts
    if (jobDetails.status === JobStatus.DISABLED) {
      let query = this.client
        .from(this.tableName)
        .update({
          status: jobDetails.status,
          progress: 100,
          progress_message: "",
          progress_details: null,
          completed_at: now,
          last_attempted_at: now,
        })
        .eq("id", jobDetails.id)
        .eq("queue", this.queueName);
      query = this.applyPrefixFilters(query);
      const { error } = await query;
      if (error) throw error;
      return;
    }

    // Read current attempts to compute next value deterministically
    let getQuery = this.client
      .from(this.tableName)
      .select("attempts, max_attempts")
      .eq("id", jobDetails.id as number)
      .eq("queue", this.queueName);
    getQuery = this.applyPrefixFilters(getQuery);
    const { data: current, error: getError } = await getQuery.single();
    if (getError) throw getError;
    const currentAttempts = (current?.attempts as number | undefined) ?? 0;
    const maxAttempts =
      (current?.max_attempts as number | undefined) ?? jobDetails.max_attempts ?? 10;
    const nextAttempts = currentAttempts + 1;

    if (jobDetails.status === JobStatus.PENDING) {
      // Check if the next attempt would exceed max attempts
      if (nextAttempts >= maxAttempts) {
        // Update to FAILED status instead of rescheduling
        let failQuery = this.client
          .from(this.tableName)
          .update({
            status: JobStatus.FAILED,
            error: "Max attempts reached",
            error_code: "MAX_ATTEMPTS_REACHED",
            progress: 100,
            progress_message: "",
            progress_details: null,
            completed_at: now,
            last_attempted_at: now,
          })
          .eq("id", jobDetails.id)
          .eq("queue", this.queueName);
        failQuery = this.applyPrefixFilters(failQuery);
        const { error: failError } = await failQuery;
        if (failError) throw failError;
        return;
      }

      // Reschedule the job. Clear abort_requested_at so an abort that was
      // requested DURING the previous attempt does not immediately cancel
      // the retry.
      let query = this.client
        .from(this.tableName)
        .update({
          error: jobDetails.error ?? null,
          error_code: jobDetails.error_code ?? null,
          status: jobDetails.status,
          visible_at: jobDetails.visible_at!,
          progress: 0,
          progress_message: "",
          progress_details: null,
          attempts: nextAttempts,
          last_attempted_at: now,
          abort_requested_at: null,
        })
        .eq("id", jobDetails.id)
        .eq("queue", this.queueName);
      query = this.applyPrefixFilters(query);
      const { error } = await query;
      if (error) throw error;
      return;
    }

    if (jobDetails.status === JobStatus.COMPLETED || jobDetails.status === JobStatus.FAILED) {
      let query = this.client
        .from(this.tableName)
        .update({
          output: jobDetails.output ?? null,
          error: jobDetails.error ?? null,
          error_code: jobDetails.error_code ?? null,
          status: jobDetails.status,
          progress: 100,
          progress_message: "",
          progress_details: null,
          attempts: nextAttempts,
          completed_at: now,
          last_attempted_at: now,
        })
        .eq("id", jobDetails.id)
        .eq("queue", this.queueName);
      query = this.applyPrefixFilters(query);
      const { error } = await query;
      if (error) throw error;
      return;
    }

    // Transitional states (e.g. PROCESSING) — increment attempts like other stores
    let query = this.client
      .from(this.tableName)
      .update({
        status: jobDetails.status,
        output: jobDetails.output ?? null,
        error: jobDetails.error ?? null,
        error_code: jobDetails.error_code ?? null,
        visible_at: jobDetails.visible_at ?? null,
        attempts: nextAttempts,
        last_attempted_at: now,
      })
      .eq("id", jobDetails.id)
      .eq("queue", this.queueName);
    query = this.applyPrefixFilters(query);
    const { error } = await query;
    if (error) throw error;
  }

  /**
   * Releases a claimed job without consuming a retry attempt.
   */
  public async releaseClaim(jobId: unknown): Promise<void> {
    // releaseClaim returns the row to PENDING without consuming an attempt.
    // Clear abort_requested_at so an abort that was requested mid-claim does
    // not survive the release and immediately cancel the next claim.
    let query = this.client
      .from(this.tableName)
      .update({
        status: JobStatus.PENDING,
        lease_owner: null,
        progress: 0,
        progress_message: "",
        progress_details: null,
        abort_requested_at: null,
      })
      .eq("id", jobId)
      .eq("queue", this.queueName);

    query = this.applyPrefixFilters(query);
    const { error } = await query;
    if (error) throw error;
  }

  /**
   * Terminal write that does NOT bump `attempts`. See IQueueStorage.finalize
   * for the rationale (avoids double-counting on ack/fail because the lease
   * reclaim path already charged the attempt at next() time).
   */
  public async finalize(id: unknown, fields: QueueFinalizeFields<Output>): Promise<void> {
    // Partial update — Supabase's PostgREST `update()` only writes the
    // properties present on the object passed in.
    const patch = this.finalizePatch(fields);
    if (Object.keys(patch).length === 0) return;
    let query = this.client
      .from(this.tableName)
      .update(patch)
      .eq("id", id as never)
      .eq("queue", this.queueName);
    query = this.applyPrefixFilters(query);
    const { error } = await query;
    if (error) throw error;
  }

  /**
   * {@link finalize} fenced to one claim: the ownership predicate rides on the
   * UPDATE's filters, so a reclaim can never interleave between the check and
   * the write. `attempts` is matched by the same filters, which is what makes
   * writing `fence.attempts + 1` an atomic increment.
   */
  public async finalizeClaim(
    id: unknown,
    fence: ClaimFence,
    fields: ClaimFinalizeFields<Output>
  ): Promise<boolean> {
    const patch = this.finalizePatch(fields);
    if ("lease_expires_at" in fields) patch.lease_expires_at = fields.lease_expires_at ?? null;
    if (fields.incrementAttempts === true) patch.attempts = fence.attempts + 1;
    // An empty write still has to answer whether the claim holds the row.
    if (Object.keys(patch).length === 0) patch.lease_owner = fence.leaseOwner;
    let query = this.client
      .from(this.tableName)
      .update(patch)
      .eq("id", id as never)
      .eq("queue", this.queueName)
      .eq("status", JobStatus.PROCESSING)
      .eq("lease_owner", fence.leaseOwner);
    // `attempts` is nullable, and a NULL reads as 0 everywhere else, `extendLease`
    // included, so a fence at 0 has to hold a NULL row too.
    query =
      fence.attempts === 0
        ? query.or("attempts.eq.0,attempts.is.null")
        : query.eq("attempts", fence.attempts);
    query = this.applyPrefixFilters(query);
    const { data, error } = await query.select("id").maybeSingle();
    if (error) throw error;
    return data != null;
  }

  private finalizePatch(fields: QueueFinalizeFields<Output>): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if ("output" in fields) patch.output = fields.output ?? null;
    if ("error" in fields) patch.error = fields.error ?? null;
    if ("error_code" in fields) patch.error_code = fields.error_code ?? null;
    if ("status" in fields) patch.status = fields.status;
    if ("completed_at" in fields) patch.completed_at = fields.completed_at ?? null;
    if ("abort_requested_at" in fields) {
      patch.abort_requested_at = fields.abort_requested_at ?? null;
    }
    if ("lease_owner" in fields) patch.lease_owner = fields.lease_owner ?? null;
    if ("progress" in fields) patch.progress = fields.progress ?? 0;
    if ("progress_message" in fields) patch.progress_message = fields.progress_message ?? "";
    if ("progress_details" in fields) patch.progress_details = fields.progress_details ?? null;
    if ("visible_at" in fields) patch.visible_at = fields.visible_at ?? null;
    return patch;
  }

  /**
   * Clears all jobs from the queue.
   */
  public async deleteAll(): Promise<void> {
    let query = this.client.from(this.tableName).delete().eq("queue", this.queueName);
    query = this.applyPrefixFilters(query);
    const { error } = await query;

    if (error) throw error;
  }

  /**
   * Looks up cached output for a given input
   * Uses input fingerprinting for efficient matching
   * @returns The cached output or null if not found
   */
  public async outputForInput(input: Input): Promise<Output | null> {
    const fingerprint = await makeFingerprint(input);

    let query = this.client
      .from(this.tableName)
      .select("output")
      .eq("fingerprint", fingerprint)
      .eq("queue", this.queueName)
      .eq("status", JobStatus.COMPLETED);

    query = this.applyPrefixFilters(query);

    const { data, error } = await query.single();

    if (error) {
      if (error.code === "PGRST116") return null; // Not found
      throw error;
    }

    return data?.output ?? null;
  }

  /**
   * Aborts a job.
   * - If PENDING: immediately mark as FAILED with abort_requested_at set.
   * - If PROCESSING: set abort_requested_at only (leave status as PROCESSING).
   * - Otherwise: no-op.
   */
  public async abort(jobId: unknown): Promise<void> {
    const now = new Date().toISOString();

    // Abort PENDING → FAILED immediately
    {
      let query = this.client
        .from(this.tableName)
        .update({
          status: JobStatus.FAILED,
          abort_requested_at: now,
          completed_at: now,
        })
        .eq("id", jobId)
        .eq("queue", this.queueName)
        .eq("status", JobStatus.PENDING);
      query = this.applyPrefixFilters(query);
      const { error } = await query;
      if (error) throw error;
    }

    // Abort PROCESSING → set abort_requested_at only
    {
      let query = this.client
        .from(this.tableName)
        .update({ abort_requested_at: now })
        .eq("id", jobId)
        .eq("queue", this.queueName)
        .eq("status", JobStatus.PROCESSING);
      query = this.applyPrefixFilters(query);
      const { error } = await query;
      if (error) throw error;
    }
  }

  /** Force-overwrite status without touching attempts (used to persist DISABLED after lease release). */
  public async saveStatus(jobId: unknown, status: string): Promise<void> {
    let query = this.client
      .from(this.tableName)
      .update({ status })
      .eq("id", jobId)
      .eq("queue", this.queueName);
    query = this.applyPrefixFilters(query as any) as any;
    const { error } = await (query as any);
    if (error) throw error;
  }

  /**
   * Retrieves all jobs for a given job run ID.
   * @param job_run_id - The ID of the job run to retrieve
   * @returns An array of jobs
   */
  public async getByRunId(job_run_id: string): Promise<Array<JobStorageFormat<Input, Output>>> {
    let query = this.client
      .from(this.tableName)
      .select("*")
      .eq("job_run_id", job_run_id)
      .eq("queue", this.queueName);

    query = this.applyPrefixFilters(query);
    const { data, error } = await query;

    if (error) throw error;
    return (data as Array<JobStorageFormat<Input, Output>>) ?? [];
  }

  /**
   * Implements the saveProgress method
   */
  public async saveProgress(
    jobId: unknown,
    progress: number,
    message: string,
    details: Record<string, any> | null
  ): Promise<void> {
    let query = this.client
      .from(this.tableName)
      .update({
        progress,
        progress_message: message,
        progress_details: details,
      })
      .eq("id", jobId)
      .eq("queue", this.queueName);

    query = this.applyPrefixFilters(query);
    const { error } = await query;

    if (error) throw error;
  }

  /**
   * Deletes a job by its ID
   */
  public async delete(jobId: unknown): Promise<void> {
    let query = this.client
      .from(this.tableName)
      .delete()
      .eq("id", jobId)
      .eq("queue", this.queueName);

    query = this.applyPrefixFilters(query);
    const { error } = await query;

    if (error) throw error;
  }

  /**
   * Finds the most recent active (PENDING or PROCESSING) job with the given fingerprint in this queue.
   * Uses the partial index idx_<table>_fingerprint_active for O(1) lookup.
   */
  public async findActiveByFingerprint(
    fingerprint: string,
    queueName: string
  ): Promise<JobStorageFormat<Input, Output> | undefined> {
    const prefixConditions = this.buildPrefixWhereSql();
    const validatedQueueName = this.validateSqlValue(queueName, "queueName");
    const escapedQueueName = this.escapeSqlString(validatedQueueName);
    const escapedFingerprint = this.escapeSqlString(fingerprint);

    const sql = `
      SELECT * FROM ${this.tableName}
        WHERE fingerprint = '${escapedFingerprint}' AND queue = '${escapedQueueName}'
          AND status IN ('PENDING','PROCESSING')${prefixConditions}
        ORDER BY created_at DESC
        LIMIT 1`;

    const { data, error } = await this.client.rpc("exec_sql", { query: sql });
    if (error) throw error;
    if (!data || !Array.isArray(data) || data.length === 0) return undefined;
    return data[0] as JobStorageFormat<Input, Output>;
  }

  /**
   * Retrieves multiple jobs by their IDs in a single query.
   * Returns results in the same order as the input ids array, with undefined for missing ids.
   */
  public async getMany(
    ids: readonly unknown[]
  ): Promise<Array<JobStorageFormat<Input, Output> | undefined>> {
    if (ids.length === 0) return [];

    let query = this.client
      .from(this.tableName)
      .select("*")
      .in("id", ids as any[])
      .eq("queue", this.queueName);
    query = this.applyPrefixFilters(query);
    const { data, error } = await query;
    if (error) throw error;

    const map = new Map<unknown, JobStorageFormat<Input, Output>>();
    for (const row of (data ?? []) as JobStorageFormat<Input, Output>[]) {
      map.set(row.id, row);
    }
    return ids.map((id) => map.get(id));
  }

  /**
   * Atomically writes output and sets status=COMPLETED.
   */
  public async completeWithResult(id: unknown, result: Output): Promise<void> {
    const now = new Date().toISOString();
    let query = this.client
      .from(this.tableName)
      .update({
        output: result ?? null,
        status: "COMPLETED" as JobStatus,
        progress: 100,
        progress_message: "",
        progress_details: null,
        completed_at: now,
      })
      .eq("id", id as never)
      .eq("queue", this.queueName);
    query = this.applyPrefixFilters(query);
    const { error } = await query;
    if (error) throw error;
  }

  /**
   * Atomically writes error fields and sets status=FAILED.
   * Preserves existing error/error_code when opts fields are absent.
   */
  public async failWithError(
    id: unknown,
    opts: {
      readonly error?: string | null;
      readonly errorCode?: string | null;
      readonly abortRequested?: boolean;
    }
  ): Promise<void> {
    // For Supabase's PostgREST API, COALESCE isn't directly available — we use
    // raw SQL via exec_sql to preserve existing values when opts fields are absent.
    const numericId = Number(id);
    if (!Number.isFinite(numericId)) {
      throw new Error(`Invalid job id: ${String(id)}`);
    }
    const prefixConditions = this.buildPrefixWhereSql();
    const validatedQueueName = this.validateSqlValue(this.queueName, "queueName");
    const escapedQueueName = this.escapeSqlString(validatedQueueName);

    const errorLiteral =
      "error" in opts
        ? opts.error != null
          ? `'${this.escapeSqlString(opts.error)}'`
          : "NULL"
        : "NULL";
    const errorCodeLiteral =
      "errorCode" in opts
        ? opts.errorCode != null
          ? `'${this.escapeSqlString(opts.errorCode)}'`
          : "NULL"
        : "NULL";
    const abortClause =
      opts.abortRequested === true
        ? `CASE WHEN abort_requested_at IS NOT NULL THEN abort_requested_at ELSE NOW() AT TIME ZONE 'UTC' END`
        : `abort_requested_at`;

    const sql = `
      UPDATE ${this.tableName}
          SET error = COALESCE(${errorLiteral}, error),
              error_code = COALESCE(${errorCodeLiteral}, error_code),
              abort_requested_at = ${abortClause},
              status = 'FAILED',
              completed_at = COALESCE(completed_at, NOW() AT TIME ZONE 'UTC')
        WHERE id = ${numericId} AND queue = '${escapedQueueName}'${prefixConditions}`;

    const { error } = await this.client.rpc("exec_sql", { query: sql });
    if (error) throw error;
  }

  /**
   * Atomically writes status=DISABLED, releases the lease, clears progress
   * fields, and stamps `completed_at` (preserving an existing value via
   * COALESCE). Does NOT write error/error_code — DISABLED is not an error
   * transition.
   *
   * Implemented via `exec_sql` so the COALESCE on completed_at runs inside
   * the same UPDATE — PostgREST `.update()` cannot reference existing column
   * values, which would otherwise force a read-then-write and open a race
   * window with concurrent updates. Mirrors the {@link failWithError} pattern.
   */
  public async markDisabled(id: unknown): Promise<void> {
    const numericId = Number(id);
    if (!Number.isFinite(numericId)) {
      throw new Error(`Invalid job id: ${String(id)}`);
    }
    const prefixConditions = this.buildPrefixWhereSql();
    const validatedQueueName = this.validateSqlValue(this.queueName, "queueName");
    const escapedQueueName = this.escapeSqlString(validatedQueueName);

    const sql = `
      UPDATE ${this.tableName}
          SET status = 'DISABLED',
              completed_at = COALESCE(completed_at, NOW() AT TIME ZONE 'UTC'),
              lease_owner = NULL,
              progress = 0,
              progress_message = '',
              progress_details = NULL
        WHERE id = ${numericId} AND queue = '${escapedQueueName}'${prefixConditions}`;

    const { error } = await this.client.rpc("exec_sql", { query: sql });
    if (error) throw error;
  }

  /**
   * Delete jobs with a specific status older than a cutoff date
   * @param status - Status of jobs to delete
   * @param olderThanMs - Delete jobs completed more than this many milliseconds ago
   */
  public async deleteJobsByStatusAndAge(status: JobStatus, olderThanMs: number): Promise<void> {
    const cutoffDate = new Date(Date.now() - olderThanMs).toISOString();

    let query = this.client
      .from(this.tableName)
      .delete()
      .eq("queue", this.queueName)
      .eq("status", status)
      .not("completed_at", "is", null)
      .lte("completed_at", cutoffDate);

    query = this.applyPrefixFilters(query);
    const { error } = await query;

    if (error) throw error;
  }

  /**
   * Checks if a job from a realtime payload matches the specified prefix filter
   * @param job - The job record from the realtime payload
   * @param prefixFilter - The prefix filter to match against (undefined = use instance prefixes, {} = no filter)
   */
  private matchesPrefixFilter(
    job: Record<string, unknown> | undefined,
    prefixFilter?: Readonly<Record<string, string | number>>
  ): boolean {
    if (!job) return false;

    // Check queue name first
    if (job.queue !== this.queueName) {
      return false;
    }

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
    for (const [key, value] of Object.entries(filterValues)) {
      if (job[key] !== value) {
        return false;
      }
    }
    return true;
  }

  /**
   * Checks if a prefix filter is custom (different from instance's prefixes).
   */
  private isCustomPrefixFilter(prefixFilter?: Readonly<Record<string, string | number>>): boolean {
    // No filter specified - use instance prefixes (not custom)
    if (prefixFilter === undefined) {
      return false;
    }
    // Empty filter - receive all (custom)
    if (Object.keys(prefixFilter).length === 0) {
      return true;
    }
    // Check if filter matches instance prefixes exactly
    const instanceKeys = Object.keys(this.prefixValues);
    const filterKeys = Object.keys(prefixFilter);
    if (instanceKeys.length !== filterKeys.length) {
      return true; // Different number of keys = custom
    }
    for (const key of instanceKeys) {
      if (this.prefixValues[key] !== prefixFilter[key]) {
        return true; // Different value = custom
      }
    }
    return false; // Matches instance prefixes exactly
  }

  /**
   * Gets all jobs from the queue with a custom prefix filter.
   * Used for subscriptions with custom prefix filters (filters at DB level).
   *
   * @param prefixFilter - The prefix values to filter by (empty object = all jobs)
   * @returns A promise that resolves to an array of jobs
   */
  private async getAllJobsWithFilter(
    prefixFilter: Readonly<Record<string, string | number>>
  ): Promise<Array<JobStorageFormat<Input, Output>>> {
    let query = this.client.from(this.tableName).select("*").eq("queue", this.queueName);

    // Apply the custom prefix filter
    for (const [key, value] of Object.entries(prefixFilter)) {
      query = query.eq(key, value);
    }

    const { data, error } = await query;

    if (error) throw error;
    return (data ?? []) as Array<JobStorageFormat<Input, Output>>;
  }

  /**
   * Subscribes to changes in the queue.
   * Uses Supabase realtime by default.
   *
   * @param callback - Function called when a change occurs
   * @param options - Subscription options including prefix filter
   * @returns Unsubscribe function
   */
  public subscribeToChanges(
    callback: (change: QueueChangePayload<Input, Output>) => void,
    options?: QueueSubscribeOptions
  ): () => void {
    return this.subscribeToChangesWithRealtime(callback, options?.prefixFilter);
  }

  /**
   * Subscribe using Supabase realtime (protected).
   *
   * @param callback - Function called when a change occurs
   * @param prefixFilter - Optional prefix filter (undefined = use instance prefixes, {} = no filter)
   * @returns Unsubscribe function
   */
  protected subscribeToChangesWithRealtime(
    callback: (change: QueueChangePayload<Input, Output>) => void,
    prefixFilter?: Readonly<Record<string, string | number>>
  ): () => void {
    const channelName = `queue-${this.tableName}-${this.queueName}-${Date.now()}`;

    this.realtimeChannel = this.client
      .channel(channelName)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: this.tableName,
          filter: `queue=eq.${this.queueName}`,
        },
        (payload) => {
          // Filter by prefix values
          const newJob = payload.new as Record<string, unknown> | undefined;
          const oldJob = payload.old as Record<string, unknown> | undefined;

          // Check if either old or new job matches the filter
          const newMatches = this.matchesPrefixFilter(newJob, prefixFilter);
          const oldMatches = this.matchesPrefixFilter(oldJob, prefixFilter);

          if (!newMatches && !oldMatches) {
            return;
          }

          callback({
            type: payload.eventType.toUpperCase() as QueueChangeType,
            old:
              oldJob && Object.keys(oldJob).length > 0
                ? (oldJob as JobStorageFormat<Input, Output>)
                : undefined,
            new:
              newJob && Object.keys(newJob).length > 0
                ? (newJob as JobStorageFormat<Input, Output>)
                : undefined,
          });
        }
      )
      .subscribe();

    return () => {
      if (this.realtimeChannel) {
        // Normalized rather than chained directly: the client type says this
        // returns a promise, but not every client implementation does, and a
        // teardown must not throw on the way out.
        Promise.resolve(this.client.removeChannel(this.realtimeChannel)).catch((error: unknown) => {
          getLogger().warn("Failed to remove Supabase realtime channel", { error });
        });
        this.realtimeChannel = null;
      }
    };
  }

  /**
   * Gets or creates the shared polling subscription manager for normal subscriptions (fallback).
   * This ensures all normal subscriptions share a single polling loop per interval.
   */
  private getPollingManager(): PollingSubscriptionManager<
    JobStorageFormat<Input, Output>,
    unknown,
    QueueChangePayload<Input, Output>
  > {
    if (!this.pollingManager) {
      this.pollingManager = new PollingSubscriptionManager<
        JobStorageFormat<Input, Output>,
        unknown,
        QueueChangePayload<Input, Output>
      >(
        async () => {
          // Fetch jobs with instance's prefix filter (efficient DB-level filtering)
          const jobs = await this.getAllJobs();
          return new Map(jobs.map((j) => [j.id, j]));
        },
        (a, b) => deepEqual(a, b),
        {
          insert: (item) => ({ type: "INSERT" as const, new: item }),
          update: (oldItem, newItem) => ({ type: "UPDATE" as const, old: oldItem, new: newItem }),
          delete: (item) => ({ type: "DELETE" as const, old: item }),
        }
      );
    }
    return this.pollingManager;
  }

  /**
   * Creates a dedicated polling subscription for custom prefix filters (fallback).
   * This runs separately from the normal polling manager with DB-level filtering.
   */
  private subscribeWithCustomPrefixFilterPolling(
    callback: (change: QueueChangePayload<Input, Output>) => void,
    prefixFilter: Readonly<Record<string, string | number>>,
    intervalMs: number
  ): () => void {
    let lastKnownJobs = new Map<unknown, JobStorageFormat<Input, Output>>();
    let cancelled = false;

    const poll = async () => {
      if (cancelled) return;
      try {
        const currentJobs = await this.getAllJobsWithFilter(prefixFilter);
        if (cancelled) return;
        const currentMap = new Map(currentJobs.map((j) => [j.id, j]));

        // Detect changes
        for (const [id, job] of currentMap) {
          const old = lastKnownJobs.get(id);
          if (!old) {
            callback({ type: "INSERT", new: job });
          } else if (!deepEqual(old, job)) {
            callback({ type: "UPDATE", old, new: job });
          }
        }

        for (const [id, job] of lastKnownJobs) {
          if (!currentMap.has(id)) {
            callback({ type: "DELETE", old: job });
          }
        }

        lastKnownJobs = currentMap;
      } catch {
        // Ignore polling errors
      }
    };

    const intervalId = setInterval(poll, intervalMs);
    void poll(); // Initial poll

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }

  /**
   * Subscribe using polling (protected, available as fallback).
   *
   * Normal subscriptions (no custom prefix filter) share a single polling loop for efficiency.
   * Custom prefix filter subscriptions get their own dedicated polling loop with DB-level filtering.
   *
   * @param callback - Function called when a change occurs
   * @param options - Subscription options including interval and prefix filter
   * @returns Unsubscribe function
   */
  protected subscribeToChangesWithPolling(
    callback: (change: QueueChangePayload<Input, Output>) => void,
    options?: QueueSubscribeOptions
  ): () => void {
    const intervalMs = options?.pollingIntervalMs ?? 1000;

    // Check if this is a custom prefix filter subscription
    if (this.isCustomPrefixFilter(options?.prefixFilter)) {
      // Custom prefix filter - use dedicated polling with DB-level filtering
      return this.subscribeWithCustomPrefixFilterPolling(
        callback,
        options!.prefixFilter!,
        intervalMs
      );
    }

    // Normal subscription - use shared polling manager (efficient)
    const manager = this.getPollingManager();
    return manager.subscribe(callback, { intervalMs });
  }
}
