/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe } from "vitest";
import { dimensionValidationBlock } from "./assertions/dimensionValidation";
import { legacyEncodingBlock } from "./assertions/legacyEncoding";
import { metadataFilterBlock } from "./assertions/metadataFilter";
import { searchOptionsBlock } from "./assertions/searchOptions";
import { similarityRankingBlock } from "./assertions/similarityRanking";
import { similaritySearchEventBlock } from "./assertions/similaritySearchEvent";
import { vectorRoundTripBlock } from "./assertions/vectorRoundTrip";
import type { VectorStorageContractOpts } from "./types";

/**
 * The conformance suite for {@link IVectorStorage}, in the shape
 * `runTabularStorageContract` already has.
 *
 * Eight classes implement the interface and each had its own hand-written file,
 * no two checking the same things — which is how a release shipped in which
 * every single query failed on one backend: its sibling suite only ever wrote
 * and read back, so nothing there issued a search. The fix added seven cases,
 * all against that one backend, and the other seven implementations gained
 * nothing.
 */
export function runVectorStorageContract(opts: VectorStorageContractOpts): void {
  describe.skipIf(opts.skip)(`Vector storage contract: ${opts.name}`, () => {
    similarityRankingBlock(opts);
    vectorRoundTripBlock(opts);
    searchOptionsBlock(opts);
    metadataFilterBlock(opts);
    similaritySearchEventBlock(opts);
    legacyEncodingBlock(opts);
    dimensionValidationBlock(opts);
  });
}

export {
  EAST,
  NORTH,
  NORTHEAST,
  VECTOR_DIMENSIONS,
  VectorItemPrimaryKeyNames,
  VectorItemSchema,
} from "./types";
export type {
  VectorStorageCapabilities,
  VectorStorageContractAssertion,
  VectorStorageContractOpts,
} from "./types";
