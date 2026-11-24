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
import { HybridSubscriptionManager } from "@workglow/storage";
import { createServiceToken, deepEqual, getLogger, makeFingerprint, uuid4 } from "@workglow/util";
import { IndexedDbMigrationRunner } from "../migrations/IndexedDbMigrationRunner";
import { indexedDbQueueMigrations } from "../migrations/indexedDbQueueMigrations";
import { openIdb } from "../storage/openIdb";

export const INDEXED_DB_QUEUE_STORAGE = createServiceToken<IQueueStorage<any, any>>(
  "jobqueue.storage.indexedDb"
);

export interface IndexedDbQueueStorageOptions extends QueueStorageOptions {
  /** Enable BroadcastChannel notifications (default: true) */
  readonly useBroadcastChannel?: boolean;
  /** Backup polling interval in ms (default: 5000, 0 to disable) */
  readonly backupPollingIntervalMs?: number;
}

export class IndexedDbQueueStorage<Input, Output> implements IQueueStorage<Input, Output> {
  public readonly scope = "process" as const;
  private db: IDBDatabase | undefined;
  private readonly tableName: string;
  protected readonly prefixes: readonly PrefixColumn[];
  protected readonly prefixValues: Readonly<Record<string, string | number>>;
  private hybridManager: HybridSubscriptionManager<
    JobStorageFormat<Input, Output>,
    unknown,
    QueueChangePayload<Input, Output>
  > | null = null;
  private readonly hybridOptions: {
    readonly useBroadcastChannel: boolean;
    readonly backupPollingIntervalMs: number;
  };

  constructor(
    public readonly queueName: string,
    options: IndexedDbQueueStorageOptions = {}
  ) {
    this.prefixes = options.prefixes ?? [];
    this.prefixValues = options.prefixValues ?? {};
    this.hybridOptions = {
      useBroadcastChannel: options.useBroadcastChannel ?? true,
      backupPollingIntervalMs: options.backupPollingIntervalMs ?? 5000,
    };
    // Table name varies by prefix configuration to avoid conflicts
    if (this.prefixes.length > 0) {
      const prefixNames = this.prefixes.map((p) => p.name).join("_");
      this.tableName = `jobs_${prefixNames}`;
    } else {
      this.tableName = "jobs";
    }
  }

  private matchesPrefixes(job: JobStorageFormat<Input, Output> & Record<string, unknown>): boolean {
    for (const [key, value] of Object.entries(this.prefixValues)) {
      if (job[key] !== value) {
        return false;
      }
    }
    return true;
  }

  /** Prefix values as an array in column order for index key construction. */
  private getPrefixKeyValues(): Array<string | number> {
    return this.prefixes.map((p) => this.prefixValues[p.name]);
  }

  private async getDb(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    await this.migrate();
    return this.db!;
  }

  /**
   * Returns the versioned migrations that this storage's object store +
   * indexes depend on. Callers can compose them with other storages'
   * migrations under a shared {@link IndexedDbMigrationRunner}; otherwise
   * call {@link migrate}.
   */
  public getMigrations() {
    return indexedDbQueueMigrations(this.tableName, this.prefixes);
  }

  /**
   * Applies any pending migrations for this queue's IndexedDB database, then
   * opens a long-lived connection at the migrated version. Idempotent — a
   * second call closes any prior handle (so it doesn't pin the
   * pre-migration version or block another tab's upgrade), reruns the
   * runner (no-op if the bookkeeping store says everything is applied), and
   * reopens the connection.
   */
  public async migrate(): Promise<void> {
    if (this.db) {
      try {
        this.db.close();
      } catch {
        // ignore — close is best-effort
      }
      this.db = undefined;
    }
    const runner = new IndexedDbMigrationRunner(this.tableName);
    await runner.run(this.getMigrations());
    this.db = await openIdb(this.tableName);
  }

  public async add(job: JobStorageFormat<Input, Output>): Promise<unknown> {
    const db = await this.getDb();
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

    const tx = db.transaction(this.tableName, "readwrite");
    const store = tx.objectStore(this.tableName);

    return new Promise((resolve, reject) => {
      const request = store.add(jobWithPrefixes);

      tx.oncomplete = () => {
        this.hybridManager?.notifyLocalChange();
        resolve(jobWithPrefixes.id);
      };
      tx.onerror = () => reject(tx.error);
      request.onerror = () => reject(request.error);
    });
  }

