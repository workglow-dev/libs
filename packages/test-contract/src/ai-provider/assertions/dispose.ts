/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { getLogger } from "@workglow/util";
import { describe, expect } from "vitest";

import { it } from "../../creditExhaustedSkip";

import type { AiProviderConformanceOpts, ConformanceHandle } from "../types";

export function disposeBlock(
  opts: AiProviderConformanceOpts,
  getHandle: () => ConformanceHandle
): void {
  describe("Dispose", () => {
    it(
      "release resources observable via inspect()",
      async () => {
        const handle = getHandle();
        const before = handle.inspect();
        if (!before.sessionMap && (!before.disposables || before.disposables.length === 0)) {
          getLogger().warn(
            `[conformance] ${opts.name} exposes no inspect() handles; dispose assertion skipped`
          );
          return;
        }
        await handle.dispose();
        const after = handle.inspect();
        if (after.sessionMap) {
          expect(after.sessionMap.size).toBe(0);
        }
        if (after.disposables) {
          for (const d of after.disposables) {
            expect(d.alive).toBe(false);
          }
        }
      },
      opts.timeout
    );
  });
}
