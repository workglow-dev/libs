/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServiceToken } from "@workglow/util";

export const JOB_LIMITER = createServiceToken<ILimiter>("jobqueue.limiter");

/**
 * An opaque slot reservation. What it holds is implementation-defined — a
 * symbol, a storage row id, a lease string — so a caller passes it back
 * unexamined.
 *
 * Non-nullable on purpose, which is what lets `LimiterToken | null` narrow at
 * all: `unknown | null` collapses to plain `unknown`, so a signature spelled
 * that way promises a caller a null case the compiler then never gives it.
 */
export type LimiterToken = NonNullable<unknown>;

/**
 * Whether a limiter's state is shared across processes.
 *
 * - `"process"` — state lives in this process only. Multiple workers in the
 *   same process share it, but separate processes do not. The configured limit
 *   is multiplied by the number of processes.
 * - `"cluster"` — state lives in shared storage (Postgres, Supabase, etc.)
 *   visible to every process in the cluster. The configured limit is enforced
 *   globally.
 */
export type LimiterScope = "process" | "cluster";

/**
 * Interface for a job limiter.
 *
 * The atomic primitive is {@link tryAcquire}: it both checks whether a job may
 * proceed and reserves the slot in a single uninterruptible step. Callers
 * MUST use {@link tryAcquire}/{@link release} when correctness matters under
 * concurrency.
 *
 * The limiter half of `runGenericJobQueueTests` is where that atomicity is
 * actually asserted — a `canProceed`-then-`recordJobStart` pair passes every
 * single-threaded test and admits two jobs into one slot the moment anything
 * runs concurrently. It is an in-repo example rather than something an
 * implementer can run: it lives in the private `@workglow/test`, and unlike the
 * contracts in `@workglow/test-contract` it has not been published. An
 * implementation outside this repository has to assert the property itself
 * until it is.
 */
export interface ILimiter {
  /**
   * Whether this limiter's state is shared across processes. See
   * {@link LimiterScope}. In-memory limiters MUST report `"process"` so users
   * don't mistake them for cluster-safe.
   */
  readonly scope: LimiterScope;

  /**
   * Atomic check-and-record. Returns an opaque, non-null token on success
   * (the caller may proceed AND the reservation has been recorded). Returns
   * `null` without side effects if the limiter is at capacity.
   *
   * The returned token MUST be passed to {@link release} to free the slot —
   * otherwise rolling back the reservation under contention would race to
   * delete some other worker's slot. Tokens are implementation-defined and
   * callers must treat them as opaque.
   *
   * Implementations must be safe under concurrent callers — two parallel
   * `tryAcquire()` calls with one slot remaining must result in exactly one
   * non-null token and one `null`.
   */
  tryAcquire(): Promise<LimiterToken | null>;

  /**
   * Release a slot previously reserved by {@link tryAcquire}. The token must
   * be the value that {@link tryAcquire} returned for the slot being freed.
   * Used when the caller cannot actually use the slot it acquired (e.g.
   * claimed a job that vanished, executor failed before running, worker
   * shut down).
   */
  release(token: unknown): Promise<void>;

  /**
   * Signal that the job which acquired this token has finished executing.
   * Called on the normal completion path (success, error, retry) to release
   * resources held for the duration of the job.
   *
   * Semantics differ from {@link release}: `release` undoes a reservation as
   * if the job never ran; `complete` finalises a reservation that was actually
   * used.
   *
   * - `ConcurrencyLimiter`: decrements the running-job counter so the next
   *   job can acquire a slot.
   * - `RateLimiter`: no-op — the window reservation was consumed and must
   *   persist until the window expires.
   * - All others: no-op.
   */
  complete(token: unknown): Promise<void>;

  getNextAvailableTime(): Promise<Date>;
  setNextAvailableTime(date: Date): Promise<void>;
  clear(): Promise<void>;
}

export interface RateLimiterOptions {
  readonly maxExecutions: number;
  readonly windowSizeInSeconds: number;
}

export interface RateLimiterWithBackoffOptions extends RateLimiterOptions {
  readonly initialBackoffDelay?: number;
  readonly backoffMultiplier?: number;
  readonly maxBackoffDelay?: number;
}
