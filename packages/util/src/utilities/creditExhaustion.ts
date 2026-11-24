/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Whether a provider's error reports an account that cannot pay. It lives here,
 * with no dependency on the AI packages, so the job classifier that fails such
 * a call permanently and the test-contract helper that skips a live test over
 * it read one matcher, and a storage contract suite importing that helper does
 * not pull in an AI package to do it.
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
