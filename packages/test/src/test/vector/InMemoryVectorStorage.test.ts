/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyVectorStorage } from "@workglow/storage";
import { InMemoryVectorStorage } from "@workglow/storage";
import { runVectorStorageContract } from "@workglow/test-contract/vector-storage";
import {
  VECTOR_DIMENSIONS,
  VectorItemPrimaryKeyNames,
  VectorItemSchema,
} from "@workglow/test-contract/vector-storage";

/**
 * The reference implementation, and the only one that had no vector test at
 * all — the RAG suites exercised it incidentally, which is how a store's own
 * contract goes unstated. It costs nothing to run and it is what the SQL
 * backends' answers are compared against.
 */
runVectorStorageContract({
  name: "InMemoryVectorStorage",
  capabilities: {
    supportsMetadataFilter: true,
    supportsScoreThreshold: true,
    supportsDimensionValidation: true,
  },
  createStorage: async (): Promise<AnyVectorStorage> =>
    new InMemoryVectorStorage(
      VectorItemSchema,
      VectorItemPrimaryKeyNames,
      [],
      VECTOR_DIMENSIONS
    ) as unknown as AnyVectorStorage,
});
