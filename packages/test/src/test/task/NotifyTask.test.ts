/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AbortSignalJobError,
  formatErrorChainForDiagnostics,
  PermanentJobError,
  RetryableJobError,
} from "@workglow/job-queue";
import type { IExecuteContext } from "@workglow/task-graph";
import {
  createPolicyEnforcer,
  createProfilePolicy,
  ENTITLEMENT_ENFORCER,
  Entitlements,
  TaskGraph,
  TaskGraphRunner,
  TaskRegistry,
  Workflow,
} from "@workglow/task-graph";
import {
  createFetchUrlJobError,
  createSafeFetchRedirectError,
  discordNotify,
  DiscordNotifyTask,
  FetchUrlErrorCode,
  registerCommonTasks,
  registerSafeFetch,
  slackNotify,
  SlackNotifyTask,
  urlResourcePattern,
  webhookNotify,
  WebhookNotifyTask,
  type SafeFetchFn,
  type SafeFetchOptions,
} from "@workglow/tasks";
import {
  Container,
  getGlobalCredentialStore,
  SECURITY_LIMITS,
  ServiceRegistry,
} from "@workglow/util";
import { validateSchema } from "@workglow/util/schema";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The token lives in the webhook path, so these URLs are the credential. Every
 * assertion below that checks for `SECRETTOKEN` is guarding the redaction
 * boundary — a failure there is a secret-disclosure bug, not a cosmetic one.
 */
const SLACK_URL = "https://hooks.slack.com/services/T00000000/B00000000/SECRETTOKEN";
const DISCORD_URL = "https://discord.com/api/webhooks/123456789/SECRETTOKEN";
const WEBHOOK_URL = "https://example.com/hooks/SECRETTOKEN";

/** Where a redirecting (or compromised) endpoint would send the payload. */
const REDIRECT_TARGET = "https://attacker.example/collect";

/**
 * Reproduces what both `safeFetch` transports do for a 3xx under
 * `redirect: "error"`: the exported refusal sentinel, built from the requested
 * URL and the 3xx status without ever reading the `Location` header.
 */
function redirectRefusal(url: string, status = 302): Promise<Response> {
  return Promise.reject(createSafeFetchRedirectError(url, status));
}

const mockFetch = vi.fn((_url: string, _options: SafeFetchOptions) =>
  Promise.resolve(new Response("ok", { status: 200 }))
);
const mockSafeFetch: SafeFetchFn = (url, options) => mockFetch(url, options);

function lastCall(): { url: string; options: SafeFetchOptions } {
  const calls = mockFetch.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const [url, options] = calls[calls.length - 1]!;
  return { url, options };
}

function requestHeaders(): Record<string, string> {
  return lastCall().options.headers as Record<string, string>;
}

/**
 * Minimal execute context, used by the few cases that must reach `execute()`
 * directly to bypass schema validation and exercise a runtime guard.
 */
function makeContext(): IExecuteContext {
  return {
    signal: new AbortController().signal,
    updateProgress: async () => {},
    own: <T>(t: T) => t,
    disown: () => {},
    registry: undefined as unknown as IExecuteContext["registry"],
    resourceScope: undefined,
  };
}

