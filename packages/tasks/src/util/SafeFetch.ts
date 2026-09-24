/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * SSRF-aware fetch wrapper.
 *
 * The browser default performs a static URL classification only and delegates
 * to `globalThis.fetch`. The Node/Bun entrypoints register a server-side
 * implementation (see `SafeFetch.server.ts`) that additionally resolves DNS,
 * classifies every resolved address, and pins the connection to a specific
 * IP via an undici Agent — this closes the DNS-rebinding gap.
 *
 * Callers pass `allowPrivate` to opt into private/loopback targets. The task
 * layer sets this flag based on whether the task has been granted the
 * `network:private` entitlement (via its dynamic `entitlements()`).
 */

import { SECURITY_LIMITS } from "@workglow/util";
import type { FetchUrlJobErrorInstance } from "../task/FetchUrlJobError";
import {
  createFetchUrlJobError,
  FetchUrlErrorCode,
  isFetchUrlJobError,
} from "../task/FetchUrlJobError";
import { classifyUrl, urlMatchesScope } from "./UrlClassifier";

export interface SafeFetchOptions extends RequestInit {
  /**
   * When true, requests to private/loopback/link-local/metadata hosts are
   * permitted. When false (default), such requests throw PermanentJobError
   * both at URL-classification time and (in the server impl) at DNS-resolution
   * time — defeating DNS rebinding.
   */
  readonly allowPrivate?: boolean;
  /**
   * When `allowPrivate` is true, additionally restrict private-host requests
   * (including redirect targets) to URLs matching at least one of these glob
   * patterns. Must match the patterns the task declared in its
   * `network:private` entitlement scope (see `urlResourcePattern`). When
   * `undefined`, no scope check is applied and the boolean `allowPrivate`
   * governs alone — legacy behavior for direct callers outside the task
   * layer.
   *
   * This closes the "compromised redirect escapes grant scope" SSRF gap:
   * the task-graph enforcer approves a narrow private-host scope at
   * preflight, and this field re-enforces that same scope on every redirect
   * hop so a Location header cannot pivot to a different private host or
   * port the task was never authorized to reach.
   */
  readonly privateResourceScopes?: readonly string[];
  /**
   * Extra request-header names that carry a secret and must be dropped when a
   * redirect crosses to a different origin. {@link CROSS_ORIGIN_STRIPPED_HEADERS}
   * is always dropped regardless of this field; this list exists for schemes
   * that place a credential on a caller-named header (e.g. `X-Api-Key`), which
   * safeFetch cannot recognize on its own. Matched case-insensitively.
   */
  readonly sensitiveHeaders?: readonly string[];
}

/**
 * Request headers always dropped on a cross-origin redirect hop. Following a
 * redirect must not replay ambient authority to a host the caller never chose:
 * the redirect target is named by the previous server, which may itself be
 * compromised or attacker-influenced.
 */
export const CROSS_ORIGIN_STRIPPED_HEADERS: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "cookie",
];

/** Origin comparison, so a differing scheme or port also counts as cross-origin. */
function isCrossOrigin(fromUrl: string, toUrl: string): boolean {
  try {
    return new URL(fromUrl).origin !== new URL(toUrl).origin;
  } catch {
    // Unparseable on either side: fail closed and strip.
    return true;
  }
}

/**
 * Returns a copy of `headers` without the entries `drop` selects (by header
 * name), preserving the caller's `HeadersInit` shape (`Headers`, entry pairs, or
 * a plain record). Never mutates its argument.
 */
function removeHeaders(
  headers: HeadersInit | undefined,
  drop: (name: string) => boolean
): HeadersInit | undefined {
  if (headers === undefined) return undefined;

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const next = new Headers();
    headers.forEach((value, key) => {
      if (!drop(key)) next.append(key, value);
    });
    return next;
  }
  if (Array.isArray(headers)) {
    return headers.filter((entry) => !drop(entry[0] ?? ""));
  }
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers as Record<string, string>)) {
    if (!drop(key)) next[key] = value;
  }
  return next;
}

/**
 * Returns a copy of `headers` with the credential-bearing entries removed,
 * preserving the caller's `HeadersInit` shape (`Headers`, entry pairs, or a
 * plain record). Never mutates its argument.
 */
export function stripSensitiveHeaders(
  headers: HeadersInit | undefined,
  sensitiveHeaders: readonly string[] | undefined
): HeadersInit | undefined {
  const extra = new Set((sensitiveHeaders ?? []).map((name) => name.toLowerCase()));
  return removeHeaders(headers, (name) => {
    const lower = name.toLowerCase();
    return CROSS_ORIGIN_STRIPPED_HEADERS.includes(lower) || extra.has(lower);
  });
}

