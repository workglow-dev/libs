/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a provider's error says about itself beyond its status: whether the
 * account is out of credits, and how long the provider asked the caller to
 * wait. Both read the error as each vendor's SDK builds it, and both walk
 * `cause`, so a wrapper around an SDK error still answers. The billing matcher
 * is `@workglow/util`'s, re-exported here.
 */

export { hasBillingCode, isCreditExhaustedError } from "@workglow/util";

/**
 * The wait a job queue gives a 429 that stated none. A queue reschedules a
 * retryable job at its limiter's next free slot, which for a concurrency
 * limiter is now, so without a date of its own a rate-limited job would be
 * retried at once until its attempts ran out.
 */
export const DEFAULT_RATE_LIMIT_RETRY_MS = 30_000;

const ESTIMATED_RETRY_DATE: unique symbol = Symbol.for("workglow.ai.estimatedRetryDate");

/**
 * Marks `err`'s `retryDate` as this package's own default rather than the
 * provider's word, so a caller with a backoff of its own (an agent's round
 * retry) uses that instead, while a queue still spaces the retry by the date.
 * Returns `err`.
 */
export function markRetryDateEstimated<T extends object>(err: T): T {
  try {
    Object.defineProperty(err, ESTIMATED_RETRY_DATE, { value: true });
  } catch {
    // A frozen error keeps its date; it is then read as stated.
  }
  return err;
}

/** Whether `err`'s `retryDate` is a default {@link markRetryDateEstimated} stamped, not a stated wait. */
export function isRetryDateEstimated(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { [ESTIMATED_RETRY_DATE]?: unknown })[ESTIMATED_RETRY_DATE] === true
  );
}

/** Header names, lower-cased, a provider states its wait in. */
const RETRY_AFTER_MS_HEADER = "retry-after-ms";
const RETRY_AFTER_HEADER = "retry-after";

/**
 * How long the provider asked the caller to wait, in milliseconds, or
 * `undefined` when it said nothing — in which case the caller picks its own
 * backoff rather than treating a guess as the provider's word.
 *
 * Read in order, the first answer winning:
 * - `retryAfterMs`, the serialisable copy carried across a worker boundary;
 * - `retryDate` on an error that already holds one;
 * - `headers` (a `Headers` instance or a plain record): `retry-after-ms`, then
 *   `retry-after` as seconds or an HTTP date;
 * - Gemini's `RetryInfo.retryDelay` (`"7s"`), in `details` or the message's body;
 * - OpenAI's "Please try again in 1.2s" / "in 350ms";
 * - "retry after N" (seconds).
 */
export function statedRetryAfterMs(err: unknown, now: number = Date.now()): number | undefined {
  let found: number | undefined;
  someInCauseChain(err, (node) => {
    found = nodeRetryAfterMs(node, now);
    return found !== undefined;
  });
  return found;
}

/**
 * Copies {@link statedRetryAfterMs} onto `err` as `retryAfterMs`, a number,
 * because a worker boundary flattens an error to a few plain fields: the
 * headers it was read from, a `Date`, and the cause chain do not cross.
 * Returns `err`; a value that is not an object is returned untouched.
 */
export function withStatedRetryAfter<T>(err: T): T {
  if (err === null || typeof err !== "object") return err;
  const ms = statedRetryAfterMs(err);
  if (ms === undefined) return err;
  try {
    (err as { retryAfterMs?: number }).retryAfterMs = ms;
  } catch {
    // A frozen error keeps its message; the delay is lost, not the failure.
  }
  return err;
}

function nodeRetryAfterMs(node: unknown, now: number): number | undefined {
  if (typeof node === "string") return retryAfterFromMessage(node);
  if (!node || typeof node !== "object") return undefined;
  const rec = node as Record<string, unknown>;

  const carried = rec.retryAfterMs;
  if (typeof carried === "number" && Number.isFinite(carried) && carried >= 0) return carried;

  const retryDate = rec.retryDate;
  if (
    retryDate instanceof Date &&
    !Number.isNaN(retryDate.getTime()) &&
    !isRetryDateEstimated(node)
  ) {
    return Math.max(0, retryDate.getTime() - now);
  }

  const fromHeaders = retryAfterFromHeaders(rec.headers, now);
  if (fromHeaders !== undefined) return fromHeaders;

  const fromDetails =
    retryDelayFromDetails(rec.details) ?? retryDelayFromDetails(nested(rec.error, "details"));
  if (fromDetails !== undefined) return fromDetails;

  const message = [stringish(rec.message), stringish(nested(rec.error, "message"))]
    .filter((part): part is string => part !== undefined)
    .join("\n");
  return message ? retryAfterFromMessage(message) : undefined;
}

function headerValue(headers: unknown, name: string): string | undefined {
  if (!headers || typeof headers !== "object") return undefined;
  if (typeof (headers as { get?: unknown }).get === "function") {
    const value = (headers as { get(name: string): unknown }).get(name);
    return typeof value === "string" ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== name) continue;
    if (typeof value === "string") return value;
    if (typeof value === "number") return String(value);
    if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  }
  return undefined;
}

function retryAfterFromHeaders(headers: unknown, now: number): number | undefined {
  const ms = headerValue(headers, RETRY_AFTER_MS_HEADER);
  if (ms !== undefined) {
    const value = Number(ms.trim());
    if (ms.trim() !== "" && Number.isFinite(value) && value >= 0) return value;
  }
  const after = headerValue(headers, RETRY_AFTER_HEADER)?.trim();
  if (after === undefined || after === "") return undefined;
  if (/^\d+(?:\.\d+)?$/.test(after)) return Number(after) * 1000;
  const date = Date.parse(after);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** A protobuf `Duration` as JSON spells it: `"7s"`, `"0.5s"`. */
function durationMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?)s$/.exec(value.trim());
  return match ? Math.round(Number(match[1]) * 1000) : undefined;
}

function retryDelayFromDetails(details: unknown): number | undefined {
  if (!Array.isArray(details)) return undefined;
  for (const detail of details) {
    const ms = durationMs(nested(detail, "retryDelay"));
    if (ms !== undefined) return ms;
  }
  return undefined;
}

function retryAfterFromMessage(message: string): number | undefined {
  const gemini = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(message);
  if (gemini) return Math.round(Number(gemini[1]) * 1000);
  // Digit runs and segments are bounded: the message is provider text, and an
  // unbounded `\d+` inside a repeated group backtracks polynomially on a long
  // run of digits.
  const openai = /try again in ((?:\d{1,9}(?:\.\d{1,9})? ?(?:ms|h|m|s)){1,4})\b/i.exec(message);
  if (openai) return goDurationMs(openai[1]!);
  const legacy = /retry.after[:\s]*(\d+)/i.exec(message);
  return legacy ? Number(legacy[1]) * 1000 : undefined;
}

/**
 * A Go-style duration as OpenAI words a wait: `350ms`, `1.2s`, `6m0s`, `1h2m3s`.
 * `ms` is read before `m`, so `350ms` is never 350 minutes.
 */
function goDurationMs(text: string): number {
  const unitMs: Readonly<Record<string, number>> = { h: 3_600_000, m: 60_000, s: 1_000, ms: 1 };
  let total = 0;
  for (const [, amount, unit] of text.matchAll(/(\d{1,9}(?:\.\d{1,9})?) ?(ms|h|m|s)/gi)) {
    total += Number(amount) * unitMs[unit!.toLowerCase()]!;
  }
  return Math.round(total);
}

function someInCauseChain(err: unknown, test: (node: unknown) => boolean): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (test(current)) return true;
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

function nested(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringish(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
