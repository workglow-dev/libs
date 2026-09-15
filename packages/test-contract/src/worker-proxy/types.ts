/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ConformanceFixture, ConformanceHandle } from "../ai-provider/types";

export interface WorkerProxyBoundaryOpts {
  readonly name: string;
  readonly skip?: boolean;
  readonly timeout: number;
  /**
   * Returns a handle whose `register()` installs the worker as the active
   * route for every model named in `opts.models`. The boundary assertions
   * dispatch via `getAiProviderRegistry()` / `textGeneration()` and rely on
   * this to ensure traffic actually crosses the worker postMessage boundary
   * — without it the assertions would pass against an inline provider for
   * the wrong reason. Adapter shims must guarantee this invariant.
   */
  readonly factory: () => Promise<ConformanceHandle>;
  readonly capabilities: WorkerProxyCapabilities;
  readonly models: WorkerProxyModels;
  readonly fixture?: Partial<ConformanceFixture>;
  /**
   * Names of boundary assertions that are currently broken in this adapter.
   * Each named assertion is wrapped in `it.fails` instead of `it`.
   *
   * Known names:
   *   "boundary.disposeTerminatesWorker"
   *   "boundary.errorPropagation"
   *   "boundary.backlogOrdering"
   */
  readonly expectedFailures?: ReadonlyArray<string>;
}

export interface WorkerProxyCapabilities {
  /** When true, the entire boundary block is replaced with a single skipped
   * test logging "<name>: requires browser test runner". */
  readonly browserOnly: boolean;
  /** When false, only the basic "rejection surfaces on the main thread"
   * assertion runs. When true, additionally asserts that the worker-thrown
   * `Error.name` and `Error.message` round-trip across the postMessage
   * boundary intact. Default true. */
  readonly errorPropagation: boolean;
}

export interface WorkerProxyModels {
  readonly textGeneration?: string;
  readonly toolCalling?: string;
}