/**
 * Applies {@link stripSensitiveHeaders} to a request init when the next hop is
 * cross-origin; returns `init` unchanged otherwise.
 *
 * Callers thread the result forward as the init for every remaining hop, so a
 * header stripped once stays stripped for the rest of the chain even if a later
 * Location returns to the original origin. That is deliberate: restoring it
 * would let a `vendor -> attacker -> vendor` chain launder the credential back
 * into a request whose path the attacker chose.
 */
export function applyCrossOriginHeaderStrip<T extends { headers?: HeadersInit | undefined }>(
  init: T,
  fromUrl: string,
  toUrl: string,
  sensitiveHeaders: readonly string[] | undefined
): T {
  if (!isCrossOrigin(fromUrl, toUrl)) return init;
  return { ...init, headers: stripSensitiveHeaders(init.headers, sensitiveHeaders) };
}

/**
 * Entity headers that describe a request body. Dropped alongside the body when
 * a redirect downgrades a request to a bodiless GET.
 *
 * This is load-bearing rather than cosmetic: leaving `Content-Length: 47` on a
 * request that now carries no body makes undici state a length no body
 * satisfies.
 */
export const REDIRECT_BODY_HEADERS: readonly string[] = [
  "content-encoding",
  "content-language",
  "content-length",
  "content-location",
  "content-type",
];

/**
 * Applies the redirect's method/body rules to a request init, returning the init
 * for the next hop.
 *
 * Without this, every hop replayed the original method and body verbatim, so a
 * POST whose body carries a `client_secret` was re-POSTed to whatever origin the
 * previous server's Location header named — the header strip protects headers
 * only, and a body is not a header.
 *
 * - **303 (any method but HEAD), and 301/302 on POST** downgrade to a bodiless
 *   `GET`. That is what the Fetch spec, browsers, `curl -L` and undici's own
 *   follow mode all do, so matching it is compatibility rather than a policy of
 *   ours.
 * - **307/308 (and 301/302 on a non-POST)** preserve method and body by
 *   definition. Crossing origins with a body then THROWS
 *   {@link FetchUrlErrorCode.REDIRECT_BODY_NOT_REPLAYED} rather than silently
 *   downgrading: a downgrade would suppress the leak but also silently not
 *   perform the write the caller asked for, and then report success.
 *
 * Otherwise `init` is returned unchanged (identity), so a same-origin 307 keeps
 * its method, body and `Content-Type`.
 */
export function applyRedirectMethodAndBody<T extends RequestInit>(
  init: T,
  status: number,
  fromUrl: string,
  toUrl: string
): T {
  const method = (init.method ?? "GET").toUpperCase();
  const toBodilessGet = (): T => ({
    ...init,
    method: "GET",
    body: undefined,
    headers: removeHeaders(init.headers, (name) =>
      REDIRECT_BODY_HEADERS.includes(name.toLowerCase())
    ),
  });

  if (status === 303 && method !== "HEAD") return toBodilessGet();
  if ((status === 301 || status === 302) && method === "POST") return toBodilessGet();

  if (init.body !== undefined && init.body !== null && isCrossOrigin(fromUrl, toUrl)) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.REDIRECT_BODY_NOT_REPLAYED,
      `Refusing to follow the ${status} redirect from ${fromUrl} to ${toUrl}: a ${status} ` +
        `preserves the request method and body, and replaying the body cross-origin would ` +
        `disclose it to an origin the caller did not choose.`,
      { url: toUrl }
    );
  }
  return init;
}

export type SafeFetchFn = (url: string, options: SafeFetchOptions) => Promise<Response>;

const MAX_REDIRECT_HOPS = SECURITY_LIMITS.safeFetchMaxRedirectHops;

