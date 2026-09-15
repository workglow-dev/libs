/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect } from "vitest";
import type { VectorStorageContractOpts } from "../types";
import { EAST } from "../types";
import type { Hit } from "./shared";
import { itFor, seededStore } from "./shared";

/**
 * `topK` truncates and `scoreThreshold` filters — and they mean the same thing
 * on a backend that computes the scores in SQL as on one that scans in memory.
 *
 * That parity is not free: it has already had to be fixed once, when the two
 * paths disagreed about which side of the threshold an exact match fell on.
 * Stating it here is what makes the next backend inherit the answer instead of
 * rediscovering the question.
 */
export function searchOptionsBlock(opts: VectorStorageContractOpts): void {
  describe("searchOptions", () => {
    const store = seededStore(opts);
    const itImpl = itFor(opts, "searchOptions");

    itImpl(
      "truncates to topK, keeping the most similar",
      async () => {
        const hits = (await store().similaritySearch(EAST, { topK: 2 })) as Hit[];
        expect(hits.map((hit) => hit.id)).toEqual(["east", "northeast"]);
      },
      opts.timeout
    );

    itImpl(
      "returns everything when topK exceeds the row count",
      async () => {
        // A backend that pushes `topK` into a `LIMIT` and one that slices an
        // array agree here; one that treats it as an exact count does not.
        expect(await store().similaritySearch(EAST, { topK: 10 })).toHaveLength(3);
      },
      opts.timeout
    );

    describe.skipIf(!opts.capabilities.supportsScoreThreshold)("scoreThreshold", () => {
      itImpl(
        "drops rows scoring below the threshold",
        async () => {
          const hits = (await store().similaritySearch(EAST, { scoreThreshold: 0.9 })) as Hit[];
          expect(hits.map((hit) => hit.id)).toEqual(["east"]);
        },
        opts.timeout
      );

      itImpl(
        "keeps a row scoring exactly the threshold",
        async () => {
          // Zero, because it is the one boundary every backend can hit
          // exactly: `north` is orthogonal to `EAST`, so its score is 0 in
          // float32 and in float64 alike. `Math.SQRT1_2` is not — it rounds
          // down through a Float32Array, so a threshold set to it sits just
          // above the score the store can produce, and the test would be
          // measuring the rounding rather than the comparison.
          //
          // The boundary is where the SQL and in-memory paths drifted apart
          // before, and either answer is defensible until one is written down.
          const hits = (await store().similaritySearch(EAST, { scoreThreshold: 0 })) as Hit[];
          expect(hits.map((hit) => hit.id)).toEqual(["east", "northeast", "north"]);
        },
        opts.timeout
      );
    });
  });
}
