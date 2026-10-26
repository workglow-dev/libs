/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { itExpectFail } from "../../itExpectFail";
import {
  answeredCallHistory,
  pathToText,
  runToolTurnRound,
  TOOL_TURN_FIXTURE,
  turnHolding,
  wireTurns,
} from "../toolTurnFixture";
import type { ToolTurnConformanceOpts, ToolTurnHarness } from "../toolTurnTypes";

/** How many leading path segments two paths share. */
function sharedPrefix(
  a: ReadonlyArray<string | number>,
  b: ReadonlyArray<string | number>
): number {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * An image a tool returned reaches the model where the provider says it goes.
 * Each vendor takes it in exactly one place, and the wrong one is not an error
 * the vendor reports: an image in a tool message is a 400 on some, silently
 * dropped by others, and leaks the model's thinking into its answer on older
 * Gemini.
 */
export function toolResultImageBlock(
  opts: ToolTurnConformanceOpts,
  harness: () => ToolTurnHarness
): void {
  const itImage = new Set(opts.expectedFailures ?? []).has("toolResult.image") ? itExpectFail : it;
  const shape = opts.toolResultImages;
  const label =
    shape.kind === "in-result"
      ? "inside the tool result it came from"
      : shape.kind === "user-turn-after"
        ? "in a user turn after the tool results, leaving the result text-only"
        : `nowhere, the model reading text only (${shape.reason})`;

  describe("Tool-result images", () => {
    itImage(
      `sends a tool's image ${label}`,
      async () => {
        const { request } = await runToolTurnRound(
          harness(),
          answeredCallHistory([
            { type: "text", text: TOOL_TURN_FIXTURE.resultText },
            { type: "image", ...TOOL_TURN_FIXTURE.image },
          ])
        );
        const turns = wireTurns(opts, request);
        const resultAt = turnHolding(turns, TOOL_TURN_FIXTURE.resultText);
        expect(resultAt, "the tool result's text is nowhere in the request").toBeGreaterThan(-1);
        expect(turns[resultAt]!.role).toBe("tool");
        const imageAt = turnHolding(turns, TOOL_TURN_FIXTURE.image.data);

        if (shape.kind === "text-only") {
          expect(imageAt, "an image reached a model that reads text only").toBe(-1);
          // Dropped without a word, the image reads as a tool that returned
          // less than it did, and the model is likely to call it again.
          expect(
            JSON.stringify(turns[resultAt]!.body),
            "the tool result does not say an image was returned"
          ).toContain(TOOL_TURN_FIXTURE.image.mimeType);
          return;
        }
        expect(imageAt, "the tool's image is nowhere in the request").toBeGreaterThan(-1);

        if (shape.kind === "in-result") {
          expect(imageAt, "the image left the tool result's turn").toBe(resultAt);
          // Inside the result means under the same element of the turn as the
          // result's text, not a separate block beside it.
          const body = turns[resultAt]!.body;
          const textPath = pathToText(body, TOOL_TURN_FIXTURE.resultText)!;
          const imagePath = pathToText(body, TOOL_TURN_FIXTURE.image.data)!;
          const common = textPath.slice(0, sharedPrefix(textPath, imagePath));
          expect(
            common.some((segment) => typeof segment === "number"),
            `the image (${imagePath.join(".")}) is not inside the result (${textPath.join(".")})`
          ).toBe(true);
        } else {
          expect(imageAt, "the image stayed in the tool result's turn").not.toBe(resultAt);
          expect(imageAt).toBeGreaterThan(resultAt);
          expect(turns[imageAt]!.role).toBe("user");
          for (const between of turns.slice(resultAt + 1, imageAt)) {
            expect(between.role, "only tool results may come between them").toBe("tool");
          }
        }
      },
      opts.timeout
    );
  });
}

/**
 * A tool that returned nothing still answers its call. Dropping the empty
 * result leaves the call unanswered, and every vendor rejects the next round
 * of a conversation holding an unanswered call.
 */
export function emptyToolResultBlock(
  opts: ToolTurnConformanceOpts,
  harness: () => ToolTurnHarness
): void {
  const itEmpty = new Set(opts.expectedFailures ?? []).has("toolResult.empty") ? itExpectFail : it;

  describe("Empty tool results", () => {
    itEmpty(
      "still answers the call when the tool returned nothing",
      async () => {
        const { request } = await runToolTurnRound(harness(), answeredCallHistory([]));
        const turns = wireTurns(opts, request);
        const callAt = turnHolding(turns, TOOL_TURN_FIXTURE.call.name);
        expect(callAt, "the call is nowhere in the request").toBeGreaterThan(-1);
        expect(turns[callAt]!.role).toBe("assistant");
        const answers = turns
          .slice(callAt + 1)
          .filter((turn) => turn.role === "tool")
          .filter(
            (turn) =>
              pathToText(turn.body, TOOL_TURN_FIXTURE.call.id) !== undefined ||
              pathToText(turn.body, TOOL_TURN_FIXTURE.call.name) !== undefined
          );
        expect(answers, "no tool turn names the call it answers, by id or by name").toHaveLength(1);
      },
      opts.timeout
    );
  });
}
