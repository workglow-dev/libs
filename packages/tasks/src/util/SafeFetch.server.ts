/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * Server-side SafeFetch implementation.
 *
 * Combines:
 *   1. Static URL classification (shared with the browser impl).
 *   2. DNS pre-resolution of every A/AAAA record for the hostname.
 *   3. Rejection if any resolved address is private/link-local/metadata
 *      (unless `allowPrivate` is set).
 *   4. Connection pinning via an undici Agent whose `connect.lookup` hook
 *      returns the pre-resolved IP — this prevents a second DNS lookup at
 *      connect time and defeats DNS rebinding (TOCTOU).
 *
 * Registered at module load from `packages/tasks/src/node.ts` via
 * `registerSafeFetch`.
 */

import { SECURITY_LIMITS } from "@workglow/util";
import { lookup as dnsLookup } from "node:dns/promises";
import { Agent, fetch as undiciFetch } from "undici";
import {
  createFetchUrlJobError,
  FetchUrlErrorCode,
  isFetchUrlJobError,
} from "../task/FetchUrlJobError";
import {
  applyCrossOriginHeaderStrip,
  applyRedirectMethodAndBody,
  createSafeFetchRedirectError,
  registerSafeFetch,
  type SafeFetchFn,
  type SafeFetchOptions,
} from "./SafeFetch";
import { classifyIpLiteral, classifyUrl, urlMatchesScope } from "./UrlClassifier";

const MAX_REDIRECT_HOPS = SECURITY_LIMITS.safeFetchMaxRedirectHops;

/**
 * Close an undici {@link Agent} if it exposes a `close` method.
 * Bun can load undici in a way where `Agent` instances lack `close` on the
 * prototype, which would make unconditional `dispatcher.close()` throw
 * (see `close` is not a function) while the fetch may still work.
 */
function closeAgent(dispatcher: Agent): void {
  void dispatcher.close?.().catch(() => {});
}

async function closeAgentAsync(dispatcher: Agent): Promise<void> {
  await dispatcher.close?.().catch(() => {});
}

/**
 * Cancel a response body nobody is going to read.
 *
 * Not merely tidy: `Agent.close()` waits for pending requests to complete, and
 * an un-cancelled redirect body IS one — so cancelling first is what lets the
 * close actually finish instead of hanging with the socket held open.
 *
 * Fire-and-forget with a swallowed rejection: cancelling an already-errored
 * source rejects, and an unhandled rejection exits the process under Node's
 * default `--unhandled-rejections=throw`.
 */
function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => {});
}

interface ResolvedAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

/**
 * Resolve the hostname to all A/AAAA records. Rejects with a PermanentJobError
 * on any DNS failure (NXDOMAIN, SERVFAIL, etc.) so the caller doesn't fall
 * back to letting the OS resolver re-run at connect time.
 */
async function resolveAll(hostname: string): Promise<readonly ResolvedAddress[]> {
  try {
    const addrs = await dnsLookup(hostname, { all: true, verbatim: true });
    if (!Array.isArray(addrs) || addrs.length === 0) {
      throw createFetchUrlJobError(
        FetchUrlErrorCode.DNS_FAILED,
        `DNS lookup returned no addresses for '${hostname}'`
      );
    }
    return addrs.map((a) => ({ address: a.address, family: a.family as 4 | 6 }));
  } catch (err) {
    if (isFetchUrlJobError(err)) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    throw createFetchUrlJobError(
      FetchUrlErrorCode.DNS_FAILED,
      `DNS lookup failed for '${hostname}': ${msg}`
    );
  }
}

function isLiteralHost(host: string): boolean {
  // Literal IPv4 if it looks numeric/dotted, or IPv6 if it contains a colon.
  if (host.includes(":")) return true;
  return /^[0-9a-fx.]+$/i.test(host);
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** The request init actually handed to undici, once SafeFetch-only fields are removed. */
type HopInit = Omit<
  SafeFetchOptions,
  "allowPrivate" | "privateResourceScopes" | "sensitiveHeaders" | "redirect"
>;

/**
 * Resolve a single hop: classify URL, DNS-resolve if needed, pin connection,
 * execute the request with redirect:manual, and return the raw response.
 * The caller is responsible for closing the dispatcher after the response is consumed.
 */
async function fetchOneHop(
  url: string,
  opts: SafeFetchOptions,
  fetchInit: HopInit
): Promise<{ response: Response; dispatcher: Agent }> {
  const classification = classifyUrl(url);
  if (classification.kind === "invalid") {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.INVALID_URL,
      `Refusing to fetch invalid URL: ${classification.reason}`,
      { url }
    );
  }
  if (classification.kind === "private" && !opts.allowPrivate) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.PRIVATE_DENIED,
      `Refusing to fetch private/internal URL ${url}: ${classification.reason}. ` +
        `Grant the 'network:private' entitlement to allow this request.`,
      { url }
    );
  }
  if (
    classification.kind === "private" &&
    opts.privateResourceScopes !== undefined &&
    !urlMatchesScope(url, opts.privateResourceScopes)
  ) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.SCOPE_DENIED,
      `Refusing to fetch ${url}: outside granted network:private scope ` +
        `[${opts.privateResourceScopes.join(", ")}]. A compromised upstream may be attempting ` +
        `to escape the task's authorized private-host origin.`,
      { url }
    );
  }

  const parsed = new URL(url);
  const host = classification.host ?? parsed.hostname.toLowerCase();

  let pinned: ResolvedAddress;

  if (isLiteralHost(host) && classification.literalIp !== undefined) {
    pinned = {
      address: classification.literalIp,
      family: classification.literalIp.includes(":") ? 6 : 4,
    };
  } else {
    const addrs = await resolveAll(host);
    for (const addr of addrs) {
      const ipClass = classifyIpLiteral(addr.address);
      if (ipClass === undefined) {
        throw createFetchUrlJobError(
          FetchUrlErrorCode.DNS_FAILED,
          `DNS resolved '${host}' to an unparseable address '${addr.address}'`,
          { url }
        );
      }
      if (ipClass.kind === "private" && !opts.allowPrivate) {
        throw createFetchUrlJobError(
          FetchUrlErrorCode.PRIVATE_DENIED,
          `Refusing to fetch ${url}: hostname '${host}' resolved to private address ` +
            `${addr.address} (${ipClass.reason}). This may indicate DNS rebinding. ` +
            `Grant the 'network:private' entitlement to allow this request.`,
          { url }
        );
      }
    }
    pinned = addrs[0]!;
  }

  const pinnedAddress = pinned.address;
  const pinnedFamily = pinned.family;
  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, _lookupOptions, cb) => {
        cb(null, pinnedAddress, pinnedFamily);
      },
    },
  });

  try {
    const response = await undiciFetch(url, {
      ...(fetchInit as Parameters<typeof undiciFetch>[1]),
      dispatcher,
      redirect: "manual",
    });
    return { response: response as unknown as Response, dispatcher };
  } catch (err) {
    await closeAgentAsync(dispatcher);
    throw err;
  }
}

