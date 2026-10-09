/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AiProviderRunFn,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  ToolCalls,
  ToolDefinition,
  Usage,
} from "@workglow/ai";
import { createEstimatedOutputUsageReporter } from "@workglow/ai/provider-utils";
import { buildToolDescription, filterValidToolCalls, sanitizeToolArgs } from "@workglow/ai/worker";
import { parsePartialJson } from "@workglow/util/worker";
import type { OllamaModelConfig } from "./Ollama_ModelSchema";
import { getOllamaModelName } from "./Ollama_ModelUtil";
import { ollamaThinkParam } from "./Ollama_EffortPolicy";
import type { OllamaChatMessage } from "./Ollama_Messages";
import { mapOllamaUsage } from "./Ollama_Usage";

type GetClient = (model: OllamaModelConfig | undefined) => Promise<any>;

export type OllamaToolCallingMessagesFn = (input: ToolCallingTaskInput) => OllamaChatMessage[];

function mapOllamaTools(tools: ReadonlyArray<ToolDefinition>) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: buildToolDescription(t),
      parameters: t.inputSchema as any,
    },
  }));
}

export function createOllamaToolCallingStream(
  getClient: GetClient,
  buildMessages: OllamaToolCallingMessagesFn
): AiProviderRunFn<ToolCallingTaskInput, ToolCallingTaskOutput, OllamaModelConfig> {
  return async (input, model, signal, emit) => {
    const client = await getClient(model);
    const modelName = getOllamaModelName(model);

    const messages = buildMessages(input);

    const tools = input.toolChoice === "none" ? undefined : mapOllamaTools(input.tools);

    const provisionalUsage = createEstimatedOutputUsageReporter(emit);
    provisionalUsage.onPrompt(
      messages
        .map((m) => m.content)
        .filter(Boolean)
        .join("\n")
    );

    const stream = await client.chat({
      model: modelName,
      messages,
      tools,
      ...ollamaThinkParam(model),
      options: {
        temperature: input.temperature,
        num_predict: input.maxTokens,
      },
      stream: true,
    });

    const onAbort = (): void => stream.abort();
    signal?.addEventListener("abort", onAbort, { once: true });

    let callIndex = 0;
    let usage: Usage | undefined;

    try {
      for await (const chunk of stream) {
        usage = mapOllamaUsage(chunk) ?? usage;
        const thinking = chunk.message.thinking;
        if (thinking) {
          provisionalUsage.onText(thinking);
          emit({ type: "text-delta", port: "reasoning", textDelta: thinking });
        }
        const delta = chunk.message.content;
        if (delta) {
          provisionalUsage.onText(delta);
          emit({ type: "text-delta", port: "text", textDelta: delta });
        }

        const chunkToolCalls = chunk.message.tool_calls;
        if (Array.isArray(chunkToolCalls) && chunkToolCalls.length > 0) {
          const parsed: ToolCalls = [];
          for (const tc of chunkToolCalls) {
            let parsedInput: Record<string, unknown> = {};
            const fnArgs = tc.function.arguments;
            if (typeof fnArgs === "string") {
              try {
                parsedInput = JSON.parse(fnArgs);
              } catch {
                const partial = parsePartialJson(fnArgs);
                parsedInput = (partial as Record<string, unknown>) ?? {};
              }
              provisionalUsage.onText(fnArgs);
            } else if (fnArgs != null) {
              parsedInput = fnArgs as Record<string, unknown>;
              provisionalUsage.onText(JSON.stringify(fnArgs));
            }
            parsed.push({
              id: `call_${callIndex++}`,
              name: tc.function.name as string,
              input: sanitizeToolArgs(parsedInput) as Record<string, unknown>,
            });
          }
          // Filter hallucinated tool names at the delta, not at finish: the
          // consumer accumulates deltas and the streaming finish carries only a
          // structural default, so unvalidated calls must never be emitted.
          const valid = filterValidToolCalls(parsed, input.tools);
          if (valid.length > 0) {
            emit({ type: "object-delta", port: "toolCalls", objectDelta: valid });
          }
        }
      }

      provisionalUsage.flush();
      // Static default scaffold only — the run-fn does not accumulate. The
      // consumer's accumulated deltas take precedence; this supplies the
      // required output ports when the model streamed neither text nor calls.
      emit({
        type: "finish",
        data: { text: "", toolCalls: [] } as ToolCallingTaskOutput,
        usage,
      });
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  };
}
