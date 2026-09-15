/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { it as vitestIt } from "vitest";

/**
 * Live provider tests treat "the account is out of credits" as a billing
 * condition rather than a product bug. A key being present is not the same as
 * the account being able to pay; HuggingFace / OpenRouter 402s, Anthropic's
 * credit-balance error, DeepSeek's `Insufficient Balance`, and OpenAI's
 * `insufficient_quota` are all billing.
 *
 * Rate limits (429 + `rate_limit_exceeded`) are NOT this: those are transient
 * and the existing retry policy handles them.
 *
 * Where it skips and where it fails is a deliberate split
 * ({@link creditExhaustionSkipsTest}): on CI it skips for every provider,
 * because a red build tells a reviewer nothing they can act on; locally it
 * fails, because the developer running the suite is the one who can top the
 * account up. `WORKGLOW_CREDIT_EXHAUSTED_SKIP=1` forces the skip locally
 * (and `=0` forces the failure on CI).
 */

const BILLING_CODES = new Set([
  "insufficient_quota",
  "billing_hard_limit_reached",
  "insufficient_credits",
  "insufficient_balance",
]);

const CREDIT_MESSAGE =
  /insufficient credits|not enough credits|no credits remaining|out of credits|insufficient[\s_-]balance|balance is (?:too low|insufficient)|exceeded[\s\S]{0,80}credits|monthly included credits|payment required|exceeded your current quota|check your plan and billing|billing_hard_limit/i;

/**
 * A 402 that survives only as text. `classifyProviderError` rebuilds the error
 * as a `PermanentJobError` carrying the message and no `cause`, so by the time
 * a live test sees a DeepSeek billing failure the numeric `status` is gone and
 * the OpenAI-SDK message shape (`402 Insufficient Balance`) is all that is
 * left. Anchored to an HTTP-shaped position — start of a line, or after a
 * summary line's colon — so prose that merely contains the number
 * ("Item 402(c)") is not scavenged as a status.
 */
const HTTP_402_MESSAGE =
  /\bHTTP\/?\d?(?:\.\d)?\s*402\b|\bstatus(?:\s*code)?\s*[:=]\s*402\b|\berror code:?\s*402\b|(?:^|:\s+)402\s+[a-z]/im;

export function isCreditExhaustedError(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (matchesCreditExhaustion(current)) return true;
    current = causeOf(current);
  }
  return false;
}

function matchesCreditExhaustion(err: unknown): boolean {
  if (typeof err === "string") return messageLooksLikeCreditExhaustion(err);

  if (!err || typeof err !== "object") return false;

  const rec = err as Record<string, unknown>;
  const status = numericStatus(rec);
  if (status === 402) return true;

  const code = stringish(rec.code) ?? stringish(nested(rec.error, "code"));
  const type = stringish(rec.type) ?? stringish(nested(rec.error, "type"));
  if (code && BILLING_CODES.has(code)) return true;
  if (type && BILLING_CODES.has(type)) return true;

  const message = [
    stringish(rec.message),
    stringish(nested(rec.error, "message")),
    stringifyUnknown(err),
  ]
    .filter((part): part is string => typeof part === "string")
    .join("\n");
  return messageLooksLikeCreditExhaustion(message);
}

function messageLooksLikeCreditExhaustion(message: string): boolean {
  return CREDIT_MESSAGE.test(message) || HTTP_402_MESSAGE.test(message);
}

