/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_LIMITS, SECURITY_LIMITS } from "@workglow/util";
import { describe, expect, it } from "vitest";

describe("DEFAULT_LIMITS", () => {
  it("exposes every documented behavioral default with its expected value", () => {
    expect(DEFAULT_LIMITS.bridgeMaxDepth).toBe(16);
    expect(DEFAULT_LIMITS.jobMaxAttempts).toBe(10);
    expect(DEFAULT_LIMITS.jobQueuePollIntervalMs).toBe(100);
    expect(DEFAULT_LIMITS.jobQueueMaxIdlePollIntervalMs).toBe(1_000);
    expect(DEFAULT_LIMITS.jobQueueLeaseFloorMs).toBe(30_000);
    expect(DEFAULT_LIMITS.jobQueueLimiterMaxWakeMs).toBe(30_000);
    expect(DEFAULT_LIMITS.jobQueueMaxProcessingTimeSamples).toBe(1_000);
    expect(DEFAULT_LIMITS.jobQueueMaxFingerprintScan).toBe(10_000);
    expect(DEFAULT_LIMITS.jobErrorMaxDiagnosticsChars).toBe(48_000);
    expect(DEFAULT_LIMITS.jobErrorMaxCauseChainDepth).toBe(8);
    expect(DEFAULT_LIMITS.storageMaxPendingMessages).toBe(1_000);
    expect(DEFAULT_LIMITS.aiLocalFetchMaxRedirects).toBe(5);
    expect(DEFAULT_LIMITS.aiChatMaxIterations).toBe(100);
    expect(DEFAULT_LIMITS.structuredGenMaxRetries).toBe(2);
    expect(DEFAULT_LIMITS.otpCacheHardTtlMs).toBe(6 * 60 * 60 * 1000);
    expect(DEFAULT_LIMITS.grepMaxSearchMs).toBe(30_000);
    expect(DEFAULT_LIMITS.grepMaxLineChars).toBe(64_000);
    expect(DEFAULT_LIMITS.grepMaxOutputLines).toBe(10_000);
    expect(DEFAULT_LIMITS.grepMaxOutputChars).toBe(1_000_000);
  });

  it("is a frozen object shape (const assertion) with only number values", () => {
    for (const value of Object.values(DEFAULT_LIMITS)) {
      expect(typeof value).toBe("number");
    }
  });
});

describe("SECURITY_LIMITS", () => {
  it("exposes every documented security ceiling with its expected value", () => {
    expect(SECURITY_LIMITS.regexMaxBracketCount).toBe(100);
    expect(SECURITY_LIMITS.imageMaxDecodedPixels).toBe(100_000_000);
    expect(SECURITY_LIMITS.imageMaxInputBytesNode).toBe(64 * 1024 * 1024);
    expect(SECURITY_LIMITS.imageMaxInputBytesBrowser).toBe(32 * 1024 * 1024);
    expect(SECURITY_LIMITS.safeFetchMaxRedirectHops).toBe(20);
    expect(SECURITY_LIMITS.tabularMaxCursorLength).toBe(8 * 1024);
    expect(SECURITY_LIMITS.regexMatchBatchLines).toBe(512);
    expect(SECURITY_LIMITS.regexMatchBatchTimeoutMs).toBe(1_000);
  });

  it("is a frozen object shape (const assertion) with only number values", () => {
    for (const value of Object.values(SECURITY_LIMITS)) {
      expect(typeof value).toBe("number");
    }
  });
});
