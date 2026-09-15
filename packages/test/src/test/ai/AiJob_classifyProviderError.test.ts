/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  classifyProviderError,
  ImageGenerationContentPolicyError,
  ImageGenerationProviderError,
  ProviderUnsupportedFeatureError,
} from "@workglow/ai";
import { DeepSeekToolChoiceNotHonoredError } from "@workglow/deepseek/ai";
import { AbortSignalJobError, PermanentJobError, RetryableJobError } from "@workglow/job-queue";
import { rehydrateWorkerError, workerErrorPayload } from "@workglow/util/worker";
import { describe, expect, it } from "vitest";

describe("classifyProviderError mapping for image-generation errors", () => {
  it("maps ProviderUnsupportedFeatureError to PermanentJobError", () => {
    const err = new ProviderUnsupportedFeatureError("mask", "m", "not supported");
    const classified = classifyProviderError(err, "ImageGenerateTask", "TEST_PROVIDER");
    expect(classified).toBeInstanceOf(PermanentJobError);
  });

  it("maps ImageGenerationContentPolicyError to PermanentJobError", () => {
    const err = new ImageGenerationContentPolicyError("m", "violates policy");
    const classified = classifyProviderError(err, "ImageGenerateTask", "TEST_PROVIDER");
    expect(classified).toBeInstanceOf(PermanentJobError);
  });

  it("maps retryable ImageGenerationProviderError to RetryableJobError", () => {
    const err = new ImageGenerationProviderError("m", "rate limited");
    const classified = classifyProviderError(err, "ImageGenerateTask", "TEST_PROVIDER");
    expect(classified).toBeInstanceOf(RetryableJobError);
  });
});

describe("classifyProviderError mapping for tool-choice errors", () => {
  it("passes DeepSeekToolChoiceNotHonoredError through as RetryableJobError", () => {
    const err = new DeepSeekToolChoiceNotHonoredError("deepseek-v4-pro", "required", "no calls");
    const classified = classifyProviderError(err, "ToolCallingTask", "DEEPSEEK");
    expect(classified).toBeInstanceOf(RetryableJobError);
    expect(classified).toBe(err);
  });
});

/**
 * A run function registered worker-backed throws inside the worker, and the
 * error reaches this classifier having been flattened to `message`, `name` and
 * the fields {@link workerErrorPayload} carries. Its class is gone, so every
 * `instanceof` here is false on exactly the errors a provider took the most
 * care over.
 */
describe("classifyProviderError for an error that crossed a worker boundary", () => {
  const acrossWorker = (error: unknown): Error =>
    rehydrateWorkerError(
      JSON.parse(JSON.stringify(workerErrorPayload(error, { includeStack: false, roots: [] })))
    );

  it("keeps a provider's retryable classification retryable", () => {
    const err = acrossWorker(new ImageGenerationProviderError("m", "upstream 503"));
    expect(err).not.toBeInstanceOf(ImageGenerationProviderError);
    expect(classifyProviderError(err, "ImageGenerateTask", "TEST_PROVIDER")).toBeInstanceOf(
      RetryableJobError
    );
  });

  it("keeps a RetryableJobError thrown in the worker retryable", () => {
    const err = acrossWorker(new RetryableJobError("upstream is restarting"));
    expect(err).not.toBeInstanceOf(RetryableJobError);
    expect(classifyProviderError(err, "TextGenerationTask", "TEST_PROVIDER")).toBeInstanceOf(
      RetryableJobError
    );
  });

  it("keeps a permanent classification permanent", () => {
    const err = acrossWorker(new ImageGenerationContentPolicyError("m", "violates policy"));
    const classified = classifyProviderError(err, "ImageGenerateTask", "TEST_PROVIDER");
    expect(classified).toBeInstanceOf(PermanentJobError);
    expect(classified).not.toBeInstanceOf(RetryableJobError);
  });

  it("does not let a message heuristic overturn a stated permanent answer", () => {
    // "timed out" in the prose would otherwise reach the heuristic that reads
    // it as transient, and re-run a request the provider said cannot succeed.
    const err = acrossWorker(
      new ImageGenerationContentPolicyError("m", "refused; the review timed out")
    );
    expect(classifyProviderError(err, "ImageGenerateTask", "TEST_PROVIDER")).not.toBeInstanceOf(
      RetryableJobError
    );
  });

  it("still reports an abort as an abort rather than a failure", () => {
    const err = acrossWorker(new AbortSignalJobError("The operation was aborted"));
    expect(classifyProviderError(err, "TextGenerationTask", "TEST_PROVIDER")).toBeInstanceOf(
      AbortSignalJobError
    );
  });

  it("leaves an unclassified failure permanent", () => {
    // Nothing declared anything, so the classifier has only the message — and
    // the default has to stay permanent or an unknown failure retries forever.
    const err = acrossWorker(new Error("something went wrong"));
    const classified = classifyProviderError(err, "TextGenerationTask", "TEST_PROVIDER");
    expect(classified).toBeInstanceOf(PermanentJobError);
    expect(classified).not.toBeInstanceOf(RetryableJobError);
  });
});
