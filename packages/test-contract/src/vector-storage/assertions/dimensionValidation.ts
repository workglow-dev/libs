/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnyVectorStorage } from "@workglow/storage";
import { StorageValidationError } from "@workglow/storage";
import { afterEach, beforeEach, describe, expect } from "vitest";
import type { VectorStorageContractOpts } from "../types";
import { EAST, VECTOR_DIMENSIONS } from "../types";
import { itFor } from "./shared";

const SHORT = new Float32Array([1, 2, 3]);
const LONG = new Float32Array([1, 2, 3, 4, 5]);

/**
 * A vector of the wrong width is refused, and refused BEFORE the row lands.
 *
 * The store's width is fixed at construction and every row has to have it, so a
 * row of another width is not a bad read waiting to happen — it is a bad read
 * arbitrarily far away, surfacing in whichever query first reaches it, with
 * nothing left to say where it came from. Rejecting late is barely better than
 * not rejecting: the assertion below reads the table back, because a throw
 * after the insert satisfies `rejects` and still leaves the row.
 */
export function dimensionValidationBlock(opts: VectorStorageContractOpts): void {
  describe.skipIf(!opts.capabilities.supportsDimensionValidation)("dimensionValidation", () => {
    const itImpl = itFor(opts, "dimensionValidation");
    let storage: AnyVectorStorage;

    beforeEach(async () => {
      storage = await opts.createStorage();
      await storage.setupDatabase?.();
    });

    afterEach(async () => {
      await storage.deleteAll();
      storage.destroy?.();
      await opts.releaseStorage?.(storage);
    });

    itImpl(
      "declares the width it was built with",
      async () => {
        expect(storage.getVectorDimensions()).toBe(VECTOR_DIMENSIONS);
      },
      opts.timeout
    );

    for (const [label, vector] of [
      ["one entry short", SHORT],
      ["one entry long", LONG],
    ] as const) {
      itImpl(
        `refuses a put whose vector is ${label}, and writes nothing`,
        async () => {
          await expect(storage.put({ id: "x", vector, metadata: {} })).rejects.toBeInstanceOf(
            StorageValidationError
          );
          expect((await storage.getAll()) ?? []).toHaveLength(0);
        },
        opts.timeout
      );

      itImpl(
        `refuses a search whose query vector is ${label}`,
        async () => {
          // The query side is the same rule and a different code path: a
          // wrong-width query either throws or is quietly coerced by the
          // engine into a search that returns confident nonsense.
          await expect(storage.similaritySearch(vector)).rejects.toBeInstanceOf(
            StorageValidationError
          );
        },
        opts.timeout
      );

      itImpl(
        `refuses a putBulk containing a vector that is ${label}, and writes nothing`,
        async () => {
          // Not even the good row: a bulk write that half-lands leaves the
          // caller with no way to know which half.
          await expect(
            storage.putBulk([
              { id: "good", vector: EAST, metadata: {} },
              { id: "bad", vector, metadata: {} },
            ])
          ).rejects.toBeInstanceOf(StorageValidationError);
          expect((await storage.getAll()) ?? []).toHaveLength(0);
        },
        opts.timeout
      );
    }
  });
}
