/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Single source of truth for default numeric limits used across the
 * `libs` packages (task-graph, job-queue, storage, ai, tasks). Every one
 * of these defaults remains overridable at its call site (constructor or
 * function option); this module only centralizes the fallback value so it
 * is not duplicated and drifted across packages.
 *
 * See {@link SECURITY_LIMITS} for hard ceilings that are NOT caller
 * overridable because they exist to defend against resource-exhaustion /
 * injection attacks (ReDoS, decompression bombs, SSRF).
 */
export const DEFAULT_LIMITS = {
  /** Max nesting depth for subgraph task-event re-emission before bridging becomes a no-op. */
  bridgeMaxDepth: 16,
  /** Default max attempts before a job is considered permanently failed. */
  jobMaxAttempts: 10,
  /** Default interval (ms) between JobQueueWorker poll iterations. */
  jobQueuePollIntervalMs: 100,
  /** Floor (ms) applied when deriving a worker's lease duration from its poll interval. */
  jobQueueLeaseFloorMs: 30_000,
  /** Upper bound (ms) on how long JobQueueWorker will sleep before re-checking a rate limiter. */
  jobQueueLimiterMaxWakeMs: 30_000,
  /** Size of the rolling window of recent job-processing-time samples JobQueueWorker retains. */
  jobQueueMaxProcessingTimeSamples: 1_000,
  /** Max rows the in-memory/IndexedDB fingerprint-dedup fallback will scan before giving up. */
  jobQueueMaxFingerprintScan: 10_000,
  /** Max characters kept when formatting a job error's `.cause` chain for diagnostics. */
  jobErrorMaxDiagnosticsChars: 48_000,
  /** Max levels of `.cause` walked when formatting error diagnostics. */
  jobErrorMaxCauseChainDepth: 8,
  /** Max buffered cross-tab change-notification messages before older ones are dropped. */
  storageMaxPendingMessages: 1_000,
  /** Max redirect hops followed by the loopback-only AI provider fetch helper. */
  aiLocalFetchMaxRedirects: 5,
  /** Max tool-calling turns for AiChatTask / AiChatWithKbTask. */
  aiChatMaxIterations: 100,
  /** Max validation-error retries for StructuredGenerationTask. */
  structuredGenMaxRetries: 2,
  /** Default absolute TTL (ms) for OtpPassphraseCache. */
  otpCacheHardTtlMs: 6 * 60 * 60 * 1000,
  /** Default wall-clock budget (ms) for a whole FileGrepTask scan. */
  grepMaxSearchMs: 30_000,
  /** Max characters of one FileGrepTask line; the rest of that physical line is discarded. */
  grepMaxLineChars: 64_000,
  /** Default max FileGrepTask output lines (including context) when the caller states none. */
  grepMaxOutputLines: 10_000,
  /** Default max FileGrepTask output characters when the caller states none. */
  grepMaxOutputChars: 1_000_000,
} as const satisfies Record<string, number>;

/**
 * Hard ceilings that defend against resource-exhaustion or injection
 * attacks (ReDoS, decompression/pixel bombs, SSRF via redirects, cursor
 * tampering). Unlike {@link DEFAULT_LIMITS}, these are NOT exposed as
 * caller-overridable options — a caller weakening one of these would
 * reopen the vulnerability the constant defends against.
 */
export const SECURITY_LIMITS = {
  /** Max '[' characters allowed in a RegexTask pattern before rejecting (ReDoS guard). */
  regexMaxBracketCount: 100,
  /** Max decoded pixels (width * height) accepted by the image raster codec. */
  imageMaxDecodedPixels: 100_000_000,
  /** Max raw (base64-decoded) byte size of an incoming data URI on the Node image codec. */
  imageMaxInputBytesNode: 64 * 1024 * 1024,
  /** Max raw byte size of an incoming data URI on the browser image codec. */
  imageMaxInputBytesBrowser: 32 * 1024 * 1024,
  /** Max redirect hops followed by the SSRF-aware `safeFetch` wrapper. */
  safeFetchMaxRedirectHops: 20,
  /**
   * Max bytes buffered from a webhook response body before the read is
   * abandoned. Truncation constants apply only after a body is fully in
   * memory, so without this ceiling a hostile endpoint answering with an
   * unbounded body would OOM the runner.
   */
  webhookMaxResponseBodyBytes: 1024 * 1024,
  /** Max accepted length (characters) of an encoded tabular storage pagination cursor. */
  tabularMaxCursorLength: 8 * 1024,
  /** Lines matched per interruptible regex batch (ReDoS defence, see below). */
  regexMatchBatchLines: 512,
  /**
   * Wall-clock budget (ms) for one interruptible regex batch. A shape screen
   * cannot decide backtracking, so this is the bound that is actually enforced:
   * matching runs where it can be interrupted, and a batch that overruns fails
   * the task instead of blocking forever.
   */
  regexMatchBatchTimeoutMs: 1_000,
} as const satisfies Record<string, number>;
