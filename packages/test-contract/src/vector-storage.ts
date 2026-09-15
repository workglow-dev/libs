/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Conformance suite for `IVectorStorage` — vector round trip, similarity
 * ranking, metadata filtering and dimension validation.
 */

export * from "./vector-storage/runVectorStorageContract";
export * from "./vector-storage/types";
export * from "./vector-storage/assertions/dimensionValidation";
export * from "./vector-storage/assertions/legacyEncoding";
export * from "./vector-storage/assertions/metadataFilter";
export * from "./vector-storage/assertions/searchOptions";
export * from "./vector-storage/assertions/shared";
export * from "./vector-storage/assertions/similarityRanking";
export * from "./vector-storage/assertions/similaritySearchEvent";
export * from "./vector-storage/assertions/vectorRoundTrip";
