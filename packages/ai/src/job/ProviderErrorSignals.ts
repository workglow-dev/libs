/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a provider's error says about itself beyond its status: whether the
 * account is out of credits, and how long the provider asked the caller to
 * wait. Both read the error as each vendor's SDK builds it, and both walk
 * `cause`, so a wrapper around an SDK error still answers.
 */

const BILLING_CODES: ReadonlySet<string> = new Set([
  "insufficient_quota",
  "billing_hard_limit_reached",
  "insufficient_credits",
  "insufficient_balance",
  "billing_error",
]);

const CREDIT_MESSAGE =
  /insufficient credits|not enough credits|no (?:credits remaining|remaining credits)|out of credits|credits are depleted|prepayment credits|insufficient[\s_-]balance|balance is (?:too low|insufficient)|exceeded[\s\S]{0,80}credits|monthly included credits|payment required|exceeded your current quota|check your plan and billing|billing_hard_limit/i;

/**
 * A 402 that survives only as text: an error rebuilt from its message (a
 * classified job error, one flattened across a worker) has lost its numeric
 * `status`. Anchored to an HTTP-shaped position — start of a line, after a
 * summary line's colon, or a JSON error body's `"code": 402`, which is how
 * Gemini's billing failure arrives — so prose that merely contains the number
 * ("Item 402(c)") is not scavenged as a status.
 */
const HTTP_402_MESSAGE =
  /\bHTTP\/?\d?(?:\.\d)?\s*402\b|\bstatus(?:\s*code)?\s*[:=]\s*402\b|\berror code:?\s*402\b|"code"\s*:\s*402\b|(?:^|:\s+)402\s+[a-z]/im;

/**
 * Whether `err` reports an account that cannot pay: a 402, a billing code or
 * type (OpenAI's `insufficient_quota`, Anthropic's `billing_error`), or a
 * vendor's credit-exhaustion wording. Rate limits are not this — a TPM or RPM
 * 429 passes on its own.
 *
 * The wording half is looser than the structured half: Gemini words a
 * per-minute quota as "exceeded your current quota ... check your plan and
 * billing", exactly as OpenAI words exhausted credits. {@link hasBillingCode}
 * answers the structured half alone, for a caller that has to tell them apart.
 */
export function isCreditExhaustedError(err: unknown): boolean {
  return someInCauseChain(err, (node) => {
    if (typeof node === "string") return messageLooksLikeCreditExhaustion(node);
    if (nodeHasBillingCode(node)) return true;
    if (!node || typeof node !== "object") return false;
    const rec = node as Record<string, unknown>;
    const message = [stringish(rec.message), stringish(nested(rec.error, "message"))]
      .filter((part): part is string => part !== undefined)
      .join("\n");
    return messageLooksLikeCreditExhaustion(message);
  });
}

/** Whether `err` carries a 402 status or a billing code or type as a field, not just as wording. */
export function hasBillingCode(err: unknown): boolean {
  return someInCauseChain(err, nodeHasBillingCode);
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
  if (retryDate instanceof Date && !Number.isNaN(retryDate.getTime())) {
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
  const openai = /try again in (\d+(?:\.\d+)?)\s*(ms|s)\b/i.exec(message);
  if (openai) {
    const amount = Number(openai[1]);
    return Math.round(openai[2]!.toLowerCase() === "ms" ? amount : amount * 1000);
  }
  const legacy = /retry.after[:\s]*(\d+)/i.exec(message);
  return legacy ? Number(legacy[1]) * 1000 : undefined;
}

function nodeHasBillingCode(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const rec = node as Record<string, unknown>;
  if (numericStatus(rec) === 402) return true;
  for (const value of [rec.code, rec.type, nested(rec.error, "code"), nested(rec.error, "type")]) {
    if (typeof value === "string" && BILLING_CODES.has(value)) return true;
  }
  return false;
}

function messageLooksLikeCreditExhaustion(message: string): boolean {
  return CREDIT_MESSAGE.test(message) || HTTP_402_MESSAGE.test(message);
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

function numericStatus(rec: Record<string, unknown>): number | undefined {
  for (const value of [rec.status, rec.statusCode, nested(rec.error, "status")]) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function nested(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringish(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
