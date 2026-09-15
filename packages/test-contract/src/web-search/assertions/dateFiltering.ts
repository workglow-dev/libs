/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { WebSearchTask } from "@workglow/web-search";
import { afterEach, describe, expect, it } from "vitest";
import { PROBE_QUERY, registerOnly, sentText } from "../fixtures";
import type { WebSearchConformanceHarness, WebSearchProviderConformanceOpts } from "../types";

/**
 * The distinct calendar dates one request carried, however the vendor spelled
 * them — a bare `YYYY-MM-DD`, a slice of an RFC-3339 timestamp, or two of them
 * run together in one parameter.
 *
 * Distinct, because `sentText` renders what went out twice (raw and decoded),
 * and counting the bounds is the whole point.
 */
function datesIn(text: string): string[] {
  return [...new Set(text.match(/\d{4}-\d{2}-\d{2}/g) ?? [])];
}

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
      "fills the open end of a half-open range rather than sending it half",
      async () => {
        harness = await opts.createHarness({ resultCount: 3 });
        registerOnly(harness);
        if (!harness.provider.capabilities.dateFilter) return;

        await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
          dateRange: { start: "2024-01-01" },
        });
        const openEnded = datesIn(sentText(harness));

        // The bound the caller actually named reaches the wire either way.
        expect(openEnded).toContain("2024-01-01");

        if (!opts.fillsOpenDateBounds) {
          // An API taking each bound separately is honoring the request by
          // sending the one it was given; there is no end to fill.
          return;
        }
        // A closed interval has to carry two. Sending one is the failure this
        // whole block exists for: the request goes out unfiltered at the open
        // end while `dateFilter: true` reports the bound as honored — and
        // asserting only that the START appears cannot tell the two apart,
        // because a provider that drops the end still sends the start.
        expect(openEnded.length).toBeGreaterThanOrEqual(2);
      },
      opts.timeout
    );

    it(
      "fills the open start of a half-open range too",
      async () => {
        harness = await opts.createHarness({ resultCount: 3 });
        registerOnly(harness);
        if (!harness.provider.capabilities.dateFilter) return;

        await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
          dateRange: { end: "2024-06-30" },
        });
        const openStart = datesIn(sentText(harness));

        expect(openStart).toContain("2024-06-30");
        if (!opts.fillsOpenDateBounds) return;
        // The other direction, which a provider can get wrong on its own: an
        // adapter filling only the end reads as correct on the case above.
        expect(openStart.length).toBeGreaterThanOrEqual(2);
      },
      opts.timeout
    );
  });
}
