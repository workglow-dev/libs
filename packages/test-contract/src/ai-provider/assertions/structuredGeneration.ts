/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { structuredGeneration } from "@workglow/ai";
import { describe, expect } from "vitest";

import { it } from "../../creditExhaustedSkip";

import type { AiProviderConformanceOpts, ConformanceFixture } from "../types";

export function structuredGenerationBlock(
  opts: AiProviderConformanceOpts,
  fixture: ConformanceFixture
): void {
  const enabled = opts.capabilities.structured && !!opts.models.structured;
  describe.skipIf(!enabled)("Structured generation", () => {
    it(
      "produces an object that contains the schema's required fields",
      async () => {
        const result = await structuredGeneration({
          model: opts.models.structured!,
          prompt: fixture.structuredPrompt,
          outputSchema: fixture.structuredSchema as { [x: string]: unknown },
          maxTokens: fixture.maxTokens,
        });
        expect(result).toBeDefined();
        expect(result.object).toBeDefined();
        expect(typeof result.object).toBe("object");
        expect(result.object).toHaveProperty("name");
        expect(result.object).toHaveProperty("age");
      },
      opts.timeout
    );
  });
}
