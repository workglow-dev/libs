/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe } from "vitest";

import { ariaRoundTripBlock } from "./assertions/ariaRoundTrip";
import { capabilityHonestyBlock } from "./assertions/capabilityHonesty";
import { networkIntrospectionBlock } from "./assertions/networkIntrospection";
import { tabsLifecycleBlock } from "./assertions/tabsLifecycle";
import { resolveFixture } from "./fixtures";
import type { IBrowserContextConformanceOpts } from "./types";

export function runIBrowserContextConformance(opts: IBrowserContextConformanceOpts): void {
  describe.skipIf(opts.skip)(`IBrowserContext conformance: ${opts.name}`, () => {
    const fixture = resolveFixture(opts.fixture);

    // Each block creates its own context via opts.factory() in beforeAll —
    // a fresh handle per block so block N's tab churn / navigation can't
    // taint block N+1. This is intentional even though it means real-browser
    // shims pay one launch cost per block.
    capabilityHonestyBlock(opts, fixture);
    tabsLifecycleBlock(opts, fixture);
    ariaRoundTripBlock(opts, fixture);
    networkIntrospectionBlock(opts, fixture);
  });
}
