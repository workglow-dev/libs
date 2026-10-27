/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { _testOnly } from "@workglow/cactus/ai";
import type { ScriptedReply, WireTurn } from "@workglow/test-contract/ai-provider";
import { runToolTurnConformance } from "@workglow/test-contract/ai-provider";

import { proseToolExchangeTurns } from "../ai-provider/proseToolExchangeWire";
import { runFnFor } from "./test-utils";

const { cactusEngines } = _testOnly;

const model = {
  model_id: "cactus-conformance",
  title: "",
  description: "",
  provider: "LOCAL_CACTUS",
  provider_config: { model_id: "needle-conformance" },
  capabilities: ["tool-use"],
  metadata: {},
} as never;

/** What Needle is handed: one query string, and the tool declarations beside it. */
interface NeedleRequest {
  readonly query: string;
  readonly toolsJson: string;
}

/** The reply as Needle v3 decodes it: `<think>`, the answer, then a fenced call payload. */
function decodedPieces(reply: ScriptedReply): string[] {
  const pieces: string[] = [];
  if (reply.reasoning !== undefined) pieces.push(`<think>${reply.reasoning}</think>`);
  if (reply.text !== undefined) pieces.push(reply.text);
  const calls = reply.toolCalls ?? [];
  if (calls.length > 0) {
    const payload = calls.map((call) => ({ name: call.name, arguments: call.input }));
    pieces.push(`<tool_call>${JSON.stringify(payload)}</tool_call>`);
  }
  return pieces;
}

/** The conversation is the query alone; the tool declarations are not a turn. */
function turns(request: unknown): WireTurn[] {
  return proseToolExchangeTurns((request as NeedleRequest).query);
}

runToolTurnConformance({
  name: "Cactus",
  createHarness: () => {
    const sent: NeedleRequest[] = [];
    const replies: ScriptedReply[] = [];
    cactusEngines.set("needle-conformance", {
      run: () => {
        throw new Error("the run-fn streams when the engine can");
      },
      run_stream: (query: string, toolsJson: string, onToken: (chunk: string) => void) => {
        sent.push({ query, toolsJson });
        const pieces = decodedPieces(replies.shift() ?? {});
        for (const piece of pieces) onToken(piece);
        return pieces.join("");
      },
    } as never);
    const runFn = runFnFor(["tool-use"]);
    return {
      respond: (reply) => void replies.push(reply),
      run: (request, emit) =>
        runFn(
          { ...request, toolChoice: "auto" } as never,
          model,
          new AbortController().signal,
          emit as never
        ),
      sent: () => sent,
      dispose: () => cactusEngines.clear(),
    };
  },
  turns,
  reasoningStream: "reasoning-port",
  reasoningReplay: {
    kind: "none",
    reason:
      "Needle answers one query and keeps no conversation; a round's thinking is not " +
      "part of what the next round's query carries",
  },
  toolResultImages: {
    kind: "text-only",
    reason: "Needle reads one text query, so a tool's image can only be named in it",
  },
});
