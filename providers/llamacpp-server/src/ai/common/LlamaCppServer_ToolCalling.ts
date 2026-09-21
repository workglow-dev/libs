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
  Usage,
} from "@workglow/ai";
import {
  createEstimatedOutputUsageReporter,
  localOnlyFetch,
  mapOpenAIChatUsage,
  OPENAI_STREAM_USAGE_OPTIONS,
} from "@workglow/ai/provider-utils";
import {
  buildToolDescription,
  filterValidToolCalls,
  isAllowedToolName,
  sanitizeToolArgs,
  toTextFlatMessages,
} from "@workglow/ai/worker";
import type { PartialJsonStream } from "@workglow/util/worker";
import { createPartialJsonStream } from "@workglow/util/worker";
import {
  acquireBaseUrl,
  buildServerUrl,
  readChatCompletionDeltas,
  type ILlamaCppServerProviderOptions,
} from "./LlamaCppServer_Client";
import type { LlamaCppServerModelConfig } from "./LlamaCppServer_ModelSchema";
import { getLlamaCppServerModelName } from "./LlamaCppServer_ModelUtil";

type AcquireFn = typeof acquireBaseUrl;

/**
 * Per-tool-call streaming state. `args` is fed each argument fragment as it
 * arrives, so a delta costs O(fragment) rather than re-parsing that call's whole
 * accumulated argument string; `parsed` caches the parser's live root so
 * rebuilding the tool-call list leaves calls that did not change untouched.
 */
interface ToolCallAccumulator {
  id: string | undefined;
  name: string | undefined;
  readonly args: PartialJsonStream;
  parsed: Record<string, unknown>;
}

function mapTools(tools: readonly ToolDefinition[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: buildToolDescription(t),
      parameters: t.inputSchema as unknown,
    },
  }));
}

export function createLlamaCppServerToolCallingStream(
  opts: ILlamaCppServerProviderOptions,
  acquire: AcquireFn = acquireBaseUrl
): AiProviderRunFn<ToolCallingTaskInput, ToolCallingTaskOutput, LlamaCppServerModelConfig> {
  return async (input, model, signal, emit) => {
    signal?.throwIfAborted?.();
    const messages = toTextFlatMessages(input);
    const tools = input.toolChoice === "none" ? undefined : mapTools(input.tools);
    const body = JSON.stringify({
      model: getLlamaCppServerModelName(model),
      messages,
      ...(tools ? { tools } : {}),
      stream: true,
      ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
      ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
      ...OPENAI_STREAM_USAGE_OPTIONS,
    });
    const { baseUrl, release } = await acquire(model, opts);
    try {
      const provisionalUsage = createEstimatedOutputUsageReporter(emit);
      provisionalUsage.onPrompt(
        messages
          .map((m) => (typeof m.content === "string" ? m.content : ""))
          .filter(Boolean)
          .join("\n")
      );

      const response = await localOnlyFetch(
        buildServerUrl(baseUrl, "/v1/chat/completions"),
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal,
        },
        "LlamaCppServer"
      );
      if (!response.ok) {
        const text = await response.text().catch(() => "(no body)");
        throw new Error(
          `LlamaCppServer: HTTP ${response.status} from /v1/chat/completions (tool-use) — ${text}`
        );
      }

      const calls = new Map<number, ToolCallAccumulator>();
      let nextSyntheticIndex = 0;
      let usage: Usage | undefined;

      for await (const delta of readChatCompletionDeltas(response, signal)) {
        if (delta.done) break;
        usage = mapOpenAIChatUsage(delta.usage) ?? usage;
        if (delta.contentDelta) {
          provisionalUsage.onText(delta.contentDelta);
          emit({ type: "text-delta", port: "text", textDelta: delta.contentDelta });
        }
        if (delta.toolCallDeltas?.length) {
          for (const tc of delta.toolCallDeltas) {
            const idx = typeof tc.index === "number" ? tc.index : nextSyntheticIndex++;
            let call = calls.get(idx);
            if (call === undefined) {
              call = {
                id: undefined,
                name: undefined,
                args: createPartialJsonStream(),
                parsed: {},
              };
              calls.set(idx, call);
            }
            if (tc.id) call.id = tc.id;
            if (tc.function?.name) call.name = tc.function.name;
            if (tc.function?.arguments) {
              provisionalUsage.onText(tc.function.arguments);
              call.parsed = call.args.push(tc.function.arguments) ?? call.parsed;
            }
          }
          emit({
            type: "object-delta",
            port: "toolCalls",
            objectDelta: buildToolCalls(calls, input.tools),
          });
        }
      }
      provisionalUsage.flush();
      // Close each parser so a truncated argument stream is repaired once, at
      // the end, instead of on every delta.
      for (const call of calls.values()) {
        call.parsed = call.args.finishObject();
      }
      // One last delta, because the repair above is the first time the
      // arguments are complete — same ids, so it upserts over the partial ones.
      const finalToolCalls = filterValidToolCalls(buildToolCalls(calls), input.tools);
      if (finalToolCalls.length > 0) {
        emit({ type: "object-delta", port: "toolCalls", objectDelta: finalToolCalls });
      }
      // Text and calls both reached the consumer as deltas and `TaskRunner`
      // accumulates them; repeating either hands it a competing copy.
      emit({
        type: "finish",
        data: { text: "", toolCalls: [] } as ToolCallingTaskOutput,
        usage,
      });
    } finally {
      await release();
    }
  };
}

/**
 * `allowedTools` filters silently, and the interim deltas pass it.
 *
 * The delta fold is an upsert by id, so a call that reaches the stream cannot
 * later be retracted — which means a name the model invented has to be kept out
 * rather than removed at the end. {@link filterValidToolCalls} is still run once
 * on the final set, where its warning names the dropped call exactly once
 * instead of once per delta.
 */
function buildToolCalls(
  callsByIndex: ReadonlyMap<number, ToolCallAccumulator>,
  allowedTools?: ReadonlyArray<ToolDefinition>
): ToolCalls {
  const result: ToolCalls = [];
  for (const idx of [...callsByIndex.keys()].sort((a, b) => a - b)) {
    const call = callsByIndex.get(idx)!;
    if (!call.name) continue;
    if (allowedTools && !isAllowedToolName(call.name, allowedTools)) continue;
    // `sanitizeToolArgs` copies, so the emitted call is detached from the
    // parser's live root and unaffected by later fragments.
    result.push({
      id: call.id ?? `call_${idx}`,
      name: call.name,
      input: sanitizeToolArgs(call.parsed) as Record<string, unknown>,
    });
  }
  return result;
}
