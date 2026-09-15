/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { itExpectFail } from "../../itExpectFail";
import type { WorkerProxyBoundaryOpts } from "../types";
import { runProviderTextGeneration } from "./providerCallHelpers";

const FAIL_KEY = "boundary.errorPropagation";

export function errorPropagationBlock(opts: WorkerProxyBoundaryOpts): void {
  const failing = opts.expectedFailures?.includes(FAIL_KEY) ?? false;
  const test = failing ? itExpectFail : it;

  describe("Worker-side throw surfaces on main thread", () => {
    test(
      "provider rejection from inside the worker surfaces as a thrown error",
      async () => {
        const modelId = opts.models.textGeneration;
        if (!modelId) {
          throw new Error(`${opts.name}: models.textGeneration is required for boundary tests`);
        }
        // Use a registered model so resolution succeeds and the call is
        // dispatched into the worker. The provider's run fn rejects when
        // asked for an absurd token budget — the rejection therefore
        // originates inside the worker and must cross the postMessage
        // boundary to surface here.
        await expect(
          runProviderTextGeneration(modelId, "ignored", {
            maxTokens: 1_000_000_000,
            timeoutMs: opts.timeout / 4,
          })
        ).rejects.toThrow(/.+/);
      },
      opts.timeout
    );

    if (opts.capabilities.errorPropagation) {
      test(
        "worker-thrown Error preserves name and non-empty message across postMessage",
        async () => {
          const modelId = opts.models.textGeneration;
          if (!modelId) {
            throw new Error(`${opts.name}: models.textGeneration is required for boundary tests`);
          }
          let captured: unknown;
          try {
            await runProviderTextGeneration(modelId, "ignored", {
              maxTokens: 1_000_000_000,
              timeoutMs: opts.timeout / 4,
            });
          } catch (err) {
            captured = err;
          }
          // WorkerManager reconstructs cross-boundary errors on the main
          // thread and only round-trips `message` + `name` (the worker's
          // stack is not preserved). Verifying these two fields are intact
          // is the strongest structural check the harness can make without
          // assuming internal symbol names appear in stack frames.
          expect(captured).toBeInstanceOf(Error);
          const e = captured as Error;
          expect(e.message.length).toBeGreaterThan(0);
          expect(e.name.length).toBeGreaterThan(0);
        },
        opts.timeout
      );
    }
  });
}
