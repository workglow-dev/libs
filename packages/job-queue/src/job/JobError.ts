/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseError } from "@workglow/util";

export class JobError extends BaseError {
  public static override type: string = "JobError";
  /**
   * Whether the queue should try this job again. Read through
   * {@link isRetryableError} rather than by testing for
   * {@link RetryableJobError}: the class is lost whenever the error crosses a
   * worker boundary, and this field is what is carried across it.
   */
  public retryable = false;
  /**
   * Machine-readable error code persisted as `error_code` on queued jobs.
   * When set, takes precedence over the error class name for persistence.
   */
  public code?: string;
}

/**
 * Value stored in queue `error_code` for a failed job.
 */
export function jobErrorPersistedCode(error: JobError): string {
  return error.code ?? error.constructor.name;
}

/**
 * A job error that is caused by a job not being found
 *
 * Examples: job.id is undefined, job.id is not found in the storage, etc.
 */
export class JobNotFoundError extends JobError {
  public static override type: string = "JobNotFoundError";
  constructor(message: string = "Job not found") {
    super(message);
  }
}

/**
 * A job error that is retryable
 *
 * Examples: network timeouts, temporary unavailability of an external service, or rate-limiting
 */
export class RetryableJobError extends JobError {
  public static override type: string = "RetryableJobError";
  constructor(
    message: string,
    public retryDate?: Date
  ) {
    super(message);
    this.retryable = true;
  }
}

/**
 * A job error that is not retryable
 *
 * Examples: invalid input, missing required parameters, or a permanent failure of
 * an external service, permission errors, running out of money for an API, etc.
 */
export class PermanentJobError extends JobError {
  public static override type: string = "PermanentJobError";
}

/**
 * A job error that is caused by an abort signal,
 * meaning the client aborted the job on purpose,
 * not by the queue going down or similar.
 *
 * Example: job.abort()
 */
export class AbortSignalJobError extends PermanentJobError {
  public static override type: string = "AbortSignalJobError";
}

/**
 * A job error that is caused by a job being disabled
 *
 * Examples: job.disable()
 */
export class JobDisabledError extends PermanentJobError {
  public static override type: string = "JobDisabledError";
}
