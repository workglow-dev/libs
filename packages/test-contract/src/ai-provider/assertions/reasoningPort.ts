/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { itExpectFail } from "../../itExpectFail";
import {
  portText,
  reasoningCallReply,
  runToolTurnRound,
  TOOL_TURN_FIXTURE,
  userTurn,
} from "../toolTurnFixture";
import type { ToolTurnConformanceOpts, ToolTurnHarness } from "../toolTurnTypes";

/**
 * A model's thinking goes on the `reasoning` port and never on `text`. Text is
 * what a host shows as the answer and records as the assistant's words, so
 * reasoning that leaks onto it is replayed to the model as something it said
 * and shown to a person as the reply.
 */
export function reasoningPortBlock(
  opts: ToolTurnConformanceOpts,
  harness: () => ToolTurnHarness
): void {
  const itPort = new Set(opts.expectedFailures ?? []).has("reasoning.port") ? itExpectFail : it;
  const forwarded = opts.reasoningStream === "reasoning-port";

  describe("Reasoning stays off the text port", () => {
    itPort(
      forwarded
        ? "streams the thinking on reasoning and only the answer on text"
        : "keeps the thinking it does not forward off text as well",
      async () => {
        const { events } = await runToolTurnRound(harness(), [userTurn], {
          reasoning: TOOL_TURN_FIXTURE.reasoning,
          text: TOOL_TURN_FIXTURE.text,
        });
        expect(portText(events, "text")).toBe(TOOL_TURN_FIXTURE.text);
        if (forwarded) {
          expect(portText(events, "reasoning")).toBe(TOOL_TURN_FIXTURE.reasoning);
        } else {
          expect(portText(events, "reasoning")).toBe("");
        }
      },
      opts.timeout
    );

    itPort(
      "leaves text empty on a round that only thought and called a tool",
      async () => {
        const { events, output } = await runToolTurnRound(harness(), [userTurn], {
          ...reasoningCallReply,
          text: undefined,
        });
        expect(portText(events, "text")).toBe("");
        expect(output.toolCalls.map((call) => call.name)).toEqual([TOOL_TURN_FIXTURE.call.name]);
        if (forwarded) {
          expect(portText(events, "reasoning")).toBe(TOOL_TURN_FIXTURE.reasoning);
        }
      },
      opts.timeout
    );
  });
}
