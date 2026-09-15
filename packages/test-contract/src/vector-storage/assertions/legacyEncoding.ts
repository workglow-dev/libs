/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect } from "vitest";
import type { VectorStorageContractOpts } from "../types";
import { NORTH } from "../types";
import type { Hit } from "./shared";
import { itFor, seededStore } from "./shared";

/**
 * A row written in the column's stored form — by an older release, or by
 * anything that is not this class's writer — is still searchable.
 *
 * This is the other half of the decode that broke: a search path may not assume
 * every row it reads was encoded by the writer it ships with. Only a backend
 * that has a stored form to write can be asked, so the block is skipped where
 * the adapter supplies no `writeRawRow`.
 */
export function legacyEncodingBlock(opts: VectorStorageContractOpts): void {
  describe.skipIf(opts.writeRawRow === undefined)("legacyEncoding", () => {
    const store = seededStore(opts);

    itFor(opts, "legacyEncoding")(
      "searches a row that never round-tripped through this writer",
      async () => {
        await opts.writeRawRow?.(store(), {
          id: "legacy",
          vector: [...NORTH],
          metadata: { region: "legacy" },
        });

        const hits = (await store().similaritySearch(NORTH, { topK: 2 })) as Hit[];

        expect(hits.map((hit) => hit.id)).toContain("legacy");
        // And it decodes to the same thing a written row does, rather than
        // merely not throwing.
        const legacy = hits.find((hit) => hit.id === "legacy");
        expect([...(legacy!.vector as Float32Array)]).toEqual([...NORTH]);
      },
      opts.timeout
    );
  });
}
