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

import { PermanentJobError, RetryableJobError } from "@workglow/job-queue";
import {
  discordNotify,
  FetchUrlErrorCode,
  getSafeFetchImpl,
  slackNotify,
  webhookNotify,
} from "@workglow/tasks";
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

/**
 * Binds an ephemeral loopback port and immediately releases it, so a connection
 * to it is refused. Not registered for teardown — it is already closed.
 */
async function refusedOrigin(): Promise<string> {
  const server = http.createServer(() => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
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

  // The reason this case belongs in the real-transport file: the `.cause` here
  // is undici's own, not a fixture's. undici rejects a refused connection as
  // `TypeError: fetch failed` and puts the only actionable text — the errno —
  // on the cause, so an operator reading the job error saw three words that
  // never distinguished a refused port from an unresolvable host or a TLS
  // failure.
  test("a refused connection reports the underlying cause, not just 'fetch failed'", async () => {
    const origin = await refusedOrigin();

    const error = (await slackNotify({
      url: `${origin}${slackPath}`,
      text: "hi",
      allow_private_destination: true,
    }).catch((e: unknown) => e)) as RetryableJobError;

    expect(error).toBeInstanceOf(RetryableJobError);
    expect(error.message).toContain("ECONNREFUSED");
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

  // The header guard belongs in this file for the same reason everything else
  // here does: the mocked `safeFetch` in `NotifyTask.test.ts` never constructs
  // a `Headers` object, so it can prove the guard fires but not that the guard
  // is still in FRONT of the thing it guards. Only the real transport can.
  //
  // This is the tripwire for undici changing its validation out from under the
  // guard. If undici ever tightened on a header this guard admits, the request
  // would start rejecting with a bare `TypeError` classified as a retryable
  // NETWORK_ERROR again — so the accepted-header case below is asserted too,
  // and it is the half that would actually break.
  test("an invalid header is refused before the request reaches the server", async () => {
    let requests = 0;
    const { origin } = await withServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    const error = (await webhookNotify({
      url: `${origin}/hooks/SECRETTOKEN`,
      payload: {},
      headers: { "X-Bad Name": "v" },
      allow_private_destination: true,
    }).catch((e: unknown) => e)) as PermanentJobError;

    expect(error).toBeInstanceOf(PermanentJobError);
    expect(error).not.toBeInstanceOf(RetryableJobError);
    expect(error.code).toBe(FetchUrlErrorCode.CONFIGURATION);
    expect(requests).toBe(0);

    await drainRejections();
    expect(unhandled).toEqual([]);
  });

  test("a header the guard admits is accepted by the transport and arrives intact", async () => {
    let seen: string | undefined;
    const { origin } = await withServer((req, res) => {
      seen = req.headers["x-signature"] as string | undefined;
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });

    const result = await webhookNotify({
      url: `${origin}/hooks/SECRETTOKEN`,
      payload: {},
      headers: { "X-Signature": "sha256=abcdef" },
      allow_private_destination: true,
    });

    expect(result.status).toBe(200);
    expect(seen).toBe("sha256=abcdef");

    await drainRejections();
    expect(unhandled).toEqual([]);
  });
});
