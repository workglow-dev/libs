/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { WebSearchCapabilities } from "@workglow/web-search";
import { unhonorableOptions, WebSearchTask } from "@workglow/web-search";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROBE_QUERY, registerOnly } from "../fixtures";
import type { WebSearchConformanceHarness, WebSearchProviderConformanceOpts } from "../types";

/**
 * The option fields as `WebSearchTask` takes them, which is where every probe
 * is spent. Written out rather than reused from `WebSearchRequest`: the task's
 * input schema carries mutable arrays and the provider request readonly ones,
 * and a probe has to satisfy both.
 */
interface ProbeOptions {
  readonly includeDomains?: string[];
  readonly excludeDomains?: string[];
  readonly dateRange?: { readonly start?: string; readonly end?: string };
  readonly includeAnswer?: boolean;
  readonly includeContent?: boolean;
}

/**
 * One request shape, and the name the capability check reports it under.
 *
 * Every option `unhonorableOptions` can name is probed, plus the pair it
 * reports only in combination. The list is checked against that function's own
 * vocabulary below rather than trusted, so an option added to the capability
 * record cannot quietly go unprobed.
 */
interface Probe {
  readonly label: string;
  readonly request: ProbeOptions;
}

function probesFor(domain: string): readonly Probe[] {
  return [
    { label: "includeDomains", request: { includeDomains: [domain] } },
    { label: "excludeDomains", request: { excludeDomains: [domain] } },
    {
      label: "includeDomains with excludeDomains",
      request: { includeDomains: [domain], excludeDomains: ["elsewhere.example"] },
    },
    { label: "dateRange", request: { dateRange: { start: "2024-01-01", end: "2024-12-31" } } },
    { label: "includeAnswer", request: { includeAnswer: true } },
    { label: "includeContent", request: { includeContent: true } },
  ];
}

/**
 * What a provider declares is what it is asked to do, and nothing else.
 *
 * `WebSearchCapabilities` is a promise made to the router: an option the record
 * says the provider cannot serve must be refused BEFORE the vendor is reached,
 * and an option it says the provider can serve must actually be attempted. Both
 * halves fail quietly on their own. Under-declaring loses working behaviour to
 * `"auto"` routing, which walks past the provider that could have served the
 * request; over-declaring is worse, because the request is routed here and the
 * adapter throws — or, in the failure this whole record exists to prevent,
 * silently drops the option and reports a search that ran without it.
 *
 * Asserted by reading the record rather than by listing what each provider
 * does. That is the only version of this test that stays true when a provider
 * changes what it supports, which is the event it exists to catch.
 */
export function capabilityAgreementBlock(opts: WebSearchProviderConformanceOpts): void {
  const domain = opts.sampleDomain ?? "example.com";
  const probes = probesFor(domain);

  describe("capability agreement", () => {
    let harness: WebSearchConformanceHarness;

    beforeEach(async () => {
      harness = await opts.createHarness({ resultCount: 2 });
      registerOnly(harness);
    });

    afterEach(() => harness.dispose());

    it(
      "probes every option the capability check can refuse",
      () => {
        // The ratchet. `unhonorableOptions` is the vocabulary, so a gap it can
        // report that no probe produces is an option this block would never
        // ask about — and the whole record would look agreed-upon.
        const everything: WebSearchCapabilities = {
          answer: false,
          content: false,
          domainFilter: false,
          excludeDomainFilter: false,
          exclusiveDomainDirections: true,
          dateFilter: false,
          maxResultsCap: undefined,
        };
        const reachable = new Set<string>();
        for (const probe of probes) {
          for (const gap of unhonorableOptions(everything, {
            query: PROBE_QUERY,
            ...probe.request,
          })) {
            reachable.add(gap);
          }
        }
        // The pair is only reported when neither direction is refused on its
        // own, so a record that refuses both never names it. Probe it against a
        // record that serves each direction separately instead.
        for (const gap of unhonorableOptions(
          { ...everything, domainFilter: "native", excludeDomainFilter: "native" },
          { query: PROBE_QUERY, includeDomains: [domain], excludeDomains: ["elsewhere.example"] }
        )) {
          reachable.add(gap);
        }
        expect([...reachable].sort()).toEqual(probes.map((p) => p.label).sort());
      },
      opts.timeout
    );

    for (const probe of probes) {
      it(
        `agrees with its own record about ${probe.label}`,
        async () => {
          const declared = unhonorableOptions(harness.provider.capabilities, {
            query: PROBE_QUERY,
            ...probe.request,
          });
          const run = new WebSearchTask().run({
            query: PROBE_QUERY,
            provider: harness.provider.name,
            ...probe.request,
          });

          if (declared.length > 0) {
            await expect(run).rejects.toThrow(
              new RegExp(declared.map((g) => g.replace(/\s/g, "\\s")).join("|"))
            );
            // Refused BEFORE the call, not by the vendor afterwards: a request
            // that reached the wire was billed, and its failure arrives as
            // whatever the vendor says rather than as the option that was wrong.
            expect(harness.sent()).toEqual([]);
          } else {
            await expect(run).resolves.toBeDefined();
            expect(harness.sent().length).toBeGreaterThan(0);
          }
        },
        opts.timeout
      );
    }
  });
}
