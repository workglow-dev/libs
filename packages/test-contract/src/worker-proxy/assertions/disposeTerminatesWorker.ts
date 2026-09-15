/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import type { ConformanceHandle } from "../../ai-provider/types";
import { itExpectFail } from "../../itExpectFail";
import type { WorkerProxyBoundaryOpts } from "../types";
import { runProviderTextGeneration } from "./providerCallHelpers";

const FAIL_KEY = "boundary.disposeTerminatesWorker";

export function disposeTerminatesWorkerBlock(
  opts: WorkerProxyBoundaryOpts,
  getHandle: () => ConformanceHandle,
  markDisposed: () => void
): void {
  const failing = opts.expectedFailures?.includes(FAIL_KEY) ?? false;
  const test = failing ? itExpectFail : it;

  describe("Dispose terminates worker", () => {
    test(
      "after dispose() the worker no longer responds to traffic",
      async () => {
        const handle = getHandle();
        const modelId = opts.models.textGeneration;
        if (!modelId) {
          throw new Error(`${opts.name}: models.textGeneration is required for boundary tests`);
        }

        // Sanity request — must succeed before dispose.
        const before = await runProviderTextGeneration(
          modelId,
          "Reply with the single word READY.",
          { maxTokens: 8, timeoutMs: opts.timeout / 4 }
        );
        expect(before.text.length).toBeGreaterThan(0);

        await handle.dispose();
        markDisposed();

        const after = runProviderTextGeneration(modelId, "Reply with the single word LATE.", {
          maxTokens: 8,
          timeoutMs: opts.timeout / 4,
        });
        await expect(after).rejects.toThrow(/.+/);
      },
      opts.timeout
    );
  });
}
