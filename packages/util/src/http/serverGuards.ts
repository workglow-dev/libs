/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

/** Bytes of entropy behind a generated token. 32 is what a session key wants. */
const TOKEN_BYTES = 32;

/**
 * A fresh bearer token for one server process.
 *
 * base64url rather than hex or a UUID: it survives being pasted into a JSON
 * client config, a shell one-liner and a URL unescaped, which is the whole
 * journey this value makes.
 */
export function generateBearerToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** The only auth scheme these servers answer to, lower-cased for comparison. */
const BEARER_SCHEME = "bearer";

/** A bare character class, so scanning for one cannot backtrack. */
const LINE_TERMINATOR = /[\n\r\u2028\u2029]/;

/**
 * The credential out of an `Authorization` header, or `undefined` when the
 * header is absent or names another scheme.
 *
 * The scheme is matched case-insensitively because RFC 9110 says it is; a
 * client sending `bearer` is not making a mistake worth a 401 nobody can read.
 *
 * Spelled out rather than as `/^bearer[ \t]+(.+)$/i`, which is quadratic on
 * this input: the separator run and the credential can both match a tab, so a
 * header the pattern ultimately rejects is re-split at every position between
 * them. Measured at 380ms for a 16 KB header — which is exactly Node's default
 * header cap — against microseconds here.
 */
export function readBearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const value = header.trim();
  if (value.length <= BEARER_SCHEME.length) return undefined;
  if (value.slice(0, BEARER_SCHEME.length).toLowerCase() !== BEARER_SCHEME) return undefined;
  // RFC 9110 puts at least one space or tab between the scheme and the
  // credential, so `Bearerabc` names no scheme this server knows.
  const separator = value[BEARER_SCHEME.length];
  if (separator !== " " && separator !== "\t") return undefined;
  const credential = value.slice(BEARER_SCHEME.length + 1);
  // The `.` this replaced never matched a line terminator, so a header
  // carrying one named no credential. A header value cannot legally hold one
  // anyway; rejecting keeps the old reading rather than trimming it away.
  if (LINE_TERMINATOR.test(credential)) return undefined;
  const token = credential.trim();
  return token.length > 0 ? token : undefined;
}

/** Compares two tokens without leaking their common prefix through timing. */
export function bearerTokenMatches(provided: string, expected: string): boolean {
  const left = Buffer.from(provided, "utf8");
  const right = Buffer.from(expected, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export interface BearerAuthFailure {
  readonly status: 401;
  readonly error: string;
  /** Send as `WWW-Authenticate`, which is what tells a client to retry with a token. */
  readonly wwwAuthenticate: string;
}

/**
 * Checks one request's `Authorization` header against the expected token.
 *
 * `expected` of `undefined` means the host turned authentication off, and this
 * returns `undefined` (allowed) without looking at the header at all — the
 * decision to run unauthenticated belongs to whoever started the server, not to
 * whoever sends the next request.
 */
export function authorizeBearer(
  header: string | undefined,
  expected: string | undefined
): BearerAuthFailure | undefined {
  if (expected === undefined) return undefined;
  const provided = readBearerToken(header);
  if (provided === undefined) {
    return {
      status: 401,
      error: "missing bearer token",
      wwwAuthenticate: 'Bearer error="invalid_request"',
    };
  }
  if (!bearerTokenMatches(provided, expected)) {
    return {
      status: 401,
      error: "invalid bearer token",
      wwwAuthenticate: 'Bearer error="invalid_token"',
    };
  }
  return undefined;
}

/** A bind address that names no reachable host, so no allow-list follows from it. */
export function isWildcardHost(host: string): boolean {
  return host === "" || host === "0.0.0.0" || host === "::" || host === "[::]";
}

/** What a server is, for the error naming the auth choice it refused. */
export interface ServerAuthIdentity {
  /** The function the caller invoked, so the error points at their call. */
  readonly name: string;
  /** What reaching the port lets a caller do: "every tool it offers runs a task". */
  readonly consequence: string;
}

/**
 * Refuses a server that would do work for whoever reaches the port.
 *
 * `undefined` cannot be spelled through the types and is checked anyway: an
 * untyped caller still arrives here with the field omitted, and that used to
 * mean "serve unauthenticated".
 *
 * A wildcard bind additionally refuses `null` outright. It is reachable under
 * every name and address the machine answers to, and {@link resolveAllowedHosts}
 * can derive no `Host` allow-list from it either, so nothing at all would be
 * left deciding who gets in. Naming the interface to bind is how an
 * unauthenticated server on a reachable address is asked for.
 */
export function assertAuthChoice(
  token: string | null | undefined,
  host: string,
  server: ServerAuthIdentity
): void {
  if (token === undefined) {
    throw new Error(
      `${server.name} requires \`token\`: a bearer token every request must present, ` +
        "or `null` to serve without authentication."
    );
  }
  if (token === null && isWildcardHost(host.toLowerCase())) {
    throw new Error(
      `${server.name} refuses to serve unauthenticated on the wildcard bind "${host}": ` +
        `${server.consequence}. Pass a token, or bind the one interface it should answer on.`
    );
  }
}

/**
 * The `Host` values to answer to, or `undefined` for "do not check".
 *
 * The check exists to stop DNS rebinding pointing a page on another site at a
 * loopback server, and a loopback bind is the case it can actually decide. A
 * wildcard bind is reachable under every name the machine answers to — its own
 * hostname, a LAN address, whatever a reverse proxy passes through — and none
 * of those are derivable from `0.0.0.0`. Deriving the list from the bind
 * address anyway refused every real client of the exposure the operator had
 * just asked for, so a wildcard bind checks nothing unless the host names the
 * values itself.
 */
export function resolveAllowedHosts(
  host: string,
  extra: Iterable<string> | undefined
): ReadonlySet<string> | undefined {
  const named = [...(extra ?? [])].map((value) => value.toLowerCase());
  if (isWildcardHost(host.toLowerCase()) && named.length === 0) return undefined;
  return new Set([host.toLowerCase(), "localhost", "127.0.0.1", "[::1]", "::1", ...named]);
}

/**
 * The host a `Host:` header names, without its port.
 *
 * An IPv6 literal is bracketed and full of colons, so splitting on the first
 * one yields `"["` — which matches no allow-list, and refuses every request
 * from `http://[::1]:8788/` while naming a host nobody typed.
 */
export function hostWithoutPort(header: string | undefined): string {
  const value = (header ?? "").trim();
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    return close === -1 ? value.toLowerCase() : value.slice(0, close + 1).toLowerCase();
  }
  const colon = value.indexOf(":");
  return (colon === -1 ? value : value.slice(0, colon)).toLowerCase();
}

/** Thrown only by the size cap, so a dropped connection is not reported as one. */
export class BodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`request body exceeds ${limit} bytes`);
    this.name = "BodyTooLargeError";
  }
}

/**
 * The whole request body as text, or a {@link BodyTooLargeError} past `limit`.
 *
 * Buffered whole because the handlers behind it parse JSON, and bounded because
 * of that: an unbounded body is a caller's memory to spend.
 */
export async function readRequestBody(req: IncomingMessage, limit: number): Promise<string> {
  // A declared length over the cap is refused before a byte is buffered.
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError(limit);

  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > limit) throw new BodyTooLargeError(limit);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, size).toString("utf8");
}
