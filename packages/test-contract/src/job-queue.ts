/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conformance suite for `IQueueStorage` and `IRateLimiterStorage` — what every
 * queue backend owes the job runner that sits on top of it: claim semantics,
 * retry and backoff, terminal transitions, rate limiting, and the fingerprint
 * that makes a duplicate submission one job.
 */

export * from "./job-queue/genericJobQueueTests";
