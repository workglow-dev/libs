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
 * A metadata filter narrows the search, and narrows it to what matches rather
 * than to what happens to be near.
 *
 * The case worth stating is the second one: filtering to a row that is NOT the
 * nearest. A backend that takes the top `k` and then filters returns nothing
 * there, while one that filters and then ranks returns the row — and the first
 * behaviour is a silently empty result for every scoped RAG query.
 */
export function metadataFilterBlock(opts: VectorStorageContractOpts): void {
  describe.skipIf(!opts.capabilities.supportsMetadataFilter)("metadataFilter", () => {
    const store = seededStore(opts);
    const itImpl = itFor(opts, "metadataFilter");

    itImpl(
      "returns only the rows the filter matches",
      async () => {
        const hits = (await store().similaritySearch(EAST, { filter: { region: "n" } })) as Hit[];
        expect(hits.map((hit) => hit.id)).toEqual(["north"]);
      },
      opts.timeout
    );

    itImpl(
      "finds a match the ranking would not have reached",
      async () => {
        // `north` is the LAST of the three by similarity to EAST. Asking for it
        // with topK 1 separates "filter, then rank" from "rank, then filter".
        const hits = (await store().similaritySearch(EAST, {
          filter: { region: "n" },
          topK: 1,
        })) as Hit[];
        expect(hits.map((hit) => hit.id)).toEqual(["north"]);
      },
      opts.timeout
    );

    itImpl(
      "returns nothing when the filter matches nothing",
      async () => {
        expect(
          await store().similaritySearch(EAST, { filter: { region: "nowhere" } })
        ).toHaveLength(0);
      },
      opts.timeout
    );
  });
}