function numericStatus(rec: Record<string, unknown>): number | undefined {
  for (const key of ["status", "statusCode"] as const) {
    const value = rec[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  const nestedStatus = nested(rec.error, "status");
  if (typeof nestedStatus === "number" && Number.isFinite(nestedStatus)) return nestedStatus;
  return undefined;
}

function nested(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined;
  return (value as Record<string, unknown>)[key];
}

function stringish(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringifyUnknown(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

function causeOf(err: unknown): unknown {
  if (!err || typeof err !== "object") return undefined;
  return (err as { cause?: unknown }).cause;
}

export function creditSkipNote(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `skipped: provider out of credits (${message})`;
}

const SKIP_OVERRIDE_ENV = "WORKGLOW_CREDIT_EXHAUSTED_SKIP";

function isTruthyFlag(value: string): boolean {
  return !/^(?:0|false|off|no)$/i.test(value.trim());
}

/**
 * Whether a billing failure skips the test or fails it.
 *
 * CI skips: nobody watching a build can top an account up, and one exhausted
 * key would otherwise turn every provider suite red for a change that touched
 * none of them — so the leniency is provider-agnostic by construction, keyed on
 * the environment rather than on which vendor ran out.
 *
 * Locally it fails, loudly, because the developer running the suite IS the
 * person who can act on it — and a silently green local run is how an
 * exhausted account goes unnoticed until CI is the only thing exercising the
 * provider at all.
 *
 * `WORKGLOW_CREDIT_EXHAUSTED_SKIP` overrides in both directions.
 */
export function creditExhaustionSkipsTest(
  env: Record<string, string | undefined> = process.env
): boolean {
  const override = env[SKIP_OVERRIDE_ENV];
  if (override !== undefined && override.trim() !== "") return isTruthyFlag(override);
  for (const key of ["CI", "GITHUB_ACTIONS"] as const) {
    const value = env[key];
    if (value !== undefined && value.trim() !== "" && isTruthyFlag(value)) return true;
  }
  return false;
}

/**
 * The local-failure path. Rethrows the provider's own error unchanged — its
 * identity and stack are what makes the failure diagnosable — after one line
 * saying why it was not skipped and how to skip it.
 */
function reportLocalCreditFailure(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  console.error(
    `provider out of credits (${message})\n` +
      `  Failing because this is not CI. Top the account up, or set ${SKIP_OVERRIDE_ENV}=1 to skip instead.`
  );
}

export async function runWithCreditSkip<T>(
  ctx: { skip: (note?: string) => void },
  fn: () => Promise<T> | T
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isCreditExhaustedError(err)) {
      if (!creditExhaustionSkipsTest()) {
        reportLocalCreditFailure(err);
        throw err;
      }
      ctx.skip(creditSkipNote(err));
      // vitest's skip() is `never` (throws). Mocks used in unit tests return.
      return undefined as T;
    }
    throw err;
  }
}

/**
 * Wraps one test body. This is the seam every conformance assertion actually
 * runs through (the exported {@link it} proxies each callback through it), so
 * the CI-skips / locally-fails policy is applied here rather than at each
 * call site.
 */
export function wrapTestBodyForCreditSkip(
  fn: (...args: never[]) => unknown
): (...args: never[]) => unknown {
  return async function wrapped(this: unknown, ...args: never[]): Promise<unknown> {
    try {
      return await fn.apply(this, args);
    } catch (err) {
      if (!isCreditExhaustedError(err)) throw err;
      if (!creditExhaustionSkipsTest()) {
        reportLocalCreditFailure(err);
        throw err;
      }
      const ctx = args[0] as { skip?: (note?: string) => void } | undefined;
      if (ctx && typeof ctx.skip === "function") {
        ctx.skip(creditSkipNote(err));
        return undefined;
      }
      // bun:test has no TestContext.skip; passing is "don't fail the test".
      console.warn(creditSkipNote(err));
      return undefined;
    }
  };
}

function wrapCallable(fn: CallableFunction): CallableFunction {
  return new Proxy(fn, {
    apply(target, thisArg, argArray: unknown[]) {
      const wrapped = argArray.map((arg) =>
        typeof arg === "function" ? wrapTestBodyForCreditSkip(arg as never) : arg
      );
      const result = Reflect.apply(target, thisArg, wrapped);
      return typeof result === "function" ? wrapCallable(result) : result;
    },
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function") {
        return wrapCallable((value as CallableFunction).bind(target));
      }
      return value;
    },
  });
}

/**
 * Drop-in `it` for live provider tests: a credit/billing error skips the test on
 * CI and fails it locally (see {@link creditExhaustionSkipsTest}).
 */
export const it = wrapCallable(vitestIt) as typeof vitestIt;
