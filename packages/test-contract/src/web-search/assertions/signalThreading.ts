/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PROBE_QUERY, registerOnly } from "../fixtures";
import type { WebSearchConformanceHarness, WebSearchProviderConformanceOpts } from "../types";

/**
 * The run's signal reaches the call, not just a check in front of it.
 *
 * A `throwIfAborted()` before the request answers the easy half — a run already
 * cancelled does not start one — and leaves the expensive half alone: a
 * cancelled run whose request is already in flight keeps it in flight, and a
 * grounded turn nobody is waiting for is still billed for every token it
 * generates. The signal has to be handed to the transport itself.
 *
 * Asserted on what the adapter passed outward rather than on how fast the
 * promise rejects. A rejection proves the task stopped waiting; only the signal
 * on the call proves the call stopped running.
 */
export function signalThreadingBlock(opts: WebSearchProviderConformanceOpts): void {
  describe.skipIf(!opts.signalReachesTransport)("signal threading", () => {
    let harness: WebSearchConformanceHarness;

    beforeEach(async () => {
      harness = await opts.createHarness({ resultCount: 2 });
      registerOnly(harness);
    });

    afterEach(() => harness.dispose());

    it(
      "hands the run's signal to the outbound call",
      async () => {
        const controller = new AbortController();
        await harness.search({ query: PROBE_QUERY }, controller.signal);

        const signals = harness.signals();
        expect(signals.length).toBeGreaterThan(0);
        for (const signal of signals) {
          expect(signal).toBeDefined();
          expect(signal?.aborted).toBe(false);
        }
        // The run's own signal, not a fresh one the adapter made: a signal
        // nothing aborts is indistinguishable from no signal at all, and that
        // is exactly what a `throwIfAborted()` in front of an unsignalled call
        // looks like from outside.
        controller.abort();
        for (const signal of signals) {
          expect(signal?.aborted).toBe(true);
        }
      },
      opts.timeout
    );
  });
}
