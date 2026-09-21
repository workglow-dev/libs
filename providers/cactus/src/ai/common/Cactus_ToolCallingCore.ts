/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  ToolCalls,
  ToolDefinition,
} from "@workglow/ai";
import { extractMessageText } from "@workglow/ai/provider-utils";
import { filterValidToolCalls } from "@workglow/ai/worker";
import type { NeedleEngine } from "./Cactus_LoadEngine";
import type { CactusModelConfig } from "./Cactus_ModelSchema";
import {
  createNeedleReasoningFilter,
  needleStreamPiece,
  parseNeedleToolCalls,
} from "./Cactus_ParseToolCalls";

function buildToolsJson(tools: ReadonlyArray<ToolDefinition>): string {
  return JSON.stringify(
    tools.map((t) => ({
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.inputSchema ? { parameters: t.inputSchema } : {}),
    }))
  );
}

function promptText(input: ToolCallingTaskInput): string {
  if (typeof input.prompt === "string") return input.prompt;
  if (input.prompt) return extractMessageText(input.prompt);
  if (input.messages && input.messages.length > 0) {
    const last = input.messages[input.messages.length - 1];
    return extractMessageText(last.content);
  }
  return "";
}

/**
 * `NeedleWasm`, `NeedleV2Wasm` and `NeedleV3Wasm` all expose `run_stream`;
 * `run` is the fallback for a test double or a future build that does not.
 *
 * The callback signature spans both shapes on purpose: v1 and v2 pass
 * `(tokenId, piece)`, v3 passes the decoded delta alone. `needleStreamPiece`
 * resolves which one arrived.
 */
interface NeedleRunnable {
  readonly run_stream?: (
    query: string,
    toolsJson: string,
    onToken: (tokenIdOrChunk: number | string, piece?: string) => void
  ) => Promise<string> | string;
  readonly run: (query: string, toolsJson: string) => Promise<string> | string;
}

/**
 * The tool-calling run-fn, parameterised by the runtime that resolves the
 * engine. The node and browser entry points differ only in that resolver, so
 * the body lives here once rather than being kept in sync in two files.
 */
export function createCactusToolCalling(
  getOrLoadEngine: (model: CactusModelConfig) => Promise<NeedleEngine>
): AiProviderRunFn<ToolCallingTaskInput, ToolCallingTaskOutput, CactusModelConfig> {
  return async (input, model, signal, emit) => {
    if (!model) throw new Error("Model config is required for ToolCallingTask.");
    if (signal?.aborted) throw signal.reason ?? new Error("The operation was aborted");

    const engine = (await getOrLoadEngine(model)) as unknown as NeedleRunnable;
    const query = promptText(input);
    const toolsJson = buildToolsJson(input.tools);

    // One definition of "what the caller sees as text", so the streamed and
    // one-shot paths cannot disagree about it.
    const reasoning = createNeedleReasoningFilter();
    const emitVisible = (chunk: string): void => {
      if (chunk.length > 0) emit({ type: "text-delta", port: "text", textDelta: chunk });
    };

    let raw: string;
    if (typeof engine.run_stream === "function") {
      raw = await engine.run_stream(query, toolsJson, (tokenIdOrChunk, piece) => {
        emitVisible(reasoning.push(needleStreamPiece(tokenIdOrChunk, piece)));
      });
    } else {
      const out = await engine.run(query, toolsJson);
      raw = typeof out === "string" ? out : String(out);
      // No stream to ride: the whole generation is one delta, so the
      // accumulator ends up with the same text either way.
      emitVisible(reasoning.push(raw));
    }
    emitVisible(reasoning.flush());

    const parsed: ToolCalls = parseNeedleToolCalls(raw);
    const validToolCalls = filterValidToolCalls(parsed, input.tools);
    if (validToolCalls.length > 0) {
      emit({ type: "object-delta", port: "toolCalls", objectDelta: [...validToolCalls] });
    }
    // The deltas above are the output; `TaskRunner` accumulates them. Repeating
    // them here would hand the accumulator a second, competing copy.
    emit({ type: "finish", data: { text: "", toolCalls: [] } as ToolCallingTaskOutput });
  };
}
