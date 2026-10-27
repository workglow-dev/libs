/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe } from "vitest";

import { nativeTurnBlock } from "./assertions/nativeTurn";
import { reasoningPortBlock } from "./assertions/reasoningPort";
import { reasoningRoundTripBlock } from "./assertions/reasoningRoundTrip";
import { emptyToolResultBlock, toolResultImageBlock } from "./assertions/toolResultShape";
import type { ToolTurnConformanceOpts, ToolTurnHarness } from "./toolTurnTypes";

/**
 * What a provider's tool-calling run-fn owes the conversation around it: where
 * a round's thinking goes, how it reaches the next round, and how a tool's
 * result is put back on the wire.
 *
 * Unlike {@link runAiProviderConformance}, which drives a live model and is
 * skipped without credentials, every assertion here runs against the
 * provider's own transport answering from a script — so it runs on every
 * build, and the rules it pins are ones a live model would only break
 * intermittently, if ever visibly.
 */
export function runToolTurnConformance(opts: ToolTurnConformanceOpts): void {
  describe.skipIf(opts.skip)(`Tool turn conformance: ${opts.name}`, () => {
    let current: ToolTurnHarness | undefined;
    const harness = (): ToolTurnHarness => {
      if (!current) throw new Error("tool-turn harness not initialized");
      return current;
    };

    beforeEach(async () => {
      current = await opts.createHarness();
    });

    afterEach(async () => {
      const done = current;
      current = undefined;
      await done?.dispose();
    });

    reasoningPortBlock(opts, harness);
    nativeTurnBlock(opts, harness);
    reasoningRoundTripBlock(opts, harness);
    toolResultImageBlock(opts, harness);
    emptyToolResultBlock(opts, harness);
  });
}
