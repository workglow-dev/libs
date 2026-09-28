/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { JobError } from "@workglow/job-queue";
import {
  createInMemoryQueue,
  InMemoryQueueStorage,
  InMemoryRateLimiterStorage,
  JobQueueClient,
  JobQueueServer,
  JobStatus,
  PermanentJobError,
  RateLimiter,
  RetryableJobError,
  wrapQueueStorage,
} from "@workglow/job-queue";
import {
  CACHE_REGISTRY,
  DefaultCacheRegistry,
  getTaskQueueRegistry,
  JobTaskFailedError,
  setTaskQueueRegistry,
  TaskConfigurationError,
  TaskInvalidInputError,
} from "@workglow/task-graph";
import { InMemoryTaskOutputRepository } from "@workglow/task-graph/test";
import type { FetchUrlTaskInput, FetchUrlTaskOutput } from "@workglow/tasks";
import {
  applyCredentialToHeaders,
  createFetchUrlJobError,
  fetchUrl,
  FetchUrlErrorCode,
  FetchUrlJob,
  FetchUrlTask,
  isFetchUrlJobError,
  isFetchUrlNetworkCause,
  isFetchUrlRetryableErrorCode,
  registerSafeFetch,
  type SafeFetchFn,
} from "@workglow/tasks";
import {
  Container,
  InMemoryCredentialStore,
  registerCredentialDefaults,
  ServiceRegistry,
  setGlobalCredentialStore,
  setLogger,
  sleep,
} from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

const mock = vi.fn;

// Create base mock response
const createMockResponse = (jsonData: any = {}): Response => {
  return new Response(JSON.stringify(jsonData), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
    },
  });
};

function concatChunks(chunks: readonly Uint8Array[]): Uint8Array {
  const merged = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return merged;
}

/** 200 whose body stream errors — the shape of a peer closing mid-read. */
function erroredBodyResponse(error: Error): Response {
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.error(error);
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    }
  );
}

// Mock fetch for testing — stubbed into SafeFetch so we bypass the real
// server impl (DNS + undici) during unit tests. These tests cover retry,
// progress, and response-type logic, not SSRF policy.
const mockFetch = mock((_url: string, _options: RequestInit & { allowPrivate?: boolean }) =>
  Promise.resolve(createMockResponse({}))
);
const mockSafeFetch: SafeFetchFn = (url, options) => mockFetch(url, options);

