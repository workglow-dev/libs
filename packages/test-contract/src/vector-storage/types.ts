/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyVectorStorage } from "@workglow/storage";
import type { DataPortSchemaObject } from "@workglow/util/schema";
import { TypedArraySchema } from "@workglow/util/schema";

/**
 * The schema every backend's own vector suite already declares, hoisted here so
 * they stop declaring it separately. An `id`, the embedding, and a `metadata`
 * object — the shape a filter is applied to.
 */
export const VectorItemSchema = {
  type: "object",
  properties: {
    id: { type: "string" },
    vector: TypedArraySchema(),
    metadata: { type: "object", format: "metadata", additionalProperties: true },
  },
  required: ["id", "vector", "metadata"],
  additionalProperties: false,
} as const satisfies DataPortSchemaObject;

export const VectorItemPrimaryKeyNames = ["id"] as const;

/** Four, so a unit vector's cosine score is exactly the coordinate it points along. */
export const VECTOR_DIMENSIONS = 4;

export const EAST = new Float32Array([1, 0, 0, 0]);
export const NORTH = new Float32Array([0, 1, 0, 0]);
export const NORTHEAST = new Float32Array([Math.SQRT1_2, Math.SQRT1_2, 0, 0]);

/**
 * Closed union of vector-storage contract assertions an adapter can mark as
 * known failing. A typo in `expectedFailures` becomes a TS error rather than a
 * silently-ignored entry.
 */
export type VectorStorageContractAssertion =
  | "similarityRanking"
  | "vectorRoundTrip"
  | "searchOptions"
  | "metadataFilter"
  | "similaritySearchEvent"
  | "legacyEncoding"
  | "dimensionValidation";

export interface VectorStorageCapabilities {
  /** Whether `options.filter` narrows by metadata. */
  readonly supportsMetadataFilter: boolean;
  /** Whether `options.scoreThreshold` drops rows below the score. */
  readonly supportsScoreThreshold: boolean;
  /**
   * Whether a write whose vector is the wrong length is refused.
   *
   * A backend that stores the vector opaquely cannot check it, and one that
   * declares this must refuse BEFORE writing — a row of the wrong width that
   * lands is worse than one that never validates, because the search that
   * trips over it is arbitrarily far away.
   */
  readonly supportsDimensionValidation: boolean;
}

export interface VectorStorageContractOpts {
  readonly name: string;
  readonly skip?: boolean;
  readonly timeout?: number;
  readonly capabilities: VectorStorageCapabilities;
  /** A fresh, empty store of {@link VectorItemSchema} at {@link VECTOR_DIMENSIONS}. */
  readonly createStorage: () => Promise<AnyVectorStorage>;
  /**
   * Releases whatever the factory allocated that the storage does not own —
   * typically a connection handle. Called from every `afterEach`, passed the
   * instance the factory returned.
   */
  readonly releaseStorage?: (storage: AnyVectorStorage) => void | Promise<void>;
  /**
   * Writes a row past this class's writer, in the column's stored form.
   *
   * Only a backend that has a stored form to write can supply it, and it is
   * what the {@link VectorStorageContractAssertion} `legacyEncoding` block
   * needs: the decode has to accept a row that never round-tripped through the
   * current writer, and a test that inserts through the writer cannot ask that.
   */
  readonly writeRawRow?: (
    storage: AnyVectorStorage,
    row: { readonly id: string; readonly vector: readonly number[]; readonly metadata: unknown }
  ) => Promise<void> | void;
  readonly expectedFailures?: ReadonlyArray<VectorStorageContractAssertion>;
}
