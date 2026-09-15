/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyVectorStorage } from "@workglow/storage";
import { afterEach, beforeEach, it } from "vitest";
import { itExpectFail } from "../../itExpectFail";
import type { VectorStorageContractAssertion, VectorStorageContractOpts } from "../types";
import { EAST, NORTH, NORTHEAST } from "../types";

/** A hit, as much of one as every assertion here needs to read. */
export interface Hit {
  readonly id: string;
  readonly score: number;
  readonly vector: unknown;
}

export function itFor(
  opts: VectorStorageContractOpts,
  assertion: VectorStorageContractAssertion
): typeof it {
  return new Set(opts.expectedFailures ?? []).has(assertion) ? (itExpectFail as typeof it) : it;
}

/**
 * The three-row fixture every block searches over: two axis-aligned unit
 * vectors and the bisector between them, so a cosine search from `EAST` has one
 * exact match, one at `SQRT1_2` and one orthogonal — three distinct scores in a
 * known order, which is what makes "ranked by similarity" checkable rather than
 * merely non-empty.
 */
export function seededStore(opts: VectorStorageContractOpts): () => AnyVectorStorage {
  let storage: AnyVectorStorage;

  beforeEach(async () => {
    storage = await opts.createStorage();
    await storage.setupDatabase?.();
    await storage.putBulk([
      { id: "east", vector: EAST, metadata: { region: "e" } },
      { id: "north", vector: NORTH, metadata: { region: "n" } },
      { id: "northeast", vector: NORTHEAST, metadata: { region: "ne" } },
    ]);
  });

  afterEach(async () => {
    await storage.deleteAll();
    storage.destroy?.();
    await opts.releaseStorage?.(storage);
  });

  return () => storage;
}
