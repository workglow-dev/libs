/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * The single place a remote-supplied retry hint becomes a `Date`.
 *
 * `Retry-After` — the header, and the JSON `retry_after` some providers answer
 * a 429 with — is attacker-controlled input. A retry date built from it
 * unchecked is not merely a long wait: a large enough delay pushes the
 * timestamp past the maximum representable `Date`, and the resulting Invalid
 * Date survives an `instanceof Date` check downstream, where its NaN turns
 * into a `RangeError` from `toISOString()` and the job is never rescheduled at
 * all. Everything that parses one of these values funnels through here so the
 * ceiling cannot be applied at one call site and forgotten at the next.
 */

import { SECURITY_LIMITS } from "@workglow/util";

/** Ceiling in milliseconds derived from {@link SECURITY_LIMITS.httpRetryAfterMaxSeconds}. */
const MAX_RETRY_AFTER_MS = SECURITY_LIMITS.httpRetryAfterMaxSeconds * 1000;

/**
 * Turns an absolute epoch-milliseconds instant into a bounded retry date,
 * clamped to `[now, now + httpRetryAfterMaxSeconds]`.
 *
 * The `Number.isFinite(date.getTime())` gate is the single return gate for
 * every retry date this module produces. It is unreachable once the clamp has
 * run — which is the point: no caller has to remember that a `Date` can be
 * invalid, because none can be handed one from here.
 */
export function retryDateFromEpochMs(epochMs: number): Date | undefined {
  if (!Number.isFinite(epochMs)) {
    return undefined;
  }
  const now = Date.now();
  const clamped = Math.min(Math.max(epochMs, now), now + MAX_RETRY_AFTER_MS);
  const date = new Date(clamped);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

/**
 * Parses a `Retry-After` header value in either RFC 9110 form — delay seconds
 * or an HTTP date — into a bounded retry date.
 *
 * Both forms need the ceiling: `"1e20"` overflows the timestamp outright, and
 * `"Fri, 01 Jan 9999 00:00:00 GMT"` parses perfectly well into a date that
 * parks a job for millennia. A date already in the past carries no usable
 * hint and yields `undefined`, so a caller can fall through to its next
 * source rather than retrying immediately on a stale value.
 */
export function retryDateFromRetryAfterHeader(header: string | null | undefined): Date | undefined {
  if (header === null || header === undefined) {
    return undefined;
  }
  const trimmed = header.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  const seconds = Number(trimmed);
  // `>= 0`, not `> 0`: zero is a valid delta-seconds meaning "retry now", and
  // it is the whole of what the server said. Excluding it drops the header
  // entirely — the date branch below reads "0" as the year 2000, which is in
  // the past and so sets nothing — leaving the caller unable to tell
  // `Retry-After: 0` from a response carrying no header at all. A caller that
  // backs off on its own then applies its no-guidance default to a response
  // that asked for no wait.
  if (Number.isFinite(seconds) && seconds >= 0) {
    return retryDateFromEpochMs(Date.now() + seconds * 1000);
  }
  const parsed = Date.parse(trimmed);
  if (Number.isFinite(parsed) && parsed > Date.now()) {
    return retryDateFromEpochMs(parsed);
  }
  return undefined;
}