  async get(id: unknown): Promise<JobStorageFormat<Input, Output> | undefined> {
    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readonly");
    const store = tx.objectStore(this.tableName);
    const request = store.get(id as string);
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const job = request.result as
          | (JobStorageFormat<Input, Output> & Record<string, unknown>)
          | undefined;
        if (job && job.queue === this.queueName && this.matchesPrefixes(job)) {
          resolve(job);
        } else {
          resolve(undefined);
        }
      };
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  public async peek(
    status: JobStatus = JobStatus.PENDING,
    num: number = 100
  ): Promise<JobStorageFormat<Input, Output>[]> {
    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readonly");
    const store = tx.objectStore(this.tableName);
    const index = store.index("queue_status_visible_at");
    const prefixKeyValues = this.getPrefixKeyValues();

    return new Promise((resolve, reject) => {
      const ret = new Map<unknown, JobStorageFormat<Input, Output>>();
      const keyRange = IDBKeyRange.bound(
        [...prefixKeyValues, this.queueName, status, ""],
        [...prefixKeyValues, this.queueName, status, "\uffff"]
      );
      const cursorRequest = index.openCursor(keyRange);

      const handleCursor = (e: Event) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
        if (!cursor || ret.size >= num) {
          resolve(Array.from(ret.values()));
          return;
        }
        const job = cursor.value as JobStorageFormat<Input, Output> & Record<string, unknown>;
        // Map keyed by id ensures no duplicates
        if (this.matchesPrefixes(job)) {
          ret.set(cursor.value.id, cursor.value);
        }
        cursor.continue();
      };

      cursorRequest.onsuccess = handleCursor;
      cursorRequest.onerror = () => reject(cursorRequest.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Retrieves the next job from the queue using optimistic locking.
   * Claims PENDING jobs ready to run, and also reclaims PROCESSING jobs whose
   * lease has expired (crash recovery). Sets lease_expires_at on the claimed row.
   *
   * IndexedDB uses snapshot isolation, so concurrent transactions can both see the same
   * PENDING job. To prevent processing the same job multiple times, this method:
   * 1. Claims a job by setting it to PROCESSING with a unique claim token
   * 2. After the transaction completes, re-reads the job to verify the claim succeeded
   * 3. If another worker claimed it first (different claim token), returns undefined
   *
   * @param workerId - Worker ID to associate with the job (required)
   * @param opts - Optional options including leaseMs (default 30000)
   * @returns A promise that resolves to the next job or undefined if the queue is empty.
   */
  public async next(
    workerId: string,
    opts?: { leaseMs?: number }
  ): Promise<JobStorageFormat<Input, Output> | undefined> {
    const leaseMs = opts?.leaseMs ?? 30000;
    validateLeaseMs(leaseMs, "leaseMs");
    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readwrite");
    const store = tx.objectStore(this.tableName);
    const now = new Date().toISOString();
    const leaseExpiry = new Date(Date.now() + leaseMs).toISOString();
    const prefixKeyValues = this.getPrefixKeyValues();

    // Used after the tx to verify we actually won the race to claim this job.
    const claimToken = workerId;

    const jobToReturn = await new Promise<JobStorageFormat<Input, Output> | undefined>(
      (resolve, reject) => {
        let claimedJob: JobStorageFormat<Input, Output> | undefined;

        const tryClaimJob = (job: JobStorageFormat<Input, Output> & Record<string, unknown>) => {
          // Lease-expiry reclaim consumes one attempt against max_attempts;
          // a fresh PENDING claim does not (the worker's validateJobState
          // FAILs the job when attempts >= max_attempts on the next step).
          const isLeaseExpiryReclaim = job.status === JobStatus.PROCESSING;
          job.status = JobStatus.PROCESSING;
          job.last_attempted_at = now;
          job.lease_owner = claimToken;
          job.lease_expires_at = leaseExpiry;
          if (isLeaseExpiryReclaim) {
            job.attempts = ((job.attempts as number | undefined) ?? 0) + 1;
          }
          // Always clear stale abort_requested_at on (re)claim. A PROCESSING
          // row may have had abort_requested_at set before the previous
          // worker crashed; the new owner must start with a clean slate.
          job.abort_requested_at = null;

          try {
            const updateRequest = store.put(job);
            updateRequest.onsuccess = () => {
              claimedJob = job;
            };
            updateRequest.onerror = () => {};
          } catch {
            // ignore
          }
        };

        const pendingIndex = store.index("queue_status_visible_at");
        const pendingRequest = pendingIndex.openCursor(
          IDBKeyRange.bound(
            [...prefixKeyValues, this.queueName, JobStatus.PENDING, ""],
            [...prefixKeyValues, this.queueName, JobStatus.PENDING, now],
            false,
            false
          )
        );

        pendingRequest.onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
          if (!cursor) {
            // No PENDING job found — try expired-lease PROCESSING job
            if (!claimedJob) {
              tryExpiredLeaseScan();
            }
            return;
          }
          const job = cursor.value as JobStorageFormat<Input, Output> & Record<string, unknown>;
          if (
            job.queue !== this.queueName ||
            job.status !== JobStatus.PENDING ||
            !this.matchesPrefixes(job)
          ) {
            cursor.continue();
            return;
          }
          tryClaimJob(job);
          // Don't continue cursor — claim attempted
        };

        pendingRequest.onerror = () => reject(pendingRequest.error);

        const tryExpiredLeaseScan = () => {
          const processingIndex = store.index("queue_status_visible_at");
          const processingRequest = processingIndex.openCursor(
            IDBKeyRange.bound(
              [...prefixKeyValues, this.queueName, JobStatus.PROCESSING, ""],
              [...prefixKeyValues, this.queueName, JobStatus.PROCESSING, "￿"],
              false,
              false
            )
          );

          processingRequest.onsuccess = (e) => {
            const cursor = (e.target as IDBRequest<IDBCursorWithValue>).result;
            if (!cursor) return; // none found, tx.oncomplete will resolve with undefined
            const job = cursor.value as JobStorageFormat<Input, Output> & Record<string, unknown>;
            if (
              job.queue !== this.queueName ||
              job.status !== JobStatus.PROCESSING ||
              !this.matchesPrefixes(job)
            ) {
              cursor.continue();
              return;
            }
            // null lease_expires_at = expired per spec
            if (job.lease_expires_at && job.lease_expires_at >= now) {
              cursor.continue();
              return;
            }
            tryClaimJob(job);
          };

          processingRequest.onerror = () => reject(processingRequest.error);
        };

        tx.oncomplete = () => {
          if (claimedJob) {
            this.hybridManager?.notifyLocalChange();
          }
          resolve(claimedJob);
        };
        tx.onerror = () => reject(tx.error);
      }
    );

    if (!jobToReturn) {
      return undefined;
    }

    // Verify we actually won the race by re-reading the job
    const verifiedJob = await this.get(jobToReturn.id);

    if (!verifiedJob) {
      return undefined;
    }

    if (verifiedJob.lease_owner !== claimToken) {
      return undefined;
    }

    if (verifiedJob.status !== JobStatus.PROCESSING) {
      return undefined;
    }

    return verifiedJob;
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
    const extended = await this.updateIf(id, (job) => {
      if (
        job.status !== JobStatus.PROCESSING ||
        job.lease_owner !== workerId ||
        (attempts !== undefined && (job.attempts ?? 0) !== attempts)
      ) {
        return false;
      }
      job.lease_expires_at = new Date(Date.now() + ms).toISOString();
      return true;
    });
    if (!extended) {
      throw new LeaseLostError(
        `extendLease failed: job ${String(id)} is not PROCESSING or lease is not owned by worker ${workerId}`
      );
    }
  }

  public async size(status = JobStatus.PENDING): Promise<number> {
    const db = await this.getDb();
    const prefixKeyValues = this.getPrefixKeyValues();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.tableName, "readonly");
      const store = tx.objectStore(this.tableName);
      const index = store.index("queue_status");
      const keyRange = IDBKeyRange.only([...prefixKeyValues, this.queueName, status]);
      const request = index.count(keyRange);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  public async complete(job: JobStorageFormat<Input, Output>): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readwrite");
    const store = tx.objectStore(this.tableName);

    return new Promise((resolve, reject) => {
      const getReq = store.get(job.id as string);
      getReq.onsuccess = () => {
        const existing = getReq.result as
          | (JobStorageFormat<Input, Output> & Record<string, unknown>)
          | undefined;
        if (!existing || existing.queue !== this.queueName || !this.matchesPrefixes(existing)) {
          // Contract: complete() must silently no-op (not throw) when the row is
          // missing or belongs to another queue. Lease-expiry races can legitimately
          // make the target row disappear between claim and complete, so the
          // transaction is allowed to commit with no write and resolve.
          return;
        }
        const currentAttempts = existing.attempts ?? 0;
        job.attempts = currentAttempts + 1;
        // PENDING-retry / terminal completion: always clear
        // abort_requested_at so a flag set DURING the attempt does not
        // survive into the next retry and immediately cancel it.
        const jobAsRecord = job as JobStorageFormat<Input, Output> & Record<string, unknown>;
        jobAsRecord.abort_requested_at = null;
        job.queue = this.queueName;

        const jobWithPrefixes = jobAsRecord;
        for (const [key, value] of Object.entries(this.prefixValues)) {
          jobWithPrefixes[key] = value;
        }

        const putReq = store.put(jobWithPrefixes);
        putReq.onsuccess = () => {};
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);

      tx.oncomplete = () => {
        this.hybridManager?.notifyLocalChange();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  public async releaseClaim(id: unknown): Promise<void> {
    const job = await this.get(id);
    if (!job) return;

    job.status = JobStatus.PENDING;
    job.lease_owner = null;
    job.progress = 0;
    job.progress_message = "";
    job.progress_details = null;
    // Clear stale abort_requested_at — an abort flag set during the previous
    // claim must not immediately cancel the next worker that picks up the row.
    (job as unknown as Record<string, unknown>).abort_requested_at = null;

    await this.put(job);
  }

  /**
   * Aborts a job.
   * - If PENDING: immediately mark as FAILED with abort_requested_at set.
   * - If PROCESSING: set abort_requested_at only (leave status as PROCESSING).
   * - Otherwise: no-op.
   */
  public async abort(id: unknown): Promise<void> {
    const job = await this.get(id);
    if (!job) return;
    const now = new Date().toISOString();
    if (job.status === JobStatus.PENDING) {
      job.status = JobStatus.FAILED;
      job.abort_requested_at = now;
      job.completed_at = now;
      // Use put() (not complete()) so attempts is NOT bumped — the worker
      // never actually attempted this job. Matches the cross-backend
      // contract verified in InMemory/Postgres.
      await this.put(job);
    } else if (job.status === JobStatus.PROCESSING) {
      job.abort_requested_at = now;
      await this.put(job);
    }
  }

  /** Force-overwrite status without touching attempts (used to persist DISABLED after lease release). */
  public async saveStatus(id: unknown, status: string): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readwrite");
    const store = tx.objectStore(this.tableName);
    const getRequest = store.get(id as IDBValidKey);
    return new Promise((resolve, reject) => {
      getRequest.onsuccess = () => {
        const record = getRequest.result;
        if (!record) {
          resolve();
          return;
        }
        const putRequest = store.put({ ...record, status });
        putRequest.onsuccess = () => resolve();
        putRequest.onerror = () => reject(putRequest.error);
      };
      getRequest.onerror = () => reject(getRequest.error);
    });
  }

  public async getByRunId(job_run_id: string): Promise<JobStorageFormat<Input, Output>[]> {
    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readonly");
    const store = tx.objectStore(this.tableName);
    const index = store.index("queue_job_run_id");
    const prefixKeyValues = this.getPrefixKeyValues();
    const keyRange = IDBKeyRange.only([...prefixKeyValues, this.queueName, job_run_id]);
    const request = index.getAll(keyRange);

    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const results = (request.result || []).filter(
          (job: JobStorageFormat<Input, Output> & Record<string, unknown>) =>
            this.matchesPrefixes(job)
        );
        resolve(results);
      };
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Terminal write that does NOT bump `attempts`. See IQueueStorage.finalize
   * for the rationale (avoids double-counting on ack/fail).
   */
  public async finalize(id: unknown, fields: QueueFinalizeFields<Output>): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return;
    this.applyFinalizeFields(existing, fields);
    await this.put(existing);
  }

  /**
   * {@link finalize} fenced to one claim. The ownership check and the write
   * share one readwrite transaction, which IndexedDB serializes against every
   * other readwrite transaction on the store, so no reclaim can land between
   * them — even from another tab.
   */
  public async finalizeClaim(
    id: unknown,
    fence: ClaimFence,
    fields: ClaimFinalizeFields<Output>
  ): Promise<boolean> {
    return this.updateIf(id, (job) => {
      if (
        job.status !== JobStatus.PROCESSING ||
        job.lease_owner !== fence.leaseOwner ||
        (job.attempts ?? 0) !== fence.attempts
      ) {
        return false;
      }
      this.applyFinalizeFields(job, fields);
      if ("lease_expires_at" in fields) job.lease_expires_at = fields.lease_expires_at ?? null;
      if (fields.incrementAttempts === true) job.attempts = (job.attempts ?? 0) + 1;
      return true;
    });
  }

  private applyFinalizeFields(
    job: JobStorageFormat<Input, Output>,
    fields: QueueFinalizeFields<Output>
  ): void {
    const updated = job as JobStorageFormat<Input, Output> & Record<string, unknown>;
    if ("output" in fields) updated.output = fields.output ?? null;
    if ("error" in fields) updated.error = fields.error ?? null;
    if ("error_code" in fields) updated.error_code = fields.error_code ?? null;
    if ("status" in fields) updated.status = fields.status;
    if ("completed_at" in fields) updated.completed_at = fields.completed_at ?? null;
    if ("abort_requested_at" in fields) {
      updated.abort_requested_at = fields.abort_requested_at ?? null;
    }
    if ("lease_owner" in fields) updated.lease_owner = fields.lease_owner ?? null;
    if ("progress" in fields) updated.progress = fields.progress ?? 0;
    if ("progress_message" in fields) updated.progress_message = fields.progress_message ?? "";
    if ("progress_details" in fields) updated.progress_details = fields.progress_details ?? null;
    if ("visible_at" in fields) updated.visible_at = fields.visible_at ?? null;
  }

  /**
   * Read a row and write it back in ONE readwrite transaction, only when
   * `mutate` (which edits the row in place) returns true. Resolves whether a
   * write happened; a missing row, or one of another queue or prefix, is not
   * written.
   */
  private async updateIf(
    id: unknown,
    mutate: (job: JobStorageFormat<Input, Output> & Record<string, unknown>) => boolean
  ): Promise<boolean> {
    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readwrite");
    const store = tx.objectStore(this.tableName);
    return new Promise((resolve, reject) => {
      let written = false;
      const getReq = store.get(id as string);
      getReq.onsuccess = () => {
        const existing = getReq.result as
          | (JobStorageFormat<Input, Output> & Record<string, unknown>)
          | undefined;
        if (!existing || existing.queue !== this.queueName || !this.matchesPrefixes(existing)) {
          return;
        }
        if (!mutate(existing)) return;
        const putReq = store.put(existing);
        putReq.onsuccess = () => {
          written = true;
        };
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
      tx.oncomplete = () => {
        if (written) this.hybridManager?.notifyLocalChange();
        resolve(written);
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  /**
   * Atomically writes status=DISABLED, releases the lease, clears progress
   * fields, and stamps completed_at (preserving an existing value). IDB
   * is single-threaded per-origin within a JS context, so the get + finalize
   * pair is observably atomic — no other transaction can interleave between
   * them inside this microtask chain.
   */
  public async markDisabled(id: unknown): Promise<void> {
    const existing = await this.get(id);
    if (!existing) return;
    const completedAt = existing.completed_at ?? new Date().toISOString();
    await this.finalize(id, {
      status: JobStatus.DISABLED,
      completed_at: completedAt,
      lease_owner: null,
      progress: 0,
      progress_message: "",
      progress_details: null,
    });
  }

  public async deleteAll(): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readwrite");
    const store = tx.objectStore(this.tableName);
    const index = store.index("queue_status");
    const prefixKeyValues = this.getPrefixKeyValues();

    return new Promise((resolve, reject) => {
      const keyRange = IDBKeyRange.bound(
        [...prefixKeyValues, this.queueName, ""],
        [...prefixKeyValues, this.queueName, "\uffff"]
      );
      const request = index.openCursor(keyRange);

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const job = cursor.value as JobStorageFormat<Input, Output> & Record<string, unknown>;
          if (job.queue === this.queueName && this.matchesPrefixes(job)) {
            const deleteRequest = cursor.delete();
            deleteRequest.onsuccess = () => {
              cursor.continue();
            };
            deleteRequest.onerror = () => {
              cursor.continue();
            };
          } else {
            cursor.continue();
          }
        }
      };

      tx.oncomplete = () => {
        this.hybridManager?.notifyLocalChange();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      request.onerror = () => reject(request.error);
    });
  }

  public async outputForInput(input: Input): Promise<Output | null> {
    const fingerprint = await makeFingerprint(input);
    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readonly");
    const store = tx.objectStore(this.tableName);
    const index = store.index("queue_fingerprint_status");
    const prefixKeyValues = this.getPrefixKeyValues();
    const request = index.get([
      ...prefixKeyValues,
      this.queueName,
      fingerprint,
      JobStatus.COMPLETED,
    ]);

    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const job = request.result as
          | (JobStorageFormat<Input, Output> & Record<string, unknown>)
          | undefined;
        if (job && this.matchesPrefixes(job)) {
          resolve(job.output ?? null);
        } else {
          resolve(null);
        }
      };
      request.onerror = () => reject(request.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  public async saveProgress(
    id: unknown,
    progress: number,
    message: string,
    details: Record<string, any> | null
  ): Promise<void> {
    const job = await this.get(id);
    if (!job) {
      // Contract: progress updates for a missing job silently no-op — the job may
      // have already completed/been removed, or a lease-expiry race removed it.
      getLogger().warn("Job not found for progress update", { id });
      return;
    }

    job.progress = progress;
    job.progress_message = message;
    job.progress_details = details;

    await this.put(job);
  }

  /**
   * Persists a job to the store without modifying attempts or other completion logic.
   */
  private async put(job: JobStorageFormat<Input, Output>): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readwrite");
    const store = tx.objectStore(this.tableName);

    job.queue = this.queueName;

    const jobWithPrefixes = job as JobStorageFormat<Input, Output> & Record<string, unknown>;
    for (const [key, value] of Object.entries(this.prefixValues)) {
      jobWithPrefixes[key] = value;
    }

    return new Promise((resolve, reject) => {
      const putReq = store.put(jobWithPrefixes);
      putReq.onerror = () => reject(putReq.error);
      tx.oncomplete = () => {
        this.hybridManager?.notifyLocalChange();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  public async delete(id: unknown): Promise<void> {
    const job = await this.get(id);
    if (!job) return;

    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readwrite");
    const store = tx.objectStore(this.tableName);
    const request = store.delete(id as string);

    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => {
        this.hybridManager?.notifyLocalChange();
      };
      tx.onerror = () => reject(tx.error);
    });
  }

  public async deleteJobsByStatusAndAge(status: JobStatus, olderThanMs: number): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readwrite");
    const store = tx.objectStore(this.tableName);
    const index = store.index("queue_status");
    const cutoffDate = new Date(Date.now() - olderThanMs).toISOString();
    const prefixKeyValues = this.getPrefixKeyValues();
    const keyRange = IDBKeyRange.only([...prefixKeyValues, this.queueName, status]);

    return new Promise((resolve, reject) => {
      const request = index.openCursor(keyRange);

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const job = cursor.value as JobStorageFormat<Input, Output> & Record<string, unknown>;
          if (
            job.queue === this.queueName &&
            this.matchesPrefixes(job) &&
            job.status === status &&
            job.completed_at &&
            job.completed_at <= cutoffDate
          ) {
            cursor.delete();
          }
          cursor.continue();
        }
      };

      tx.oncomplete = () => {
        this.hybridManager?.notifyLocalChange();
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      request.onerror = () => reject(request.error);
    });
  }

  private async getAllJobs(): Promise<Array<JobStorageFormat<Input, Output>>> {
    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readonly");
    const store = tx.objectStore(this.tableName);
    const index = store.index("queue_status");
    const prefixKeyValues = this.getPrefixKeyValues();

    return new Promise((resolve, reject) => {
      const jobs: Array<JobStorageFormat<Input, Output>> = [];
      const keyRange = IDBKeyRange.bound(
        [...prefixKeyValues, this.queueName, ""],
        [...prefixKeyValues, this.queueName, "\uffff"]
      );
      const request = index.openCursor(keyRange);

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const job = cursor.value as JobStorageFormat<Input, Output> & Record<string, unknown>;
          if (job.queue === this.queueName && this.matchesPrefixes(job)) {
            jobs.push(job);
          }
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve(jobs);
      tx.onerror = () => reject(tx.error);
      request.onerror = () => reject(request.error);
    });
  }

  private async getAllJobsWithFilter(
    prefixFilter: Readonly<Record<string, string | number>>
  ): Promise<Array<JobStorageFormat<Input, Output>>> {
    const db = await this.getDb();
    const tx = db.transaction(this.tableName, "readonly");
    const store = tx.objectStore(this.tableName);

    return new Promise((resolve, reject) => {
      const jobs: Array<JobStorageFormat<Input, Output>> = [];
      const request = store.openCursor();

      request.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor) {
          const job = cursor.value as JobStorageFormat<Input, Output> & Record<string, unknown>;
          if (job.queue !== this.queueName) {
            cursor.continue();
            return;
          }
          if (Object.keys(prefixFilter).length === 0) {
            jobs.push(job);
          } else {
            let matches = true;
            for (const [key, value] of Object.entries(prefixFilter)) {
              if (job[key] !== value) {
                matches = false;
                break;
              }
            }
            if (matches) {
              jobs.push(job);
            }
          }
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve(jobs);
      tx.onerror = () => reject(tx.error);
      request.onerror = () => reject(request.error);
    });
  }

  private isCustomPrefixFilter(prefixFilter?: Readonly<Record<string, string | number>>): boolean {
    if (prefixFilter === undefined) {
      return false;
    }
    if (Object.keys(prefixFilter).length === 0) {
      return true;
    }
    const instanceKeys = Object.keys(this.prefixValues);
    const filterKeys = Object.keys(prefixFilter);
    if (instanceKeys.length !== filterKeys.length) {
      return true;
    }
    for (const key of instanceKeys) {
      if (this.prefixValues[key] !== prefixFilter[key]) {
        return true;
      }
    }
    return false;
  }

  private getHybridManager(): HybridSubscriptionManager<
    JobStorageFormat<Input, Output>,
    unknown,
    QueueChangePayload<Input, Output>
  > {
    if (!this.hybridManager) {
      const channelName = `indexeddb-queue-${this.tableName}-${this.queueName}`;

      this.hybridManager = new HybridSubscriptionManager<
        JobStorageFormat<Input, Output>,
        unknown,
        QueueChangePayload<Input, Output>
      >(
        channelName,
        async () => {
          const jobs = await this.getAllJobs();
          return new Map(jobs.map((j) => [j.id, j]));
        },
        (a, b) => deepEqual(a, b),
        {
          insert: (item) => ({ type: "INSERT" as const, new: item }),
          update: (oldItem, newItem) => ({ type: "UPDATE" as const, old: oldItem, new: newItem }),
          delete: (item) => ({ type: "DELETE" as const, old: item }),
        },
        {
          defaultIntervalMs: 1000,
          useBroadcastChannel: this.hybridOptions.useBroadcastChannel,
          backupPollingIntervalMs: this.hybridOptions.backupPollingIntervalMs,
        }
      );
    }
    return this.hybridManager;
  }

  private subscribeWithCustomPrefixFilter(
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
        // ignore polling errors
      }
    };

    const intervalId = setInterval(poll, intervalMs);
    void poll();

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }

  /**
   * Uses polling since IndexedDB has no native cross-tab change notifications.
   * Normal subscriptions share a single polling loop; custom prefix filter
   * subscriptions get a dedicated loop with DB-level filtering.
   */
  public subscribeToChanges(
    callback: (change: QueueChangePayload<Input, Output>) => void,
    options?: QueueSubscribeOptions
  ): () => void {
    const intervalMs = options?.pollingIntervalMs ?? 1000;

    if (this.isCustomPrefixFilter(options?.prefixFilter)) {
      return this.subscribeWithCustomPrefixFilter(callback, options!.prefixFilter!, intervalMs);
    }

    const manager = this.getHybridManager();
    return manager.subscribe(callback, { intervalMs });
  }

  destroy(): void {
    if (this.hybridManager) {
      this.hybridManager.destroy();
      this.hybridManager = null;
    }
  }
}
