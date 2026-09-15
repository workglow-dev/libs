/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { it } from "vitest";

type ItFn = (name: string, fn: () => Promise<void> | void, timeout?: number) => void;

export const itExpectFail: ItFn = (name, fn, timeout) => {
  const native = (it as unknown as { fails?: ItFn }).fails;
  if (typeof native === "function") {
    native(name, fn, timeout);
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
