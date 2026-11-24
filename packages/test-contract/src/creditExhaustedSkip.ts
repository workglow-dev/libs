/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { isCreditExhaustedError } from "@workglow/ai";
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
 *
 * The billing matcher is `@workglow/ai`'s, the same one `classifyProviderError`
 * uses to fail an out-of-credits call permanently instead of retrying it.
 */

export { isCreditExhaustedError };

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