describe("Webhook notification tasks", () => {
  let prevSafeFetch: SafeFetchFn;

  beforeAll(() => {
    prevSafeFetch = registerSafeFetch(mockSafeFetch);
  });

  afterAll(() => {
    registerSafeFetch(prevSafeFetch);
  });

  beforeEach(() => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(() => Promise.resolve(new Response("ok", { status: 200 })));
  });

  describe("WebhookNotifyTask", () => {
    test("POSTs the payload as JSON and returns the response body", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("accepted", { status: 202, statusText: "Accepted" }))
      );

      const result = await webhookNotify({
        url: WEBHOOK_URL,
        payload: { event: "deploy", ok: true },
      });

      expect(result).toEqual({ success: true, status: 202, response: "accepted" });

      const { url, options } = lastCall();
      expect(url).toBe(WEBHOOK_URL);
      expect(options.method).toBe("POST");
      expect(requestHeaders()["Content-Type"]).toBe("application/json");
      expect(options.body).toBe(JSON.stringify({ event: "deploy", ok: true }));
    });

    test("merges caller headers over the JSON content type", async () => {
      await webhookNotify({
        url: WEBHOOK_URL,
        payload: { a: 1 },
        headers: { "X-Custom": "yes" },
      });

      expect(requestHeaders()).toEqual({
        "Content-Type": "application/json",
        "X-Custom": "yes",
      });
    });

    test("truncates a large response body to 1KB", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("x".repeat(4096), { status: 200 }))
      );

      const result = await webhookNotify({ url: WEBHOOK_URL, payload: {} });

      expect(result.response).toBe(`${"x".repeat(1024)}...`);
    });

    test("fails with a configuration error when no URL is available", async () => {
      const error = await webhookNotify({ payload: {} }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PermanentJobError);
      expect((error as PermanentJobError).code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect(mockFetch.mock.calls.length).toBe(0);
    });
  });

  describe("SlackNotifyTask", () => {
    test("POSTs the message and reports the status", async () => {
      const result = await slackNotify({ url: SLACK_URL, text: "deploy finished" });

      expect(result).toEqual({ success: true, status: 200 });

      const { url, options } = lastCall();
      expect(url).toBe(SLACK_URL);
      expect(options.method).toBe("POST");
      expect(requestHeaders()["Content-Type"]).toBe("application/json");
      expect(options.body).toBe(JSON.stringify({ text: "deploy finished", link_names: false }));
    });

    // An unset array port materializes as `[]`, which Slack rejects, so an
    // empty `blocks` list must be dropped rather than sent.
    test("omits absent optional fields entirely", async () => {
      await slackNotify({ url: SLACK_URL, text: "hi" });

      const body = lastCall().options.body as string;
      expect(body).toBe('{"text":"hi","link_names":false}');
      expect(body).not.toContain("username");
      expect(body).not.toContain("blocks");
      expect(body).not.toContain("undefined");
    });

    test("includes optional fields when supplied", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "hi",
        blocks: [{ type: "section" }],
        username: "deploybot",
        icon_emoji: ":rocket:",
      });

      expect(lastCall().options.body).toBe(
        JSON.stringify({
          text: "hi",
          blocks: [{ type: "section" }],
          username: "deploybot",
          icon_emoji: ":rocket:",
          link_names: false,
        })
      );
    });

    test("surfaces the Slack failure body in a permanent error", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("invalid_payload", { status: 400, statusText: "Bad Request" }))
      );

      const error = await slackNotify({ url: SLACK_URL, text: "hi" }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
      const jobError = error as PermanentJobError;
      expect(jobError.code).toBe(FetchUrlErrorCode.HTTP_CLIENT_ERROR);
      expect(jobError.message).toContain("400");
      expect(jobError.message).toContain("invalid_payload");
    });

    test("429 with Retry-After produces a retryable error with a retry date", async () => {
      const before = Date.now();
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response("rate_limited", {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "Retry-After": "30" },
          })
        )
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as RetryableJobError;

      expect(error).toBeInstanceOf(RetryableJobError);
      expect(error.code).toBe(FetchUrlErrorCode.HTTP_RATE_LIMITED);
      expect(error.retryDate).toBeInstanceOf(Date);
      const expected = before + 30_000;
      expect(error.retryDate!.getTime()).toBeGreaterThan(expected - 1000);
      expect(error.retryDate!.getTime()).toBeLessThan(expected + 1000);
    });

    // `Retry-After` is whatever the endpoint says it is. Unclamped, a huge
    // delay pushes the timestamp past the maximum representable Date, and the
    // resulting Invalid Date is what the job queue reschedules from: its NaN
    // delay throws a RangeError out of `toISOString()`, which the worker
    // swallows, so the job is never rescheduled at all.
    test("an absurd Retry-After is clamped instead of overflowing the date", async () => {
      const before = Date.now();
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response("rate_limited", {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "Retry-After": "1e20" },
          })
        )
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as RetryableJobError;

      expect(error).toBeInstanceOf(RetryableJobError);
      expect(error.retryDate).toBeInstanceOf(Date);
      expect(Number.isFinite(error.retryDate!.getTime())).toBe(true);
      expect(error.retryDate!.getTime()).toBeGreaterThanOrEqual(before);
      expect(error.retryDate!.getTime()).toBeLessThanOrEqual(
        before + SECURITY_LIMITS.httpRetryAfterMaxSeconds * 1000 + 1000
      );
    });

    // The HTTP-date form of the header needs the same ceiling for a different
    // reason: this one parses into a perfectly valid Date, and parks the job
    // until the year 9999.
    test("a far-future HTTP-date Retry-After is clamped to the ceiling", async () => {
      const before = Date.now();
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response("rate_limited", {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "Retry-After": "Fri, 01 Jan 9999 00:00:00 GMT" },
          })
        )
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as RetryableJobError;

      expect(error).toBeInstanceOf(RetryableJobError);
      expect(error.retryDate).toBeInstanceOf(Date);
      expect(error.retryDate!.getTime()).toBeLessThanOrEqual(
        before + SECURITY_LIMITS.httpRetryAfterMaxSeconds * 1000 + 1000
      );
    });

    test("a network rejection becomes a retryable network error", async () => {
      mockFetch.mockImplementation(() =>
        Promise.reject(new TypeError("connect ECONNREFUSED 93.184.216.34:443"))
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as RetryableJobError;

      expect(error).toBeInstanceOf(RetryableJobError);
      expect(error.code).toBe(FetchUrlErrorCode.NETWORK_ERROR);
      expect(error.message).toContain("ECONNREFUSED");
    });

    // undici rejects EVERY connection failure as `TypeError: fetch failed` and
    // puts the text that says why on `.cause`. Reporting only the outer message
    // makes a refused connection, an unresolvable host and a TLS failure read
    // identically. The cause's message is lifted; the cause OBJECT is not,
    // because `formatErrorChainForDiagnostics` persists every link's message
    // and stack and would re-import the unredacted URL.
    test("a network rejection lifts its cause message without importing the URL", async () => {
      mockFetch.mockImplementation(() =>
        Promise.reject(
          new TypeError("fetch failed", {
            cause: new Error(`connect ECONNREFUSED to ${SLACK_URL}`),
          })
        )
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as RetryableJobError;

      expect(error).toBeInstanceOf(RetryableJobError);
      expect(error.message).toContain("ECONNREFUSED");
      expect(error.message).not.toContain("SECRETTOKEN");
      expect(error.cause).toBeUndefined();
      expect(formatErrorChainForDiagnostics(error)).not.toContain("SECRETTOKEN");
    });

    // `leaksUrl` used to ask only the message and the `url` field. A typed
    // error can carry the token in its STACK alone — V8 bakes the message of
    // whatever threw into it — and such an error was passed through untouched.
    test("a typed error leaking the token only through its stack is rewritten", async () => {
      mockFetch.mockImplementation(() =>
        Promise.reject(
          Object.assign(
            createFetchUrlJobError(FetchUrlErrorCode.NETWORK_ERROR, "socket hang up", {
              url: "https://hooks.slack.com",
            }),
            { stack: `FetchUrlJobError: socket hang up\n    at post (${SLACK_URL}:1:1)` }
          )
        )
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as RetryableJobError;

      expect(String(error.stack)).not.toContain("SECRETTOKEN");
      expect(formatErrorChainForDiagnostics(error)).not.toContain("SECRETTOKEN");
    });
  });

  describe("DiscordNotifyTask", () => {
    test("POSTs the message content", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));

      await discordNotify({
        url: DISCORD_URL,
        content: "shipped",
        username: "ci",
        avatar_url: "https://example.com/a.png",
        embeds: [{ title: "build" }],
      });

      const { url, options } = lastCall();
      expect(url).toBe(DISCORD_URL);
      expect(options.method).toBe("POST");
      expect(requestHeaders()["Content-Type"]).toBe("application/json");
      expect(options.body).toBe(
        JSON.stringify({
          content: "shipped",
          username: "ci",
          avatar_url: "https://example.com/a.png",
          embeds: [{ title: "build" }],
          allowed_mentions: { parse: [] },
        })
      );
    });

    test("treats 204 No Content as success without parsing a body", async () => {
      const response = new Response(null, { status: 204 });
      const jsonSpy = vi.spyOn(response, "json");
      const textSpy = vi.spyOn(response, "text");
      mockFetch.mockImplementation(() => Promise.resolve(response));

      const result = await discordNotify({ url: DISCORD_URL, content: "shipped" });

      expect(result).toEqual({ success: true, status: 204 });
      expect(jsonSpy).not.toHaveBeenCalled();
      expect(textSpy).not.toHaveBeenCalled();
    });

    // Slack answers 200 with a body it does not want read. The success read now
    // streams via `getReader()`, so a `text()` spy alone would be vacuous —
    // assert the stream is never opened, and IS released.
    test("a body it will not read is cancelled rather than opened", async () => {
      const response = new Response("ok", { status: 200 });
      const textSpy = vi.spyOn(response, "text");
      const readerSpy = vi.spyOn(response.body!, "getReader");
      const cancelSpy = vi.spyOn(response.body!, "cancel");
      mockFetch.mockImplementation(() => Promise.resolve(response));

      await slackNotify({ url: SLACK_URL, text: "hi" });

      expect(textSpy).not.toHaveBeenCalled();
      expect(readerSpy).not.toHaveBeenCalled();
      expect(cancelSpy).toHaveBeenCalled();
      // A second cancel of an already-cancelled body must stay quiet.
      await expect(response.body!.cancel()).resolves.toBeUndefined();
    });

    test("429 with a JSON retry_after body produces a retryable error with a retry date", async () => {
      const before = Date.now();
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ message: "You are being rate limited.", retry_after: 5 }), {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      const error = (await discordNotify({ url: DISCORD_URL, content: "hi" }).catch(
        (e: unknown) => e
      )) as RetryableJobError;

      expect(error).toBeInstanceOf(RetryableJobError);
      expect(error.code).toBe(FetchUrlErrorCode.HTTP_RATE_LIMITED);
      expect(error.retryDate).toBeInstanceOf(Date);
      const expected = before + 5_000;
      expect(error.retryDate!.getTime()).toBeGreaterThan(expected - 1000);
      expect(error.retryDate!.getTime()).toBeLessThan(expected + 1000);
    });

    // The JSON body is even more directly attacker-controlled than the header:
    // it is a number straight out of the response payload.
    test("an absurd JSON retry_after is clamped instead of overflowing the date", async () => {
      const before = Date.now();
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ retry_after: 1e20 }), {
            status: 429,
            statusText: "Too Many Requests",
            headers: { "Content-Type": "application/json" },
          })
        )
      );

      const error = (await discordNotify({ url: DISCORD_URL, content: "hi" }).catch(
        (e: unknown) => e
      )) as RetryableJobError;

      expect(error).toBeInstanceOf(RetryableJobError);
      expect(error.retryDate).toBeInstanceOf(Date);
      expect(Number.isFinite(error.retryDate!.getTime())).toBe(true);
      expect(error.retryDate!.getTime()).toBeGreaterThanOrEqual(before);
      expect(error.retryDate!.getTime()).toBeLessThanOrEqual(
        before + SECURITY_LIMITS.httpRetryAfterMaxSeconds * 1000 + 1000
      );
    });
  });

  describe("secret redaction", () => {
    test("an HTTP failure never echoes the webhook token", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("no_service", { status: 404, statusText: "Not Found" }))
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as PermanentJobError & { url?: string };

      expect(error.message).not.toContain("SECRETTOKEN");
      expect(error.message).toContain("https://hooks.slack.com");
      expect(error.url).not.toContain("SECRETTOKEN");
    });

    test("a network failure never echoes the webhook token", async () => {
      mockFetch.mockImplementation(() => Promise.reject(new Error("boom")));

      const error = (await discordNotify({ url: DISCORD_URL, content: "hi" }).catch(
        (e: unknown) => e
      )) as RetryableJobError & { url?: string };

      expect(error.message).not.toContain("SECRETTOKEN");
      expect(error.message).toContain("https://discord.com");
      expect(error.url).not.toContain("SECRETTOKEN");
    });

    test("a safeFetch error carrying the full URL is rewritten before it escapes", async () => {
      mockFetch.mockImplementation((url: string) =>
        Promise.reject(
          createFetchUrlJobError(
            FetchUrlErrorCode.PRIVATE_DENIED,
            `Refusing to fetch private/internal URL ${url}: loopback`,
            { url }
          )
        )
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as PermanentJobError & { url?: string };

      expect(error.message).not.toContain("SECRETTOKEN");
      expect(error.url).not.toContain("SECRETTOKEN");
      // The classification is preserved even though the message was rewritten.
      expect(error.code).toBe(FetchUrlErrorCode.PRIVATE_DENIED);
      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
    });

    // A rewritten `.message` is not enough: V8 bakes the ORIGINAL message into
    // `.stack`, and stacks are persisted (formatErrorChainForDiagnostics feeds
    // them into the stored job error), so a copied stack re-exports the token.
    test("a rewritten error's .stack never contains the webhook token", async () => {
      mockFetch.mockImplementation((url: string) =>
        Promise.reject(
          createFetchUrlJobError(
            FetchUrlErrorCode.PRIVATE_DENIED,
            `Refusing to fetch private/internal URL ${url}: resolves into RFC1918 space`,
            { url }
          )
        )
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as PermanentJobError & { url?: string };

      const stack = String(error.stack);
      expect(stack).not.toContain("SECRETTOKEN");
      expect(stack).toContain("https://hooks.slack.com");
      // Frames are retained, not thrown away, on a V8 stack.
      expect(stack.split("\n").length).toBeGreaterThan(1);

      // The persisted diagnostics dump walks the cause chain and re-serializes
      // every message + stack it finds — it must find no token, and no cause.
      expect(formatErrorChainForDiagnostics(error)).not.toContain("SECRETTOKEN");
      expect(error.cause).toBeUndefined();
    });

    // Echo endpoints (webhook.site, RequestBin) reply 200 with the request
    // line, so a success body can carry the whole webhook URL straight into
    // the `response` port — which is task output, persisted and pipeable.
    test("a success body echoing the webhook URL is redacted", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(`Received POST ${WEBHOOK_URL}`, { status: 200 }))
      );

      const result = await webhookNotify({ url: WEBHOOK_URL, payload: {} });

      expect(result.response).not.toContain("SECRETTOKEN");
      // The origin stays as the useful diagnostic.
      expect(result.response).toContain("https://example.com");
    });

    // A body cut short by a dead connection used to be returned exactly as a
    // complete short body is, and surfaced as the task's `response` under
    // `success: true` — a fragment presented as the endpoint's whole reply.
    // It is marked, not thrown on: the POST already returned 2xx, so the
    // notification WAS delivered and a throw would post it twice on retry.
    test("a body whose stream fails mid-read is marked truncated, not passed off as whole", async () => {
      // The error must land on a LATER read than the chunk: erroring in the
      // same turn discards what was already enqueued, which would make the
      // fixture a bodiless failure rather than a body cut in half.
      mockFetch.mockImplementation(() => {
        let reads = 0;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(controller) {
                if (reads++ === 0) {
                  controller.enqueue(new TextEncoder().encode("partial-"));
                  return;
                }
                controller.error(new Error("connection reset"));
              },
            }),
            { status: 200 }
          )
        );
      });

      const result = await webhookNotify({ url: WEBHOOK_URL, payload: {} });

      expect(result.success).toBe(true);
      expect(result.response).toBe("partial-...");
    });

    // An endpoint routinely echoes only PART of the URL, which the literal
    // full-URL match never sees. Express answers an unknown route with the
    // PATH and no origin, and Slack sets `includeBodyInError`, so this 404
    // body reaches the error message verbatim.
    test("a failure body echoing only the URL path is redacted", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response("Cannot POST /services/T00000000/B00000000/SECRETTOKEN", {
            status: 404,
            statusText: "Not Found",
          })
        )
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as PermanentJobError;

      expect(error.message).not.toContain("SECRETTOKEN");
      expect(error.message).not.toContain("/services/");
      expect(String(error.stack)).not.toContain("SECRETTOKEN");
      expect(String(error.stack)).not.toContain("/services/");
      expect(formatErrorChainForDiagnostics(error)).not.toContain("SECRETTOKEN");
      expect(formatErrorChainForDiagnostics(error)).not.toContain("/services/");
    });

    test("a failure body quoting the token alone is redacted", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response("token SECRETTOKEN rejected", { status: 403, statusText: "Forbidden" })
        )
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as PermanentJobError;

      expect(error.message).not.toContain("SECRETTOKEN");
      // The surrounding diagnostic survives; only the token is removed.
      expect(error.message).toContain("rejected");
    });

    // The guard against over-redaction. `webhooks` is a real path segment of
    // every Discord webhook URL and is exactly 8 characters, so a length floor
    // alone would delete the word from ordinary prose. It is exempt because it
    // is a named ROUTING segment of a supported provider, not because it is
    // lowercase — this pins the replacement for the deleted lowercase rule.
    test("an ordinary word that happens to be a path segment survives", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response("invalid webhooks payload", { status: 400, statusText: "Bad Request" })
        )
      );

      const error = (await discordNotify({ url: DISCORD_URL, content: "hi" }).catch(
        (e: unknown) => e
      )) as PermanentJobError;

      expect(error.message).toContain("invalid webhooks payload");
      expect(error.message).not.toContain("SECRETTOKEN");
    });

    // A token in the query string is a real deployment shape — plenty of
    // endpoints authenticate with `?token=…` rather than a path segment — and
    // nothing admitted a query VALUE as a redaction candidate. The whole
    // `?token=…` pair was a candidate, but an endpoint echoes the value alone,
    // so the pair never matched and the secret went out verbatim.
    test("a token carried in the query string is redacted from an echoed body", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response("bad token SUPERSECRET1", { status: 403, statusText: "Forbidden" })
        )
      );

      const error = (await slackNotify({
        url: "https://hooks.example.com/notify?token=SUPERSECRET1",
        text: "hi",
      }).catch((e: unknown) => e)) as PermanentJobError;

      expect(error.message).not.toContain("SUPERSECRET1");
      expect(String(error.stack)).not.toContain("SUPERSECRET1");
      // The surrounding diagnostic survives; only the token is removed.
      expect(error.message).toContain("bad token");
    });

    // An all-lowercase path segment was exempted outright, on the theory that
    // such a run is a word rather than a token. A lowercase token is still a
    // token, and the endpoint echoing it does not care about its character
    // class.
    test("an all-lowercase token in the path is redacted from an echoed body", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response("rejected: supersecrettoken", { status: 403, statusText: "Forbidden" })
        )
      );

      const error = (await slackNotify({
        url: "https://hooks.example.com/hooks/supersecrettoken",
        text: "hi",
      }).catch((e: unknown) => e)) as PermanentJobError;

      expect(error.message).not.toContain("supersecrettoken");
      expect(String(error.stack)).not.toContain("supersecrettoken");
      expect(error.message).toContain("rejected");
    });

    // The stated cost of dropping the lowercase exemption, pinned rather than
    // discovered later: a long lowercase word in a generic webhook's path is
    // now redacted out of echoed diagnostics, because nothing distinguishes it
    // from a lowercase token.
    test("a long lowercase path word in a generic webhook is redacted, the accepted cost", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response("unknown notifications route", { status: 404, statusText: "Not Found" })
        )
      );

      const error = (await slackNotify({
        url: "https://hooks.example.com/notifications/deploy",
        text: "hi",
      }).catch((e: unknown) => e)) as PermanentJobError;

      expect(error.message).not.toContain("notifications");
      expect(error.message).toContain("unknown");
    });

    // `statusText` is caller-controlled text just like the body, and it was
    // interpolated into the message and stored as `httpStatusText` with no
    // redaction pass over it at all.
    test("a reason phrase echoing the token is redacted", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("nope", { status: 403, statusText: "token SECRETTOKEN bad" }))
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as PermanentJobError & { httpStatusText?: string };

      expect(error.message).not.toContain("SECRETTOKEN");
      expect(String(error.httpStatusText)).not.toContain("SECRETTOKEN");
    });

    test("the webhook URL is absent from every output schema", () => {
      for (const taskClass of [WebhookNotifyTask, SlackNotifyTask, DiscordNotifyTask]) {
        const schema = taskClass.outputSchema();
        expect(typeof schema).toBe("object");
        if (typeof schema === "object" && schema !== null && "properties" in schema) {
          expect(Object.keys(schema.properties ?? {})).not.toContain("url");
        }
      }
    });
  });

  describe("permanent error pass-through", () => {
    test("a permanent error that does not leak is rethrown unchanged", async () => {
      const thrown = createFetchUrlJobError(
        FetchUrlErrorCode.SCOPE_DENIED,
        "outside granted network:private scope",
        { url: "https://internal.example/" }
      );
      mockFetch.mockImplementation(() => Promise.reject(thrown));

      const error = await slackNotify({ url: SLACK_URL, text: "hi" }).catch((e: unknown) => e);

      expect(error).toBe(thrown);
      expect((error as PermanentJobError).code).toBe(FetchUrlErrorCode.SCOPE_DENIED);
      expect((error as PermanentJobError).code).not.toBe(FetchUrlErrorCode.NETWORK_ERROR);
      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
    });
  });

  describe("registration and Workflow wiring", () => {
    test("registerCommonTasks registers all three notification tasks", () => {
      registerCommonTasks();

      expect(TaskRegistry.all.get("WebhookNotifyTask")).toBeDefined();
      expect(TaskRegistry.all.get("SlackNotifyTask")).toBeDefined();
      expect(TaskRegistry.all.get("DiscordNotifyTask")).toBeDefined();
    });

    test("declared schemas are valid", () => {
      for (const taskClass of [WebhookNotifyTask, SlackNotifyTask, DiscordNotifyTask]) {
        expect(validateSchema(taskClass.inputSchema()).valid).toBe(true);
        expect(validateSchema(taskClass.outputSchema()).valid).toBe(true);
      }
    });

    test("Workflow.slackNotify runs end to end", async () => {
      const workflow = new Workflow();
      workflow.slackNotify({ url: SLACK_URL, text: "from workflow" });

      const results = await workflow.run();

      expect(results).toEqual({ success: true, status: 200 });
      expect(lastCall().options.body).toBe(
        JSON.stringify({ text: "from workflow", link_names: false })
      );
    });

    test("Workflow.webhookNotify and Workflow.discordNotify are installed", () => {
      const workflow = new Workflow();
      expect(typeof workflow.webhookNotify).toBe("function");
      expect(typeof workflow.discordNotify).toBe("function");
    });
  });

  describe("private-destination entitlements", () => {
    const requiresPrivate = (task: WebhookNotifyTask): boolean =>
      task.entitlements().entitlements.some((e) => e.id === "network:private");

    test("a public URL needs no network:private entitlement", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = {
        url: WEBHOOK_URL,
        payload: {},
        allow_private_destination: false,
      } as any;
      expect(requiresPrivate(task)).toBe(false);
    });

    // The destination is not knowable at entitlement-evaluation time — the
    // enforcer runs before the credential resolver — so the requirement is
    // driven by the DECLARATION, not by grading a URL that may be a decoy.
    test("a private URL alone declares no network:private", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = {
        url: "http://127.0.0.1:9200/ingest",
        payload: {},
        allow_private_destination: false,
      } as any;
      expect(requiresPrivate(task)).toBe(false);
    });

    test("a private URL with allow_private_destination requires network:private", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = {
        url: "http://127.0.0.1:9200/ingest",
        payload: {},
        allow_private_destination: true,
      } as any;
      expect(requiresPrivate(task)).toBe(true);
    });

    // Inverted: a credential key no longer forces an unscoped private grant on
    // every instance that uses the store. Execute-time enforcement against the
    // URL actually resolved is what keeps that safe.
    test("a credential key alone requires no network:private", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = {
        url: WEBHOOK_URL,
        payload: {},
        url_credential_key: "internal-hook",
        allow_private_destination: false,
      } as any;
      expect(requiresPrivate(task)).toBe(false);
    });

    test("an absent url alone requires no network:private", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = { payload: {}, allow_private_destination: false } as any;
      expect(requiresPrivate(task)).toBe(false);
    });

    // An unset flag means "not yet knowable" — a root task's run-input lands
    // after entitlements are evaluated — so the declaration fails closed.
    test("an unset allow_private_destination declares network:private", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = { url: WEBHOOK_URL, payload: {} } as any;
      expect(requiresPrivate(task)).toBe(true);
    });

    // The UX guarantee: an ordinary instance carries the schema default, so a
    // public Slack/Discord/webhook post never demands network:private. Deleting
    // `default: false` from the schema would break this.
    test("the schema default keeps an ordinary instance off network:private", () => {
      const task = new WebhookNotifyTask({ defaults: { url: WEBHOOK_URL, payload: {} } });
      expect(requiresPrivate(task)).toBe(false);
    });

    test("a declared private destination is scoped to the url port", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = {
        url: "http://127.0.0.1:9200/ingest",
        payload: {},
        allow_private_destination: true,
      } as any;
      const granted = task.entitlements().entitlements.find((e) => e.id === "network:private");
      expect(granted?.resources).toEqual(["http://127.0.0.1:9200/*"]);
    });

    // With a credential key the URL is genuinely unknown here, so the grant
    // cannot be scoped and says so rather than pretending otherwise.
    test("a declared private destination behind a credential key is unscoped", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = {
        url: WEBHOOK_URL,
        payload: {},
        url_credential_key: "internal-hook",
        allow_private_destination: true,
      } as any;
      const granted = task.entitlements().entitlements.find((e) => e.id === "network:private");
      expect(granted).toBeDefined();
      expect(granted!.resources).toBeUndefined();
    });

    // The two credential ports have DIFFERENT consequences for scoping, which
    // is the whole reason `webhookPrivateEntitlements` takes them separately.
    // `url_credential_key` hides the destination, so the grant cannot name one.
    // `credential_key` only decides what the request CARRIES — the `url` port is
    // still the destination and is still perfectly knowable here — so unscoping
    // on it would hand out a wildcard `network:private` grant for no reason.
    test("a header credential key does not unscope a declared private destination", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = {
        url: "http://127.0.0.1:9200/ingest",
        payload: {},
        credential_key: "deploy-token",
        allow_private_destination: true,
      } as any;
      const granted = task.entitlements().entitlements.find((e) => e.id === "network:private");
      expect(granted?.resources).toEqual(["http://127.0.0.1:9200/*"]);
    });

    // `optional: true` entitlements are skipped outright by evaluatePolicy, so
    // a decorative declaration is no gate at all on the instance that really
    // reaches into the credential store.
    test("a configured credential key makes the credential entitlement enforced", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = { payload: {}, url_credential_key: "hook" } as any;
      const credential = task.entitlements().entitlements.find((e) => e.id === "credential");
      expect(credential).toBeDefined();
      expect(credential!.optional).not.toBe(true);
    });

    // The other half of the split: a header credential reads the store just as
    // surely as a URL credential does, so it must enforce the `credential`
    // entitlement even though it changes nothing about scoping.
    test("a header credential key alone makes the credential entitlement enforced", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = { url: WEBHOOK_URL, payload: {}, credential_key: "deploy-token" } as any;
      const credential = task.entitlements().entitlements.find((e) => e.id === "credential");
      expect(credential).toBeDefined();
      expect(credential!.optional).not.toBe(true);
    });

    test("without a credential key the credential entitlement stays optional", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = { url: WEBHOOK_URL, payload: {} } as any;
      const credential = task.entitlements().entitlements.find((e) => e.id === "credential");
      expect(credential?.optional).toBe(true);
    });
  });

  // A workflow piping a fetch result or a model summary into `content`/`text`
  // would otherwise ping an entire server on every run — and a retry loop turns
  // that into a mass-notification amplifier the caller cannot switch off, since
  // `additionalProperties: false` means no caller can supply `allowed_mentions`
  // themselves.
  describe("mention neutering", () => {
    test("Discord suppresses every mention class by default", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));

      await discordNotify({ url: DISCORD_URL, content: "@everyone deploy done" });

      expect(lastCall().options.body as string).toContain('"allowed_mentions":{"parse":[]}');
    });

    test("Discord honors allow_mentions", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));

      await discordNotify({
        url: DISCORD_URL,
        content: "@everyone deploy done",
        allow_mentions: true,
      });

      expect(lastCall().options.body as string).not.toContain("allowed_mentions");
    });

    // In `text` the default is now total entity escaping, which subsumes the
    // `<!` broadcast escape — the closing `>` is escaped too, so the assertion
    // reads `&lt;!channel&gt;` rather than `&lt;!channel>`. The broadcast is
    // just as dead; a broader remedy replaced a narrower one on this field. The
    // narrow form is still what `blocks` and `allow_markup` produce, and is
    // asserted as such in the cases below.
    test("Slack neutralizes channel-wide broadcasts by default", async () => {
      await slackNotify({ url: SLACK_URL, text: "<!channel> deploy done" });

      const body = lastCall().options.body as string;
      expect(body).toContain("&lt;!channel&gt;");
      expect(body).not.toContain("<!channel>");
      expect(body).toContain('"link_names":false');
    });

    test("Slack neutralizes here, everyone and subteam broadcasts too", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "<!here> <!everyone> <!subteam^S123>",
      });

      const body = lastCall().options.body as string;
      for (const form of ["<!here>", "<!everyone>", "<!subteam^S123>"]) {
        expect(body).not.toContain(form);
      }
    });

    /**
     * REPLACES "Slack leaves links and single-user mentions intact", which
     * pinned "a caller-supplied `<url|label>` reaches Slack verbatim" as a
     * guarantee. Under this task's own threat model — content piped in from a
     * fetch or a model — that guarantee IS the vulnerability: the label is
     * attacker-chosen and Slack renders it in place of the URL, so
     * `<https://evil.example|Deploy succeeded>` is a phishing link that reads
     * as a status update.
     *
     * Both halves of the old assertion survive, moved behind `allow_markup`.
     */
    test("Slack escapes markup in text by default", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "<https://x/|y> pinged <@U1>",
      });

      expect(JSON.parse(lastCall().options.body as string).text).toBe(
        "&lt;https://x/|y&gt; pinged &lt;@U1&gt;"
      );
    });

    test("allow_markup keeps links and single-user mentions intact", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "<https://x/|y> pinged <@U1>",
        allow_markup: true,
      });

      const body = lastCall().options.body as string;
      expect(body).toContain("<https://x/|y>");
      expect(body).toContain("<@U1>");
    });

    // `<!` is Slack's CONTROL-SEQUENCE sigil, not a broadcast sigil, and
    // `<!date^…>` is the one documented member of that family that can notify
    // nobody. Escaping it is pure collateral: Slack un-escapes the entity for
    // display, so the message shows the raw token.
    //
    // These four cases and the one below all set `allow_markup` for a single
    // shared reason: a date token is markup, and `text` is entity-escaped by
    // default, so the exemption they exercise only has anything to exempt on
    // the markup rung. Nothing about the exemption itself changed — the
    // date-token-in-`blocks` case further down needs no flag and is the one
    // that still pins `(?!!)` on the default path.
    test("a Slack date token survives the broadcast escape", async () => {
      const text = "Deploy at <!date^1700000000^{date_short}|Nov 14>";
      await slackNotify({ url: SLACK_URL, text, allow_markup: true });

      expect(JSON.parse(lastCall().options.body as string).text).toBe(text);
    });

    // The exemption is the token's whole SHAPE, so a fallback carrying a `<`
    // is a shape the matcher cannot finish verifying — the token is escaped
    // WHOLE rather than exempted with a live broadcast inside it. Previously
    // the two-character `<!` prefix was exempt on its own and this asserted a
    // surviving `<!date^`; a matcher that cannot verify a token fails closed.
    test("a broadcast inside a date token's fallback escapes the whole token", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "<!date^1700000000^{date_short}|<!channel>>",
        allow_markup: true,
      });

      const posted = JSON.parse(lastCall().options.body as string).text as string;
      expect(posted).toContain("&lt;!channel");
      expect(posted).toContain("&lt;!date");
      expect(posted).not.toContain("<!");
    });

    // Whether Slack accepts an upper-case token is unverified, so the exemption
    // fails closed rather than opening a path nobody has checked.
    test("a case-variant date token is still escaped", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "<!DATE^1700000000^{date_short}|x>",
        allow_markup: true,
      });

      expect(JSON.parse(lastCall().options.body as string).text).toContain("&lt;!DATE");
    });

    // The rung matters: `allow_markup` re-enables LINKS, not pings. A broadcast
    // is still neutralized alongside the date token it sits next to.
    test("channel broadcasts are still neutralized alongside a date token", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "<!channel> ships <!date^1700000000^{date_short}|Nov 14>",
        allow_markup: true,
      });

      const posted = JSON.parse(lastCall().options.body as string).text as string;
      expect(posted).toContain("&lt;!channel>");
      expect(posted).not.toContain("<!channel>");
      expect(posted).toContain("<!date^1700000000^{date_short}|Nov 14>");
    });

    // THE load-bearing assertion for `MASKED_LINK`'s `(?!!)` exemption, and the
    // only date-token case that needs no `allow_markup`: `blocks` is delabeled
    // by default rather than entity-escaped, so the delabeler is live here and
    // `<!date^…|Nov 14>` is a `<…|…>` shape it would otherwise gut. The
    // `|Nov 14` assertion is explicit so the exemption cannot regress silently
    // behind the `toBe` on the whole leaf.
    test("a date token inside blocks survives the deep walk", async () => {
      const token = "<!date^1700000000^{date_short}|Nov 14>";
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: `ships ${token}` } }],
      });

      const posted = JSON.parse(lastCall().options.body as string);
      expect(posted.blocks[0].text.text).toBe(`ships ${token}`);
      expect(posted.blocks[0].text.text).toContain("|Nov 14");
    });

    // `blocks` is as reachable from a pipe or a model as `text` is, so leaving
    // it unescaped left the whole neutering one field away from being bypassed.
    test("Slack neutralizes broadcasts inside blocks", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "<!channel> down" } }],
      });

      const body = lastCall().options.body as string;
      expect(body).toContain("&lt;!channel>");
      expect(body).not.toContain("<!channel>");
    });

    test("Slack neutralizes broadcasts nested in fields and elements", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          { type: "section", fields: [{ type: "mrkdwn", text: "<!here> a" }] },
          { type: "context", elements: [{ type: "mrkdwn", text: "<!subteam^S1> b" }] },
        ],
      });

      const body = lastCall().options.body as string;
      for (const form of ["<!here>", "<!subteam^S1>"]) {
        expect(body).not.toContain(form);
      }
      expect(body).toContain("&lt;!here>");
      expect(body).toContain("&lt;!subteam^S1>");
    });

    /**
     * The `blocks` twin of the pinned `text` case above, and it gets the WEAKER
     * remedy: a blocks leaf cannot be entity-escaped, because the very same
     * shape-agnostic walk that reaches this `text` leaf also reaches `url`,
     * `image_url`, `value` and `action_id` leaves — and escaping `&` in a URL
     * corrupts every query string it touches. So the masking LABEL is dropped
     * and the bare URL is left, which is enough to show a reader where a link
     * really goes. `<@U1>` survives; that is the stated residual.
     */
    test("Slack strips masked link labels inside blocks by default", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "<https://x/|y> <@U1>" } }],
      });

      const posted = JSON.parse(lastCall().options.body as string);
      expect(posted.blocks[0].text.text).toBe("<https://x/> <@U1>");
    });

    test("allow_markup keeps masked links inside blocks intact", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "<https://x/|y> <@U1>" } }],
        allow_markup: true,
      });

      const body = lastCall().options.body as string;
      expect(body).toContain("<https://x/|y>");
      expect(body).toContain("<@U1>");
    });

    test("allow_mentions leaves blocks verbatim", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "<!channel> down" } }],
        allow_mentions: true,
      });

      const body = lastCall().options.body as string;
      expect(body).toContain("<!channel>");
      expect(body).not.toContain("&lt;!");
    });

    /**
     * Link/label injection: the sequence the old pinned tests declared safe.
     *
     * `BROADCAST_SIGIL` escapes only `<!`, so `<https://evil.example|Deploy
     * succeeded>` passed both the lexical escape and the deep walk untouched,
     * and `link_names: false` governs bare `@name` text rather than control
     * sequences. Slack renders the LABEL in place of the URL, so a notification
     * assembled from a fetch result or a model summary could display a phishing
     * destination as a status line.
     */
    test("an injected masked link is escaped in text by default", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "<https://evil.example|Deploy succeeded>",
      });

      const posted = JSON.parse(lastCall().options.body as string).text as string;
      expect(posted).toBe("&lt;https://evil.example|Deploy succeeded&gt;");
      // Nothing Slack will render as a link: no live angle bracket survives.
      expect(posted).not.toContain("<");
      expect(posted).not.toContain(">");
    });

    test("an injected masked link is delabeled inside a blocks leaf", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "<https://evil.example|Deploy succeeded>" },
          },
        ],
      });

      const posted = JSON.parse(lastCall().options.body as string);
      // The destination is still clickable — that is the weaker remedy — but it
      // can no longer masquerade as anything else.
      expect(posted.blocks[0].text.text).toBe("<https://evil.example>");
      expect(posted.blocks[0].text.text).not.toContain("Deploy succeeded");
    });

    // Order inside `escapeSlackText`: `&` must go FIRST. Escaping `<`/`>` first
    // would introduce ampersands that the `&` pass then re-escapes, so `<c>`
    // would arrive as `&amp;lt;c&amp;gt;` and render as the literal `&lt;c&gt;`.
    test("escapeSlackText escapes the ampersand before the angle brackets", async () => {
      await slackNotify({ url: SLACK_URL, text: "a & b <c>" });

      const posted = JSON.parse(lastCall().options.body as string).text as string;
      expect(posted).toBe("a &amp; b &lt;c&gt;");
      expect(posted).not.toContain("&amp;amp;");
      expect(posted).not.toContain("&amp;lt;");
    });

    /**
     * THE regression the whole text/blocks split exists to avoid.
     *
     * `neutralizeSlackBroadcastsDeep` is shape-agnostic on purpose — it cannot
     * tell a `text` leaf from a `url` leaf — so applying `escapeSlackText`
     * inside the walk would turn every `?a=1&b=2` into `?a=1&amp;b=2` and break
     * the link. `<!` is safe to escape everywhere precisely because it has no
     * legitimate occurrence in a URL; `&` has.
     */
    test("a query string in a blocks url leaf is left untouched", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "section",
            accessory: {
              type: "button",
              text: { type: "plain_text", text: "Open" },
              url: "https://ci.example/build?a=1&b=2",
              action_id: "open_build",
            },
          },
        ],
      });

      const posted = JSON.parse(lastCall().options.body as string);
      expect(posted.blocks[0].accessory.url).toBe("https://ci.example/build?a=1&b=2");
      expect(posted.blocks[0].accessory.action_id).toBe("open_build");
      // Byte-identical, stated explicitly: the structural link reduction
      // rewrites the LABEL of a url-bearing object and must never touch the
      // destination it keeps.
      expect(posted.blocks[0].accessory.url).toStrictEqual("https://ci.example/build?a=1&b=2");
      expect((posted.blocks[0].accessory.url as string).length).toBe(
        "https://ci.example/build?a=1&b=2".length
      );
    });

    // The ladder has no dead rung: `allow_mentions` is the strictly wider
    // permission and implies `allow_markup`, so a caller who opted into live
    // pings never has to discover a second flag to get live links back.
    test("allow_mentions implies allow_markup for text", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "<https://x/|y> pinged <@U1>",
        allow_mentions: true,
      });

      expect(JSON.parse(lastCall().options.body as string).text).toBe(
        "<https://x/|y> pinged <@U1>"
      );
    });

    // `allow_markup` re-enables markup only. Broadcasts are `allow_mentions`'
    // business and stay neutralized, in `text` and in `blocks` alike.
    test("allow_markup does not re-enable channel-wide broadcasts", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "<!channel> down",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "<!here> too" } }],
        allow_markup: true,
      });

      const body = lastCall().options.body as string;
      expect(body).toContain("&lt;!channel>");
      expect(body).toContain("&lt;!here>");
      expect(body).not.toContain("<!channel>");
      expect(body).not.toContain("<!here>");
      expect(body).toContain('"link_names":false');
    });

    // Order within a leaf: the broadcast escape runs before the delabeler.
    // Reversed, `MASKED_LINK` cannot match across the inner `<`, so nothing is
    // stripped and the masked link survives with a merely-escaped label.
    test("a masked link whose label hides a broadcast is still delabeled", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "<https://evil.example|<!channel>>" } },
        ],
      });

      const leaf = JSON.parse(lastCall().options.body as string).blocks[0].text.text as string;
      expect(leaf).toContain("<https://evil.example>");
      expect(leaf).not.toContain("<!channel>");
    });

    // A cycle is infinitely deep, so the depth cap terminates it. The failure
    // must be permanent (no retry can fix a caller-authored cycle) and must
    // happen before anything is sent.
    test("a self-referential blocks structure is a permanent configuration error", async () => {
      const block: Record<string, unknown> = { type: "section" };
      block.self = block;

      const error = await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [block] as never,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
      expect((error as PermanentJobError).code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    test("Slack honors allow_mentions", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "<!channel> deploy done",
        allow_mentions: true,
      });

      const body = lastCall().options.body as string;
      expect(body).toContain("<!channel>");
      expect(body).not.toContain("&lt;!");
      expect(body).not.toContain("link_names");
    });

    // The structural half. A `rich_text` message says @channel with an element
    // SHAPE, not with the `<!channel>` sigil, so there is no `<!` for the
    // lexical escape to find and the ping goes out fully live. Escaping every
    // string leaf — which is what the docs called complete — does nothing here.
    test("Slack neutralizes a rich_text broadcast element, which carries no escapable text", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "broadcast", range: "channel" }],
              },
            ],
          },
        ],
      });

      const body = lastCall().options.body as string;
      expect(body).not.toContain('"type":"broadcast"');
      expect(body).not.toContain('"range":"channel"');
      // Rewritten, not deleted: an emptied `elements[]` is rejected by Slack,
      // which would turn this control into an availability bug. `link_names`
      // is already false, so the literal text cannot auto-link.
      expect(body).toContain("@channel");
    });

    // `range` is caller-controlled and the replacement node is BUILT from it
    // rather than visited, so it was the one string leaf in the whole traversal
    // that skipped the lexical escape — a live `<!channel>` handed back inside
    // the node written to neutralize a broadcast.
    test("Slack escapes a broadcast range that smuggles its own sigil", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "broadcast", range: "x<!channel>y" }],
              },
            ],
          },
        ],
      });

      const body = lastCall().options.body as string;
      expect(body).not.toContain("<!channel>");
      expect(body).toContain("&lt;!channel>");
    });

    test("Slack neutralizes a rich_text usergroup ping", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "usergroup", usergroup_id: "S12345678" }],
              },
            ],
          },
        ],
      });

      const body = lastCall().options.body as string;
      expect(body).not.toContain("usergroup_id");
      expect(body).not.toContain("S12345678");
      expect(body).toContain("@usergroup");
    });

    // Asserted rather than assumed: this currently passes for the wrong reason
    // (nothing rewrites the element at all), so it pins the gate rather than
    // documenting it.
    test("allow_mentions leaves a rich_text broadcast element verbatim", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [{ type: "broadcast", range: "channel" }],
              },
            ],
          },
        ],
        allow_mentions: true,
      });

      const body = lastCall().options.body as string;
      expect(body).toContain('"type":"broadcast"');
      expect(body).toContain('"range":"channel"');
    });

    // Narrowness guard: the rewrite keys on `type` alone, so an ordinary block
    // whose type is not a broadcast must pass through untouched — including its
    // own nested `type` fields.
    test("an ordinary section block is not rewritten by the structural pass", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "deploy done" } }],
      });

      const body = lastCall().options.body as string;
      expect(body).toContain('"type":"section"');
      expect(body).toContain('"type":"mrkdwn"');
      expect(body).toContain("deploy done");
    });
  });

  /**
   * Block Kit says `<url|label>` a SECOND way — structurally, with a `url`
   * field beside a label field — and the lexical delabeler cannot see it. A
   * button, a rich_text link and an overflow option each mask an
   * attacker-chosen destination behind an attacker-chosen label with no `<`
   * anywhere in the payload, so the default config (no `allow_markup`, no
   * `allow_mentions`) shipped exactly the phishing primitive the text form is
   * escaped for.
   */
  describe("structural masked links in blocks", () => {
    test("a rich_text link element is reduced to its destination", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  { type: "link", url: "https://evil.example/", text: "Deploy succeeded" },
                ],
              },
            ],
          },
        ],
      });

      const posted = JSON.parse(lastCall().options.body as string);
      const link = posted.blocks[0].elements[0].elements[0];
      expect(link.text).toBe("https://evil.example/");
      expect(link.url).toBe("https://evil.example/");
      expect(lastCall().options.body as string).not.toContain("Deploy succeeded");
    });

    // The destination is KEPT, never deleted: a button with no url and no live
    // action_id handler behind it is an availability change, which is the same
    // argument the broadcast rewrite makes for rewriting rather than deleting.
    test("a button accessory's label cannot mask its url", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "build" },
            accessory: {
              type: "button",
              text: { type: "plain_text", text: "Deploy succeeded" },
              url: "https://evil.example/pwn",
              action_id: "open_build",
            },
          },
        ],
      });

      const accessory = JSON.parse(lastCall().options.body as string).blocks[0].accessory;
      expect(accessory.text.text).toBe("https://evil.example/pwn");
      expect(accessory.url).toBe("https://evil.example/pwn");
      expect(accessory.action_id).toBe("open_build");
    });

    // Pins the rule as SHAPE-driven rather than type-enumerated: an overflow
    // menu's option carries `url` + `text` and no `type` discriminator at all,
    // so any list of element types misses it.
    test("an overflow option's label cannot mask its url", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "actions",
            elements: [
              {
                type: "overflow",
                action_id: "menu",
                options: [
                  {
                    text: { type: "plain_text", text: "Read the changelog" },
                    value: "changelog",
                    url: "https://evil.example/steal",
                  },
                ],
              },
            ],
          },
        ],
      });

      const option = JSON.parse(lastCall().options.body as string).blocks[0].elements[0].options[0];
      expect(option.type).toBeUndefined();
      expect(option.text.text).toBe("https://evil.example/steal");
      expect(option.url).toBe("https://evil.example/steal");
      expect(option.value).toBe("changelog");
    });

    // Narrowness guard. Only objects that ARE links carry a plain `url` beside
    // a label — `image` uses `image_url`/`alt_text` — so the shape rule cannot
    // reach it.
    test("an image block is not treated as a structural link", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "image",
            image_url: "https://ci.example/chart.png?a=1&b=2",
            alt_text: "Build chart",
          },
        ],
      });

      const image = JSON.parse(lastCall().options.body as string).blocks[0];
      expect(image.image_url).toBe("https://ci.example/chart.png?a=1&b=2");
      expect(image.alt_text).toBe("Build chart");
    });

    test("allow_markup keeps a structural link intact", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "section",
            accessory: {
              type: "button",
              text: { type: "plain_text", text: "Deploy succeeded" },
              url: "https://evil.example/pwn",
            },
          },
        ],
        allow_markup: true,
      });

      const accessory = JSON.parse(lastCall().options.body as string).blocks[0].accessory;
      expect(accessory.text.text).toBe("Deploy succeeded");
      expect(accessory.url).toBe("https://evil.example/pwn");
    });

    test("allow_mentions leaves a structural link verbatim", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "section",
            accessory: {
              type: "button",
              text: { type: "plain_text", text: "Deploy succeeded" },
              url: "https://evil.example/pwn",
            },
          },
        ],
        allow_mentions: true,
      });

      const accessory = JSON.parse(lastCall().options.body as string).blocks[0].accessory;
      expect(accessory.text.text).toBe("Deploy succeeded");
      expect(accessory.url).toBe("https://evil.example/pwn");
    });
  });

  /**
   * Slack's date token is `<!date^ts^token_string^optional_link|fallback>`, so
   * the four-field form carries BOTH an attacker-chosen label and an
   * attacker-chosen destination. Exempting it on the two-character `<!date^`
   * prefix re-admitted the very masked link the rest of this file escapes; the
   * exemption is the safe ARITY instead.
   */
  describe("date token arity", () => {
    test("a date token carrying an optional link is escaped in blocks by default", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: "<!date^1700000000^Reset your password^https://evil.example|Nov 14>",
            },
          },
        ],
      });

      const leaf = JSON.parse(lastCall().options.body as string).blocks[0].text.text as string;
      expect(leaf).toContain("&lt;!date");
      expect(leaf).not.toContain("<!date");
      expect(leaf).not.toContain("<!");
    });

    // The structural twin of the same hole: a rich_text `date` element takes an
    // optional `url` and gets its label from `format`/`fallback`, so this is
    // the one shape where DELETING the url is right — the date still renders.
    test("a rich_text date element's optional link is stripped", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "rich_text",
            elements: [
              {
                type: "rich_text_section",
                elements: [
                  {
                    type: "date",
                    timestamp: 1700000000,
                    format: "{date_num}",
                    fallback: "Nov 14",
                    url: "https://evil.example/pwn",
                  },
                ],
              },
            ],
          },
        ],
      });

      const date = JSON.parse(lastCall().options.body as string).blocks[0].elements[0].elements[0];
      expect(Object.hasOwn(date, "url")).toBe(false);
      expect(date.timestamp).toBe(1700000000);
      expect(date.format).toBe("{date_num}");
      expect(date.fallback).toBe("Nov 14");
    });

    // Fail-closed arity guard: a timestamp Slack would not accept is a token
    // this matcher cannot verify, so it is escaped rather than exempted.
    test("a date token with a non-numeric timestamp is escaped", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [
          {
            type: "section",
            text: { type: "mrkdwn", text: "<!date^notatimestamp^{date_short}|Nov 14>" },
          },
        ],
      });

      const leaf = JSON.parse(lastCall().options.body as string).blocks[0].text.text as string;
      expect(leaf).toContain("&lt;!date");
      expect(leaf).not.toContain("<!date");
    });
  });

  describe("request timeouts", () => {
    // Vitest's fake timers do not drive `AbortSignal.timeout` (Node implements
    // it on an internal timer, not the patched global), so the default is
    // asserted at the point it is armed and the behavior with a real short one.
    test("arms an abort signal from the default timeout", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      try {
        await slackNotify({ url: SLACK_URL, text: "hi" });
        expect(timeoutSpy).toHaveBeenLastCalledWith(30000);
        expect(lastCall().options.signal).toBeInstanceOf(AbortSignal);

        mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
        await discordNotify({ url: DISCORD_URL, content: "hi" });
        expect(timeoutSpy).toHaveBeenLastCalledWith(30000);

        mockFetch.mockImplementation(() => Promise.resolve(new Response("ok", { status: 200 })));
        await webhookNotify({ url: WEBHOOK_URL, payload: {} });
        expect(timeoutSpy).toHaveBeenLastCalledWith(30000);
      } finally {
        timeoutSpy.mockRestore();
      }
    });

    test("an endpoint that never answers is aborted by the timeout", async () => {
      mockFetch.mockImplementation(
        (_url, options) =>
          new Promise<Response>((_resolve, reject) => {
            options.signal!.addEventListener("abort", () => {
              reject((options.signal as AbortSignal).reason);
            });
          })
      );

      const error = await slackNotify({ url: SLACK_URL, text: "hi", timeout: 50 }).catch(
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).not.toContain("SECRETTOKEN");
    });

    test("a caller abort surfaces as an abort error, not a retryable network error", async () => {
      mockFetch.mockImplementation(() =>
        Promise.reject(new DOMException("The operation was aborted.", "AbortError"))
      );

      const error = await slackNotify({ url: SLACK_URL, text: "hi" }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(AbortSignalJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
      expect((error as { code?: string }).code).not.toBe(FetchUrlErrorCode.NETWORK_ERROR);
    });

    // `AbortSignal.timeout` validates its delay as a uint32 INTEGER: a
    // fractional value throws a bare `RangeError` a queued consumer cannot
    // classify, and anything past the SIGNED 32-bit range is clamped to 1 ms
    // with a `TimeoutOverflowWarning` — so "effectively never time out" aborts
    // instantly and blames the endpoint. Both are refused, at the schema and
    // again at the runtime guard.
    test("the schema rejects a fractional timeout before any request", async () => {
      const error = await slackNotify({ url: SLACK_URL, text: "hi", timeout: 500.5 }).catch(
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(Error);
      // Rejected by validation, not by the platform timer blowing up on it.
      expect(error).not.toBeInstanceOf(RangeError);
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    test("the schema rejects a timeout past the 32-bit timer bound", async () => {
      const error = await slackNotify({
        url: SLACK_URL,
        text: "hi",
        timeout: 3_000_000_000,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // Reached through `execute` directly, bypassing schema validation, because
    // that is what a queued consumer classifying a failure sees: the guard has
    // to produce a PERMANENT, coded error rather than the platform's
    // `RangeError`, which would be retried forever.
    test("the timeout guard is a classifiable configuration error, not a RangeError", async () => {
      const error = (await new SlackNotifyTask()
        .execute({ url: SLACK_URL, text: "hi", timeout: 500.5 } as never, makeContext())
        .catch((e: unknown) => e)) as PermanentJobError;

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
      expect(error.code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect(error.message).toContain("2147483647");
      expect(error.message).not.toContain("SECRETTOKEN");
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    test("a timeout past the bound is refused rather than firing after 1 ms", async () => {
      const error = (await new SlackNotifyTask()
        .execute({ url: SLACK_URL, text: "hi", timeout: 3_000_000_000 } as never, makeContext())
        .catch((e: unknown) => e)) as PermanentJobError;

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error.code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect(error.message).not.toContain("Timed out");
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    test("the largest honored timeout is accepted", async () => {
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
      try {
        await expect(
          slackNotify({ url: SLACK_URL, text: "hi", timeout: 2147483647 })
        ).resolves.toBeDefined();
        expect(timeoutSpy).toHaveBeenLastCalledWith(2147483647);
      } finally {
        timeoutSpy.mockRestore();
      }
    });

    // The port is duplicated across three task schemas, so the bound is
    // asserted on all three: fixing one and missing the others is the shape
    // this defect already had.
    test("all three notify tasks bound the timeout port identically", () => {
      for (const schema of [
        SlackNotifyTask.inputSchema(),
        DiscordNotifyTask.inputSchema(),
        WebhookNotifyTask.inputSchema(),
      ]) {
        expect((schema.properties as Record<string, unknown>).timeout).toMatchObject({
          type: "integer",
          minimum: 1,
          maximum: 2147483647,
          default: 30000,
        });
      }
    });
  });

  describe("response body cap", () => {
    /** An endless body; `cancelled` flips when the consumer gives up on it. */
    function endlessBody(status: number): { response: Response; cancelled: () => boolean } {
      let cancelled = false;
      const chunk = new Uint8Array(2 * 1024 * 1024).fill(120); // 2MB of "x"
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(chunk.slice());
        },
        cancel() {
          cancelled = true;
        },
      });
      return {
        response: new Response(stream, { status, statusText: "Server Error" }),
        cancelled: () => cancelled,
      };
    }

    test("caps the buffered response body", async () => {
      const { response, cancelled } = endlessBody(200);
      mockFetch.mockImplementation(() => Promise.resolve(response));

      const result = await webhookNotify({ url: WEBHOOK_URL, payload: {} });

      expect(result.response.length).toBeLessThanOrEqual(1024 + 3);
      expect(cancelled()).toBe(true);
    });

    test("caps the failure body too", async () => {
      const { response, cancelled } = endlessBody(500);
      mockFetch.mockImplementation(() => Promise.resolve(response));

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as RetryableJobError;

      expect(error).toBeInstanceOf(RetryableJobError);
      expect(error.message.length).toBeLessThan(2048);
      expect(cancelled()).toBe(true);
    });
  });

  describe("private destinations", () => {
    // Reachability matches FetchUrlTask, but the `response` port would make
    // this a working SSRF READ primitive against a metadata endpoint.
    test("does not echo the response body for a private destination", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("AKIAEXAMPLESECRET", { status: 200 }))
      );

      const result = await webhookNotify({
        url: "http://169.254.169.254/latest/meta-data/",
        payload: { ping: true },
        allow_private_destination: true,
      });

      expect(result.response).toBe("");
      expect(JSON.stringify(result)).not.toContain("AKIA");
      expect(result.status).toBe(200);
    });

    test("refuses a private destination that was not declared", async () => {
      const error = (await webhookNotify({
        url: "http://169.254.169.254/latest/meta-data/",
        payload: { ping: true },
      }).catch((e: unknown) => e)) as PermanentJobError;

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
      expect(error.code).toBe(FetchUrlErrorCode.PRIVATE_DENIED);
      expect(error.message).toContain("allow_private_destination");
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // The declaration is checked against the URL actually resolved, which is
    // the only place a credential-backed destination can be graded at all: the
    // entitlement enforcer runs before the credential resolver does.
    test("a credential resolving to a private URL is refused at execute time", async () => {
      const store = getGlobalCredentialStore();
      await store.put("internal-hook", "http://127.0.0.1:9200/x");
      const error = (await webhookNotify({
        payload: {},
        url_credential_key: "internal-hook",
      })
        .catch((e: unknown) => e)
        .finally(() => store.delete("internal-hook"))) as PermanentJobError;

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error.code).toBe(FetchUrlErrorCode.PRIVATE_DENIED);
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    test("the refusal does not echo the webhook token", async () => {
      const error = (await slackNotify({
        url: "http://127.0.0.1:9200/services/T00000000/B00000000/SECRETTOKEN",
        text: "hi",
      }).catch((e: unknown) => e)) as PermanentJobError & { url?: string };

      expect(error.code).toBe(FetchUrlErrorCode.PRIVATE_DENIED);
      expect(error.message).not.toContain("SECRETTOKEN");
      expect(error.url).not.toContain("SECRETTOKEN");
    });

    // The suppression follows the declaration for the same reason the
    // transport does: the URL alone cannot say whether the host is internal,
    // so a caller who declared it MAY be private never gets its reply back.
    test("a declared private destination never echoes its body, even for a public-looking hostname", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("AKIAEXAMPLESECRET", { status: 200 }))
      );

      const result = await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        allow_private_destination: true,
      });

      expect(result.response).toBe("");
      expect(JSON.stringify(result)).not.toContain("AKIA");
    });

    test("still echoes a public destination's body", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response("pong", { status: 200 })));

      const result = await webhookNotify({ url: WEBHOOK_URL, payload: {} });

      expect(result.response).toBe("pong");
    });
  });

  // `allowPrivate` and `privateResourceScopes` are what the transport itself
  // enforces against, so the arguments each task hands it are pinned here
  // rather than being left implied by the outcome assertions above.
  describe("safeFetch private-destination arguments", () => {
    const PRIVATE_URL = "http://127.0.0.1:9200/ingest";

    test("a public destination is fetched with allowPrivate false and no scopes", async () => {
      await webhookNotify({ url: WEBHOOK_URL, payload: {} });

      expect(lastCall().options.allowPrivate).toBe(false);
      expect(lastCall().options.privateResourceScopes).toBeUndefined();
    });

    test("a declared private destination is scoped to its own origin", async () => {
      await webhookNotify({
        url: PRIVATE_URL,
        payload: {},
        allow_private_destination: true,
      });

      expect(lastCall().options.allowPrivate).toBe(true);
      expect(lastCall().options.privateResourceScopes).toEqual(["http://127.0.0.1:9200/*"]);
    });

    // The DECLARATION governs the transport, not the URL's spelling. A
    // hostname that is no literal IP and matches no reserved suffix classifies
    // public even when it resolves into private space (split-horizon DNS), so
    // deriving `allowPrivate` from that classification leaves the declaration
    // unable to reach the destination it declares. What authorizes the
    // widening is the `network:private` GRANT, re-checked against the URL
    // actually resolved — see the graph-root enforcement cases below.
    test("a declared private destination widens the transport even for a public-looking hostname", async () => {
      await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        allow_private_destination: true,
      });

      expect(lastCall().options.allowPrivate).toBe(true);
      expect(lastCall().options.privateResourceScopes).toEqual(["https://example.com/*"]);
    });

    // The pattern the enforcer graded and the scope the transport re-enforces
    // are the same string, computed once — two independent computations could
    // drift and hand out a scope no grant covered.
    test("the widened transport is scoped to exactly the pattern the grant was checked against", async () => {
      await webhookNotify({ url: PRIVATE_URL, payload: {}, allow_private_destination: true });
      expect(lastCall().options.privateResourceScopes).toEqual([urlResourcePattern(PRIVATE_URL)]);

      await webhookNotify({ url: WEBHOOK_URL, payload: {}, allow_private_destination: true });
      expect(lastCall().options.privateResourceScopes).toEqual([urlResourcePattern(WEBHOOK_URL)]);
    });

    test("Slack and Discord share the same transport arguments", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));

      await slackNotify({ url: PRIVATE_URL, text: "hi", allow_private_destination: true });
      expect(lastCall().options.allowPrivate).toBe(true);
      expect(lastCall().options.privateResourceScopes).toEqual(["http://127.0.0.1:9200/*"]);

      await discordNotify({ url: PRIVATE_URL, content: "hi", allow_private_destination: true });
      expect(lastCall().options.allowPrivate).toBe(true);
      expect(lastCall().options.privateResourceScopes).toEqual(["http://127.0.0.1:9200/*"]);

      await slackNotify({ url: SLACK_URL, text: "hi" });
      expect(lastCall().options.allowPrivate).toBe(false);
      expect(lastCall().options.privateResourceScopes).toBeUndefined();

      await discordNotify({ url: DISCORD_URL, content: "hi" });
      expect(lastCall().options.allowPrivate).toBe(false);
      expect(lastCall().options.privateResourceScopes).toBeUndefined();
    });
  });

  describe("credential misconfiguration", () => {
    // Wiring a bearer token into `url_credential_key` is the likely mistake:
    // for these tasks the credential must BE the whole webhook URL.
    test("a bearer-token credential value fails with a configuration error", async () => {
      const store = getGlobalCredentialStore();
      await store.put("bearer-hook", "Bearer abc123");
      const error = await webhookNotify({
        payload: {},
        url_credential_key: "bearer-hook",
      })
        .catch((e: unknown) => e)
        .finally(() => store.delete("bearer-hook"));

      expect(error).toBeInstanceOf(PermanentJobError);
      expect((error as PermanentJobError).code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect((error as PermanentJobError).message).toContain("absolute http(s) URL");
      expect((error as PermanentJobError).message).not.toContain("abc123");
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // A configured key that the store cannot answer used to fall through to
    // the `url` port and post anyway, reporting success. That silently sends
    // the notification somewhere other than where the operator configured it,
    // and hides an unlocked-store / wrong-key misconfiguration entirely.
    test("a configured credential key the store cannot answer fails closed", async () => {
      const error = await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        url_credential_key: "absent-key",
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PermanentJobError);
      expect((error as PermanentJobError).code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect((error as PermanentJobError).message).toContain("url_credential_key");
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // The discriminator is "the port is present", not "the value is empty", so
    // it must not fire for a task that never configured a credential at all.
    test("an unconfigured credential key leaves the plain url working", async () => {
      const result = await webhookNotify({ url: WEBHOOK_URL, payload: {} });

      expect(result.success).toBe(true);
      expect(lastCall().url).toBe(WEBHOOK_URL);
    });

    test("a non-http scheme is rejected before any request is made", async () => {
      const error = await webhookNotify({ url: "file:///etc/passwd", payload: {} }).catch(
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(PermanentJobError);
      expect((error as PermanentJobError).code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // The header credential's twin of the URL case above, and it failed OPEN:
    // `applyCredentialToHeaders` returns the caller's headers unchanged when
    // the resolved credential is `undefined`, so a locked store or a mistyped
    // key posted the notification UNAUTHENTICATED and reported success.
    test("a configured credential_key the store cannot answer fails closed", async () => {
      const error = (await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        credential_key: "absent-header-key",
      }).catch((e: unknown) => e)) as PermanentJobError;

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error.code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect(error.message).toContain("credential_key");
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // "Resolve but do not send" is a debug affordance, not a reason to swallow
    // a locked store: the operator configured a key either way, so a store
    // that cannot answer is a misconfiguration under every scheme.
    test("a store miss under credential_scheme 'none' also fails closed", async () => {
      const error = (await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        credential_key: "absent-header-key",
        credential_scheme: "none",
      }).catch((e: unknown) => e)) as PermanentJobError;

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error.code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect(error.message).toContain("credential_key");
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // The regression twin of the URL case: the discriminator is "the port is
    // present", so a task that never configured a header credential at all
    // must keep working.
    test("an unconfigured credential_key leaves plain headers working", async () => {
      const result = await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        headers: { "X-Custom": "yes" },
      });

      expect(result.success).toBe(true);
      expect(requestHeaders()).toEqual({
        "Content-Type": "application/json",
        "X-Custom": "yes",
      });
    });
  });

  /**
   * The URL secret has had a redaction pass since this module was written; the
   * HEADER secret had none. `WebhookNotifyTask` sets `readSuccessBody: true`,
   * so an echoing endpoint (webhook.site, RequestBin, a chatty 200) hands up
   * to 1 KB of its own reply straight into the `response` output port — task
   * output, pipeable and persisted with the run — and the only redaction on
   * that path knew the URL and nothing else.
   */
  describe("header credential redaction", () => {
    const HEADER_SECRET = "sk-live-9f3a2b7c1d4e";

    async function withStoredSecret<T>(fn: () => Promise<T>): Promise<T> {
      const store = getGlobalCredentialStore();
      await store.put("echo-token", HEADER_SECRET);
      try {
        return await fn();
      } finally {
        await store.delete("echo-token");
      }
    }

    test("an echoing endpoint cannot return the header credential in the response port", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(`received Authorization: Bearer ${HEADER_SECRET}`))
      );

      const result = await withStoredSecret(() =>
        webhookNotify({ url: WEBHOOK_URL, payload: {}, credential_key: "echo-token" })
      );

      expect(result.response).not.toContain(HEADER_SECRET);
      expect(result.response).toContain("<redacted>");
    });

    // `includeBodyInError: false` already closes the failure-BODY path for this
    // task, so the reason phrase is the error surface actually open to it.
    test("a reason phrase quoting the credential is redacted", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("", { status: 400, statusText: `bad token ${HEADER_SECRET}` }))
      );

      const error = (await withStoredSecret(() =>
        webhookNotify({ url: WEBHOOK_URL, payload: {}, credential_key: "echo-token" }).catch(
          (e: unknown) => e
        )
      )) as PermanentJobError;

      expect(error.message).not.toContain(HEADER_SECRET);
      expect(formatErrorChainForDiagnostics(error)).not.toContain(HEADER_SECRET);
    });

    // undici puts the text that says WHY on `.cause`, and this module lifts
    // that message into its own. A stack is persisted by
    // `formatErrorChainForDiagnostics`, so it gets its own assertion.
    test("a transport error quoting the credential is redacted in message and stack", async () => {
      mockFetch.mockImplementation(() => {
        const err = new TypeError("fetch failed");
        (err as { cause?: unknown }).cause = new Error(`upstream rejected Bearer ${HEADER_SECRET}`);
        return Promise.reject(err);
      });

      const error = (await withStoredSecret(() =>
        webhookNotify({ url: WEBHOOK_URL, payload: {}, credential_key: "echo-token" }).catch(
          (e: unknown) => e
        )
      )) as Error;

      expect(error.message).not.toContain(HEADER_SECRET);
      expect(error.stack ?? "").not.toContain(HEADER_SECRET);
      expect(formatErrorChainForDiagnostics(error)).not.toContain(HEADER_SECRET);
    });

    // Regression guard against reordering: exact secrets are replaced FIRST,
    // then the URL pass runs. Reversed, the URL pass can chop a substring out
    // of a secret and leave the remainder unmatched.
    test("url redaction still applies alongside a header secret", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(`POST ${WEBHOOK_URL} auth=${HEADER_SECRET}`))
      );

      const result = await withStoredSecret(() =>
        webhookNotify({ url: WEBHOOK_URL, payload: {}, credential_key: "echo-token" })
      );

      expect(result.response).not.toContain(HEADER_SECRET);
      expect(result.response).not.toContain("SECRETTOKEN");
    });

    // Redact BEFORE truncate. The success body is cut at 1024 chars, so a
    // secret straddling that boundary is sliced in half — after which it
    // matches no candidate and its first 14 characters sit in task output.
    test("a secret spanning the truncation boundary leaves no usable prefix", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(`${"x".repeat(1010)}${HEADER_SECRET}${"y".repeat(3000)}`.slice(0, 4096))
        )
      );

      const result = await withStoredSecret(() =>
        webhookNotify({ url: WEBHOOK_URL, payload: {}, credential_key: "echo-token" })
      );

      expect(result.response).not.toContain(HEADER_SECRET);
      // The half that would survive truncation must not be a usable prefix.
      expect(result.response).not.toContain(HEADER_SECRET.slice(0, 12));
    });
  });

  // Following a redirect re-issues the SAME request — method, serialized
  // payload and caller headers — at whatever origin the `Location` names. For a
  // notification whose URL (or `Authorization` header) is the credential, one
  // `302` from a merely-misconfigured partner hands the payload to a third
  // party, and every hop re-delivers the message.
  describe("redirect refusal", () => {
    test("every task asks the transport to refuse redirects", async () => {
      await slackNotify({ url: SLACK_URL, text: "hi" });
      expect(lastCall().options.redirect).toBe("error");

      mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
      await discordNotify({ url: DISCORD_URL, content: "hi" });
      expect(lastCall().options.redirect).toBe("error");

      mockFetch.mockImplementation(() => Promise.resolve(new Response("ok", { status: 200 })));
      await webhookNotify({ url: WEBHOOK_URL, payload: {} });
      expect(lastCall().options.redirect).toBe("error");
    });

    test("a refused redirect is a permanent failure and is never re-sent", async () => {
      mockFetch.mockImplementation((url: string) => redirectRefusal(url));

      const error = (await webhookNotify({
        url: WEBHOOK_URL,
        payload: { event: "deploy" },
      }).catch((e: unknown) => e)) as PermanentJobError & { url?: string };

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
      expect(error.code).toBe(FetchUrlErrorCode.INVALID_URL);
      expect(error.code).not.toBe(FetchUrlErrorCode.NETWORK_ERROR);
      expect(error.message).toContain("redirect");
      // The payload must not be replayed at the redirect target.
      expect(mockFetch.mock.calls.length).toBe(1);
    });

    test("the refusal leaks neither the webhook token nor the redirect target", async () => {
      mockFetch.mockImplementation((url: string) => redirectRefusal(url));

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as PermanentJobError & { url?: string };

      expect(error.message).not.toContain("SECRETTOKEN");
      expect(error.message).not.toContain(REDIRECT_TARGET);
      expect(error.message).not.toContain("attacker.example");
      expect(error.message).toContain("https://hooks.slack.com");
      expect(error.url).not.toContain("SECRETTOKEN");
      expect(String(error.stack)).not.toContain("SECRETTOKEN");
      expect(formatErrorChainForDiagnostics(error)).not.toContain("SECRETTOKEN");
    });

    test("Discord's refusal is permanent too", async () => {
      mockFetch.mockImplementation((url: string) => redirectRefusal(url));

      const error = await discordNotify({ url: DISCORD_URL, content: "hi" }).catch(
        (e: unknown) => e
      );

      expect(error).toBeInstanceOf(PermanentJobError);
      expect((error as PermanentJobError).code).toBe(FetchUrlErrorCode.INVALID_URL);
      expect(mockFetch.mock.calls.length).toBe(1);
    });

    // The refusal used to be recognized by its SHAPE — a `TypeError` whose
    // message matched /redirect/i. That fails open: reword the transport's
    // message (a refactor, or an undici change) and the match silently stops,
    // the refusal falls through to the generic branch, and it is relabelled
    // NETWORK_ERROR — which is in FETCH_URL_RETRYABLE_ERROR_CODES. The refused
    // redirect would then be retried, with no test failing. Detection is now
    // the transport's exported discriminant, so the wording is free to change.
    test("a refusal whose message never says 'redirect' is still permanent", async () => {
      mockFetch.mockImplementation((url: string) =>
        Promise.reject(
          createFetchUrlJobError(
            FetchUrlErrorCode.REDIRECT_NOT_FOLLOWED,
            `Fetch for ${url} was answered 307 and the request was not re-sent.`,
            { url, httpStatus: 307 }
          )
        )
      );

      const error = (await webhookNotify({
        url: WEBHOOK_URL,
        payload: { event: "deploy" },
      }).catch((e: unknown) => e)) as PermanentJobError & { url?: string };

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
      expect(error.code).toBe(FetchUrlErrorCode.INVALID_URL);
      expect(error.code).not.toBe(FetchUrlErrorCode.NETWORK_ERROR);
      // The remedy is still named, and the token still redacted.
      expect(error.message).toContain("redirect");
      expect(error.message).toContain("Configure the final URL instead.");
      expect(error.message).not.toContain("SECRETTOKEN");
      expect(String(error.stack)).not.toContain("SECRETTOKEN");
      expect(mockFetch.mock.calls.length).toBe(1);
    });

    // The converse: detection is identity-based in BOTH directions, so prose
    // alone can no longer promote an unrelated failure into the permanent
    // branch. Nothing real lands here — both transports issue their own fetch
    // with `redirect: "manual"`, so the runtime never raises a redirect-mode
    // TypeError of its own — but it pins that the regex is gone.
    test("an ordinary TypeError that merely mentions redirects is not the refusal", async () => {
      mockFetch.mockImplementation(() =>
        Promise.reject(new TypeError("fetch failed after redirect to origin pool"))
      );

      const error = (await webhookNotify({ url: WEBHOOK_URL, payload: {} }).catch(
        (e: unknown) => e
      )) as PermanentJobError & { url?: string };

      expect(error.code).toBe(FetchUrlErrorCode.NETWORK_ERROR);
      expect(error.message).not.toContain("SECRETTOKEN");
    });
  });

  // `includeBodyInError` is set unconditionally by the Slack and Discord tasks,
  // so the private-destination gate has to live at the shared choke point:
  // without it, posting to an internal service returns that service's detailed
  // reply through the error message — the SSRF read the `response` port is
  // already suppressed to prevent.
  describe("private destination failure bodies", () => {
    const PRIVATE_URL = "http://127.0.0.1:9200/_search";
    const ES_BODY = JSON.stringify({
      error: { type: "parsing_exception", reason: "cluster secrets index shard 3" },
    });

    test("Slack does not echo a private endpoint's failure body", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(ES_BODY, { status: 400, statusText: "Bad Request" }))
      );

      const error = (await slackNotify({
        url: PRIVATE_URL,
        text: "x",
        allow_private_destination: true,
      }).catch((e: unknown) => e)) as PermanentJobError & { httpStatus?: number };

      expect(error.message).not.toContain("parsing_exception");
      expect(error.message).not.toContain("cluster secrets index");
      // The status still reports; only the body is withheld.
      expect(error.message).toContain("400");
      expect(error.httpStatus).toBe(400);
    });

    // The body was withheld for a private destination but the reason phrase was
    // not, and a server is free to put anything in it. That left the SSRF read
    // open through a narrower channel: the internal service names its own index
    // in the phrase, and it reached both the message and `httpStatusText`.
    test("Slack does not echo a private endpoint's reason phrase", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(
          new Response(ES_BODY, { status: 400, statusText: "index=cluster-secrets shard=3" })
        )
      );

      const error = (await slackNotify({
        url: PRIVATE_URL,
        text: "x",
        allow_private_destination: true,
      }).catch((e: unknown) => e)) as PermanentJobError & {
        httpStatus?: number;
        httpStatusText?: string;
      };

      expect(error.message).not.toContain("cluster-secrets");
      // The status still reports; only the caller-controlled text is withheld.
      expect(error.message).toContain("400");
      expect(error.httpStatus).toBe(400);
      expect(error.httpStatusText).toBeUndefined();
    });

    test("Discord does not echo a private endpoint's failure body", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(ES_BODY, { status: 400, statusText: "Bad Request" }))
      );

      const error = (await discordNotify({
        url: PRIVATE_URL,
        content: "x",
        allow_private_destination: true,
      }).catch((e: unknown) => e)) as PermanentJobError;

      expect(error.message).not.toContain("parsing_exception");
      expect(error.message).toContain("400");
    });

    test("a public endpoint's failure body is still surfaced", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response("invalid_payload", { status: 400, statusText: "Bad Request" }))
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "x" }).catch(
        (e: unknown) => e
      )) as PermanentJobError;

      expect(error.message).toContain("invalid_payload");
    });

    test("a private endpoint's success body is not read at all", async () => {
      const response = new Response("AKIAEXAMPLESECRET", { status: 200 });
      const readerSpy = vi.spyOn(response.body!, "getReader");
      mockFetch.mockImplementation(() => Promise.resolve(response));

      const result = await webhookNotify({
        url: PRIVATE_URL,
        payload: {},
        allow_private_destination: true,
      });

      expect(result.response).toBe("");
      expect(readerSpy).not.toHaveBeenCalled();
    });
  });

  describe("response body read ceiling", () => {
    test("abandons a failure body past the byte ceiling", async () => {
      const CHUNK_BYTES = 64 * 1024;
      const TOTAL_CHUNKS = 40; // 2.5MB available, well past the 1MB ceiling
      const chunk = new Uint8Array(CHUNK_BYTES).fill(121); // "y"
      let pulled = 0;
      const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulled += 1;
          if (pulled > TOTAL_CHUNKS) {
            controller.close();
            return;
          }
          controller.enqueue(chunk.slice());
        },
      });
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(stream, { status: 500, statusText: "Server Error" }))
      );

      const error = (await slackNotify({ url: SLACK_URL, text: "hi" }).catch(
        (e: unknown) => e
      )) as RetryableJobError;

      expect(error).toBeInstanceOf(RetryableJobError);
      // The read stops at the ceiling rather than buffering the whole body.
      expect(pulled).toBeLessThan(TOTAL_CHUNKS);
      expect(pulled * CHUNK_BYTES).toBeLessThanOrEqual(
        SECURITY_LIMITS.webhookMaxResponseBodyBytes + CHUNK_BYTES
      );
      // What survives is still truncated for the message.
      expect(error.message.length).toBeLessThan(2048);
    });
  });

  // The catch around the request classifies anything it does not recognize as a
  // retryable network failure, so building the request there would turn a
  // caller mistake into an error that is retried forever.
  describe("request construction failures", () => {
    test("a circular payload is a permanent configuration error", async () => {
      const payload: Record<string, unknown> = { event: "deploy" };
      payload.self = payload;

      const error = await webhookNotify({ url: WEBHOOK_URL, payload }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
      expect((error as PermanentJobError).code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect((error as PermanentJobError).code).not.toBe(FetchUrlErrorCode.NETWORK_ERROR);
      expect((error as PermanentJobError).message).not.toContain("SECRETTOKEN");
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    test("a BigInt in the payload is a permanent configuration error", async () => {
      const error = await webhookNotify({
        url: WEBHOOK_URL,
        payload: { size: BigInt(9007199254740993n) } as never,
      }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
      expect((error as PermanentJobError).code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect(mockFetch.mock.calls.length).toBe(0);
    });
  });

  /**
   * A malformed request header is a caller mistake no retry can fix, but undici
   * builds the `Headers` object INSIDE `fetch` and rejects with a bare
   * `TypeError` — name `"TypeError"`, no `code`, not a `FetchUrlJobError`. It
   * matched none of `toRedactedWebhookError`'s named branches and fell through
   * to `NETWORK_ERROR`, so a queued consumer retried a typo forever.
   *
   * The second, sharper half is what the error MESSAGE carried. undici quotes
   * the offending header VALUE back (`Headers.append: "…" is an invalid header
   * value.`), which `detailWithCause` splices into a PERSISTED job-error
   * string. With `credential_key` below placing a resolved secret on a header,
   * that is a bearer token written to durable storage by the error that
   * reported it. Every `not.toContain` here is guarding that boundary.
   */
  describe("request headers", () => {
    const CONTROL_CHAR = String.fromCharCode(10);

    test("an invalid header name is a permanent configuration error", async () => {
      const error = (await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        headers: { "X-Bad Name": "v" },
      }).catch((e: unknown) => e)) as PermanentJobError;

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
      expect(error.code).toBe(FetchUrlErrorCode.CONFIGURATION);
      // The name is not a secret and is the only way to find the offender.
      expect(error.message).toContain("X-Bad Name");
      // Never reaches the transport: the point of the guard is that `fetch` is
      // not the thing that gets to classify this.
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // THE assertion guarding the secret echo. `Bearer abc123 ` is shaped like
    // the credential a caller would put on an `Authorization` header, and
    // undici's own message would quote it verbatim.
    test("an invalid header value is reported without echoing the value", async () => {
      const secretish = `Bearer abc123${CONTROL_CHAR}injected`;

      const error = (await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        headers: { "X-Signature": secretish },
      }).catch((e: unknown) => e)) as PermanentJobError;

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error.code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect(error.message).toContain("X-Signature");
      expect(error.message).not.toContain("abc123");
      expect(error.message).not.toContain(secretish);
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // The URL is the credential for these tasks, so the new guard's message is
    // held to the same redaction rule as every other error here.
    test("the header rejection reports only the origin of the webhook URL", async () => {
      const error = (await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        headers: { "X:Y": "v" },
      }).catch((e: unknown) => e)) as PermanentJobError & { url?: string };

      expect(error.code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect(error.message).not.toContain("SECRETTOKEN");
      expect(error.url).not.toContain("SECRETTOKEN");
    });

    // The guard must not become a wall: an ordinary header still goes out.
    test("a valid header still reaches the transport", async () => {
      await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        headers: { "X-Custom": "yes" },
      });

      expect(requestHeaders()).toEqual({
        "Content-Type": "application/json",
        "X-Custom": "yes",
      });
    });

    // `{ "Content-Type": …, ...headers }` left a caller's lowercase key in
    // place as a SECOND object property, and `Headers` folds two spellings of
    // one name into a single comma-joined field — so the request declared both
    // content types at once.
    test("a lowercase content-type override replaces rather than doubles up", async () => {
      await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        headers: { "content-type": "application/vnd.custom+json" },
      });

      const sent = requestHeaders();
      expect(sent).toEqual({ "content-type": "application/vnd.custom+json" });
      expect(Object.keys(sent).filter((k) => k.toLowerCase() === "content-type")).toHaveLength(1);
    });

    // M4: the seam that exists so an authenticated endpoint does not force the
    // secret into `headers` — and therefore into the saved graph JSON.
    test("a credential_key places a bearer token on the request", async () => {
      const store = getGlobalCredentialStore();
      await store.put("deploy-token", "s3cr3t-value");
      try {
        await webhookNotify({
          url: WEBHOOK_URL,
          payload: {},
          credential_key: "deploy-token",
        });

        expect(requestHeaders()["Authorization"]).toBe("Bearer s3cr3t-value");
      } finally {
        await store.delete("deploy-token");
      }
    });

    // The reason the port exists at all: `Task.toJSON` serializes `defaults`
    // verbatim, so a secret inlined in `headers` is written into the graph. A
    // credential KEY is a reference; only the reference is persisted.
    test("only the credential key, never the secret, reaches the graph JSON", async () => {
      const store = getGlobalCredentialStore();
      await store.put("deploy-token", "s3cr3t-value");
      const task = new WebhookNotifyTask({
        defaults: { url: WEBHOOK_URL, credential_key: "deploy-token" },
      });
      try {
        await task.run({ payload: {} } as never);

        expect(requestHeaders()["Authorization"]).toBe("Bearer s3cr3t-value");
        const serialized = JSON.stringify(task.toJSON());
        expect(serialized).toContain("deploy-token");
        expect(serialized).not.toContain("s3cr3t-value");
      } finally {
        await store.delete("deploy-token");
      }
    });

    test("credential_scheme 'header' writes the raw secret to credential_header", async () => {
      const store = getGlobalCredentialStore();
      await store.put("sig-key", "sha256=abcdef");
      try {
        await webhookNotify({
          url: WEBHOOK_URL,
          payload: {},
          credential_key: "sig-key",
          credential_scheme: "header",
          credential_header: "X-Signature",
        });

        const sent = requestHeaders();
        expect(sent["X-Signature"]).toBe("sha256=abcdef");
        expect(sent["Authorization"]).toBeUndefined();
      } finally {
        await store.delete("sig-key");
      }
    });

    // HTTP header names are case-insensitive, so a caller's lowercase
    // `authorization` is the SAME header. Left in place it would survive as a
    // distinct object property and be folded into one comma-joined field
    // alongside the real credential, sending a stale token with every request.
    test("a resolved credential replaces a caller header case-insensitively", async () => {
      const store = getGlobalCredentialStore();
      await store.put("deploy-token", "fresh");
      try {
        await webhookNotify({
          url: WEBHOOK_URL,
          payload: {},
          headers: { authorization: "stale" },
          credential_key: "deploy-token",
        });

        const sent = requestHeaders();
        expect(sent["Authorization"]).toBe("Bearer fresh");
        expect(sent["authorization"]).toBeUndefined();
        expect(JSON.stringify(sent)).not.toContain("stale");
      } finally {
        await store.delete("deploy-token");
      }
    });

    // `credentialHeaderName` throws a `TaskConfigurationError` whose message is
    // hardcoded "FetchUrlTask: …" and which carries no `FETCH_*` code, so a
    // queued consumer could not classify it at all. Re-raised under this task's
    // own label as a permanent CONFIGURATION failure.
    test("an invalid credential_header is a configuration error labelled for this task", async () => {
      const store = getGlobalCredentialStore();
      await store.put("sig-key", "abc");
      const error = (await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        credential_key: "sig-key",
        credential_scheme: "header",
        credential_header: "X Bad",
      })
        .catch((e: unknown) => e)
        .finally(() => store.delete("sig-key"))) as PermanentJobError;

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error.code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect(error.message).toContain("WebhookNotifyTask");
      expect(error.message).not.toContain("FetchUrlTask");
      expect(error.message).toContain("X Bad");
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // THE COMPOSITION TEST: M4 places a resolved secret on a header, and M1
    // then validates it like any other. Without M1 this exact case is what
    // writes the secret into a persisted job error — undici would reject the
    // value and quote it back in the `TypeError` message. The two changes are
    // stacked in one PR because of this ordering, not by convenience.
    test("a credential value carrying a control character is rejected without echoing it", async () => {
      const store = getGlobalCredentialStore();
      const poisoned = `abc123${CONTROL_CHAR}X-Injected: 1`;
      await store.put("bad-token", poisoned);
      const error = (await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        credential_key: "bad-token",
      })
        .catch((e: unknown) => e)
        .finally(() => store.delete("bad-token"))) as PermanentJobError;

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error).not.toBeInstanceOf(RetryableJobError);
      expect(error.code).toBe(FetchUrlErrorCode.CONFIGURATION);
      expect(error.message).toContain("Authorization");
      expect(error.message).not.toContain("abc123");
      expect(error.message).not.toContain(poisoned);
      // The persisted diagnostic string is the real disclosure surface, so it
      // gets its own assertion rather than trusting `.message` alone.
      expect(formatErrorChainForDiagnostics(error)).not.toContain("abc123");
      expect(mockFetch.mock.calls.length).toBe(0);
    });
  });

  // The README's snippets are copy-paste material; a constructor call that
  // throws before any request is a documentation bug with a runtime cost.
  describe("documented usage forms", () => {
    test("the helper form documented for all three tasks runs", async () => {
      expect(await webhookNotify({ url: WEBHOOK_URL, payload: { event: "deploy" } })).toEqual({
        success: true,
        status: 200,
        response: "ok",
      });

      expect(await slackNotify({ url: SLACK_URL, text: "Deploy finished" })).toEqual({
        success: true,
        status: 200,
      });

      mockFetch.mockImplementation(() => Promise.resolve(new Response(null, { status: 204 })));
      expect(await discordNotify({ url: DISCORD_URL, content: "Build passed" })).toEqual({
        success: true,
        status: 204,
      });
    });

    test("the documented `defaults` config form runs", async () => {
      const notifier = new WebhookNotifyTask({
        title: "Deploy hook",
        defaults: { url: WEBHOOK_URL },
      });

      const result = await notifier.run({ payload: { event: "deploy", version: "1.4.2" } });

      expect(result.status).toBe(200);
      expect(lastCall().url).toBe(WEBHOOK_URL);
      expect(lastCall().options.body).toBe(JSON.stringify({ event: "deploy", version: "1.4.2" }));
    });

    // Why the snippets had to change: the constructor's first argument is
    // CONFIG, whose schema is `additionalProperties: false`.
    test("passing inputs as the constructor config throws before any request", () => {
      expect(() => new WebhookNotifyTask({ url: WEBHOOK_URL, payload: {} } as never)).toThrow();
      expect(() => new SlackNotifyTask({ url: SLACK_URL, text: "hi" } as never)).toThrow();
      expect(() => new DiscordNotifyTask({ url: DISCORD_URL, content: "hi" } as never)).toThrow();
      expect(mockFetch.mock.calls.length).toBe(0);
    });
  });

  describe("graph-root entitlement enforcement", () => {
    const METADATA_URL = "http://169.254.169.254/latest/meta-data/";

    /** Grants network:http and credential, but deliberately NOT network:private. */
    function browserRegistry(): ServiceRegistry {
      const registry = new ServiceRegistry(new Container());
      registry.register(ENTITLEMENT_ENFORCER, () =>
        createPolicyEnforcer(createProfilePolicy("browser"))
      );
      return registry;
    }

    beforeEach(() => {
      registerCommonTasks();
    });

    // A root task's entitlements are graded BEFORE the graph run-input reaches
    // it, so `allow_private_destination` supplied here was invisible to the
    // enforcer. The grant, not the declaration, has to be what gates the post.
    test("graph run-input cannot smuggle allow_private_destination past a denied network:private", async () => {
      const graph = new TaskGraph();
      graph.addTask(new WebhookNotifyTask({ id: "notify", defaults: { payload: { ping: true } } }));
      const runner = new TaskGraphRunner(graph);

      const error = await runner
        .runGraph(
          { url: METADATA_URL, allow_private_destination: true },
          { registry: browserRegistry(), enforceEntitlements: true }
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(String((error as Error).message)).toContain("network:private");
      expect(String((error as Error).message)).not.toContain("/latest/meta-data");
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // The fix is a gate, not a blanket refusal: the same run succeeds once the
    // destination is actually granted.
    test("a granted network:private scope permits the same run", async () => {
      const browserPolicy = createProfilePolicy("browser");
      const registry = new ServiceRegistry(new Container());
      registry.register(ENTITLEMENT_ENFORCER, () =>
        createPolicyEnforcer({
          deny: browserPolicy.deny,
          grant: [
            ...browserPolicy.grant,
            { id: Entitlements.NETWORK_PRIVATE, resources: ["http://169.254.169.254/*"] },
          ],
          ask: browserPolicy.ask,
        })
      );

      const graph = new TaskGraph();
      graph.addTask(new WebhookNotifyTask({ id: "notify", defaults: { payload: { ping: true } } }));
      const runner = new TaskGraphRunner(graph);

      await expect(
        runner.runGraph(
          { url: METADATA_URL, allow_private_destination: true },
          { registry, enforceEntitlements: true }
        )
      ).resolves.toBeDefined();
      expect(lastCall().url).toBe(METADATA_URL);
    });

    test("a grant scoped elsewhere does not cover the resolved destination", async () => {
      const browserPolicy = createProfilePolicy("browser");
      const registry = new ServiceRegistry(new Container());
      registry.register(ENTITLEMENT_ENFORCER, () =>
        createPolicyEnforcer({
          deny: browserPolicy.deny,
          grant: [
            ...browserPolicy.grant,
            { id: Entitlements.NETWORK_PRIVATE, resources: ["http://localhost:*"] },
          ],
          ask: browserPolicy.ask,
        })
      );

      const graph = new TaskGraph();
      graph.addTask(new WebhookNotifyTask({ id: "notify", defaults: { payload: {} } }));
      const runner = new TaskGraphRunner(graph);

      const error = await runner
        .runGraph(
          { url: "http://127.0.0.1:9200/ingest", allow_private_destination: true },
          { registry, enforceEntitlements: true }
        )
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(Error);
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // Declaration-time enforcement can never reach this case: the entitlement
    // enforcer runs before the credential resolver, so the URL does not exist
    // yet when the declaration is graded.
    test("a credential-resolved private URL is checked against the grant", async () => {
      const registry = browserRegistry();
      // The store is per-registry, so seed the one this run will resolve from.
      const store = getGlobalCredentialStore(registry);
      await store.put("internal-hook", "http://127.0.0.1:9200/x");

      const error = (await new WebhookNotifyTask()
        .run(
          { payload: {}, url_credential_key: "internal-hook", allow_private_destination: true },
          { registry }
        )
        .catch((e: unknown) => e)
        .finally(() => store.delete("internal-hook"))) as PermanentJobError;

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error.code).toBe(FetchUrlErrorCode.PRIVATE_DENIED);
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // THE LOAD-BEARING CASE for letting the declaration govern the transport:
    // the authorization check must key on the DECLARATION, not on the URL's
    // static classification. Keyed on the classification, a public-looking
    // hostname would receive the widened transport with no grant check at all.
    test("a declared private destination is refused without the grant even when the URL looks public", async () => {
      const error = (await new WebhookNotifyTask()
        .run(
          { url: WEBHOOK_URL, payload: {}, allow_private_destination: true },
          { registry: browserRegistry() }
        )
        .catch((e: unknown) => e)) as PermanentJobError;

      expect(error).toBeInstanceOf(PermanentJobError);
      expect(error.code).toBe(FetchUrlErrorCode.PRIVATE_DENIED);
      expect(mockFetch.mock.calls.length).toBe(0);
    });

    // A gate, not a blanket relaxation: the same post runs once the declared
    // origin is granted.
    test("a grant scoped to the declared origin permits a public-looking private destination", async () => {
      const browserPolicy = createProfilePolicy("browser");
      const registry = new ServiceRegistry(new Container());
      registry.register(ENTITLEMENT_ENFORCER, () =>
        createPolicyEnforcer({
          deny: browserPolicy.deny,
          grant: [
            ...browserPolicy.grant,
            { id: Entitlements.NETWORK_PRIVATE, resources: ["https://example.com/*"] },
          ],
          ask: browserPolicy.ask,
        })
      );

      await expect(
        new WebhookNotifyTask().run(
          { url: WEBHOOK_URL, payload: {}, allow_private_destination: true },
          { registry }
        )
      ).resolves.toBeDefined();
      expect(lastCall().options.allowPrivate).toBe(true);
    });

    // The contract is opt-in: with no enforcer registered there is no policy to
    // satisfy, so behaviour is unchanged.
    test("no registered enforcer leaves a declared private post working", async () => {
      const result = await new WebhookNotifyTask().run(
        { url: "http://127.0.0.1:9200/ingest", payload: {}, allow_private_destination: true },
        { registry: new ServiceRegistry(new Container()) }
      );

      expect(result.status).toBe(200);
      expect(lastCall().url).toBe("http://127.0.0.1:9200/ingest");
    });
  });
});
