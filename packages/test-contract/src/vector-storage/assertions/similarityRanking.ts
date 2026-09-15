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
 * A search returns the rows, most similar first.
 *
 * This is the assertion the tree did not have, and the one that cost: a release
 * shipped in which `similaritySearch` re-decoded a vector column the inherited
 * tabular read had already turned into a `Float32Array`, so `JSON.parse` threw
 * on the first row of every search. Writes, dimension validation and `getAll`
 * were all fine — a store that accepts writes and fails every query looks
 * healthy from anywhere except a query, and only one backend had a test that
 * issued one.
 */
export function similarityRankingBlock(opts: VectorStorageContractOpts): void {
  describe("similarityRanking", () => {
    const store = seededStore(opts);

    itFor(opts, "similarityRanking")(
      "returns the stored rows ranked by similarity, with the scores that ordered them",
      async () => {
        const hits = (await store().similaritySearch(EAST)) as Hit[];

        expect(hits.map((hit) => hit.id)).toEqual(["east", "northeast", "north"]);
        // The order alone would hold for a backend that returned them in
        // insertion order by luck. The scores are what say it measured.
        expect(hits[0]!.score).toBeCloseTo(1, 5);
        expect(hits[1]!.score).toBeCloseTo(Math.SQRT1_2, 5);
        expect(hits[2]!.score).toBeCloseTo(0, 5);
      },
      opts.timeout
    );
  });
}
