/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { WebSearchTask } from "@workglow/web-search";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROBE_QUERY, registerOnly } from "../fixtures";
import type { WebSearchConformanceHarness, WebSearchProviderConformanceOpts } from "../types";

/**
 * `maxResults` is a ceiling, and it means the same thing on every route.
 *
 * It is the one option `unhonorableOptions` deliberately never reports: asking
 * for more results than a provider's cap is not a requirement the way a domain
 * restriction is, so an over-large value is clamped rather than refused. That
 * asymmetry is what makes the rest of it worth asserting — a provider is free
 * to return fewer, and never free to return more, and neither half is visible
 * to a caller who gets a plausible-looking list back.
 *
 * Three providers needed a fix for exactly this in one window, each found by
 * hand on its own route: an API with no result parameter has to apply the bound
 * itself after the fact, and every one that forgot returned whatever the vendor
 * felt like.
 */
export function maxResultsCeilingBlock(opts: WebSearchProviderConformanceOpts): void {
  describe("maxResults ceiling", () => {
    let harness: WebSearchConformanceHarness;

    afterEach(() => harness?.dispose());

    beforeEach(() => {
      // Each case builds its own harness, since how many results the canned
      // answer carries is what it is varying.
    });

    it(
      "never returns more results than asked for",
      async () => {
        harness = await opts.createHarness({ resultCount: 9 });
        registerOnly(harness);
        const out = await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
          maxResults: 3,
        });
        expect(out.results.length).toBeLessThanOrEqual(3);
        expect(out.count).toBe(out.results.length);
      },
      opts.timeout
    );

    it(
      "clamps a value over the provider's cap rather than refusing it",
      async () => {
        harness = await opts.createHarness({ resultCount: 4 });
        registerOnly(harness);
        const cap = harness.provider.capabilities.maxResultsCap;
        const asked = (cap ?? 20) + 500;
        const out = await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
          maxResults: asked,
        });
        expect(out.results.length).toBeLessThanOrEqual(cap ?? asked);
      },
      opts.timeout
    );

    it(
      "returns what it has when fewer results exist than asked for",
      async () => {
        harness = await opts.createHarness({ resultCount: 2 });
        registerOnly(harness);
        const out = await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
          maxResults: 8,
        });
        // A ceiling, never a floor: padding to reach the number would invent
        // sources, which is the worse failure of the two.
        expect(out.results).toHaveLength(2);
      },
      opts.timeout
    );

    it(
      "reports count as the number of results it actually returned",
      async () => {
        harness = await opts.createHarness({ resultCount: 6 });
        registerOnly(harness);
        const out = await new WebSearchTask().run({
          query: PROBE_QUERY,
          provider: harness.provider.name,
          maxResults: 2,
        });
        expect(out.count).toBe(out.results.length);
      },
      opts.timeout
    );
  });
}
