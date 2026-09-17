/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expectTypeOf, it } from "vitest";
import type {
  ModelPricing,
  ModelPricingBase,
  ModelTimingTier,
  ModelUsageTier,
} from "../ModelSchema";

/**
 * Compile-time guard that `ModelPricing` has the expected type structure,
 * requiring `currency: string`, while keeping rate properties optional and structured.
 * A runtime test cannot catch this: `import type` is erased before execution and vitest does not
 * type-check `.test.ts` files, so a plain object-literal assignment compiles
 * away to nothing no matter what `ModelPricing` looks like. `.test-d.ts`
 * files run through `tsc -p packages/ai/tsconfig.test.json` (`bun run
 * typecheck:tests`), a real compiler pass that keeps this assertion live.
 */
describe("ModelPricing", () => {
  it("has exactly the documented shape", () => {
    expectTypeOf<ModelPricing>().toEqualTypeOf<{
      currency: string;
      input?: number;
      output?: number;
      cached?: number;
      cacheWrite?:
        | number
        | {
            cacheWrite5m?: number;
            cacheWrite1h?: number;
          };
      imageInput?: number;
      imageCached?: number;
      cacheStoragePerHour?: number;
      batch?: ModelPricingBase;
      usageTiers?: ModelUsageTier[];
      timingTiers?: ModelTimingTier[];
    }>();
  });

  it("rejects a rate card that omits currency", () => {
    const acceptsPricing = (_pricing: ModelPricing): void => {};
    // @ts-expect-error `currency` is required and must be stated explicitly.
    acceptsPricing({
      input: 3,
      output: 15,
    });
  });
});
