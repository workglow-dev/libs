/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe } from "vitest";

import type { ConformanceHandle } from "../ai-provider/types";
import { backlogOrderingBlock } from "./assertions/backlogOrdering";
import { disposeTerminatesWorkerBlock } from "./assertions/disposeTerminatesWorker";
import { errorPropagationBlock } from "./assertions/errorPropagation";
import { browserOnlyStubBlock } from "./browserOnlyStub";
import type { WorkerProxyBoundaryOpts } from "./types";

export function runWorkerProxyBoundary(opts: WorkerProxyBoundaryOpts): void {
  if (opts.capabilities.browserOnly) {
    browserOnlyStubBlock(opts);
    return;
  }

  describe.skipIf(opts.skip)(`Worker-proxy boundary: ${opts.name}`, () => {
    let handle: ConformanceHandle | undefined;
    let disposed = false;
    const getHandle = (): ConformanceHandle => {
      if (!handle) throw new Error("worker-proxy handle not initialized");
      return handle;
    };
    const markDisposed = (): void => {
      disposed = true;
    };

    beforeAll(async () => {
      handle = await opts.factory();
      await handle.register();
    }, opts.timeout);

    afterAll(async () => {
      if (handle && !disposed) await handle.dispose();
    });

    // Order matters: dispose runs last so the live-worker assertions above
    // execute against an undisposed handle. `markDisposed` flips the shared
    // flag so afterAll skips a second dispose.
    errorPropagationBlock(opts);
    backlogOrderingBlock(opts);
    disposeTerminatesWorkerBlock(opts, getHandle, markDisposed);
  });
}
