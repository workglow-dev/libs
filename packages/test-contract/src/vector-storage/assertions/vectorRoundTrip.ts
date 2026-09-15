/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect } from "vitest";
import type { VectorStorageContractOpts } from "../types";
import { EAST } from "../types";
import type { Hit } from "./shared";
import { itFor, seededStore } from "./shared";

/**
 * A hit's vector comes back as the declared `TypedArray`, not as whatever the
 * column stores.
 *
 * The stored form is a backend's own business — JSON text, a native vector
 * type, a blob — and every one of them has a decode step on the search path
 * that the tabular read does not exercise. Handing back a string or a plain
 * array is a break for every caller doing arithmetic on the result, and it is
 * invisible to a test that only reads `id` and `score`.
 */
export function vectorRoundTripBlock(opts: VectorStorageContractOpts): void {
  describe("vectorRoundTrip", () => {
    const store = seededStore(opts);

    itFor(opts, "vectorRoundTrip")(
      "hands back the vector as a TypedArray with the values that were written",
      async () => {
        const [hit] = (await store().similaritySearch(EAST, { topK: 1 })) as Hit[];

        expect(ArrayBuffer.isView(hit!.vector)).toBe(true);
        expect([...(hit!.vector as Float32Array)]).toEqual([...EAST]);
      },
      opts.timeout
    );
  });
}
