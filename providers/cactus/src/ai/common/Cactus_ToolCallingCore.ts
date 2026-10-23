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
import { estimateCallUsage, extractMessageText } from "@workglow/ai/provider-utils";
import { filterValidToolCalls } from "@workglow/ai/worker";
import type { NeedleEngine } from "./Cactus_LoadEngine";
import type { CactusModelConfig } from "./Cactus_ModelSchema";
import {
  createNeedleVisibleTextFilter,
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

/**
 * What the engine is asked this round. Needle answers one query with no
 * conversation of its own, and each round's input carries the whole history
 * beside the turn's prompt, so the question is the latest user turn: sending
 * the prompt every round would repeat it after a tool result. A later user turn
 * within the same request can lean on the prompt (a review asking the model to
 * check its answer against what it was asked), so the prompt goes ahead of it
 * whenever the two differ. Earlier requests in the history are left out, but
 * everything after the latest user turn (tool results, assistant text) is kept:
 * the engine is stateless, so that tail is its only record of tool output.
 */
function promptText(input: ToolCallingTaskInput): string {
  const query = queryText(input);
  return input.systemPrompt ? `${input.systemPrompt}\n\n${query}` : query;
}

function toolResultText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    const record = block as {
      readonly type?: unknown;
      readonly content?: unknown;
      readonly text?: unknown;
    };
    if (record.type === "tool_result" && Array.isArray(record.content)) {
      for (const inner of record.content) {
        if (
          inner &&
          typeof inner === "object" &&
          (inner as { readonly type?: unknown }).type === "text"
        ) {
          const text = (inner as { readonly text?: unknown }).text;
          if (typeof text === "string" && text.length > 0) parts.push(text);
        }
      }
    }
  }
  return parts.join("\n");
}

/** Text the engine should see from one history message after the latest user turn. */
function tailMessageText(message: NonNullable<ToolCallingTaskInput["messages"]>[number]): string {
  if (message.role === "tool") return toolResultText(message.content);
  if (message.role === "assistant") return extractMessageText(message.content);
  return "";
}

function queryText(input: ToolCallingTaskInput): string {
  const prompt =
    typeof input.prompt === "string"
      ? input.prompt
      : input.prompt
        ? extractMessageText(input.prompt)
        : "";
  const messages = input.messages;
  if (messages && messages.length > 0) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role !== "user") continue;
      const latest = extractMessageText(messages[i].content);
      const base = prompt !== "" && latest !== prompt ? `${prompt}\n\n${latest}` : latest;
      // Stateless engine: everything after the latest user turn (tool results,
      // assistant text) is the only record of what the tools returned. Without
      // it a round after a tool runs repeats the original question alone and
      // can repeat the same call instead of answering from its result.
      const tail = messages
        .slice(i + 1)
        .map(tailMessageText)
        .filter((text) => text !== "");
      if (tail.length === 0) return base;
      return base !== "" ? `${base}\n\n${tail.join("\n\n")}` : tail.join("\n\n");
    }
  }
  if (prompt !== "") return prompt;
  if (messages && messages.length > 0) {
    return extractMessageText(messages[messages.length - 1].content);
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
    const visible = createNeedleVisibleTextFilter((chunk) => {
      emit({ type: "text-delta", port: "reasoning", textDelta: chunk });
    });
    const emitVisible = (chunk: string): void => {
      if (chunk.length > 0) emit({ type: "text-delta", port: "text", textDelta: chunk });
    };

    let raw: string;
    if (typeof engine.run_stream === "function") {
      raw = await engine.run_stream(query, toolsJson, (tokenIdOrChunk, piece) => {
        emitVisible(visible.push(needleStreamPiece(tokenIdOrChunk, piece)));
      });
    } else {
      const out = await engine.run(query, toolsJson);
      raw = typeof out === "string" ? out : String(out);
      // No stream to ride: the whole generation is one delta, so the
      // accumulator ends up with the same text either way.
      emitVisible(visible.push(raw));
    }
    emitVisible(visible.flush());

    const parsed: ToolCalls = parseNeedleToolCalls(raw);
    const validToolCalls = filterValidToolCalls(parsed, input.tools);
    if (validToolCalls.length > 0) {
      emit({ type: "object-delta", port: "toolCalls", objectDelta: [...validToolCalls] });
    }
    // The engine reports no token counts, so the usage is estimated from what it
    // read (the query and the tool declarations) and everything it generated. A
    // turn capping its input tokens then has a figure to count rather than none.
    const usage = estimateCallUsage(`${query}\n${toolsJson}`, raw);
    // The deltas above are the output; `TaskRunner` accumulates them. Repeating
    // them here would hand the accumulator a second, competing copy.
    emit({
      type: "finish",
      data: { text: "", toolCalls: [] } as ToolCallingTaskOutput,
      ...(usage === undefined ? {} : { usage }),
    });
  };
}