export const serverSafeFetch: SafeFetchFn = async (url, options) => {
  const opts: SafeFetchOptions = options ?? {};
  const requestedRedirectMode = opts.redirect ?? "follow";
  const {
    allowPrivate: _allowPrivate,
    privateResourceScopes: _privateResourceScopes,
    sensitiveHeaders,
    redirect: _redirect,
    ...initialFetchInit
  } = opts;

  let currentUrl = url;
  let fetchInit: HopInit = initialFetchInit;
  let prevDispatcher: Agent | undefined;

  // Every exit from the loop — a hop that throws (scope/private deny, DNS
  // failure, socket error), a refused redirect, and the terminal
  // TOO_MANY_REDIRECTS below — must still close the dispatcher of the hop that
  // got us here. Those are exactly the redirect-denial paths this file exists
  // to exercise, so leaking an Agent on them leaks on every denial.
  try {
    for (let hops = 0; hops <= MAX_REDIRECT_HOPS; hops += 1) {
      const { response, dispatcher } = await fetchOneHop(currentUrl, opts, fetchInit);

      // Close the previous hop's dispatcher now that we have the next response,
      // and forget it so the `finally` cannot close it a second time.
      if (prevDispatcher !== undefined) {
        closeAgent(prevDispatcher);
        prevDispatcher = undefined;
      }

      if (!isRedirectStatus(response.status)) {
        // Pipe through a passthrough TransformStream so the dispatcher is
        // closed once the body is fully consumed or cancelled. The body belongs
        // to the caller from here on, so nothing may cancel it on their behalf.
        const body = response.body;
        if (body !== null) {
          const { readable, writable } = new TransformStream();
          // `.catch` after `.finally` so the dispatcher closes on both paths.
          // Cancelling the returned readable errors the writable, so `pipeTo`
          // rejects with the cancel reason — `undefined` for a bare `cancel()` —
          // and an unhandled rejection exits the process under Node's default
          // `--unhandled-rejections=throw`. Nothing is lost by swallowing it:
          // the consumer observes any real pipe error through the readable it
          // holds.
          void body
            .pipeTo(writable)
            .finally(() => {
              closeAgent(dispatcher);
            })
            .catch(() => {});
          return new Response(readable, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
          });
        }
        closeAgent(dispatcher);
        return response;
      }

      if (requestedRedirectMode === "manual") {
        // The caller receives this response and owns its body; leave it intact.
        closeAgent(dispatcher);
        return response;
      }

      if (requestedRedirectMode === "error") {
        discardResponseBody(response);
        closeAgent(dispatcher);
        throw createSafeFetchRedirectError(currentUrl, response.status);
      }

      const location = response.headers.get("location");
      if (!location) {
        discardResponseBody(response);
        closeAgent(dispatcher);
        throw createFetchUrlJobError(
          FetchUrlErrorCode.REDIRECT_MISSING_LOCATION,
          `Refusing to follow redirect from ${currentUrl}: missing Location header.`,
          { url: currentUrl }
        );
      }

      // Nobody reads a redirect's body; leaving it pending would block this
      // dispatcher's close.
      discardResponseBody(response);
      prevDispatcher = dispatcher;
      const nextUrl = new URL(location, currentUrl).toString();
      // Keep these two adjacent: a credential can ride on a header or in the
      // body, and the pair is what covers both.
      fetchInit = applyRedirectMethodAndBody(fetchInit, response.status, currentUrl, nextUrl);
      // Credential-bearing headers never survive an origin change; the strip is
      // carried forward, so it is never undone by a later same-origin hop.
      fetchInit = applyCrossOriginHeaderStrip(fetchInit, currentUrl, nextUrl, sensitiveHeaders);
      currentUrl = nextUrl;
    }

    throw createFetchUrlJobError(
      FetchUrlErrorCode.TOO_MANY_REDIRECTS,
      `Refusing to fetch ${url}: too many redirects.`,
      { url }
    );
  } finally {
    if (prevDispatcher !== undefined) {
      closeAgent(prevDispatcher);
    }
  }
};

registerSafeFetch(serverSafeFetch);
