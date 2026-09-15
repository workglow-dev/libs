/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { it } from "vitest";

type ItFn = (name: string, fn: () => Promise<void> | void, timeout?: number) => void;

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
    // `retry: 0`, and options SECOND (`test(name, fn, {...})` was removed in
    // Vitest 4). Retrying a test that is SUPPOSED to fail is meaningless, and
    // vitest counts the intended failure as a retry — which lands every
    // expected-fail test in the run summary's "Flaky Tests" section, where a
    // real flake then hides among permanent false entries.
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
      } catch {
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
