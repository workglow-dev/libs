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
} from "@workglow/ai";
import {
  accumulateOpenAIChatStream,
  buildOpenAITools,
  OPENAI_STREAM_USAGE_OPTIONS,
} from "@workglow/ai/provider-utils";
import { filterValidToolCalls, toOpenAIMessages } from "@workglow/ai/worker";
import { RetryableJobError } from "@workglow/job-queue";
import { getClient, getModelName, reasoningParams, resolveMaxTokens } from "./DeepSeek_Client";
import type { DeepSeekModelConfig } from "./DeepSeek_ModelSchema";
import { mapDeepSeekUsage } from "./DeepSeek_Usage";

/**
 * Thrown when the caller demanded a tool call that the model did not make.
 *
 * Retryable: the model was *asked* for the call and simply didn't produce one,
 * which is nondeterministic rather than structurally impossible — a re-roll is
 * a legitimate remedy, so the job-queue retry policy applies. Extending
 * {@link RetryableJobError} is what lets {@link classifyProviderError} pass the
 * error through unchanged instead of wrapping it as a `PermanentJobError`.
 */
export class DeepSeekToolChoiceNotHonoredError extends RetryableJobError {
  public static override type = "DeepSeekToolChoiceNotHonoredError";
  constructor(
    public readonly modelId: string,
    public readonly requestedToolChoice: string,
    detail: string
  ) {
    super(
      `DeepSeek model "${modelId}" did not honor tool_choice "${requestedToolChoice}": ${detail}`
    );
    this.name = "DeepSeekToolChoiceNotHonoredError";
  }
}

/**
 * Whether `toolChoice` demands a call — i.e. `"required"` (any tool) or a
 * specific function name. `undefined` / `"auto"` / `"none"` demand nothing.
 */
export function isForcingToolChoice(toolChoice: string | undefined): toolChoice is string {
  return toolChoice !== undefined && toolChoice !== "auto" && toolChoice !== "none";
}

/**
 * Map a workglow `toolChoice` to what DeepSeek actually accepts on the wire.
 *
 * The v4 models are thinking models, and thinking mode rejects any tool_choice
 * beyond `auto` / `none` — `"required"` and the named-function object both come
 * back as `400 Thinking mode does not support this tool_choice`. So the shared
 * {@link mapOpenAIToolChoice}, which emits both, cannot be used here.
 *
 * A forcing choice is sent as `auto` so the request is accepted, and the
 * constraint is then enforced on our side once the stream completes — see
 * {@link assertToolChoiceHonored}. `none` is passed through, since suppressing
 * calls is honored natively.
 */
function mapDeepSeekToolChoice(toolChoice: string | undefined): "auto" | "none" {
  return toolChoice === "none" ? "none" : "auto";
}

/**
 * Enforce a forcing `toolChoice` after the fact, since DeepSeek cannot enforce
 * it server-side.
 *
 * This mirrors how json-mode is handled here: the vendor gives no guarantee, so
 * the guarantee is re-established by checking the response rather than by
 * silently dropping the caller's constraint. `"required"` needs at least one
 * call; a named function needs that specific function to have been called.
 *
 * Only calls that survived {@link filterValidToolCalls} count — a hallucinated
 * function name does not satisfy the request.
 */
export function assertToolChoiceHonored(
  toolChoice: string,
  calledNames: readonly string[],
  modelId: string
): void {
  if (toolChoice === "required") {
    if (calledNames.length === 0) {
      throw new DeepSeekToolChoiceNotHonoredError(
        modelId,
        toolChoice,
        "the response contained no valid tool call"
      );
    }
    return;
  }
  if (!calledNames.includes(toolChoice)) {
    const seen = calledNames.length > 0 ? calledNames.join(", ") : "none";
    throw new DeepSeekToolChoiceNotHonoredError(
      modelId,
      toolChoice,
      `expected a call to "${toolChoice}" but the response called: ${seen}`
    );
  }
}

/**
 * Streaming run-fn for `["text.generation", "tool-use"]`. Calls the DeepSeek
 * chat-completions endpoint (OpenAI-compatible) with `stream: true` and
 * forwards delta events via {@link accumulateOpenAIChatStream}, which emits
 * `text-delta` and tool-call `object-delta` events plus a final empty
 * `finish`.
 *
 * Defence-in-depth: each tool-call `object-delta` is filtered against
 * `input.tools` so a hallucinated function name never reaches the consumer.
 */
export const DeepSeek_ToolCalling_Stream: AiProviderRunFn<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  DeepSeekModelConfig
> = async (input, model, signal, emit) => {
  const client = await getClient(model);
  const modelName = getModelName(model);

  const tools = buildOpenAITools(input.tools);
  // DeepSeek's thinking models read their reasoning back on each turn of a
  // tool-calling loop, and an image a tool returned has to ride a user message.
  const messages = toOpenAIMessages(input, {
    replayReasoning: model?.provider_config?.replay_reasoning !== false,
    toolImagesInUserMessage: true,
  });
  const toolChoice = mapDeepSeekToolChoice(input.toolChoice);

  const stream = await client.chat.completions.create(
    {
      model: modelName,
      messages,
      max_tokens: resolveMaxTokens(model, input.maxTokens),
      ...reasoningParams(model),
      temperature: input.temperature,
      stream: true,
      tools,
      tool_choice: toolChoice,
      ...OPENAI_STREAM_USAGE_OPTIONS,
    },
    { signal }
  );

  // Deltas arrive per call and are upserted by id downstream, so track the
  // latest name per id rather than counting events.
  const calledByCallId = new Map<string, string>();

  const usage = await accumulateOpenAIChatStream(
    stream,
    (event) => {
      if (event.type === "object-delta" && event.port === "toolCalls") {
        const validated = filterValidToolCalls(event.objectDelta as ToolCalls, input.tools);
        if (validated.length > 0) {
          for (const call of validated) calledByCallId.set(call.id, call.name);
          emit({ type: "object-delta", port: "toolCalls", objectDelta: validated });
        }
        return;
      }
      emit(event);
    },
    mapDeepSeekUsage,
    {
      promptText: messages
        .map((m) => (typeof m.content === "string" ? m.content : ""))
        .filter(Boolean)
        .join("\n"),
    }
  );

  if (isForcingToolChoice(input.toolChoice)) {
    assertToolChoiceHonored(input.toolChoice, [...calledByCallId.values()], modelName);
  }

  emit({ type: "finish", data: { text: "", toolCalls: [] } as ToolCallingTaskOutput, usage });
};
