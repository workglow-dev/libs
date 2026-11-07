/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ITabularMigration } from "@workglow/storage";
import { describe, expect, it } from "vitest";
import { createFsFolderContractHandle } from "./fsFolderContractFactory";

function doubling(): ReadonlyArray<ITabularMigration> {
  return [
    {
      version: 1,
      ops: [
        {
          kind: "backfill",
          batchSize: 7,
          transform: (row) => ({ ...row, n: (row.n as number) * 2 }),
        },
      ],
    },
  ];
}

// Bun retries a failed test while the attempt that timed out may still be running. The
// nightly Bun run failed "backfill: every existing row is rewritten" on its retry, in
// 13 ms, with no row rewritten: the stale attempt had applied the migration in the
// retry's directory before its rows were written, so the retry's backfill was skipped.
describe("FsFolder migration contract handle", () => {
  it("keeps an earlier, still-running attempt out of the next attempt's directory", async () => {
    const handle = await createFsFolderContractHandle();
    try {
      const properties = { id: { type: "string" }, n: { type: "integer" } };
      const rows = Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, n: i }));

      const staleAttempt = handle.makeStorage(properties, doubling(), rows); // not awaited: timed out
      const retry = await handle.makeStorage(properties, doubling(), rows);
      const stale = await staleAttempt;

      // The stale attempt built its storage after the retry had moved on; it must
      // still be in its own directory, not the retry's.
      await stale.put({ id: "from-stale-attempt", n: 0 } as never);
      const all = ((await retry.getAll()) ?? []) as Array<{ id: string; n: number }>;
      expect(all.map((r) => r.id)).not.toContain("from-stale-attempt");
      expect(all).toHaveLength(30);
      expect(all.find((r) => r.id === "r3")?.n).toBe(6);
    } finally {
      await handle.dispose();
    }
  });
});
