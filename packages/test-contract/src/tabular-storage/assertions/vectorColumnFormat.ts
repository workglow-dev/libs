/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITabularStorage } from "@workglow/storage";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { itExpectFail } from "../../itExpectFail";
import type {
  TabularStorageContractOpts,
  VectorItemPrimaryKeyNames,
  VectorItemSchema,
} from "../types";

export function vectorColumnFormatBlock(opts: TabularStorageContractOpts): void {
  const expectFails = new Set(opts.expectedFailures ?? []);
  const itImpl = expectFails.has("vectorColumnFormat") ? itExpectFail : it;

  describe.skipIf(!opts.capabilities.supportsVectorColumns)("vectorColumnFormat", () => {
    let storage: ITabularStorage<typeof VectorItemSchema, typeof VectorItemPrimaryKeyNames>;

    beforeEach(async () => {
      if (!opts.createVectorStorage) {
        throw new Error(
          "createVectorStorage is required when capabilities.supportsVectorColumns is true"
        );
      }
      storage = await opts.createVectorStorage();
      await storage.setupDatabase?.();
    });

    afterEach(async () => {
      await storage.deleteAll();
      storage.destroy?.();
      await opts.releaseStorage?.(storage);
    });

    itImpl(
      "round-trip preserves Float32Array type and values",
      async () => {
        const original = new Float32Array([0.1, 0.2, 0.3]);

        await storage.put({ id: "v1", embedding: original as any });

        const retrieved = await storage.get({ id: "v1" });
        expect(retrieved).toBeDefined();

        const embedding = (retrieved as any)?.embedding;
        expect(embedding).toBeInstanceOf(Float32Array);
        expect(embedding[0]).toBeCloseTo(0.1, 5);
        expect(embedding[1]).toBeCloseTo(0.2, 5);
        expect(embedding[2]).toBeCloseTo(0.3, 5);
      },
      opts.timeout
    );
  });
}
