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

    test("Slack neutralizes channel-wide broadcasts by default", async () => {
      await slackNotify({ url: SLACK_URL, text: "<!channel> deploy done" });

      const body = lastCall().options.body as string;
      expect(body).toContain("&lt;!channel>");
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

    // The narrow `<!` escape must not break the sequences that make Slack
    // messages useful: links and single-user mentions.
    test("Slack leaves links and single-user mentions intact", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "<https://x/|y> pinged <@U1>",
      });

      const body = lastCall().options.body as string;
      expect(body).toContain("<https://x/|y>");
      expect(body).toContain("<@U1>");
    });

    // `<!` is Slack's CONTROL-SEQUENCE sigil, not a broadcast sigil, and
    // `<!date^…>` is the one documented member of that family that can notify
    // nobody. Escaping it is pure collateral: Slack un-escapes the entity for
    // display, so the message shows the raw token, and the only opt-out
    // (`allow_mentions`) re-enables live channel-wide pings in the same field.
    test("a Slack date token survives the broadcast escape", async () => {
      const text = "Deploy at <!date^1700000000^{date_short}|Nov 14>";
      await slackNotify({ url: SLACK_URL, text });

      expect(JSON.parse(lastCall().options.body as string).text).toBe(text);
    });

    // The exemption is the two-character `<!` occurrence, not "everything after
    // the first `<!date`": a broadcast written inside the token's fallback text
    // is still a live broadcast.
    test("a broadcast inside a date token's fallback is still escaped", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "<!date^1700000000^{date_short}|<!channel>>",
      });

      const posted = JSON.parse(lastCall().options.body as string).text as string;
      expect(posted).toContain("&lt;!channel");
      expect(posted).toContain("<!date^");
    });

    // Whether Slack accepts an upper-case token is unverified, so the exemption
    // fails closed rather than opening a path nobody has checked.
    test("a case-variant date token is still escaped", async () => {
      await slackNotify({ url: SLACK_URL, text: "<!DATE^1700000000^{date_short}|x>" });

      expect(JSON.parse(lastCall().options.body as string).text).toContain("&lt;!DATE");
    });

    test("channel broadcasts are still neutralized alongside a date token", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "<!channel> ships <!date^1700000000^{date_short}|Nov 14>",
      });

      const posted = JSON.parse(lastCall().options.body as string).text as string;
      expect(posted).toContain("&lt;!channel>");
      expect(posted).not.toContain("<!channel>");
      expect(posted).toContain("<!date^1700000000^{date_short}|Nov 14>");
    });

    test("a date token inside blocks survives the deep walk", async () => {
      const token = "<!date^1700000000^{date_short}|Nov 14>";
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: `ships ${token}` } }],
      });

      const posted = JSON.parse(lastCall().options.body as string);
      expect(posted.blocks[0].text.text).toBe(`ships ${token}`);
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

    test("Slack leaves links and single-user mentions inside blocks intact", async () => {
      await slackNotify({
        url: SLACK_URL,
        text: "ok",
        blocks: [{ type: "section", text: { type: "mrkdwn", text: "<https://x/|y> <@U1>" } }],
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

    // The DNS-rebinding invariant: the flag is a declaration about the
    // destination, never a licence to widen the transport for a public
    // hostname. A name that resolves into private space at connect time must
    // still be refused there.
    test("a public URL keeps allowPrivate false even when allow_private_destination is set", async () => {
      await webhookNotify({
        url: WEBHOOK_URL,
        payload: {},
        allow_private_destination: true,
      });

      expect(lastCall().options.allowPrivate).toBe(false);
      expect(lastCall().options.privateResourceScopes).toBeUndefined();
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
