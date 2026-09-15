/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe } from "vitest";
import { capabilityAgreementBlock } from "./assertions/capabilityAgreement";
import { credentialNamingBlock } from "./assertions/credentialNaming";
import { dateFilteringBlock } from "./assertions/dateFiltering";
import { domainNormalizationBlock } from "./assertions/domainNormalization";
import { maxResultsCeilingBlock } from "./assertions/maxResultsCeiling";
import { reportedQueryBlock } from "./assertions/reportedQuery";
import { signalThreadingBlock } from "./assertions/signalThreading";
import type { WebSearchProviderConformanceOpts } from "./types";

/**
 * Everything an `IWebSearchProvider` owes a caller, over every adapter.
 *
 * Seven ship — three that own an HTTP fetch, four that reach a vendor SDK for
 * model-grounded search — and they had no shared assertions at all. What that
 * cost is legible in the package's own history: three of its twelve fixes in
 * one window were "make property P true on every route", each found by hand,
 * one route at a time, after the route that already had it was shipped. A
 * property that has to hold on every route is what a parameterized suite is
 * for.
 *
 * So the assertions are derived from `WebSearchCapabilities` rather than
 * written per provider. The record already declares what each adapter can do;
 * reading it and asserting the matching behaviour is what makes the suite still
 * true after a provider changes what it supports — which is the event worth
 * catching, and the one a hand-written expectation silently outlives.
 */
export function runWebSearchProviderConformance(opts: WebSearchProviderConformanceOpts): void {
  describe.skipIf(opts.skip)(`Web search provider contract: ${opts.name}`, () => {
    capabilityAgreementBlock(opts);
    maxResultsCeilingBlock(opts);
    domainNormalizationBlock(opts);
    dateFilteringBlock(opts);
    reportedQueryBlock(opts);
    signalThreadingBlock(opts);
    credentialNamingBlock(opts);
  });
}
