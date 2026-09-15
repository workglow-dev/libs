/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { WebSearchTask } from "@workglow/web-search";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { domainRoutes, PROBE_QUERY, registerOnly, sentText } from "../fixtures";
import type { WebSearchConformanceHarness, WebSearchProviderConformanceOpts } from "../types";

/**
 * The `query` output port is the query that ran, and `provider` is who ran it.
 *
 * Both exist because the task rewrites one and chooses the other. A
 * `query-operator` provider has its domain restriction spliced into the query
 * as `site:` clauses, so the string that ran is not the string the caller
 * passed — and an adapter that echoes the input instead is reporting a search
 * that did not happen. Under `"auto"` the caller did not pick the vendor
 * either, so `provider` is the only record of which quota was spent and which
 * engine's ranking produced the list.
 */
export function reportedQueryBlock(opts: WebSearchProviderConformanceOpts): void {
  describe("reported query and provider", () => {
    let harness: WebSearchConformanceHarness;

    beforeEach(async () => {
      harness = await opts.createHarness({ resultCount: 3 });
      registerOnly(harness);
    });

    afterEach(() => harness.dispose());

    it(
      "reports the provider that ran when it was pinned",
      async () => {
        const out = await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
        });
        expect(out.provider).toBe(harness.provider.name);
      },
      opts.timeout
    );

    it(
      "reports the provider that ran when routing chose it",
      async () => {
        const out = await new WebSearchTask().run({ query: PROBE_QUERY, provider: "auto" });
        expect(out.provider).toBe(harness.provider.name);
      },
      opts.timeout
    );

    it(
      "reports the unmodified query when nothing rewrote it",
      async () => {
        const out = await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
        });
        expect(out.query).toBe(PROBE_QUERY);
      },
      opts.timeout
    );

    it(
      "reports the rewritten query when a domain restriction moved into it",
      async () => {
        const routes = domainRoutes(harness.provider);
        if (routes.include !== "query-operator") return;

        const out = await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
          includeDomains: ["example.com"],
        });

        expect(out.query).toContain("site:example.com");
        expect(out.query).not.toBe(PROBE_QUERY);
        // And it is the query that actually went out, not a second rendering of
        // the same idea: a provider reporting one string and sending another is
        // lying about what ran in the direction nobody checks.
        expect(sentText(harness)).toContain("site:example.com");
      },
      opts.timeout
    );

    it(
      "leaves the query alone when the restriction travels as a list",
      async () => {
        const routes = domainRoutes(harness.provider);
        if (routes.include !== "native") return;

        const out = await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
          includeDomains: ["example.com"],
        });
        // Splicing operators into a query a native filter already covers would
        // restrict it twice, and the second restriction is invisible.
        expect(out.query).toBe(PROBE_QUERY);
      },
      opts.timeout
    );

    it(
      "always reports results and a count, even with nothing to report",
      async () => {
        const empty = await opts.createHarness({ resultCount: 0 });
        registerOnly(empty);
        try {
          const out = await new WebSearchTask().run({
            query: PROBE_QUERY,
            provider: empty.provider.name,
          });
          expect(Array.isArray(out.results)).toBe(true);
          expect(out.count).toBe(0);
          expect(out.provider).toBe(empty.provider.name);
        } finally {
          empty.dispose();
        }
      },
      opts.timeout
    );
  });
}
