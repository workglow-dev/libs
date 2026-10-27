/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";

import { itExpectFail } from "../../itExpectFail";
import { nativeTurns, reasoningCallReply, runToolTurnRound, userTurn } from "../toolTurnFixture";
import type { ToolTurnConformanceOpts, ToolTurnHarness } from "../toolTurnTypes";

/**
 * A provider that replays its own turn emits it once per round on `nativeTurn`,
 * keyed `<vendor>:<model>`: encrypted reasoning and signed thinking are
 * readable only by the model that wrote them, so the key is what lets a later
 * round tell its own turn from one another model produced.
 *
 * A provider that does not replay one must not emit one either: `AgentTask`
 * keeps the payload on the message, where nothing would ever read it.
 */
export function nativeTurnBlock(
  opts: ToolTurnConformanceOpts,
  harness: () => ToolTurnHarness
): void {
  const itEmit = new Set(opts.expectedFailures ?? []).has("native.emit") ? itExpectFail : it;
  const replay = opts.reasoningReplay;

  describe("Native turn emission", () => {
    if (replay.kind === "native") {
      itEmit(
        `emits the round's own turn once, keyed ${replay.vendor}:${replay.model}, before finish`,
        async () => {
          const { events } = await runToolTurnRound(harness(), [userTurn], reasoningCallReply);
          const native = nativeTurns(events);
          expect(native, "one nativeTurn per round").toHaveLength(1);
          expect(native[0]!.provider).toBe(`${replay.vendor}:${replay.model}`);
          expect(typeof native[0]!.payload).toBe("string");
          const nativeAt = events.findIndex(
            (event) => event.type === "object-delta" && event.port === "nativeTurn"
          );
          const finishAt = events.findIndex((event) => event.type === "finish");
          expect(finishAt, "the run-fn emitted no finish").toBeGreaterThan(-1);
          expect(nativeAt).toBeLessThan(finishAt);
        },
        opts.timeout
      );
    } else {
      itEmit(
        "emits no nativeTurn, having no native turn to replay",
        async () => {
          const { events } = await runToolTurnRound(harness(), [userTurn], reasoningCallReply);
          expect(nativeTurns(events)).toEqual([]);
        },
        opts.timeout
      );
    }
  });
}