describe("FetchUrlTask", () => {
  let logger = getTestingLogger();
  setLogger(logger);
  let prevSafeFetch: SafeFetchFn;
  beforeAll(() => {
    prevSafeFetch = registerSafeFetch(mockSafeFetch);
  });

  afterAll(() => {
    registerSafeFetch(prevSafeFetch);
  });

  beforeEach(async () => {
    mockFetch.mockClear();
    await setTaskQueueRegistry(null);
  });

  afterEach(async () => {
    await setTaskQueueRegistry(null);
  });

  test("fetches multiple URLs successfully", async () => {
    const mockResponses = [
      { data: { id: 1, name: "Test 1" } },
      { data: { id: 2, name: "Test 2" } },
      { data: { id: 3, name: "Test 3" } },
    ];

    let responseIndex = 0;
    mockFetch.mockImplementation(() =>
      Promise.resolve(createMockResponse(mockResponses[responseIndex++]))
    );

    const urls = [
      "https://api.example.com/1",
      "https://api.example.com/2",
      "https://api.example.com/3",
    ];

    const results = await Promise.all(urls.map((url) => fetchUrl({ url, response_type: "json" })));
    expect(mockFetch.mock.calls.length).toBe(3);
    expect(results).toHaveLength(3);
    const sorted = results
      .map((result) => (result.json as any)?.data)
      .filter(Boolean)
      .sort((a, b) => (a!.id ?? 0) - (b!.id ?? 0));
    expect(sorted).toEqual(mockResponses.map((r) => r.data));
  });

  test("respects rate limiting with InMemoryQueue", async () => {
    const queueName = "rate-limited-queue";
    // Create a rate limiter that allows 1 request per minute
    const rateLimiter = new RateLimiter(new InMemoryRateLimiterStorage(), queueName, {
      maxExecutions: 1,
      windowSizeInSeconds: 1,
    }); // 1 request per 1 minute window

    // Create storage
    const storage = new InMemoryQueueStorage<FetchUrlTaskInput, FetchUrlTaskOutput>(queueName);
    await storage.migrate();
    const { messageQueue, jobStore } = wrapQueueStorage(storage);

    // Create server with the FetchUrlJob class
    const server = new JobQueueServer<FetchUrlTaskInput, FetchUrlTaskOutput>(FetchUrlJob, {
      messageQueue,
      jobStore,
      queueName,
      limiter: rateLimiter,
      pollIntervalMs: 1,
    });

    // Create client
    const client = new JobQueueClient<FetchUrlTaskInput, FetchUrlTaskOutput>({
      messageQueue,
      jobStore,
      queueName,
    });

    client.attach(server);

    // Register the queue with the registry
    getTaskQueueRegistry().registerQueue({ server, client, storage });

    const mockResponse = { data: { success: true } };
    mockFetch.mockImplementation(() => Promise.resolve(createMockResponse(mockResponse)));

    // Add jobs to queue via client
    await client.send({ url: "https://api.example.com/1", response_type: "stream" });
    await client.send({ url: "https://api.example.com/2", response_type: "stream" });
    await client.send({ url: "https://api.example.com/3", response_type: "stream" });

    // Start the server and wait for processing
    await server.start();
    await sleep(50); // Give time for rate limiting and processing

    // Verify that fetch was called only once due to rate limiting
    expect(mockFetch.mock.calls.length).toBe(1);

    // Clean up
    await server.stop();
    await storage.deleteAll();
  });

  test("handles HTTP error responses", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response("Not Found", {
          status: 404,
          statusText: "Not Found",
        })
      )
    );

    const fetchPromise = fetchUrl({
      url: "https://api.example.com/notfound",
      response_type: "stream",
    });

    const error = await fetchPromise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobTaskFailedError);
    const jobFailed = error as JobTaskFailedError;
    expect(jobFailed.jobError).toBeInstanceOf(PermanentJobError);
    expect(jobFailed.jobError.message).toContain("404");
    expect(jobFailed.code).toBe(FetchUrlErrorCode.HTTP_CLIENT_ERROR);
    expect(jobFailed.jobError.code).toBe(FetchUrlErrorCode.HTTP_CLIENT_ERROR);
    expect(isFetchUrlJobError(jobFailed.jobError)).toBe(true);
    if (isFetchUrlJobError(jobFailed.jobError)) {
      expect(jobFailed.jobError.httpStatus).toBe(404);
    }

    expect(mockFetch.mock.calls.length).toBe(1);
  });

  test("surfaces JSON message from a non-2xx body", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            error: "Internal server error",
            message: "upstream rejected the request",
          }),
          {
            status: 500,
            statusText: "Internal Server Error",
            headers: { "Content-Type": "application/json" },
          }
        )
      )
    );

    const error = await fetchUrl({
      url: "https://api.example.com/items",
      response_type: "json",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobTaskFailedError);
    const jobFailed = error as JobTaskFailedError;
    expect(jobFailed.jobError.message).toContain("upstream rejected the request");
    expect(isFetchUrlJobError(jobFailed.jobError)).toBe(true);
    if (isFetchUrlJobError(jobFailed.jobError)) {
      expect(jobFailed.jobError.httpErrorMessage).toBe("upstream rejected the request");
    }
  });

  test("surfaces a nested Yahoo chart.error.description from a 400 body", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            chart: {
              result: null,
              error: { code: "Bad Request", description: "Date range exceeds maximum of 5 years" },
            },
          }),
          {
            status: 400,
            statusText: "Bad Request",
            headers: { "Content-Type": "application/json" },
          }
        )
      )
    );

    const error = await fetchUrl({
      url: "https://api.example.com/chart",
      response_type: "json",
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobTaskFailedError);
    const jobFailed = error as JobTaskFailedError;
    expect(jobFailed.jobError).toBeInstanceOf(PermanentJobError);
    expect(jobFailed.jobError.code).toBe(FetchUrlErrorCode.HTTP_CLIENT_ERROR);
    expect(jobFailed.jobError.message).toBe(
      "Failed to fetch https://api.example.com/chart: 400 Bad Request: Date range exceeds maximum of 5 years"
    );
    expect(mockFetch.mock.calls.length).toBe(1);
  });

  test("reads only a bounded prefix of a huge error body", async () => {
    const CHUNK = new Uint8Array(1024 * 1024).fill(0x61);
    const TOTAL_CHUNKS = 64;
    let pulls = 0;

    mockFetch.mockImplementation(() => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls++;
          if (sent >= TOTAL_CHUNKS) {
            controller.close();
            return;
          }
          sent++;
          controller.enqueue(CHUNK);
        },
      });

      return Promise.resolve(
        new Response(body, {
          status: 500,
          statusText: "Internal Server Error",
          headers: { "Content-Type": "text/plain" },
        })
      );
    });

    const error = await fetchUrl({
      url: "https://api.example.com/huge-error",
      response_type: "json",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JobTaskFailedError);
    const jobFailed = error as JobTaskFailedError;
    expect(isFetchUrlJobError(jobFailed.jobError)).toBe(true);
    if (isFetchUrlJobError(jobFailed.jobError)) {
      expect(jobFailed.jobError.httpStatus).toBe(500);
      // A bounded snippet, never the body.
      expect(jobFailed.jobError.message.length).toBeLessThan(500);
    }

    // The body is 64 MiB in 1 MiB chunks; the reader must stop at its ceiling
    // rather than buffering the whole thing to slice a few kilobytes out.
    expect(pulls).toBeLessThanOrEqual(32);
  });

  test("handles network errors", async () => {
    mockFetch.mockImplementation(() => Promise.reject(new Error("Network error")));

    const fetchPromise = fetchUrl({
      url: "https://api.example.com/network-error",
      response_type: "stream",
    });

    const error = await fetchPromise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobTaskFailedError);
    const jobFailed = error as JobTaskFailedError;
    expect(jobFailed.message).toContain("Network error");
    expect(jobFailed.code).toBe(FetchUrlErrorCode.NETWORK_ERROR);
    expect(jobFailed.jobError.code).toBe(FetchUrlErrorCode.NETWORK_ERROR);
    expect(jobFailed.jobError).toBeInstanceOf(RetryableJobError);

    expect(mockFetch.mock.calls.length).toBe(1);
  });

  test("handles invalid JSON responses", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response("Invalid JSON", {
          status: 200,
          headers: {
            "Content-Type": "application/json",
          },
        })
      )
    );

    const fetchPromise = fetchUrl({
      url: "https://api.example.com/invalid-json",
      response_type: "json",
    });

    const error = await fetchPromise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobTaskFailedError);
    const jobFailed = error as JobTaskFailedError;
    expect(jobFailed.message).toContain("parse");
    expect(jobFailed.code).toBe(FetchUrlErrorCode.RESPONSE_PARSE_ERROR);

    expect(mockFetch.mock.calls.length).toBe(1);
  });

  test("treats a socket close while reading the body as a retryable network error", async () => {
    const socketError = new Error("The socket connection was closed unexpectedly");
    mockFetch.mockImplementation(() => Promise.resolve(erroredBodyResponse(socketError)));

    const error = await fetchUrl({
      url: "https://www.sec.gov/Archives/edgar/data/1/a.txt",
      response_type: "text",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JobTaskFailedError);
    const jobFailed = error as JobTaskFailedError;
    expect(jobFailed.code).toBe(FetchUrlErrorCode.NETWORK_ERROR);
    expect(jobFailed.jobError).toBeInstanceOf(RetryableJobError);
    expect(jobFailed.message).toContain("socket");
    expect(mockFetch.mock.calls.length).toBe(1);
  });

  test("treats an ECONNRESET while reading the body as a retryable network error", async () => {
    const reset = new Error("read failed") as NodeJS.ErrnoException;
    reset.code = "ECONNRESET";
    mockFetch.mockImplementation(() => Promise.resolve(erroredBodyResponse(reset)));

    const error = await fetchUrl({
      url: "https://www.sec.gov/Archives/edgar/data/1/a.txt",
      response_type: "text",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JobTaskFailedError);
    expect((error as JobTaskFailedError).code).toBe(FetchUrlErrorCode.NETWORK_ERROR);
    expect((error as JobTaskFailedError).jobError).toBeInstanceOf(RetryableJobError);
  });

  test("treats a nested socket cause while reading the body as a retryable network error", async () => {
    const wrapped = new Error("Unable to decode");
    wrapped.cause = new Error("other side closed");
    mockFetch.mockImplementation(() => Promise.resolve(erroredBodyResponse(wrapped)));

    const error = await fetchUrl({
      url: "https://www.sec.gov/Archives/edgar/data/1/a.txt",
      response_type: "text",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JobTaskFailedError);
    expect((error as JobTaskFailedError).code).toBe(FetchUrlErrorCode.NETWORK_ERROR);
    expect((error as JobTaskFailedError).jobError).toBeInstanceOf(RetryableJobError);
  });

  test("handles mixed success and failure responses", async () => {
    mockFetch.mockImplementation((input: string) => {
      const url = input;
      if (url.includes("/success")) {
        return Promise.resolve(createMockResponse({ data: "success" }));
      } else if (url.includes("/network-error")) {
        return Promise.reject(new Error("Network error"));
      } else {
        return Promise.resolve(
          new Response("Not Found", {
            status: 404,
            statusText: "Not Found",
          })
        );
      }
    });

    const urls = [
      "https://api.example.com/success",
      "https://api.example.com/network-error",
      "https://api.example.com/not-found",
    ];

    const results = await Promise.allSettled(
      urls.map((url) => fetchUrl({ url, response_type: "json" }))
    );

    expect(mockFetch.mock.calls.length).toBe(3);
    expect(results[0].status).toBe("fulfilled");
    expect((results[0] as PromiseFulfilledResult<any>).value.json).toEqual({ data: "success" });
    expect(results[1].status).toBe("rejected");
    expect((results[1] as PromiseRejectedResult).reason.message).toContain("Network error");
    expect(results[2].status).toBe("rejected");
    expect((results[2] as PromiseRejectedResult).reason).toBeInstanceOf(JobTaskFailedError);
    expect((results[2] as PromiseRejectedResult).reason.jobError).toBeInstanceOf(PermanentJobError);
    expect((results[2] as PromiseRejectedResult).reason.message).toContain("404");
  });

  test("handles rate limit responses with Retry-After header as seconds", async () => {
    const retryAfterSeconds = 30;
    const beforeTest = Date.now();
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response("Too Many Requests", {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "Retry-After": retryAfterSeconds.toString(),
          },
        })
      )
    );

    const error = await fetchUrl({
      url: "https://api.example.com/rate-limited",
      response_type: "stream",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(JobTaskFailedError);
    expect(error.code).toBe(FetchUrlErrorCode.HTTP_RATE_LIMITED);
    expect(error.jobError.message).toContain("429");
    expect(error.jobError.retryDate).toBeInstanceOf(Date);

    // Should be approximately retryAfterSeconds in the future
    const expectedTime = beforeTest + retryAfterSeconds * 1000;
    const actualTime = error.jobError.retryDate.getTime();
    const tolerance = 1000; // 1 second tolerance

    expect(actualTime).toBeGreaterThan(expectedTime - tolerance);
    expect(actualTime).toBeLessThan(expectedTime + tolerance);
    expect(mockFetch.mock.calls.length).toBe(1);
  });

  test("keeps a Retry-After of 0, which means retry now rather than no guidance", async () => {
    const beforeTest = Date.now();
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response("Too Many Requests", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "Retry-After": "0" },
        })
      )
    );

    const error = await fetchUrl({
      url: "https://api.example.com/retry-now",
      response_type: "stream",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(JobTaskFailedError);
    expect(error.code).toBe(FetchUrlErrorCode.HTTP_RATE_LIMITED);
    expect(error.jobError).toBeInstanceOf(RetryableJobError);
    // The value a caller reads to decide how long to wait. Left unset, a zero
    // is indistinguishable from a response carrying no Retry-After at all, and
    // a caller with its own backoff applies its no-guidance default to a
    // response that asked for none.
    expect(error.jobError.retryDate).toBeInstanceOf(Date);
    const waitMs = error.jobError.retryDate.getTime() - beforeTest;
    expect(waitMs).toBeGreaterThanOrEqual(0);
    expect(waitMs).toBeLessThan(1000);
  });

  test("ignores a negative Retry-After, which delta-seconds cannot express", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response("Too Many Requests", {
          status: 429,
          statusText: "Too Many Requests",
          headers: { "Retry-After": "-5" },
        })
      )
    );

    const error = await fetchUrl({
      url: "https://api.example.com/negative-retry-after",
      response_type: "stream",
    }).catch((e) => e);

    // The kind of error matters as much as the missing date: an absent
    // `retryDate` alone would also hold for a PermanentJobError, which never
    // carries one, so on its own it cannot tell "still a retryable rate limit,
    // just with no usable guidance" from "stopped being retryable at all".
    expect(error).toBeInstanceOf(JobTaskFailedError);
    expect(error.code).toBe(FetchUrlErrorCode.HTTP_RATE_LIMITED);
    expect(error.jobError).toBeInstanceOf(RetryableJobError);
    expect(error.jobError.retryDate).toBeUndefined();
    expect(mockFetch.mock.calls.length).toBe(1);
  });

  test("handles service unavailable with default retry time", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response("Service Unavailable", {
          status: 503,
          statusText: "Service Unavailable",
        })
      )
    );

    const error = await fetchUrl({
      url: "https://api.example.com/service-unavailable",
      response_type: "stream",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(JobTaskFailedError);
    expect(error.code).toBe(FetchUrlErrorCode.HTTP_SERVER_ERROR);
    expect(error.jobError).toBeInstanceOf(RetryableJobError);
    expect(error.jobError.message).toContain("503");

    expect(mockFetch.mock.calls.length).toBe(1);
  });

  test("persists FETCH_* error_code on queued job failure", async () => {
    const queueName = "fetch-error-code-queue";
    const storage = new InMemoryQueueStorage<FetchUrlTaskInput, FetchUrlTaskOutput>(queueName);
    await storage.migrate();
    const { messageQueue, jobStore } = wrapQueueStorage(storage);

    const server = new JobQueueServer<FetchUrlTaskInput, FetchUrlTaskOutput>(FetchUrlJob, {
      messageQueue,
      jobStore,
      queueName,
      pollIntervalMs: 1,
    });
    const client = new JobQueueClient<FetchUrlTaskInput, FetchUrlTaskOutput>({
      messageQueue,
      jobStore,
      queueName,
    });
    client.attach(server);
    getTaskQueueRegistry().registerQueue({ server, client, storage });

    mockFetch.mockImplementation(() =>
      Promise.resolve(new Response("Not Found", { status: 404, statusText: "Not Found" }))
    );

    const handle = await client.send({
      url: "https://api.example.com/missing",
      response_type: "stream",
    });
    await server.start();
    const queueError = await handle.waitFor().catch((e: unknown) => e);
    expect(queueError).toBeInstanceOf(PermanentJobError);
    expect((queueError as PermanentJobError).code).toBe(FetchUrlErrorCode.HTTP_CLIENT_ERROR);

    const failedJob = await client.getJob(handle.id);
    expect(failedJob?.errorCode).toBe(FetchUrlErrorCode.HTTP_CLIENT_ERROR);

    await server.stop();
    await storage.deleteAll();
  });

  test("handles Retry-After with HTTP date format", async () => {
    const retryDate = new Date(Date.now() + 60000); // 1 minute in the future
    const retryDateStr = retryDate.toUTCString();
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response("Too Many Requests", {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "retry-after": retryDateStr,
          },
        })
      )
    );

    const error = await fetchUrl({
      url: "https://api.example.com/rate-limited-date",
      response_type: "stream",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(JobTaskFailedError);
    expect(error.jobError).toBeInstanceOf(RetryableJobError);
    expect(error.jobError.message).toContain("429");
    expect(error.jobError.retryDate).toBeInstanceOf(Date);
    expect(error.jobError.retryDate > new Date()).toBe(true); // Should be in the future

    // Should be close to our specified retry date
    const timeDiff = Math.abs(error.jobError.retryDate.getTime() - retryDate.getTime());
    expect(timeDiff).toBeLessThan(1000); // Within 1 second
    expect(mockFetch.mock.calls.length).toBe(1);
  });

  test("handles invalid Retry-After date by falling back to seconds", async () => {
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response("Too Many Requests", {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "Retry-After": "invalid-date",
          },
        })
      )
    );

    const error = await fetchUrl({
      url: "https://api.example.com/rate-limited-invalid",
      response_type: "stream",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(JobTaskFailedError);
    expect(error.jobError).toBeInstanceOf(RetryableJobError);
    expect(error.jobError.message).toContain("429");
    expect(error.jobError.retryDate).not.toBeInstanceOf(Date);
    expect(mockFetch.mock.calls.length).toBe(1);
  });

  test("handles past Retry-After in the past", async () => {
    const pastDate = new Date(Date.now() - 60000); // 1 minute in the past
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response("Too Many Requests", {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "Retry-After": pastDate.toUTCString(),
          },
        })
      )
    );

    const error = await fetchUrl({
      url: "https://api.example.com/rate-limited-past",
      response_type: "stream",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(JobTaskFailedError);
    expect(error.jobError).toBeInstanceOf(RetryableJobError);
    expect(error.jobError.message).toContain("429");
    expect(error.jobError.retryDate).not.toBeInstanceOf(Date);
    expect(mockFetch.mock.calls.length).toBe(1);
  });

  test("handles Retry-After with RFC1123 date format", async () => {
    const retryDate = new Date(Date.now() + 120000); // 2 minutes in the future
    const retryDateStr = retryDate.toUTCString(); // RFC1123 format
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response("Too Many Requests", {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "Retry-After": retryDateStr,
          },
        })
      )
    );

    const error = await fetchUrl({
      url: "https://api.example.com/rate-limited-rfc1123",
      response_type: "stream",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(JobTaskFailedError);
    expect(error.jobError).toBeInstanceOf(RetryableJobError);
    expect(error.jobError.message).toContain("429");
    expect(error.jobError.retryDate).toBeInstanceOf(Date);

    // Should be very close to the date we provided (within 1 second)
    const tolerance = 1000;
    expect(Math.abs(error.jobError.retryDate.getTime() - retryDate.getTime())).toBeLessThan(
      tolerance
    );
    expect(mockFetch.mock.calls.length).toBe(1);
  });

  test("handles Retry-After with ISO8601 date format", async () => {
    const retryDate = new Date(Date.now() + 180000); // 3 minutes in the future
    const retryDateStr = retryDate.toISOString(); // ISO8601 format
    mockFetch.mockImplementation(() =>
      Promise.resolve(
        new Response("Too Many Requests", {
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            "Retry-After": retryDateStr,
          },
        })
      )
    );

    const error = await fetchUrl({
      url: "https://api.example.com/rate-limited-iso8601",
      response_type: "stream",
    }).catch((e) => e);

    expect(error).toBeInstanceOf(JobTaskFailedError);
    expect(error.jobError).toBeInstanceOf(RetryableJobError);
    expect(error.jobError.message).toContain("429");
    expect(error.jobError.retryDate).toBeInstanceOf(Date);

    // Should be very close to the date we provided (within 1 second)
    const tolerance = 1000;
    expect(Math.abs(error.jobError.retryDate.getTime() - retryDate.getTime())).toBeLessThan(
      tolerance
    );
    expect(mockFetch.mock.calls.length).toBe(1);
  });

  describe("dynamic output schema", () => {
    const props = (task: FetchUrlTask) => {
      const schema = task.outputSchema();
      if (typeof schema === "boolean" || !schema.properties) throw new Error("no properties");
      return schema.properties as Record<string, any>;
    };

    test("stream yields body + metadata only", () => {
      const task = new FetchUrlTask({
        defaults: { url: "https://api.example.com/t", response_type: "stream" },
      });
      expect(Object.keys(props(task)).sort()).toEqual(["body", "metadata"]);
    });

    test("body is always present and declares binary streaming", () => {
      for (const rt of ["stream", "text", "json", "blob", "arraybuffer"] as const) {
        const task = new FetchUrlTask({
          defaults: { url: "https://api.example.com/t", response_type: rt },
        });
        expect(props(task).body["x-stream"]).toBe("binary");
        expect(props(task).body.format).toBe("binary");
      }
    });

    test("body is the only streaming port for every response type", () => {
      for (const rt of ["stream", "text", "json", "blob", "arraybuffer"] as const) {
        const task = new FetchUrlTask({
          defaults: { url: "https://api.example.com/t", response_type: rt },
        });
        const streaming = Object.entries(props(task)).filter(([, p]) => p["x-stream"]);
        expect(streaming.map(([name]) => name)).toEqual(["body"]);
      }
    });

    test("json narrows to body + json + metadata", () => {
      const task = new FetchUrlTask({
        defaults: { url: "https://api.example.com/t", response_type: "json" },
      });
      expect(Object.keys(props(task)).sort()).toEqual(["body", "json", "metadata"]);
    });

    test("emits schemaChange when response_type changes", () => {
      const task = new FetchUrlTask({
        defaults: { url: "https://api.example.com/t", response_type: "stream" },
      });
      let fired = false;
      task.on("schemaChange", () => {
        fired = true;
      });
      task.setInput({ response_type: "json" });
      expect(fired).toBe(true);
      expect(Object.keys(props(task)).sort()).toEqual(["body", "json", "metadata"]);
    });
  });

  describe("streaming body", () => {
    test("stream response type yields body bytes and no derived port", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(new Blob([new Uint8Array([1, 2, 3, 4])]), {
            status: 200,
            headers: { "content-type": "application/octet-stream", "content-length": "4" },
          })
        )
      );
      const result = await fetchUrl({ url: "https://example.com/f.bin", response_type: "stream" });
      expect(result.text).toBeUndefined();
      expect(result.json).toBeUndefined();
      expect(result.metadata?.status).toBe(200);
    });

    test("text is byte-identical to a UTF-8 decode of the body", async () => {
      const body = "héllo wörld";
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(body, {
            status: 200,
            headers: { "content-type": "text/plain; charset=utf-8" },
          })
        )
      );
      const result = await fetchUrl({ url: "https://example.com/t.txt", response_type: "text" });
      expect(result.text).toBe(body);
    });

    test("a Content-Length mismatch throws", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(new Blob([new Uint8Array([1, 2])]), {
            status: 200,
            headers: { "content-length": "9" },
          })
        )
      );
      const error = await fetchUrl({
        url: "https://example.com/short.bin",
        response_type: "stream",
      }).catch((e) => e);
      expect(String(error)).toMatch(/content-length/i);
    });

    test("a combined Content-Length with equal duplicates is accepted", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(new Blob([new Uint8Array([1, 2])]), {
            status: 200,
            headers: { "content-length": "2, 2" },
          })
        )
      );
      const result = await fetchUrl({ url: "https://example.com/d.bin", response_type: "stream" });
      expect(result.metadata?.status).toBe(200);
    });

    test("a combined Content-Length with unequal values throws", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(new Blob([new Uint8Array([1, 2])]), {
            status: 200,
            headers: { "content-length": "2, 3" },
          })
        )
      );
      const error = await fetchUrl({
        url: "https://example.com/c.bin",
        response_type: "stream",
      }).catch((e) => e);
      expect(String(error)).toMatch(/content-length/i);
    });

    // A `Content-Length` under a content coding measures the encoded octets,
    // which is not what the loop counts — see the real-transport suite for the
    // round trip. What is pinned here is that the exemption is keyed on the
    // coding and nothing else: `identity` names no coding, so the length still
    // has to be asserted.
    test("a content coding exempts the body from its stated length", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(new Blob([new Uint8Array([1, 2])]), {
            status: 200,
            headers: { "content-length": "9", "content-encoding": "gzip" },
          })
        )
      );
      const result = await fetchUrl({
        url: "https://example.com/e.bin",
        response_type: "stream",
      });
      expect(result.metadata?.status).toBe(200);
    });

    test("Content-Encoding: identity keeps the length assertion", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(new Blob([new Uint8Array([1, 2])]), {
            status: 200,
            headers: { "content-length": "9", "content-encoding": "identity" },
          })
        )
      );
      const error = await fetchUrl({
        url: "https://example.com/i.bin",
        response_type: "stream",
      }).catch((e) => e);
      expect(String(error)).toMatch(/content-length/i);
    });

    // `Headers.get` answers `""`, not `null`, for a header present with no
    // value — so a proxy emitting a bare `Content-Length:` states no size
    // rather than a malformed one, and refusing it would fail the fetch
    // permanently (FETCH_CONTENT_LENGTH_MISMATCH is not retryable).
    test("an empty Content-Length states no size rather than a bad one", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(new Blob([new Uint8Array([1, 2])]), {
            status: 200,
            headers: { "content-length": "" },
          })
        )
      );
      const result = await fetchUrl({ url: "https://example.com/p.bin", response_type: "stream" });
      expect(result.metadata?.status).toBe(200);
    });

    // The server transport hands back a passthrough whose source pipe holds the
    // connection's undici Agent open until that pipe settles — and an unread
    // TransformStream readable never lets it, because its readable HWM is 0.
    // Cancelling is what settles it. Abandoning a non-2xx body without
    // cancelling therefore leaked an Agent and a socket per attempt, ten per
    // job on the queued path's maxAttempts.
    //
    // The socket-level proof is in SafeFetchServerTransport.test.ts; this one
    // is carrier-independent and pins the INTENT (the body gets cancelled)
    // rather than the symptom, so it keeps holding if the transport changes.
    test("an HTTP error cancels the response body instead of abandoning it", async () => {
      let cancelled = false;
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array([1, 2, 3]));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { status: 500, statusText: "Internal Server Error" }
          )
        )
      );

      await expect(
        fetchUrl({ url: "https://example.com/boom", response_type: "stream" })
      ).rejects.toThrow();
      expect(cancelled).toBe(true);
    });

    // What "required" actually buys at the TASK layer, pinned in both
    // directions because the two halves disagree and the disagreement is easy
    // to mis-remember.
    //
    // The schema does list `response_type` in `required`, and `validateInput`
    // rejects a payload without it. But `run()` never presents such a payload:
    // `Task`'s constructor seeds `defaults` from the input schema via
    // `getData(..., { addOptionalProps: true })`, and json-schema-library
    // synthesizes an `enum` property as its FIRST member — which here is
    // "stream". So `new FetchUrlTask().run({ url })` does not throw; it fetches
    // with response_type "stream".
    //
    // That is a gap in the breaking change, not a property to rely on: the
    // stated rationale ("a default would silently pick one for a caller who
    // never considered the question") is met for a persisted job payload — see
    // the FetchUrlJob test below, which is the case that used to complete
    // successfully with no value — and not met for a directly constructed
    // task. Closing it means suppressing the base class's synthesized default,
    // which is a further behaviour change and belongs to its own review. Both
    // assertions are here so that change cannot land unnoticed in either
    // direction.
    test("validateInput rejects a payload with no response_type", async () => {
      const task = new FetchUrlTask();
      await expect(
        task.validateInput({ url: "https://example.com/no-type" } as FetchUrlTaskInput)
      ).rejects.toThrow(TaskInvalidInputError);
    });

    test("run() with no response_type still fetches, defaulted to 'stream' by the base class", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("defaulted", { status: 200 }))
      );
      const task = new FetchUrlTask();
      const result = (await task.run({
        url: "https://example.com/no-type",
      } as FetchUrlTaskInput)) as FetchUrlTaskOutput;

      expect(task.runInputData.response_type).toBe("stream");
      // "stream" materializes nothing, so no derived port is populated.
      expect(result.text).toBeUndefined();
      expect(result.json).toBeUndefined();
      expect(result.metadata?.status).toBe(200);
    });

    // The task layer validates its input, but JobQueueWorker calls
    // job.execute() on a PERSISTED payload with no validation at all. A job
    // enqueued before response_type became required, drained after the deploy
    // that requires it, therefore reaches the job carrying `undefined` — and
    // grouping that with "stream" let it stream, complete, and return
    // `{ metadata }` with no text and no json: a caller that asked for a value
    // got a silent success with no value. This has to go through FetchUrlJob
    // directly; the task layer would reject it first, so only the job
    // reproduces the queued-payload case.
    test("a persisted job payload with no response_type fails before fetching", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("never reached", { status: 200 }))
      );
      const input = { url: "https://example.com/legacy-payload" } as FetchUrlTaskInput;
      const job = new FetchUrlJob<FetchUrlTaskInput, FetchUrlTaskOutput>({ input });

      const error = await job
        .execute(input, { signal: new AbortController().signal, updateProgress: async () => {} })
        .catch((e: unknown) => e);

      expect(isFetchUrlJobError(error)).toBe(true);
      expect((error as { code?: string }).code).toBe(FetchUrlErrorCode.INVALID_RESPONSE_TYPE);
      // Before the request, not after: a payload that cannot produce a result
      // should not spend a network call, and failing ahead of the first delta
      // keeps classifyBodyFailure's retry rule out of it entirely.
      expect(mockFetch).not.toHaveBeenCalled();
    });

    // `Job.ts` forbids retaining a chunk buffer across `emitStreamEvent` —
    // a carrier may transfer it, which detaches the buffer in this realm. The
    // accumulation feeding `text`/`json`/`blob` runs on the same chunk, so a
    // retained reference reads back zero-length and an empty body would be
    // reported as a successful fetch.
    test("a carrier that transfers the emitted chunk cannot empty the derived port", async () => {
      const parts = ["first-", "second-", "third"];
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                // Separately allocated chunks: detaching one buffer must not
                // reach into the next.
                for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
                controller.close();
              },
            }),
            { status: 200, headers: { "content-type": "text/plain" } }
          )
        )
      );

      const input = {
        url: "https://example.com/transfer.txt",
        response_type: "text",
      } as FetchUrlTaskInput;
      const job = new FetchUrlJob<FetchUrlTaskInput, FetchUrlTaskOutput>({ input });
      const lengthsAfterEmit: number[] = [];
      const yielded: Uint8Array[] = [];
      let finish: FetchUrlTaskOutput | undefined;
      // Drained rather than run through `execute()`: the yielded delta is the
      // half that fails SILENTLY. A detached one carries no bytes, so `body`
      // ends up empty with nothing raised, while the accumulated copy at least
      // throws on the decode.
      for await (const event of job.executeStream(input, {
        signal: new AbortController().signal,
        updateProgress: async () => {},
        emitStreamEvent: async (event) => {
          const delta = (event as { binaryDelta?: Uint8Array }).binaryDelta;
          if (!delta) return;
          // What a transferring carrier does to the buffer it was handed.
          structuredClone(delta.buffer, { transfer: [delta.buffer] });
          lengthsAfterEmit.push(delta.byteLength);
        },
      })) {
        if (event.type === "binary-delta") yielded.push(event.binaryDelta as Uint8Array);
        if (event.type === "finish") finish = event.data as FetchUrlTaskOutput;
      }

      // Without this the test proves nothing: a `structuredClone` that failed
      // to transfer would leave the buffers intact and every build would pass.
      expect(lengthsAfterEmit).toEqual(parts.map(() => 0));
      expect(finish?.text).toBe(parts.join(""));
      expect(new TextDecoder().decode(concatChunks(yielded))).toBe(parts.join(""));
    });

    // -----------------------------------------------------------------------
    // Regression: executeStream() is what TaskRunner actually calls for a
    // FetchUrlTask run (isTaskStreamable is permanently true once
    // executeStream exists), so the queued branch of execute() — queue
    // resolution, rate limiting, retries — is only reachable if executeStream
    // delegates to it. An output-only assertion can't catch a dead delegation:
    // the inline path produces the identical output. The `sendSpy` assertion
    // below is the one that actually distinguishes "ran through the queue"
    // from "ran inline and nobody noticed."
    // -----------------------------------------------------------------------
    test("a successful fetch with config.queue set actually travels through the queue", async () => {
      const queueName = "streaming-success-queue";
      const storage = new InMemoryQueueStorage<FetchUrlTaskInput, FetchUrlTaskOutput>(queueName);
      await storage.migrate();
      const { messageQueue, jobStore } = wrapQueueStorage(storage);
      const server = new JobQueueServer<FetchUrlTaskInput, FetchUrlTaskOutput>(FetchUrlJob, {
        messageQueue,
        jobStore,
        queueName,
        pollIntervalMs: 1,
      });
      const client = new JobQueueClient<FetchUrlTaskInput, FetchUrlTaskOutput>({
        messageQueue,
        jobStore,
        queueName,
      });
      client.attach(server);
      // Registering under `queueName` is what makes FetchUrlTask's own
      // resolveOrCreateQueue() find and reuse THIS client/server pair instead
      // of minting its own — see resolveOrCreateQueue's registry.getQueue lookup.
      getTaskQueueRegistry().registerQueue({ server, client, storage });
      const sendSpy = vi.spyOn(client, "send");

      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response("hello queued world", {
            status: 200,
            headers: { "Content-Type": "text/plain" },
          })
        )
      );

      try {
        await server.start();

        // No credential_key: this must reach the queue, not the
        // credential+queue refusal.
        const task = new FetchUrlTask({ queue: queueName });
        const result = await task.run({
          url: "https://api.example.com/queued-success",
          response_type: "text",
        });

        expect(result.text).toBe("hello queued world");

        // The fetch succeeding proves nothing about *how* it ran — the inline
        // path would produce the identical result. This is the assertion that
        // proves the job travelled through the queue: `executeStream`'s
        // `queuePref !== false` branch is the only code path that calls the
        // registered client's send().
        expect(sendSpy).toHaveBeenCalledTimes(1);
        expect(sendSpy.mock.calls[0]?.[0]).toMatchObject({
          url: "https://api.example.com/queued-success",
        });
        expect(await storage.size(JobStatus.COMPLETED)).toBe(1);
        expect(await storage.size(JobStatus.PENDING)).toBe(0);
        expect(mockFetch.mock.calls.length).toBe(1);
      } finally {
        await server.stop();
        await storage.deleteAll();
      }
    });
  });

  describe("conditional requests", () => {
    test("a 304 answering a conditional request finishes notModified with no body", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 304, headers: { etag: '"v1"' } }))
      );
      const result = await fetchUrl({
        url: "https://example.com/big.zip",
        response_type: "stream",
        headers: { "If-None-Match": '"v1"' },
      });
      expect(result.metadata?.notModified).toBe(true);
      expect(result.metadata?.status).toBe(304);
      expect(result.blob).toBeUndefined();
    });

    test("an unsolicited 304 throws", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 304 })));
      const error = await fetchUrl({
        url: "https://example.com/big.zip",
        response_type: "stream",
      }).catch((e) => e);
      expect(error).toBeInstanceOf(Error);
    });

    test("If-Modified-Since also counts as conditional", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 304 })));
      const result = await fetchUrl({
        url: "https://example.com/big.zip",
        response_type: "stream",
        headers: { "if-modified-since": "Wed, 01 Jan 2025 00:00:00 GMT" },
      });
      expect(result.metadata?.notModified).toBe(true);
    });

    // `TaskRunner` resolves a run's cache three ways — the run config, the
    // task's own runConfig, and a CACHE_REGISTRY binding — and each one caches
    // the bodiless 304 outcome and then serves it back to every later run while
    // the origin moves on to a 200 with different bytes. A guard reading only
    // one of the three leaves the hazard live on the other two, so all three
    // are pinned here.
    describe("a conditional request plus an output cache is refused", () => {
      const conditionalInput = {
        url: "https://example.com/big.zip",
        response_type: "stream",
        headers: { "If-None-Match": '"v1"' },
      } as const;

      beforeEach(() => {
        mockFetch.mockImplementation(() =>
          Promise.resolve(new Response(null, { status: 304, headers: { etag: '"v1"' } }))
        );
      });

      test("via the task's own runConfig", async () => {
        const task = new FetchUrlTask({ queue: false });
        task.runConfig.outputCache = new InMemoryTaskOutputRepository();
        const error = await task.run({ ...conditionalInput }).catch((e) => e);
        expect(String(error)).toMatch(/conditional request/i);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      test("via the run config passed to run()", async () => {
        const task = new FetchUrlTask({ queue: false });
        const error = await task
          .run({ ...conditionalInput }, { outputCache: new InMemoryTaskOutputRepository() })
          .catch((e) => e);
        expect(String(error)).toMatch(/conditional request/i);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      test("via a CACHE_REGISTRY binding on the run's ServiceRegistry", async () => {
        const services = new ServiceRegistry(new Container());
        services.registerInstance(
          CACHE_REGISTRY,
          new DefaultCacheRegistry({ deterministic: new InMemoryTaskOutputRepository() })
        );
        const task = new FetchUrlTask({ queue: false });
        const error = await task
          .run({ ...conditionalInput }, { registry: services })
          .catch((e) => e);
        expect(String(error)).toMatch(/conditional request/i);
        expect(mockFetch).not.toHaveBeenCalled();
      });

      // The refusal is about a cache being in play, not about the header: a run
      // with no cache anywhere still answers a conditional request normally.
      test("but not when the run resolved no cache at all", async () => {
        const services = new ServiceRegistry(new Container());
        const task = new FetchUrlTask({ queue: false });
        const result = await task.run({ ...conditionalInput }, { registry: services });
        expect(result.metadata?.notModified).toBe(true);
      });

      // The three refusals above each pin a way a cache IS present. The run's
      // resolution also answers the other direction: `outputCache: false` on
      // the run overrides the instance field, `TaskRunner` resolves no cache
      // from it, and a guard consulting the overridden field first would refuse
      // a run that can write nowhere.
      test("but not when the run config disables the cache the instance carries", async () => {
        const task = new FetchUrlTask({ queue: false });
        task.runConfig.outputCache = new InMemoryTaskOutputRepository();
        const result = await task.run({ ...conditionalInput }, { outputCache: false });
        expect(result.metadata?.notModified).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });

      // A cache being in play is necessary but not sufficient: every write path
      // in CacheCoordinator (the row save, and the stream sink that mints the
      // `body` ref) returns early on `task.cacheable`, so a non-cacheable task
      // cannot overwrite the copy its 304 validated.
      test("but not when the task itself is not cacheable", async () => {
        const task = new FetchUrlTask({ queue: false }, { cacheable: false });
        task.runConfig.outputCache = new InMemoryTaskOutputRepository();
        const result = await task.run({ ...conditionalInput });
        expect(result.metadata?.notModified).toBe(true);
        expect(mockFetch).toHaveBeenCalledTimes(1);
      });
    });
  });

  describe("HEAD requests", () => {
    // The schema enum is what the UI and validateInput both read. Without HEAD
    // in it a caller that asks for metadata-only is rejected before any request
    // is issued, and the method never reaches SafeFetch.
    test("validateInput accepts method HEAD", async () => {
      const task = new FetchUrlTask();
      await expect(
        task.validateInput({
          url: "https://example.com/big.zip",
          method: "HEAD",
          response_type: "stream",
        })
      ).resolves.toBe(true);
    });

    // A real HEAD 200 has no body: `Response.body` is null, and Content-Length
    // describes the representation a GET would return, not the (empty) bytes
    // we receive. Streaming that as a GET would throw NO_RESPONSE_BODY or
    // CONTENT_LENGTH_MISMATCH. HEAD exists to read status and headers.
    test("a HEAD 200 with no body finishes with metadata and does not stream bytes", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(null, {
            status: 200,
            headers: {
              "Content-Type": "application/zip",
              "Content-Length": "12345",
              ETag: '"v1"',
            },
          })
        )
      );

      const result = await fetchUrl({
        url: "https://example.com/big.zip",
        method: "HEAD",
        response_type: "stream",
      });

      const options = mockFetch.mock.calls.at(-1)?.[1] as { method?: string } | undefined;
      expect(options?.method).toBe("HEAD");
      expect(result.metadata?.status).toBe(200);
      expect(result.metadata?.contentType).toBe("application/zip");
      expect(result.metadata?.headers.etag).toBe('"v1"');
      expect(result.metadata?.headers["content-length"]).toBe("12345");
      expect(result.text).toBeUndefined();
      expect(result.json).toBeUndefined();
      expect(result.blob).toBeUndefined();
    });

    // A HEAD response carries no representation body, so the HEAD branch
    // finishes with metadata alone regardless of response_type — which let
    // {method: "HEAD", response_type: "json"} complete SUCCESSFULLY with
    // json undefined. Same silent success with no value the required
    // response_type change exists to prevent, reached from the other side.
    // Through the job directly, because the task layer rejects it first.
    test("a persisted HEAD payload with a derived response_type fails before fetching", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 200 })));
      const input = {
        url: "https://example.com/big.zip",
        method: "HEAD",
        response_type: "json",
      } as FetchUrlTaskInput;
      const job = new FetchUrlJob<FetchUrlTaskInput, FetchUrlTaskOutput>({ input });

      const error = await job
        .execute(input, { signal: new AbortController().signal, updateProgress: async () => {} })
        .catch((e: unknown) => e);

      expect(isFetchUrlJobError(error)).toBe(true);
      expect((error as { code?: string }).code).toBe(FetchUrlErrorCode.INVALID_RESPONSE_TYPE);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("validateInput rejects HEAD paired with a derived response_type", async () => {
      const task = new FetchUrlTask();
      await expect(
        task.validateInput({
          url: "https://example.com/big.zip",
          method: "HEAD",
          response_type: "text",
        })
      ).rejects.toThrow(TaskInvalidInputError);
    });

    test("a HEAD error status still throws", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(null, { status: 404, statusText: "Not Found" }))
      );
      await expect(
        fetchUrl({
          url: "https://example.com/missing.zip",
          method: "HEAD",
          response_type: "stream",
        })
      ).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // C1 regression: SafeFetch throws permanent FETCH_* errors (SSRF deny, DNS
  // failure, invalid URL, etc). The outer catches in the old fetch helper /
  // FetchUrlJob.execute previously rewrote *every* non-Abort throw into a
  // NETWORK_ERROR (retryable) — burning the full retry budget on a permanent
  // SSRF deny. Each case below asserts the original code/class is preserved.
  //
  // SECURITY: a permanent SSRF deny that gets re-classified as retryable is
  // a privilege-escalation amplifier — the queue worker keeps the
  // (potentially attacker-controlled) URL alive for 10 attempts. Treat any
  // regression here as a security issue.
  // -------------------------------------------------------------------------
  describe("FetchUrlTask permanent error pass-through", () => {
    const permanentCases: ReadonlyArray<{
      readonly label: string;
      readonly code: (typeof FetchUrlErrorCode)[keyof typeof FetchUrlErrorCode];
    }> = [
      { label: "PRIVATE_DENIED", code: FetchUrlErrorCode.PRIVATE_DENIED },
      { label: "SCOPE_DENIED", code: FetchUrlErrorCode.SCOPE_DENIED },
      { label: "INVALID_URL", code: FetchUrlErrorCode.INVALID_URL },
      { label: "DNS_FAILED", code: FetchUrlErrorCode.DNS_FAILED },
      { label: "REDIRECT_MISSING_LOCATION", code: FetchUrlErrorCode.REDIRECT_MISSING_LOCATION },
      { label: "TOO_MANY_REDIRECTS", code: FetchUrlErrorCode.TOO_MANY_REDIRECTS },
      {
        label: "REDIRECT_BODY_NOT_REPLAYED",
        code: FetchUrlErrorCode.REDIRECT_BODY_NOT_REPLAYED,
      },
      { label: "NO_RESPONSE_BODY", code: FetchUrlErrorCode.NO_RESPONSE_BODY },
      { label: "CONFIGURATION", code: FetchUrlErrorCode.CONFIGURATION },
    ];

    for (const { label, code } of permanentCases) {
      test(`${label} thrown by safeFetch is preserved (not rewrapped as NETWORK_ERROR)`, async () => {
        mockFetch.mockImplementation(() =>
          Promise.reject(createFetchUrlJobError(code, `${label} from mock`, { url: "x" }))
        );

        const fetchPromise = fetchUrl({
          url: "https://api.example.com/will-deny",
          response_type: "stream",
        });
        const error = await fetchPromise.catch((e: unknown) => e);
        // JobTaskFailedError wraps at the task layer; assert on `.jobError`.
        const jobErr = (error as { jobError?: unknown }).jobError ?? error;
        expect(isFetchUrlJobError(jobErr)).toBe(true);
        expect((jobErr as { code?: string }).code).toBe(code);
        expect(jobErr).toBeInstanceOf(PermanentJobError);
        // Critical: not rewrapped as NETWORK_ERROR (retryable).
        expect((jobErr as { code?: string }).code).not.toBe(FetchUrlErrorCode.NETWORK_ERROR);
      });
    }

    test("genuine TypeError still wraps to NETWORK_ERROR (positive control)", async () => {
      mockFetch.mockImplementation(() =>
        Promise.reject(new TypeError("connect ECONNREFUSED 127.0.0.1:443"))
      );
      const error = await fetchUrl({
        url: "https://api.example.com/down",
        response_type: "stream",
      }).catch((e: unknown) => e);
      const jobErr = (error as { jobError?: unknown }).jobError ?? error;
      expect(isFetchUrlJobError(jobErr)).toBe(true);
      expect((jobErr as { code?: string }).code).toBe(FetchUrlErrorCode.NETWORK_ERROR);
      expect(jobErr).toBeInstanceOf(RetryableJobError);
    });
  });

  // -------------------------------------------------------------------------
  // A decode failure's message embeds SERVER-CONTROLLED BYTES — V8 quotes a
  // snippet of the body into the SyntaxError. Matching the network-message
  // heuristic against it lets the response decide whether the job is retryable.
  // -------------------------------------------------------------------------
  describe("isFetchUrlNetworkCause", () => {
    test("returns false for a SyntaxError quoting a network-looking response body", () => {
      const decodeFailure = new SyntaxError(
        `Unexpected token 'G', "Gateway timeout at: https://registry.example/pkg" is not valid JSON`
      );

      expect(isFetchUrlNetworkCause(decodeFailure)).toBe(false);
    });

    test("still returns true for a SyntaxError carrying a network errno code", () => {
      const withCode = new SyntaxError("network timeout") as NodeJS.ErrnoException;
      withCode.code = "ECONNRESET";

      expect(isFetchUrlNetworkCause(withCode)).toBe(true);
    });

    test("still returns true for a SyntaxError whose cause is a socket error", () => {
      const withCause = new SyntaxError("not valid JSON");
      withCause.cause = Object.assign(new Error("terminated"), { code: "UND_ERR_SOCKET" });

      expect(isFetchUrlNetworkCause(withCause)).toBe(true);
    });

    test("keeps message matching for non-SyntaxError decode failures", () => {
      // The Bun body-abort shape: a bare Error with no code and no cause.
      expect(
        isFetchUrlNetworkCause(new Error("The socket connection was closed unexpectedly"))
      ).toBe(true);
    });

    test("returns true for the undici terminated/UND_ERR_SOCKET shape", () => {
      const terminated = new TypeError("terminated");
      terminated.cause = Object.assign(new Error("other side closed"), {
        code: "UND_ERR_SOCKET",
      });

      expect(isFetchUrlNetworkCause(terminated)).toBe(true);
    });
  });

  describe("decode failures whose body reads like a network error", () => {
    const decodeBodies: ReadonlyArray<string> = [
      "network timeout at: https://registry.example/pkg",
      "Gateway timeout",
      "ECONNRESET while proxying",
    ];

    for (const body of decodeBodies) {
      test(`"${body}" served as 200 JSON is a permanent parse error`, async () => {
        mockFetch.mockImplementation(() =>
          Promise.resolve(
            new Response(body, {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          )
        );

        const error = await fetchUrl({
          url: "https://api.example.com/decode-fail",
          response_type: "json",
        }).catch((e: unknown) => e);
        const jobErr = (error as { jobError?: unknown }).jobError ?? error;

        expect((jobErr as { code?: string }).code).toBe(FetchUrlErrorCode.RESPONSE_PARSE_ERROR);
        expect(jobErr).toBeInstanceOf(PermanentJobError);
        expect(isFetchUrlRetryableErrorCode((jobErr as { code?: string }).code)).toBe(false);
      });
    }
  });

  describe("credentials", () => {
    const SECRET = "sk-super-secret-value-1234567890";
    const CREDENTIAL_KEY = "my-api-credential";

    /**
     * Builds a registry scoped to its own container so the credential store
     * never leaks into the global registry shared by the other suites.
     */
    const createCredentialRegistry = async (
      entries: Readonly<Record<string, string>> = { [CREDENTIAL_KEY]: SECRET }
    ): Promise<ServiceRegistry> => {
      const registry = new ServiceRegistry(new Container());
      registerCredentialDefaults(registry);
      const store = new InMemoryCredentialStore();
      for (const [key, value] of Object.entries(entries)) {
        await store.put(key, value);
      }
      setGlobalCredentialStore(store, registry);
      return registry;
    };

    const lastRequestHeaders = (): Record<string, string> => {
      const call = mockFetch.mock.calls.at(-1);
      const options = call?.[1] as { headers?: Record<string, string> } | undefined;
      return options?.headers ?? {};
    };

    test("resolves credential_key into an Authorization: Bearer header", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse({ ok: true })));

      const registry = await createCredentialRegistry();
      const task = new FetchUrlTask();
      await task.run(
        { url: "https://api.example.com/data", credential_key: CREDENTIAL_KEY },
        { registry }
      );

      expect(lastRequestHeaders().Authorization).toBe(`Bearer ${SECRET}`);
    });

    test("keeps the secret out of the request body and off the job input", async () => {
      let seenInput: FetchUrlTaskInput | undefined;
      // executeStream is the sole body producer for the inline path (execute()
      // just drains it), so the spy has to sit on executeStream to observe what
      // the job actually receives.
      const originalExecuteStream = FetchUrlJob.prototype.executeStream;
      const spy = vi.spyOn(FetchUrlJob.prototype, "executeStream").mockImplementation(function (
        this: FetchUrlJob,
        input: any,
        context: any
      ) {
        seenInput = input;
        return originalExecuteStream.call(this, input, context);
      });

      try {
        mockFetch.mockImplementation(() => Promise.resolve(createMockResponse({ ok: true })));

        const registry = await createCredentialRegistry();
        const task = new FetchUrlTask();
        await task.run(
          {
            url: "https://api.example.com/data",
            method: "POST",
            body: "payload-without-secrets",
            credential_key: CREDENTIAL_KEY,
          },
          { registry }
        );

        // The resolved secret must never survive as a data port: it is a header,
        // not an input field the job (or a queue) can persist.
        expect(seenInput).toBeDefined();
        expect(seenInput).not.toHaveProperty("credential_key");
        expect(seenInput?.body).toBe("payload-without-secrets");

        const call = mockFetch.mock.calls.at(-1);
        const options = call?.[1] as { body?: string } | undefined;
        expect(options?.body).toBe("payload-without-secrets");
        expect(options?.body ?? "").not.toContain(SECRET);
      } finally {
        spy.mockRestore();
      }
    });

    // -----------------------------------------------------------------------
    // Regression: a resolved secret must never reach durable queue storage.
    // The queued path persists the job input (SQLite/Postgres/SQS), so the
    // credential is refused up front instead of being written to disk.
    // -----------------------------------------------------------------------
    test("refuses the queued path when a credential is present, and persists no secret", async () => {
      const queueName = "credential-leak-queue";
      const storage = new InMemoryQueueStorage<FetchUrlTaskInput, FetchUrlTaskOutput>(queueName);
      await storage.migrate();
      const { messageQueue, jobStore } = wrapQueueStorage(storage);
      const server = new JobQueueServer<FetchUrlTaskInput, FetchUrlTaskOutput>(FetchUrlJob, {
        messageQueue,
        jobStore,
        queueName,
        pollIntervalMs: 1,
      });
      const client = new JobQueueClient<FetchUrlTaskInput, FetchUrlTaskOutput>({
        messageQueue,
        jobStore,
        queueName,
      });
      client.attach(server);
      getTaskQueueRegistry().registerQueue({ server, client, storage });

      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse({ ok: true })));

      try {
        const registry = await createCredentialRegistry();
        const task = new FetchUrlTask({ queue: queueName });
        const error = await task
          .run(
            { url: "https://api.example.com/data", credential_key: CREDENTIAL_KEY },
            { registry }
          )
          .catch((e: unknown) => e);

        // The leak assertion comes first: it is the defect under regression.
        const persisted = JSON.stringify(storage.jobQueue);
        expect(persisted).not.toContain(SECRET);
        expect(await storage.size(JobStatus.PENDING)).toBe(0);

        // ...and the refusal must be explicit, never a silent downgrade to the
        // inline path (which would quietly drop queue-level rate limiting).
        const configError = (error as { cause?: unknown })?.cause ?? error;
        expect(String((configError as Error)?.message ?? "")).toContain("credential");
        expect(String((configError as Error)?.message ?? "")).not.toContain(SECRET);
      } finally {
        await server.stop();
        await storage.deleteAll();
      }
    });

    test("credential_scheme 'header' places the secret in the named header only", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse({ ok: true })));

      const registry = await createCredentialRegistry();
      const task = new FetchUrlTask();
      await task.run(
        {
          url: "https://api.example.com/data",
          credential_key: CREDENTIAL_KEY,
          credential_scheme: "header",
          credential_header: "X-Api-Key",
        },
        { registry }
      );

      const headers = lastRequestHeaders();
      expect(headers["X-Api-Key"]).toBe(SECRET);
      expect(headers.Authorization).toBeUndefined();
    });

    test("credential_scheme 'basic' sends the secret as a Basic credential", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse({ ok: true })));

      const registry = await createCredentialRegistry();
      const task = new FetchUrlTask();
      await task.run(
        {
          url: "https://api.example.com/data",
          credential_key: CREDENTIAL_KEY,
          credential_scheme: "basic",
        },
        { registry }
      );

      expect(lastRequestHeaders().Authorization).toBe(`Basic ${SECRET}`);
    });

    test("credential_scheme 'none' resolves the credential but sends no header", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse({ ok: true })));

      const registry = await createCredentialRegistry();
      const task = new FetchUrlTask();
      await task.run(
        {
          url: "https://api.example.com/data",
          credential_key: CREDENTIAL_KEY,
          credential_scheme: "none",
        },
        { registry }
      );

      const headers = lastRequestHeaders();
      expect(headers.Authorization).toBeUndefined();
      expect(JSON.stringify(headers)).not.toContain(SECRET);
    });

    test("rejects a credential_header carrying CRLF (header injection)", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse({ ok: true })));

      const registry = await createCredentialRegistry();
      const task = new FetchUrlTask();
      const error = await task
        .run(
          {
            url: "https://api.example.com/data",
            credential_key: CREDENTIAL_KEY,
            credential_scheme: "header",
            credential_header: "X-Api-Key\r\nX-Injected: evil",
          },
          { registry }
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      const configError = (error as { cause?: unknown })?.cause ?? error;
      expect(String((configError as Error)?.message ?? "")).toContain("credential_header");
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    test("a missing credential key sends no Authorization and never echoes the key name", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse({ ok: true })));

      // Registry has a store, but not this key.
      const registry = await createCredentialRegistry({ "some-other-key": SECRET });
      const task = new FetchUrlTask();
      await task.run(
        { url: "https://api.example.com/data", credential_key: "absent-key-name" },
        { registry }
      );

      const headers = lastRequestHeaders();
      expect(headers.Authorization).toBeUndefined();
      // Guards the CredentialStoreRegistry invariant: a miss resolves to
      // undefined, never to the reference id, so the key *name* is never
      // threaded through as if it were the secret.
      expect(JSON.stringify(headers)).not.toContain("absent-key-name");
    });

    test("a resolved credential overrides a user-supplied Authorization header", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse({ ok: true })));

      const registry = await createCredentialRegistry();
      const task = new FetchUrlTask();
      await task.run(
        {
          url: "https://api.example.com/data",
          headers: { Authorization: "Bearer hard-coded-token", "X-Trace": "keep-me" },
          credential_key: CREDENTIAL_KEY,
        },
        { registry }
      );

      const headers = lastRequestHeaders();
      expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
      expect(headers["X-Trace"]).toBe("keep-me");
    });

    /**
     * The silent half of the re-run credential bug, and the reason it is fixed
     * in `TaskRunner` rather than in any one task.
     *
     * Input resolution writes the resolved secret back onto `credential_key`
     * itself, and `run()` merges overrides into `runInputData` rather than
     * resetting it — so a second standalone run of the same instance used to
     * look the SECRET up as if it were a key, miss, and leave the port
     * `undefined`. `applyCredentialToHeaders` returns the headers unchanged for
     * a falsy credential, so run 2 went out over the wire with NO
     * `Authorization` header and no error anywhere: an authenticated request
     * silently downgraded to an anonymous one.
     *
     * The key lives in `defaults` here, which is the broken shape. Supplying it
     * as a `run()` override was always safe (`setInput` rewrites that port every
     * run), as was any graph run (`resetGraph` restores the raw id first).
     */
    test("a defaults-configured credential key still authenticates on a re-run", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(createMockResponse({ ok: true })));

      const registry = await createCredentialRegistry();
      const task = new FetchUrlTask({
        defaults: { url: "https://api.example.com/data", credential_key: CREDENTIAL_KEY },
      });

      await task.run({}, { registry });
      expect(lastRequestHeaders().Authorization).toBe(`Bearer ${SECRET}`);

      await task.run({}, { registry });
      expect(lastRequestHeaders().Authorization).toBe(`Bearer ${SECRET}`);

      expect(mockFetch.mock.calls.length).toBe(2);
    });
  });

  describe("applyCredentialToHeaders", () => {
    test("defaults to bearer and leaves other headers intact", () => {
      expect(
        applyCredentialToHeaders({
          headers: { "X-Trace": "abc" },
          credential: "s3cret",
          scheme: undefined,
          headerName: undefined,
        })
      ).toEqual({ "X-Trace": "abc", Authorization: "Bearer s3cret" });
    });

    test("passes a basic credential through verbatim", () => {
      expect(
        applyCredentialToHeaders({
          headers: undefined,
          credential: "dXNlcjpwYXNz",
          scheme: "basic",
          headerName: undefined,
        })
      ).toEqual({ Authorization: "Basic dXNlcjpwYXNz" });
    });

    test("places the credential in a custom header", () => {
      expect(
        applyCredentialToHeaders({
          headers: undefined,
          credential: "s3cret",
          scheme: "header",
          headerName: "X-Api-Key",
        })
      ).toEqual({ "X-Api-Key": "s3cret" });
    });

    test("'none' applies nothing", () => {
      expect(
        applyCredentialToHeaders({
          headers: { "X-Trace": "abc" },
          credential: "s3cret",
          scheme: "none",
          headerName: undefined,
        })
      ).toEqual({ "X-Trace": "abc" });
    });

    test("an absent credential is a no-op", () => {
      expect(
        applyCredentialToHeaders({
          headers: { "X-Trace": "abc" },
          credential: undefined,
          scheme: "bearer",
          headerName: undefined,
        })
      ).toEqual({ "X-Trace": "abc" });
    });

    test.each([
      ["X-Api-Key\r\nX-Injected: evil"],
      ["X-Api Key"],
      ["X-Api:Key"],
      [""],
      ["a".repeat(65)],
    ])("rejects invalid header name %j", (headerName) => {
      expect(() =>
        applyCredentialToHeaders({
          headers: undefined,
          credential: "s3cret",
          scheme: "header",
          headerName,
        })
      ).toThrow(TaskConfigurationError);
    });

    test("replaces a differently-cased header the caller supplied", () => {
      // HTTP header names are case-insensitive, and `new Headers({...})` folds
      // duplicate spellings into one comma-joined field — so leaving the
      // caller's key in place would send the stale token alongside the real one.
      expect(
        applyCredentialToHeaders({
          headers: { authorization: "Bearer stale", "X-Trace": "abc" },
          credential: "s3cret",
          scheme: "bearer",
          headerName: undefined,
        })
      ).toEqual({ "X-Trace": "abc", Authorization: "Bearer s3cret" });

      expect(
        applyCredentialToHeaders({
          headers: { "x-api-key": "stale" },
          credential: "s3cret",
          scheme: "header",
          headerName: "X-Api-Key",
        })
      ).toEqual({ "X-Api-Key": "s3cret" });
    });

    test("validates the header name even when the scheme ignores it", () => {
      expect(() =>
        applyCredentialToHeaders({
          headers: undefined,
          credential: "s3cret",
          scheme: "bearer",
          headerName: "bad\r\nname",
        })
      ).toThrow(TaskConfigurationError);
    });
  });

  // -------------------------------------------------------------------------
  // Regression: confirm @workglow/tasks registers its FETCH_*
  // reconstructor on import so JobQueueClient round-trips persisted codes
  // back to the correct retryable/permanent JobError subclass.
  // -------------------------------------------------------------------------
  describe("FETCH_* codes reconstructed by JobQueueClient", () => {
    class TestableClient<I, O> extends JobQueueClient<I, O> {
      public buildErrorFromCodePublic(message: string, errorCode?: string): JobError {
        return this.buildErrorFromCode(message, errorCode);
      }
    }

    test("FETCH_HTTP_RATE_LIMITED reconstructed by client is RetryableJobError", () => {
      const client = new TestableClient<unknown, unknown>({
        ...createInMemoryQueue<unknown, unknown>("q"),
        queueName: "q",
      });
      const err = client.buildErrorFromCodePublic("rate limited", "FETCH_HTTP_RATE_LIMITED");
      expect(err).toBeInstanceOf(RetryableJobError);
      expect(err.code).toBe("FETCH_HTTP_RATE_LIMITED");
    });

    test("FETCH_PRIVATE_DENIED reconstructed by client is PermanentJobError", () => {
      const client = new TestableClient<unknown, unknown>({
        ...createInMemoryQueue<unknown, unknown>("q"),
        queueName: "q",
      });
      const err = client.buildErrorFromCodePublic("private denied", "FETCH_PRIVATE_DENIED");
      expect(err).toBeInstanceOf(PermanentJobError);
      expect(err).not.toBeInstanceOf(RetryableJobError);
      expect(err.code).toBe("FETCH_PRIVATE_DENIED");
    });
  });
});
