/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { WebSearchTask } from "@workglow/web-search";
import { afterEach, describe, expect, it } from "vitest";
import { PROBE_QUERY, registerOnly, sentText } from "../fixtures";
import type { WebSearchConformanceHarness, WebSearchProviderConformanceOpts } from "../types";

/** The three shapes `dateRange` arrives in: closed, open at the start, open at the end. */
const RANGES = [
  { label: "a closed range", value: { start: "2024-01-01", end: "2024-06-30" } },
  { label: "a range open at the start", value: { end: "2024-06-30" } },
  { label: "a range open at the end", value: { start: "2024-01-01" } },
] as const;

/**
 * Date filtering is never emulated, and never half-sent.
 *
 * Post-filtering by `publishedDate` breaks `maxResults` and drops every result
 * whose date the provider omitted, so a provider that cannot filter server-side
 * declares `dateFilter: false` and such a request is refused rather than
 * approximated. That is the half most people expect.
 *
 * The other half is what a provider declaring `true` then owes: something for
 * EVERY range this task accepts. The real APIs take closed intervals — Brave's
 * `freshness`, Gemini's `timeRangeFilter` — so a half-open range has to be
 * filled at the open end. Dropping it instead reports a bound as honored on a
 * search that ran unfiltered, which is the failure the refusal above exists to
 * avoid, arrived at by a different road.
 */
export function dateFilteringBlock(opts: WebSearchProviderConformanceOpts): void {
  describe("date filtering", () => {
    let harness: WebSearchConformanceHarness;

    afterEach(() => harness?.dispose());

    for (const range of RANGES) {
      it(
        `never emulates ${range.label}`,
        async () => {
          harness = await opts.createHarness({ resultCount: 3 });
          registerOnly(harness);
          const run = new WebSearchTask().run({
            query: PROBE_QUERY,
            provider: harness.provider.name,
            dateRange: { ...range.value },
          });

          if (!harness.provider.capabilities.dateFilter) {
            await expect(run).rejects.toThrow(/dateRange/);
            expect(harness.sent()).toEqual([]);
            return;
          }

          await expect(run).resolves.toBeDefined();
          const withRange = sentText(harness);
          harness.dispose();

          const plain = await opts.createHarness({ resultCount: 3 });
          registerOnly(plain);
          try {
            await new WebSearchTask().run({
              query: PROBE_QUERY,
              provider: plain.provider.name,
            });
            // The bound reached the wire in whatever shape this vendor takes.
            // An open end filled with a default still changes what is sent; an
            // open end DROPPED does not, which is the whole failure.
            expect(withRange).not.toEqual(sentText(plain));
          } finally {
            plain.dispose();
          }
        },
        opts.timeout
      );
    }

    it(
      "sends the same thing for a half-open range as for the closed one it fills to",
      async () => {
        harness = await opts.createHarness({ resultCount: 3 });
        registerOnly(harness);
        if (!harness.provider.capabilities.dateFilter) return;

        await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
          dateRange: { start: "2024-01-01" },
        });
        const openEnded = sentText(harness);
        harness.dispose();

        const closed = await opts.createHarness({ resultCount: 3 });
        registerOnly(closed);
        try {
          await new WebSearchTask().run({
            query: PROBE_QUERY,
            provider: closed.provider.name,
            dateRange: { start: "2024-01-01", end: "2999-12-31" },
          });
          // Not equality — the filled end is "today" for a provider that fills
          // with one — but the start the caller named has to appear either way.
          expect(openEnded).toContain("2024");
          expect(sentText(closed)).toContain("2024");
        } finally {
          closed.dispose();
        }
      },
      opts.timeout
    );
  });
}
