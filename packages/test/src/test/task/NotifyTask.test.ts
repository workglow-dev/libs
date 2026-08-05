/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { PermanentJobError, RetryableJobError } from "@workglow/job-queue";
import { TaskRegistry, Workflow } from "@workglow/task-graph";
import {
  createFetchUrlJobError,
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
      expect(options.body).toBe(JSON.stringify({ text: "deploy finished" }));
    });

    // An unset array port materializes as `[]`, which Slack rejects, so an
    // empty `blocks` list must be dropped rather than sent.
    test("omits absent optional fields entirely", async () => {
      await slackNotify({ url: SLACK_URL, text: "hi" });

      const body = lastCall().options.body as string;
      expect(body).toBe('{"text":"hi"}');
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
      expect(lastCall().options.body).toBe(JSON.stringify({ text: "from workflow" }));
    });

    test("Workflow.webhookNotify and Workflow.discordNotify are installed", () => {
      const workflow = new Workflow();
      expect(typeof workflow.webhookNotify).toBe("function");
      expect(typeof workflow.discordNotify).toBe("function");
    });
  });
});
