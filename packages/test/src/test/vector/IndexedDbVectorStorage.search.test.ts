/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import "fake-indexeddb/auto";

import { IndexedDbVectorStorage } from "@workglow/indexeddb/storage";
import type { AnyVectorStorage } from "@workglow/storage";
import { uuid4 } from "@workglow/util";
import { runVectorStorageContract } from "@workglow/test-contract/vector-storage";
import {
  VECTOR_DIMENSIONS,
  VectorItemPrimaryKeyNames,
  VectorItemSchema,
} from "@workglow/test-contract/vector-storage";

/**
 * The shared contract on IndexedDB.
 *
 * Its three existing files cover atomicity, validation and a search of its own
 * with a fixture nothing else uses, so no two backends were answering the same
 * question. These are that question, asked here in the same words.
 */
runVectorStorageContract({
  name: "IndexedDbVectorStorage",
  capabilities: {
    supportsMetadataFilter: true,
    supportsScoreThreshold: true,
    supportsDimensionValidation: true,
  },
  createStorage: async (): Promise<AnyVectorStorage> =>
    new IndexedDbVectorStorage(
      `vec_contract_${uuid4().replace(/-/g, "_")}`,
      VectorItemSchema,
      VectorItemPrimaryKeyNames,
      [],
      VECTOR_DIMENSIONS,
      Float32Array
    ) as unknown as AnyVectorStorage,
});
