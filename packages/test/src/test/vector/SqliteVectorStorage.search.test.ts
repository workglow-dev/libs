/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyVectorStorage } from "@workglow/storage";
import { Sqlite, SqliteVectorStorage } from "@workglow/sqlite/storage";
import { runVectorStorageContract } from "@workglow/test-contract/vector-storage";
import {
  VECTOR_DIMENSIONS,
  VectorItemPrimaryKeyNames,
  VectorItemSchema,
} from "@workglow/test-contract/vector-storage";

const TABLE = "vec_search";

await Sqlite.init();

/**
 * Each store gets its own `:memory:` database, so the handle has to be closed
 * with the store rather than at the end of the file.
 */
const handles = new WeakMap<object, InstanceType<typeof Sqlite.Database>>();

/**
 * `similaritySearch` end to end on a real SQLite database.
 *
 * This file used to hold seven hand-written cases, added when a release shipped
 * in which every search on this backend threw: it re-decoded a vector column
 * the inherited tabular read had already turned into a `Float32Array`, and its
 * sibling suite only ever wrote and read back. They are the contract now, so
 * the other seven implementations get them too.
 */
runVectorStorageContract({
  name: "SqliteVectorStorage",
  capabilities: {
    supportsMetadataFilter: true,
    supportsScoreThreshold: true,
    supportsDimensionValidation: true,
  },
  createStorage: async (): Promise<AnyVectorStorage> => {
    const db = new Sqlite.Database(":memory:");
    const storage = new SqliteVectorStorage(
      db,
      TABLE,
      VectorItemSchema,
      VectorItemPrimaryKeyNames,
      [],
      VECTOR_DIMENSIONS
    ) as unknown as AnyVectorStorage;
    handles.set(storage, db);
    return storage;
  },
  releaseStorage: (storage) => {
    handles.get(storage)?.close();
  },
  writeRawRow: (storage, row) => {
    // The column's stored form, written past this class's writer.
    handles
      .get(storage)
      ?.prepare(`INSERT INTO ${TABLE} (id, vector, metadata) VALUES (?, ?, ?)`)
      .run(row.id, JSON.stringify(row.vector), JSON.stringify(row.metadata));
  },
});
