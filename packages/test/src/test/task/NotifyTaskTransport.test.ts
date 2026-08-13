/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Real-transport tests for the webhook notification tasks.
 *
 * `NotifyTask.test.ts` installs a process-global mock through `registerSafeFetch`
 * in `beforeAll`, so every case there exercises the payload shaping and the
 * redaction boundary but none of them exercise the undici request, the
 * passthrough TransformStream, or the dispatcher lifecycle. That gap is not
 * cosmetic: `postWebhookJson` cancels the success body unread for BOTH Slack and
 * Discord (`readSuccessBody: false`), and cancelling the returned readable
 * errors the writable behind it — so `pipeTo` rejects, and an unhandled
 * rejection terminates the process under Node's default
 * `--unhandled-rejections=throw`. A mocked `Response` has no pipe behind it and
 * can never see that.
 *
 * These cases therefore talk to a throwaway `node:http` server over loopback and
 * never mock the transport. This is a separate FILE rather than a block in
 * `NotifyTask.test.ts` on purpose — sharing that file's process-global mock
 * would make a real-transport case depend on vitest describe-ordering not to be
 * poisoned.
 *
 * Loopback is private address space, so every case sets
 * `allow_private_destination`. No entitlement enforcer is registered, so
 * `assertPrivateDestinationGranted` has no policy to satisfy and the post
 * proceeds.
 */

import { PermanentJobError } from "@workglow/job-queue";
import { discordNotify, getSafeFetchImpl, slackNotify } from "@workglow/tasks";
import { SECURITY_LIMITS } from "@workglow/util";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

interface TestServer {
  readonly origin: string;
  readonly server: http.Server;
}

const servers: http.Server[] = [];
const timers: NodeJS.Timeout[] = [];

/**
 * Start a loopback HTTP server on an ephemeral port. Registered for teardown in
 * `afterEach`.
 */
async function withServer(handler: http.RequestListener): Promise<TestServer> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { origin: `http://127.0.0.1:${port}`, server };
}

async function closeServer(server: http.Server): Promise<void> {
  // undici keeps sockets alive; without closeAllConnections() the close()
  // callback never fires and the hook times out.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Timer that is cleared on teardown, so a stalling handler cannot leak one. */
function trackedTimeout(fn: () => void, ms: number): void {
  timers.push(setTimeout(fn, ms));
}

/**
 * An unhandled rejection is reported after the microtask queue drains, on a
 * later macrotask turn — two `setImmediate` turns is enough for Node to have
 * decided a rejection had no handler.
 */
async function drainRejections(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitForNoConnections(server: http.Server, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let count = await new Promise<number>((resolve) =>
    server.getConnections((_err, n) => resolve(n ?? 0))
  );
  while (count > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    count = await new Promise<number>((resolve) =>
      server.getConnections((_err, n) => resolve(n ?? 0))
    );
  }
  return count;
}

/** Slack-shaped path, so the token-bearing segment is exercised end to end. */
const slackPath = "/services/T00000000/B00000000/SECRETTOKEN";

describe("Notification tasks over the real server transport (no mocks)", () => {
  let unhandled: unknown[] = [];
  const onUnhandledRejection = (reason: unknown): void => {
    unhandled.push(reason);
  };

  beforeEach(() => {
    unhandled = [];
    process.on("unhandledRejection", onUnhandledRejection);
  });

  afterEach(async () => {
    process.off("unhandledRejection", onUnhandledRejection);
    for (const timer of timers.splice(0)) clearTimeout(timer);
    for (const server of servers.splice(0)) await closeServer(server);
  });

  // Tripwire: the whole file is vacuous if a mock is installed, so assert the
  // registered implementation is the one from SafeFetch.server.ts. It is not
  // exported from the package root, so identify it by function name.
  test("the registered implementation is the real server transport", () => {
    expect(getSafeFetchImpl().name).toBe("serverSafeFetch");
  });

  // The production crash path. Slack answers 200 with the body `ok`, which
  // `postWebhookJson` cancels unread — and that cancel is exactly what makes the
  // transport's body pipe reject.
  test("a successful Slack post cancels the unread body without an unhandled rejection", async () => {
    const { origin } = await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    const result = await slackNotify({
      url: `${origin}${slackPath}`,
      text: "hi",
      allow_private_destination: true,
    });

    expect(result).toEqual({ success: true, status: 200 });

    await drainRejections();
    expect(unhandled).toEqual([]);
  });

  // The cancel must also release the dispatcher. A leaked keep-alive socket is
  // silent — the task still reports success — so it needs its own assertion.
  test("a successful Slack post releases the connection on the cancel path", async () => {
    const { origin, server } = await withServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    await slackNotify({
      url: `${origin}${slackPath}`,
      text: "hi",
      allow_private_destination: true,
    });

    expect(await waitForNoConnections(server, 5000)).toBe(0);

    await drainRejections();
    expect(unhandled).toEqual([]);
  });

  // The second cancel site: `readBodyText` abandons an oversized failure body at
  // `webhookMaxResponseBodyBytes`. Nothing else exercises that cancel against the
  // real transport, and it lands mid-pipe rather than on a drained stream.
  test("an oversized failure body is abandoned at the cap without an unhandled rejection", async () => {
    const oversized = "x".repeat(SECURITY_LIMITS.webhookMaxResponseBodyBytes + 256 * 1024);
    const { origin } = await withServer((_req, res) => {
      res.writeHead(400, { "content-type": "text/plain" });
      res.write(oversized);
      // Deliberately never ended: the read must be abandoned at the cap while
      // the body pipe is still live, which is what makes `pipeTo` reject.
      trackedTimeout(() => res.write("y".repeat(64 * 1024)), 500);
    });

    const error = (await slackNotify({
      url: `${origin}${slackPath}`,
      text: "hi",
      allow_private_destination: true,
    }).catch((e: unknown) => e)) as PermanentJobError & { httpStatus?: number };

    expect(error).toBeInstanceOf(PermanentJobError);
    expect(error.httpStatus).toBe(400);
    // The URL is the credential; it must not survive into the diagnostic.
    expect(error.message).not.toContain("SECRETTOKEN");

    await drainRejections();
    expect(unhandled).toEqual([]);
  });

  // Discord answers 204 with no body at all, which takes the transport's
  // non-TransformStream branch — the dispatcher is closed directly there, with
  // no pipe to reject. A regression guard on that branch rather than a
  // reproduction of the crash.
  test("a Discord 204 with no body completes and releases the connection", async () => {
    const { origin, server } = await withServer((_req, res) => {
      res.writeHead(204);
      res.end();
    });

    const result = await discordNotify({
      url: `${origin}/api/webhooks/123456789/SECRETTOKEN`,
      content: "hi",
      allow_private_destination: true,
    });

    expect(result).toEqual({ success: true, status: 204 });
    expect(await waitForNoConnections(server, 5000)).toBe(0);

    await drainRejections();
    expect(unhandled).toEqual([]);
  });
});
