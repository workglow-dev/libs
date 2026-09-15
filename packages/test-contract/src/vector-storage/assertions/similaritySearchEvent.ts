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
 * The `similaritySearch` event is the one thing `IVectorStorage` adds to the
 * tabular event surface, and it carries the results — not a count, and not the
 * rows before the options were applied.
 *
 * Telemetry and cache layers wrap these stores and read that payload as the
 * answer the caller got. An event that fires with the unfiltered set reports
 * work nobody received.
 */
export function similaritySearchEventBlock(opts: VectorStorageContractOpts): void {
  describe("similaritySearchEvent", () => {
    const store = seededStore(opts);

    itFor(opts, "similaritySearchEvent")(
      "fires with the results the caller was handed",
      async () => {
        let seen: Hit[] | undefined;
        // The vector extension of the event surface; the inherited `on` is
        // typed to the tabular names, so the cast is at the call site.
        (
          store() as unknown as {
            on: (name: string, fn: (query: unknown, results: Hit[]) => void) => void;
          }
        ).on("similaritySearch", (_query, results) => {
          seen = results;
        });

        await store().similaritySearch(EAST, { topK: 1 });

        expect(seen?.map((hit) => hit.id)).toEqual(["east"]);
      },
      opts.timeout
    );
  });
}
