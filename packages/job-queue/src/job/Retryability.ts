/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What an error says about being tried again, or `undefined` when it says
 * nothing.
 *
 * One fact, one field: `retryable`. Every retry path asks this rather than
 * testing a class, because a class is the half that does not survive the trip.
 * A provider run function throwing inside a worker is flattened to `message`,
 * `name` and this flag on the way back to the main thread — a
 * `RetryableJobError` arrives as a plain `Error` — so `instanceof` at the
 * receiving end reports "not retryable" for an error that said it was.
 *
 * The three-valued answer is what separates a caller that must fall back to
 * guessing from one that must not. "Said no" and "said nothing" both end in a
 * permanent failure, but only the first is a claim, and a caller holding
 * message heuristics has to run them for the second and leave the first alone.
 */
export function declaredRetryability(error: unknown): boolean | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const declared = (error as { retryable?: unknown }).retryable;
  return typeof declared === "boolean" ? declared : undefined;
}

/**
 * Whether a failure is worth another attempt.
 *
 * **Unclassified is permanent.** A value that declares nothing gets `false`,
 * not a guess: the alternative is retrying a malformed request until the
 * attempt budget runs out, on every job that ever fails for a new reason.
 * Saying so takes one field, and the ones worth retrying do say so.
 */
export function isRetryableError(error: unknown): boolean {
  return declaredRetryability(error) === true;
}
