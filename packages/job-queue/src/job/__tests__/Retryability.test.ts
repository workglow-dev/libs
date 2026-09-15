/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { AbortSignalJobError, JobError, PermanentJobError, RetryableJobError } from "../JobError";
import { declaredRetryability, isRetryableError } from "../Retryability";

describe("declaredRetryability", () => {
  it("reads the job-error hierarchy's own answer", () => {
    expect(declaredRetryability(new RetryableJobError("rate limited"))).toBe(true);
    expect(declaredRetryability(new PermanentJobError("bad request"))).toBe(false);
    expect(declaredRetryability(new AbortSignalJobError("aborted"))).toBe(false);
    expect(declaredRetryability(new JobError("plain"))).toBe(false);
  });

  it("reads an error that is not a JobError at all", () => {
    // The point of the field: a package that cannot depend on the job-queue
    // hierarchy still gets to state the answer, and a worker boundary that
    // strips the class carries the flag across.
    const declared = Object.assign(new Error("provider is down"), { retryable: true });
    expect(declaredRetryability(declared)).toBe(true);
  });

  it("says `undefined` when nothing was declared, so a caller can tell a claim from a silence", () => {
    expect(declaredRetryability(new Error("boom"))).toBeUndefined();
    expect(declaredRetryability({})).toBeUndefined();
    expect(declaredRetryability(null)).toBeUndefined();
    expect(declaredRetryability(undefined)).toBeUndefined();
    expect(declaredRetryability("boom")).toBeUndefined();
  });

  it("ignores a non-boolean `retryable`, which is not an answer", () => {
    // A truthy string or a number is a field someone else's library happens to
    // use for something else; taking it as a yes would retry on it.
    expect(
      declaredRetryability(Object.assign(new Error("x"), { retryable: "yes" }))
    ).toBeUndefined();
    expect(declaredRetryability(Object.assign(new Error("x"), { retryable: 1 }))).toBeUndefined();
  });
});

describe("isRetryableError", () => {
  it("is true only for an error that declared it", () => {
    expect(isRetryableError(new RetryableJobError("rate limited"))).toBe(true);
    expect(isRetryableError(Object.assign(new Error("429"), { retryable: true }))).toBe(true);
  });

  it("treats anything unclassified as permanent", () => {
    // Guessing the other way retries a malformed request until the attempt
    // budget runs out, for every job that fails for a reason nobody has
    // classified yet.
    expect(isRetryableError(new Error("boom"))).toBe(false);
    expect(isRetryableError(new PermanentJobError("bad request"))).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });
});
