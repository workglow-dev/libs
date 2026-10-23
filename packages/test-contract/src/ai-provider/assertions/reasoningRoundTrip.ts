/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatMessage, ContentBlock } from "@workglow/ai";
import { describe, expect, it } from "vitest";

import { itExpectFail } from "../../itExpectFail";
import {
  containsVerbatim,
  reasoningCallReply,
  recordedAssistantTurn,
  runToolTurnRound,
  TOOL_TURN_FIXTURE,
  toolResults,
  turnHolding,
  userTurn,
  wireTurns,
} from "../toolTurnFixture";
import type { ToolTurnConformanceOpts, ToolTurnHarness } from "../toolTurnTypes";

type Edit = (assistant: ChatMessage) => ChatMessage;

function mapBlocks(
  message: ChatMessage,
  map: (block: ContentBlock) => ContentBlock | undefined
): ChatMessage {
  return {
    role: message.role,
    content: message.content.flatMap((block) => {
      const mapped = map(block);
      return mapped === undefined ? [] : [mapped];
    }),
  };
}

/** The same turn with nothing native kept: what a rebuilt turn must be indistinguishable from. */
function withoutNativeTurn(assistant: ChatMessage): ChatMessage {
  return mapBlocks(assistant, (block) =>
    block.type === "reasoning" ? { type: "reasoning", text: block.text } : block
  );
}

/**
 * How a host can change the turn after the provider recorded it. Each must
 * make the provider rebuild the turn: replaying the recorded one would send a
 * call the conversation no longer holds, or another model's reasoning.
 */
function rebuildCases(vendor: string): ReadonlyArray<readonly [string, Edit, boolean]> {
  const callEdit =
    (edit: (call: Extract<ContentBlock, { type: "tool_use" }>) => ContentBlock): Edit =>
    (assistant) =>
      mapBlocks(assistant, (block) => (block.type === "tool_use" ? edit(block) : block));
  return [
    // [label, edit, whether the edited turn still has calls to answer]
    ["the host changed a call's id", callEdit((call) => ({ ...call, id: `${call.id}_2` })), true],
    [
      "the host changed a call's name",
      callEdit((call) => ({ ...call, name: TOOL_TURN_FIXTURE.tools[1].name })),
      true,
    ],
    [
      "the host changed a call's input",
      callEdit((call) => ({ ...call, input: { location: "Rome" } })),
      true,
    ],
    [
      "the host dropped the call",
      (assistant) =>
        mapBlocks(assistant, (block) => (block.type === "tool_use" ? undefined : block)),
      false,
    ],
    [
      "another model produced the turn",
      (assistant) =>
        mapBlocks(assistant, (block) =>
          block.type === "reasoning" && block.provider !== undefined
            ? { ...block, provider: `${vendor}:conformance-other-model` }
            : block
        ),
      true,
    ],
  ];
}

function history(assistant: ChatMessage, answered: boolean): ChatMessage[] {
  return answered ? [userTurn, assistant, toolResults(assistant)] : [userTurn, assistant];
}

/**
 * A round's reasoning reaches the next round the way the provider declares —
 * and for a provider replaying its own turn, only while that turn is still the
 * one the conversation holds. Every case starts from a real first round, so
 * the payload replayed is the one this run-fn emitted, not a hand-written one.
 */
export function reasoningRoundTripBlock(
  opts: ToolTurnConformanceOpts,
  harness: () => ToolTurnHarness
): void {
  const fails = new Set(opts.expectedFailures ?? []);
  const replay = opts.reasoningReplay;

  describe("Reasoning round trip", () => {
    if (replay.kind === "native") {
      const itReplay = fails.has("native.replay") ? itExpectFail : it;
      const itRebuild = fails.has("native.rebuild") ? itExpectFail : it;

      itReplay(
        "replays its own turn verbatim while the calls still match",
        async () => {
          const first = await runToolTurnRound(harness(), [userTurn], reasoningCallReply);
          expect(first.output.nativeTurn, "the first round emitted no nativeTurn").toBeDefined();
          const assistant = recordedAssistantTurn(first.output);
          const replayed = await runToolTurnRound(harness(), history(assistant, true));
          const wire = replay.wireForm(first.output.nativeTurn!.payload);
          expect(
            containsVerbatim(replayed.request, wire),
            "the replayed request does not carry the native turn unchanged"
          ).toBe(true);
          const rebuilt = await runToolTurnRound(
            harness(),
            history(withoutNativeTurn(assistant), true)
          );
          expect(
            wireTurns(opts, replayed.request),
            "replaying the native turn sent the same turns as rebuilding it"
          ).not.toEqual(wireTurns(opts, rebuilt.request));
        },
        opts.timeout
      );

      for (const [label, edit, answered] of rebuildCases(replay.vendor)) {
        itRebuild(
          `rebuilds the turn when ${label}`,
          async () => {
            const first = await runToolTurnRound(harness(), [userTurn], reasoningCallReply);
            expect(first.output.nativeTurn, "the first round emitted no nativeTurn").toBeDefined();
            const edited = edit(recordedAssistantTurn(first.output));
            const withPayload = await runToolTurnRound(harness(), history(edited, answered));
            const rebuilt = await runToolTurnRound(
              harness(),
              history(withoutNativeTurn(edited), answered)
            );
            expect(
              wireTurns(opts, withPayload.request),
              "a turn the conversation no longer matches must be sent as if no native turn was kept"
            ).toEqual(wireTurns(opts, rebuilt.request));
          },
          opts.timeout
        );
      }
    } else if (replay.kind === "text") {
      const itReplay = fails.has("reasoning.replay") ? itExpectFail : it;
      itReplay(
        "sends the round's reasoning back on its assistant turn",
        async () => {
          const first = await runToolTurnRound(harness(), [userTurn], reasoningCallReply);
          expect(first.output.reasoning).toBe(TOOL_TURN_FIXTURE.reasoning);
          const assistant = recordedAssistantTurn(first.output);
          const next = await runToolTurnRound(harness(), history(assistant, true));
          const turns = wireTurns(opts, next.request);
          const at = turnHolding(turns, TOOL_TURN_FIXTURE.reasoning);
          expect(at, "the reasoning is nowhere in the next request").toBeGreaterThan(-1);
          expect(turns[at]!.role).toBe("assistant");
          expect(turnHolding(turns, TOOL_TURN_FIXTURE.call.name)).toBeGreaterThan(-1);
        },
        opts.timeout
      );
    } else if (replay.kind === "call-signature") {
      const itReplay = fails.has("reasoning.replay") ? itExpectFail : it;
      itReplay(
        "keeps each call's signature and sends it back on the assistant turn",
        async () => {
          const first = await runToolTurnRound(harness(), [userTurn], reasoningCallReply);
          const signatures = first.output.toolCalls.map((call) => call.providerSignature);
          expect(signatures).toHaveLength(1);
          expect(typeof signatures[0], "the call came back without its signature").toBe("string");
          const next = await runToolTurnRound(
            harness(),
            history(recordedAssistantTurn(first.output), true)
          );
          const turns = wireTurns(opts, next.request);
          const at = turnHolding(turns, signatures[0]!);
          expect(at, "the signature is nowhere in the next request").toBeGreaterThan(-1);
          expect(turns[at]!.role).toBe("assistant");
        },
        opts.timeout
      );
    } else {
      it.skip(`replays no reasoning: ${replay.reason}`, () => {});
    }
  });
}
