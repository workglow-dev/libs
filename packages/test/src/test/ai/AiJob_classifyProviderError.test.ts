/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AiProvider,
  classifyProviderError,
  DEFAULT_RATE_LIMIT_RETRY_MS,
  ImageGenerationContentPolicyError,
  ImageGenerationProviderError,
  isCreditExhaustedError,
  isRetryDateEstimated,
  ProviderUnsupportedFeatureError,
  retryDelayMs,
  statedRetryAfterMs,
} from "@workglow/ai";
import { DeepSeekToolChoiceNotHonoredError } from "@workglow/deepseek/ai";
import { AbortSignalJobError, PermanentJobError, RetryableJobError } from "@workglow/job-queue";
import { rehydrateWorkerError, workerErrorPayload } from "@workglow/util/worker";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("classifyProviderError mapping for image-generation errors", () => {
  it("retries a provider's own server failure reported without an HTTP status", () => {
    const streamed = Object.assign(new Error("An error occurred while processing the request."), {
      code: "server_error",
    });
    expect(classifyProviderError(streamed, "ToolCallingTask", "OPENAI")).toBeInstanceOf(
      RetryableJobError
    );
    const nested = Object.assign(new Error("stream failed"), { error: { type: "server_error" } });
    expect(classifyProviderError(nested, "ToolCallingTask", "OPENAI")).toBeInstanceOf(
      RetryableJobError
    );
    expect(
      classifyProviderError(new Error("something unexplained"), "ToolCallingTask", "OPENAI")
    ).toBeInstanceOf(PermanentJobError);
  });

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

const NOW = Date.UTC(2026, 10, 24, 12, 0, 0);

/** An SDK API error as OpenAI's and Anthropic's clients build one: status, headers, body. */
function apiError(
  message: string,
  fields: { status?: number; code?: string; type?: string; headers?: unknown; error?: unknown }
): Error {
  return Object.assign(new Error(message), fields);
}

const GEMINI_RATE_LIMIT_BODY = JSON.stringify({
  error: {
    code: 429,
    message:
      "You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://ai.google.dev/gemini-api/docs/rate-limits.",
    status: "RESOURCE_EXHAUSTED",
    details: [
      { "@type": "type.googleapis.com/google.rpc.QuotaFailure", violations: [] },
      { "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "7s" },
    ],
  },
});

describe("classifyProviderError for a 429", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const waitOf = (err: Error): number | undefined => {
    expect(err).toBeInstanceOf(RetryableJobError);
    const date = (err as RetryableJobError).retryDate;
    return date === undefined ? undefined : date.getTime() - NOW;
  };

  it("fails OpenAI's insufficient_quota permanently instead of retrying it as a rate limit", () => {
    const err = apiError(
      "429 You exceeded your current quota, please check your plan and billing details.",
      { status: 429, code: "insufficient_quota", type: "insufficient_quota" }
    );
    const classified = classifyProviderError(err, "TextGenerationTask", "OPENAI");
    expect(classified).toBeInstanceOf(PermanentJobError);
    expect(classified).not.toBeInstanceOf(RetryableJobError);
  });

  it("fails a nested billing code permanently", () => {
    const err = apiError("429 quota", {
      status: 429,
      error: { type: "insufficient_quota", code: "insufficient_quota" },
    });
    expect(classifyProviderError(err, "TextGenerationTask", "OPENAI")).toBeInstanceOf(
      PermanentJobError
    );
  });

  it("reads OpenAI's retry-after-ms header from a plain record", () => {
    const err = apiError(
      "429 Rate limit reached for gpt in organization org-x on tokens per min. Please try again in 1.2s.",
      { status: 429, code: "rate_limit_exceeded", headers: { "retry-after-ms": "1200" } }
    );
    expect(waitOf(classifyProviderError(err, "TextGenerationTask", "OPENAI"))).toBe(1200);
  });

  it("reads OpenAI's 'try again in' wording when no header survives", () => {
    const seconds = apiError("Rate limit reached. Please try again in 1.2s.", { status: 429 });
    expect(waitOf(classifyProviderError(seconds, "TextGenerationTask", "OPENAI"))).toBe(1200);
    const millis = apiError("Rate limit reached. Please try again in 350ms.", { status: 429 });
    expect(waitOf(classifyProviderError(millis, "TextGenerationTask", "OPENAI"))).toBe(350);
  });

  it("reads Anthropic's retry-after seconds from a Headers instance", () => {
    const err = apiError("429 rate_limit_error: Number of request tokens has exceeded your rate", {
      status: 429,
      type: "rate_limit_error",
      headers: new Headers({ "retry-after": "3" }),
    });
    expect(waitOf(classifyProviderError(err, "TextGenerationTask", "ANTHROPIC"))).toBe(3000);
  });

  it("reads retry-after as an HTTP date", () => {
    const err = apiError("429 Too Many Requests", {
      status: 429,
      headers: { "retry-after": new Date(NOW + 9_000).toUTCString() },
    });
    expect(waitOf(classifyProviderError(err, "TextGenerationTask", "TEST"))).toBe(9000);
  });

  it("retries Gemini's RESOURCE_EXHAUSTED at its RetryInfo delay, not as billing", () => {
    // Gemini words a per-minute quota as "exceeded your current quota ... billing",
    // the same as a billing failure; the stated delay is what says it will pass.
    const err = apiError(`got status: 429 Too Many Requests. ${GEMINI_RATE_LIMIT_BODY}`, {
      status: 429,
    });
    expect(waitOf(classifyProviderError(err, "TextGenerationTask", "GOOGLE_GEMINI"))).toBe(7000);
  });

  it("reads Gemini's retryDelay from structured details", () => {
    const err = apiError("Resource has been exhausted", {
      status: 429,
      error: {
        details: [{ "@type": "type.googleapis.com/google.rpc.RetryInfo", retryDelay: "2.5s" }],
      },
    });
    expect(waitOf(classifyProviderError(err, "TextGenerationTask", "GOOGLE_GEMINI"))).toBe(2500);
  });

  it("keeps the legacy 'retry after N' wording", () => {
    const err = apiError("Too many requests, retry after 5", { status: 429 });
    expect(waitOf(classifyProviderError(err, "TextGenerationTask", "TEST"))).toBe(5000);
  });

  it("spaces a 429 that stated no wait for a queue, but an agent backs off on its own", () => {
    const err = apiError("429 Too Many Requests", { status: 429 });
    const classified = classifyProviderError(err, "TextGenerationTask", "TEST");
    // A queue reschedules at its limiter's next slot, which is "now" for a
    // concurrency limiter; the default is what keeps it from retrying at once.
    expect(waitOf(classified)).toBe(DEFAULT_RATE_LIMIT_RETRY_MS);
    expect(isRetryDateEstimated(classified)).toBe(true);
    expect(statedRetryAfterMs(classified)).toBeUndefined();
    expect(retryDelayMs(classified, 1, NOW)).toBe(2000);
    expect(retryDelayMs(classified, 2, NOW)).toBe(4000);
  });

  it("reads OpenAI's compound durations", () => {
    const daily = apiError(
      "Rate limit reached for gpt-x on tokens per day. Please try again in 6m0s.",
      { status: 429 }
    );
    expect(waitOf(classifyProviderError(daily, "TextGenerationTask", "OPENAI"))).toBe(360_000);
    const mixed = apiError("Please try again in 1h2m3.5s.", { status: 429 });
    expect(waitOf(classifyProviderError(mixed, "TextGenerationTask", "OPENAI"))).toBe(3_723_500);
  });

  it("retries a live 429 worded like billing but carrying no code or wait", () => {
    // Gemini's per-minute quota without its RetryInfo detail: the wording is the
    // same as exhausted credits, the 429 is a rate limit.
    const err = apiError(
      "You exceeded your current quota, please check your plan and billing details.",
      { status: 429 }
    );
    const classified = classifyProviderError(err, "TextGenerationTask", "GOOGLE_GEMINI");
    expect(classified).toBeInstanceOf(RetryableJobError);
  });

  it("keeps a stated wait on a server error", () => {
    const overloaded = apiError("529 overloaded_error", {
      status: 529,
      headers: new Headers({ "retry-after": "20" }),
    });
    expect(waitOf(classifyProviderError(overloaded, "TextGenerationTask", "ANTHROPIC"))).toBe(
      20_000
    );
  });

  it("shares one billing matcher with the live-test credit skip", () => {
    const err = apiError("429 quota", { status: 429, code: "insufficient_quota" });
    expect(isCreditExhaustedError(err)).toBe(true);
    expect(statedRetryAfterMs(err)).toBeUndefined();
  });
});

describe("a stated retry-after across a worker boundary", () => {
  beforeEach(() => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const acrossWorker = (error: unknown): Error =>
    rehydrateWorkerError(
      JSON.parse(JSON.stringify(workerErrorPayload(error, { includeStack: false, roots: [] })))
    );

  class WorkerSideProvider extends AiProvider {
    readonly name = "WORKER_SIDE";
    readonly displayName = "Worker side";
    readonly isLocal = false;
    readonly supportsBrowser = true;
    readonly supportsServer = true;
  }

  /** Registers `thrown` as a worker run-fn and returns what the worker throws. */
  async function thrownByWorkerRunFn(thrown: unknown): Promise<unknown> {
    let registered: ((...args: unknown[]) => Promise<void>) | undefined;
    new WorkerSideProvider([
      {
        serves: ["text.generation"],
        runFn: async () => {
          throw thrown;
        },
      },
    ]).registerOnWorkerServer({
      registerRunFunction: (_name: string, fn: (...args: unknown[]) => Promise<void>) => {
        registered = fn;
      },
      registerPreviewFunction: () => {},
    } as any);
    try {
      await registered!({}, {}, new AbortController().signal, () => {});
    } catch (err) {
      return err;
    }
    throw new Error("run-fn did not throw");
  }

  it("keeps a Retry-After header's delay that a flattened error would lose", async () => {
    const sdkError = apiError("429 rate_limit_error", {
      status: 429,
      headers: new Headers({ "retry-after": "3" }),
    });
    const err = acrossWorker(await thrownByWorkerRunFn(sdkError));
    const classified = classifyProviderError(err, "TextGenerationTask", "ANTHROPIC");
    expect(classified).toBeInstanceOf(RetryableJobError);
    expect((classified as RetryableJobError).retryDate?.getTime()).toBe(NOW + 3000);
  });

  it("keeps a RetryableJobError's own retryDate", async () => {
    const err = acrossWorker(
      await thrownByWorkerRunFn(new RetryableJobError("busy", new Date(NOW + 4_000)))
    );
    const classified = classifyProviderError(err, "TextGenerationTask", "TEST");
    expect((classified as RetryableJobError).retryDate?.getTime()).toBe(NOW + 4000);
  });

  it("still fails a flattened insufficient_quota permanently", () => {
    const err = acrossWorker(
      apiError("429 You exceeded your current quota, please check your plan and billing details.", {
        status: 429,
        code: "insufficient_quota",
      })
    );
    expect(classifyProviderError(err, "TextGenerationTask", "OPENAI")).toBeInstanceOf(
      PermanentJobError
    );
  });
});
