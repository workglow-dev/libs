/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { WebSearchTask } from "@workglow/web-search";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { domainRoutes, PROBE_QUERY, registerOnly, sentText } from "../fixtures";
import type { WebSearchConformanceHarness, WebSearchProviderConformanceOpts } from "../types";

/** Spellings of one host that must all reduce to the same restriction. */
const SPELLINGS = ["https://Example.COM/", "www.example.com", "EXAMPLE.com", "example.com/"];

/**
 * Entries that name no domain. Each is a value a caller did not mean rather
 * than a malformed host — most often a list pasted into one array entry — and
 * there is no portable `site:` quoting that would rescue any of them.
 */
const UNUSABLE = ["", "   ", "a.com b.com", "(example.com)", 'ex"ample.com', "it's.com"];

/**
 * A domain entry means the same thing whichever route carries it.
 *
 * There are two routes — a native domain list, and a `site:` clause spliced
 * into the query — and the same entry has to reduce identically on both. It did
 * not once: reducing only on the way into an operator left `"https://arxiv.org/"`
 * restricting one route and reaching a vendor API scheme-first on the other,
 * where it matches nothing. Under `"auto"` the caller cannot even tell which
 * route ran, so the search comes back successful, reports the provider, and
 * silently searched the whole web.
 *
 * An unusable entry is refused for the same reason, and for EVERY provider
 * rather than only the ones translating to `site:`. Dropping it is the same
 * trade one step worse: the translation emits no clause for an empty list and
 * the task clears the list afterwards, so one bad entry in a one-entry list
 * removes the restriction from both paths at once.
 */
export function domainNormalizationBlock(opts: WebSearchProviderConformanceOpts): void {
  describe("domain normalization", () => {
    let harness: WebSearchConformanceHarness;

    beforeEach(async () => {
      harness = await opts.createHarness({ resultCount: 2 });
      registerOnly(harness);
    });

    afterEach(() => harness.dispose());

    const routes = (): ReturnType<typeof domainRoutes> => domainRoutes(harness.provider);

    it(
      "reduces every spelling of one host to the same request",
      async () => {
        if (routes().include === false) return;
        const sentFor = async (domain: string): Promise<string> => {
          const local = await opts.createHarness({ resultCount: 2 });
          registerOnly(local);
          try {
            await new WebSearchTask().run({
              query: PROBE_QUERY,
              provider: local.provider.name,
              includeDomains: [domain],
            });
            return sentText(local);
          } finally {
            local.dispose();
          }
        };

        const first = await sentFor(SPELLINGS[0]);
        for (const spelling of SPELLINGS.slice(1)) {
          expect(await sentFor(spelling)).toEqual(first);
        }
      },
      opts.timeout
    );

    it(
      "carries the restriction to the wire rather than dropping it",
      async () => {
        if (routes().include === false) return;
        const plain = await opts.createHarness({ resultCount: 2 });
        registerOnly(plain);
        await new WebSearchTask().run({ query: PROBE_QUERY, provider: plain.provider.name });
        const withoutFilter = sentText(plain);
        plain.dispose();

        registerOnly(harness);
        await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
          includeDomains: ["example.com"],
        });
        // Whatever shape it takes — a list field or a `site:` clause — a
        // restriction the provider declared it can serve has to change what
        // goes out. A search that sends the same bytes either way ran
        // unfiltered and said nothing.
        expect(sentText(harness)).not.toEqual(withoutFilter);
        expect(sentText(harness)).toContain("example.com");
      },
      opts.timeout
    );

    it(
      "carries an exclude restriction to the wire rather than dropping it",
      async () => {
        if (routes().exclude === false) return;
        const plain = await opts.createHarness({ resultCount: 2 });
        registerOnly(plain);
        await new WebSearchTask().run({ query: PROBE_QUERY, provider: plain.provider.name });
        const withoutFilter = sentText(plain);
        plain.dispose();

        registerOnly(harness);
        await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
          excludeDomains: ["blocked.example"],
        });

        // The direction that is declared separately BECAUSE one real vendor
        // serves only the other: OpenAI's `web_search` takes
        // `filters.allowed_domains` and has no blocked equivalent. Claiming it
        // anyway is the over-declaration `excludeDomainFilter` exists to
        // prevent, and it does not throw — the adapter has nowhere to put the
        // list, drops it, and returns a search that reports the provider, the
        // query and a plausible result set with the restriction gone.
        expect(sentText(harness)).not.toEqual(withoutFilter);
        expect(sentText(harness)).toContain("blocked.example");
      },
      opts.timeout
    );

    for (const entry of UNUSABLE) {
      it(
        `refuses includeDomains ${JSON.stringify(entry)} before the call`,
        async () => {
          await expect(
            new WebSearchTask().run({
              query: PROBE_QUERY,
              provider: harness.provider.name,
              includeDomains: [entry],
            })
          ).rejects.toThrow(/names no domain|name no domain/);
          expect(harness.sent()).toEqual([]);
        },
        opts.timeout
      );

      it(
        `refuses excludeDomains ${JSON.stringify(entry)} before the call`,
        async () => {
          await expect(
            new WebSearchTask().run({
              query: PROBE_QUERY,
              provider: harness.provider.name,
              excludeDomains: [entry],
            })
          ).rejects.toThrow(/names no domain|name no domain/);
          expect(harness.sent()).toEqual([]);
        },
        opts.timeout
      );
    }

    it(
      "refuses a bad entry even beside good ones",
      async () => {
        // The case that actually happens: a list where one line was pasted
        // wrong. Validating only single-entry lists would let the rest through
        // with a restriction the caller never agreed to.
        await expect(
          new WebSearchTask().run({
            query: PROBE_QUERY,
            provider: harness.provider.name,
            includeDomains: ["good.example", "a.com b.com", "also-good.example"],
          })
        ).rejects.toThrow(/names no domain/);
        expect(harness.sent()).toEqual([]);
      },
      opts.timeout
    );
  });
}
