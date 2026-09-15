/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { isCreditExhaustedError, it } from "./creditExhaustedSkip";

type ItFn = (name: string, fn: () => Promise<void> | void, timeout?: number) => void;

/**
 * Cross-runner polyfill for `it.fails`. Vitest exposes it natively; bun's
 * native `bun test` runner does not. Under bun we wrap the body in a
 * try/catch and assert that it threw — so a passing-when-expected-fail
 * test still surfaces as a CI failure (signalling "remove from
 * expectedFailures").
 */
export const itExpectFail: ItFn = (name, fn, timeout) => {
  const native = (
    it as unknown as {
      fails?: (
        name: string,
        options: { readonly retry?: number; readonly timeout?: number },
        fn: () => Promise<void> | void
      ) => void;
    }
  ).fails;
  if (typeof native === "function") {
    // `retry: 0` because retrying a test that is SUPPOSED to fail is
    // meaningless, and vitest counts the intended failure as a retry — which
    // puts every expected-fail test in the run summary's "Flaky Tests" section
    // under "passed only after one or more retries". A real flake then hides
    // among permanent false entries, which is worse than no report at all.
    // Options go SECOND: `test(name, fn, {...})` was removed in Vitest 4.
    native(name, { retry: 0, timeout }, fn);
    return;
  }
  it(
    `${name} [expected-fail]`,
    async () => {
      let passed = false;
      try {
        await fn();
        passed = true;
      } catch (err) {
        // Billing exhaustion is not the adapter bug this marker records.
        if (isCreditExhaustedError(err)) throw err;
        // expected; the test was supposed to fail
      }
      if (passed) {
        throw new Error(
          `Test "${name}" was marked as expected-fail but passed. Remove its name from opts.expectedFailures.`
        );
      }
    },
    timeout
  );
};