function assertAllowedUrl(
  url: string,
  allowPrivate: boolean | undefined,
  privateResourceScopes: readonly string[] | undefined
): void {
  const classification = classifyUrl(url);
  if (classification.kind === "invalid") {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.INVALID_URL,
      `Refusing to fetch invalid URL: ${classification.reason}`,
      { url }
    );
  }
  if (classification.kind !== "private") return;
  if (!allowPrivate) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.PRIVATE_DENIED,
      `Refusing to fetch private/internal URL ${url}: ${classification.reason}. ` +
        `Grant the 'network:private' entitlement to allow this request.`,
      { url }
    );
  }
  if (privateResourceScopes !== undefined && !urlMatchesScope(url, privateResourceScopes)) {
    throw createFetchUrlJobError(
      FetchUrlErrorCode.SCOPE_DENIED,
      `Refusing to fetch private/internal URL ${url}: outside granted network:private scope ` +
        `[${privateResourceScopes.join(", ")}]. A compromised upstream may be attempting ` +
        `to escape the task's authorized private-host origin.`,
      { url }
    );
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Builds the refusal both transports raise when a 3xx arrives and the caller
 * asked for `redirect: "error"`. Every transport MUST route that refusal
 * through this factory: it is the only construction site, so the single
 * {@link FetchUrlErrorCode.REDIRECT_NOT_FOLLOWED} discriminant is what
 * {@link isSafeFetchRedirectError} matches on, and no consumer has to
 * recognize the refusal from the wording of a message.
 *
 * The `Location` header is deliberately neither read nor reported. A caller
 * whose URL is itself a credential (see `postWebhookJson`) turns this into a
 * user-facing message, and the target an untrusted endpoint tried to redirect
 * to has no place in a log line.
 */
export function createSafeFetchRedirectError(
  url: string,
  status: number
): FetchUrlJobErrorInstance {
  return createFetchUrlJobError(
    FetchUrlErrorCode.REDIRECT_NOT_FOLLOWED,
    `Refusing to follow redirect from ${url}: responded ${status} and redirect mode is 'error'.`,
    { url, httpStatus: status }
  );
}

/**
 * Narrow guard for the refusal {@link createSafeFetchRedirectError} builds.
 *
 * Exported so consumers never re-derive it from an error's name or message:
 * prose drifts silently, and a consumer that stops recognizing this refusal
 * falls through to its generic network branch — which is retryable, quietly
 * turning a refused redirect into a retried one.
 */
export function isSafeFetchRedirectError(error: unknown): error is FetchUrlJobErrorInstance {
  return isFetchUrlJobError(error) && error.code === FetchUrlErrorCode.REDIRECT_NOT_FOLLOWED;
}

/**
 * Browser-safe default implementation. Classifies the URL statically and
 * delegates to `globalThis.fetch`. Each redirect hop is validated before
 * following so a public URL cannot redirect to a private host.
 *
 * The browser controls DNS itself, so we cannot defeat DNS rebinding from
 * browser code — callers must rely on the browser sandbox (CORS,
 * same-origin) as the second layer.
 */
async function defaultSafeFetch(url: string, options: SafeFetchOptions): Promise<Response> {
  const requestedRedirectMode = options.redirect ?? "follow";
  const {
    allowPrivate,
    privateResourceScopes,
    sensitiveHeaders,
    redirect: _redirect,
    ...initialFetchOptions
  } = options;

  let currentUrl = url;
  let fetchOptions: Omit<
    SafeFetchOptions,
    "allowPrivate" | "privateResourceScopes" | "sensitiveHeaders" | "redirect"
  > = initialFetchOptions;
  for (let hops = 0; hops <= MAX_REDIRECT_HOPS; hops += 1) {
    assertAllowedUrl(currentUrl, allowPrivate, privateResourceScopes);

    const response = await globalThis.fetch(currentUrl, {
      ...fetchOptions,
      redirect: "manual",
    });

    if (!isRedirectStatus(response.status)) {
      return response;
    }

    if (requestedRedirectMode === "manual") {
      return response;
    }

    if (requestedRedirectMode === "error") {
      throw createSafeFetchRedirectError(currentUrl, response.status);
    }

    const location = response.headers.get("location");
    if (!location) {
      throw createFetchUrlJobError(
        FetchUrlErrorCode.REDIRECT_MISSING_LOCATION,
        `Refusing to follow redirect from ${currentUrl}: missing Location header.`,
        { url: currentUrl }
      );
    }

    const nextUrl = new URL(location, currentUrl).toString();
    // Keep these two adjacent: a credential can ride on a header or in the
    // body, and the pair is what covers both.
    fetchOptions = applyRedirectMethodAndBody(fetchOptions, response.status, currentUrl, nextUrl);
    // Credential-bearing headers never survive an origin change; the strip is
    // carried forward, so it is never undone by a later same-origin hop.
    fetchOptions = applyCrossOriginHeaderStrip(fetchOptions, currentUrl, nextUrl, sensitiveHeaders);
    currentUrl = nextUrl;
  }

  throw createFetchUrlJobError(
    FetchUrlErrorCode.TOO_MANY_REDIRECTS,
    `Refusing to fetch ${url}: too many redirects.`,
    { url }
  );
}

let currentImpl: SafeFetchFn = defaultSafeFetch;

/**
 * Register a platform-specific SafeFetch implementation. The Node/Bun
 * entrypoints call this at module load time to install the DNS-resolving,
 * connection-pinning implementation from `SafeFetch.server.ts`.
 *
 * Returns the previously registered implementation so callers can safely
 * restore it after a temporary override.
 */
export function registerSafeFetch(fn: SafeFetchFn): SafeFetchFn {
  const previousImpl = currentImpl;
  currentImpl = fn;
  return previousImpl;
}

export function getSafeFetchImpl(): SafeFetchFn {
  return currentImpl;
}

/** Restores the default browser-safe implementation. */
export function resetSafeFetch(): void {
  currentImpl = defaultSafeFetch;
}

/**
 * SSRF-aware fetch. See {@link SafeFetchOptions} for the `allowPrivate` flag.
 * Throws `PermanentJobError` if the URL targets a private host without
 * permission, or (server impl) if DNS resolves to a private IP.
 */
export function safeFetch(url: string, options: SafeFetchOptions = {}): Promise<Response> {
  return currentImpl(url, options);
}
