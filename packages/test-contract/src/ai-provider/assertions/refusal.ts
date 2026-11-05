/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { runToolTurnRound, userTurn } from "../toolTurnFixture";
import type { ToolTurnConformanceOpts, ToolTurnHarness } from "../toolTurnTypes";

/**
 * A model that declines is a valid outcome, not an empty answer: the refusal
 * reaches the turn as `refusal` events, and the same goes for a reply the
 * provider's content filter withholds. A run-fn that reads only the content
 * field completes both as a normal, empty answer, and nothing downstream can
 * tell that the model said no.
 */
export function refusalBlock(opts: ToolTurnConformanceOpts, harness: () => ToolTurnHarness): void {
  const support = opts.refusal;
  if (support === undefined) return;

  describe("Refusals are reported, not swallowed", () => {
    if (support.kind === "none") {
      it.skip(`has no refusal on its wire: ${support.reason}`, () => {});
      return;
    }

    it(
      "reports a stated refusal on the refusal output",
      async () => {
        const { events } = await runToolTurnRound(harness(), [userTurn], {
          refusal: "I can't help with that.",
        });
        const refusal = events
          .filter((event) => event.type === "refusal")
          .map((event) => event.refusal)
          .join("");
        expect(refusal).toBe("I can't help with that.");
      },
      opts.timeout
    );

    it(
      "reports a reply withheld by the content filter as one refusal",
      async () => {
        const { events } = await runToolTurnRound(harness(), [userTurn], {
          contentFiltered: true,
        });
        expect(events.filter((event) => event.type === "refusal")).toHaveLength(1);
      },
      opts.timeout
    );

    it(
      "reports no refusal for an ordinary answer",
      async () => {
        const { events } = await runToolTurnRound(harness(), [userTurn], { text: "fine" });
        expect(events.some((event) => event.type === "refusal")).toBe(false);
      },
      opts.timeout
    );
  });
}
