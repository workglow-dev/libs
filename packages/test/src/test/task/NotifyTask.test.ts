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
import { TaskRegistry, Workflow } from "@workglow/task-graph";
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
import { getGlobalCredentialStore, SECURITY_LIMITS } from "@workglow/util";
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
    // alone would delete the word from ordinary prose. All-lowercase-alphabetic
    // runs are words, not tokens.
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
      task.runInputData = { url: WEBHOOK_URL, payload: {} } as any;
      expect(requiresPrivate(task)).toBe(false);
    });

    test("a private URL requires network:private", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = { url: "http://127.0.0.1:9200/ingest", payload: {} } as any;
      expect(requiresPrivate(task)).toBe(true);
    });

    // Regression: the credential OVERRIDES `url` at execute time, so grading
    // entitlements on a public-looking `url` while the request actually goes
    // to whatever the credential holds is an entitlement bypass.
    test("a credential key forces network:private even beside a public url", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = {
        url: WEBHOOK_URL,
        payload: {},
        url_credential_key: "internal-hook",
      } as any;
      expect(requiresPrivate(task)).toBe(true);
    });

    test("an absent url still fails closed", () => {
      const task = new WebhookNotifyTask();
      task.runInputData = { payload: {} } as any;
      expect(requiresPrivate(task)).toBe(true);
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
      });

      expect(result.response).toBe("");
      expect(JSON.stringify(result)).not.toContain("AKIA");
      expect(result.status).toBe(200);
    });

    test("still echoes a public destination's body", async () => {
      mockFetch.mockImplementation(() => Promise.resolve(new Response("pong", { status: 200 })));

      const result = await webhookNotify({ url: WEBHOOK_URL, payload: {} });

      expect(result.response).toBe("pong");
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

      const error = (await slackNotify({ url: PRIVATE_URL, text: "x" }).catch(
        (e: unknown) => e
      )) as PermanentJobError & { httpStatus?: number };

      expect(error.message).not.toContain("parsing_exception");
      expect(error.message).not.toContain("cluster secrets index");
      // The status still reports; only the body is withheld.
      expect(error.message).toContain("400");
      expect(error.httpStatus).toBe(400);
    });

    test("Discord does not echo a private endpoint's failure body", async () => {
      mockFetch.mockImplementation(() =>
        Promise.resolve(new Response(ES_BODY, { status: 400, statusText: "Bad Request" }))
      );

      const error = (await discordNotify({ url: PRIVATE_URL, content: "x" }).catch(
        (e: unknown) => e
      )) as PermanentJobError;

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

      const result = await webhookNotify({ url: PRIVATE_URL, payload: {} });

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
});
