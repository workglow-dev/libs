/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IBrowserContext } from "@workglow/browser-control/task";

export interface IBrowserContextConformanceOpts {
  readonly name: string;
  readonly skip?: boolean;
  readonly timeout: number;
  readonly factory: () => Promise<BrowserContextHandle>;
  readonly capabilities: BrowserContextCapabilities;
  readonly fixture?: Partial<BrowserContextFixture>;
  /**
   * Names of conformance assertions currently broken in this adapter; each
   * named assertion is wrapped in `it.fails` instead of `it`. Remove the
   * entry once the adapter bug is fixed.
   *
   * Known names:
   *   "tabs.concurrentCloseStable"
   *   "aria.colonInName"
   *   "capability.networkRequests.undefinedWhenFalse"
   *   "capability.consoleMessages.undefinedWhenFalse"
   */
  readonly expectedFailures?: ReadonlyArray<string>;
}

export interface BrowserContextHandle {
  /** Construct and connect a fresh context. Called per top-level block. */
  readonly create: () => Promise<IBrowserContext>;
  /** Disconnect and release resources for a context returned by create(). */
  readonly dispose: (ctx: IBrowserContext) => Promise<void>;
}

export interface BrowserContextCapabilities {
  /** false for single-view backends (e.g. BunWebView). */
  readonly multipleTabs: boolean;
  /** Optional method honesty + positive test. */
  readonly networkRequests: boolean;
  /** Optional method honesty + positive test. */
  readonly consoleMessages: boolean;
  /** Every backend should be true; flag exists for hygiene/symmetry. */
  readonly ariaSnapshot: boolean;
}

export interface BrowserContextFixture {
  readonly pageUrl: string;
  readonly networkMarkerUrl: string;
  readonly consoleMarker: string;
  readonly ariaEdgeCaseNames: ReadonlyArray<string>;
}
