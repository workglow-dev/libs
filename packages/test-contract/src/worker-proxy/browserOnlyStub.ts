/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it } from "vitest";

import type { WorkerProxyBoundaryOpts } from "./types";

export function browserOnlyStubBlock(opts: WorkerProxyBoundaryOpts): void {
  describe.skipIf(opts.skip)(`Worker-proxy boundary: ${opts.name}`, () => {
    it.skip(`${opts.name}: requires browser test runner (browserOnly: true)`, () => {});
  });
}
