/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyVectorStorage } from "@workglow/storage";
import { InMemoryVectorStorage, TelemetryVectorStorage } from "@workglow/storage";
import { runVectorStorageContract } from "@workglow/test-contract/vector-storage";
import {
  VECTOR_DIMENSIONS,
  VectorItemPrimaryKeyNames,
  VectorItemSchema,
} from "@workglow/test-contract/vector-storage";

/**
 * The measuring wrapper, against the contract it must not change.
 *
 * A decorator's whole promise is that the thing it wraps behaves the same, and
 * the way that promise breaks is by forgetting a method: an override that
 * drops an option, or an inherited one that reaches the wrong `inner`. Running
 * the same suite through it is how that is noticed.
 */
runVectorStorageContract({
  name: "TelemetryVectorStorage",
  capabilities: {
    supportsMetadataFilter: true,
    supportsScoreThreshold: true,
    supportsDimensionValidation: true,
  },
  createStorage: async (): Promise<AnyVectorStorage> =>
    new TelemetryVectorStorage(
      "contract",
      new InMemoryVectorStorage(
        VectorItemSchema,
        VectorItemPrimaryKeyNames,
        [],
        VECTOR_DIMENSIONS
      ) as never
    ) as unknown as AnyVectorStorage,
});
