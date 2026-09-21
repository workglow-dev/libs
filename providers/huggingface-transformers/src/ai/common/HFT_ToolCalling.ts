/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "@workglow/util";
import type { TextGenerationPipeline } from "@huggingface/transformers";
import type {
  AiProviderRunFn,
  ChatMessage,
  CheckpointPrefix,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  ToolDefinition,
} from "@workglow/ai";
import {
  adaptParserResult,
  forcedToolSelection,
  getAvailableParsers,
  getGenerationPrefix,
  parseToolCalls,
} from "@workglow/ai/provider-utils";
import {
  buildToolDescription,
  filterValidToolCalls,
  toTextFlatMessages,
} from "@workglow/ai/worker";
import { renderHftPrefixPrompt, resolveHftParityAnchor } from "./HFT_CacheCheckpoint";
import type { HfTransformersOnnxModelConfig } from "./HFT_ModelSchema";
import {
  deleteHftSession,
  getHftSession,
  getPipeline,
  getPipelineCacheKey,
  hasGpuBufferEntries,
  loadTransformersSDK,
  snapshotHftSession,
  withHftPipelineInUse,
} from "./HFT_Pipeline";
import { createStreamingTextStreamer } from "./HFT_Streaming";
import { createToolCallMarkupFilter } from "./HFT_ToolMarkup";

// ============================================================================
// Model detection
// ============================================================================

function getModelTextCandidates(model: HfTransformersOnnxModelConfig): string[] {
  return [model.model_id, model.title, model.description, model.provider_config.model_path]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.toLowerCase());
}

/**
 * Detect the parser model family from the HFT model config by checking all
 * text candidates against the known parser families.
 */
function detectModelFamilyFromConfig(model: HfTransformersOnnxModelConfig): string | null {
  const candidates = getModelTextCandidates(model);
  const families = getAvailableParsers();
  for (const candidate of candidates) {
    for (const family of families) {
      if (candidate.includes(family)) {
        return family;
      }
    }
  }
  return null;
}

// ============================================================================
// Tool call result adaptation
// ============================================================================

function normalizeParsedToolCalls(
  input: ToolCallingTaskInput,
  toolCalls: ToolCallingTaskOutput["toolCalls"]
) {
  const forcedToolName = forcedToolSelection(input);
  return toolCalls.map((toolCall) =>
    toolCall.name
      ? toolCall
      : {
          ...toolCall,
          name: forcedToolName ?? toolCall.name,
        }
  );
}

// ============================================================================
// HFT tool mapping
// ============================================================================

/** OpenAI-function-shaped tool entry accepted by HFT chat templates. */
export interface HftTemplateTool {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: ToolDefinition["inputSchema"];
  };
}

export function mapHFTTools(tools: ReadonlyArray<ToolDefinition>): HftTemplateTool[] {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: buildToolDescription(t),
      parameters: t.inputSchema,
    },
  }));
}

/**
 * Resolve the tools list and optionally mutate the messages array based on the toolChoice option.
 */
function resolveHFTToolsAndMessages(
  input: ToolCallingTaskInput,
  messages: Array<{ role: string; content: string }>
): ReturnType<typeof mapHFTTools> | undefined {
  if (input.toolChoice === "none") {
    return undefined;
  }

  if (input.toolChoice === "required") {
    const requiredInstruction =
      "You must call at least one tool from the provided tool list when answering.";
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0] = { ...messages[0], content: `${messages[0].content}\n\n${requiredInstruction}` };
    } else {
      messages.unshift({ role: "system", content: requiredInstruction });
    }
    return mapHFTTools(input.tools);
  }

  if (typeof input.toolChoice === "string" && input.toolChoice !== "auto") {
    const selectedTools = input.tools?.filter(
      (tool: ToolDefinition) => tool.name === input.toolChoice
    );
    const toolsToMap = selectedTools && selectedTools.length > 0 ? selectedTools : input.tools;
    return mapHFTTools(toolsToMap);
  }

  return mapHFTTools(input.tools);
}

// ============================================================================
// HFT message building
// ============================================================================

/**
 * Build structured messages for HFT's `apply_chat_template`.
 *
 * Unlike `toTextFlatMessages` (which flattens everything to `{role, content}`
 * strings), this preserves tool_calls on assistant messages and the tool name
 * on tool-result messages — both required by HFT chat templates that support
 * tool calling.
 */
export function buildHFTMessages(
  messages: ReadonlyArray<ChatMessage> | undefined,
  systemPrompt: string | undefined,
  prompt: unknown,
  toolChoice: string | undefined
): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  if (systemPrompt) {
    out.push({ role: "system", content: systemPrompt });
  }
  if (toolChoice === "required") {
    out.push({
      role: "system",
      content: "You MUST call one of the provided tools in this turn.",
    });
  }
  if (!messages || messages.length === 0) {
    out.push({ role: "user", content: extractPromptText(prompt) });
    return out;
  }
  for (const msg of messages) {
    if (msg.role === "user") {
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");
      out.push({ role: "user", content: text });
    } else if (msg.role === "assistant") {
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { type: "text"; text: string }).text)
        .join("");
      const toolCalls = msg.content
        .filter((b) => b.type === "tool_use")
        .map((b) => {
          const tu = b as {
            type: "tool_use";
            id: string;
            name: string;
            input: Record<string, unknown>;
          };
          return { id: tu.id, name: tu.name, arguments: tu.input };
        });
      const entry: Record<string, unknown> = { role: "assistant", content: text };
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
    } else if (msg.role === "tool") {
      for (const b of msg.content) {
        if (b.type !== "tool_result") continue;
        const text = b.content
          .filter((inner) => inner.type === "text")
          .map((inner) => (inner as { type: "text"; text: string }).text)
          .join("");
        out.push({
          role: "tool",
          content: text,
          tool_call_id: b.tool_use_id,
        });
      }
    }
  }
  return out;
}

function extractPromptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt;
  if (!Array.isArray(prompt)) return asText(prompt);
  return prompt
    .map((item) => {
      if (typeof item === "string") return item;
      if (item && typeof item === "object" && (item as Record<string, unknown>).type === "text") {
        return (item as { text: string }).text;
      }
      return "";
    })
    .filter((s) => s)
    .join("\n");
}

/**
 * Select the appropriate tool list based on toolChoice, without mutating messages.
 */
function selectHFTTools(input: ToolCallingTaskInput): ReturnType<typeof mapHFTTools> | undefined {
  if (input.toolChoice === "none") return undefined;

  if (
    typeof input.toolChoice === "string" &&
    input.toolChoice !== "auto" &&
    input.toolChoice !== "required"
  ) {
    const selected = input.tools.filter((t: ToolDefinition) => t.name === input.toolChoice);
    return mapHFTTools(selected.length > 0 ? selected : input.tools);
  }

  return mapHFTTools(input.tools);
}

// ============================================================================
// Prompt building
// ============================================================================

/**
 * Check whether the input has multi-turn tool messages that need structured
 * message format (tool_calls on assistant, name on tool messages).
 */
function hasToolMessages(input: ToolCallingTaskInput): boolean {
  return input.messages?.some((m) => m.role === "tool") ?? false;
}

function buildPromptAndPrefix(
  tokenizer: TextGenerationPipeline["tokenizer"],
  input: ToolCallingTaskInput,
  modelFamily: string | null
): { prompt: string; responsePrefix: string | undefined } {
  let basePrompt: string;

  if (hasToolMessages(input)) {
    // Multi-turn with tool results: use structured messages so the tokenizer
    // can format tool_calls and tool responses correctly.
    const messages = buildHFTMessages(
      input.messages,
      input.systemPrompt,
      input.prompt,
      input.toolChoice
    );
    const tools = selectHFTTools(input);
    basePrompt = tokenizer.apply_chat_template(messages as any, {
      tools,
      tokenize: false,
      add_generation_prompt: true,
    }) as string;
  } else {
    // Single-turn or no tool results: flat messages work fine.
    const messages = toTextFlatMessages(input);
    const tools = resolveHFTToolsAndMessages(input, messages);
    basePrompt = tokenizer.apply_chat_template(messages, {
      tools,
      tokenize: false,
      add_generation_prompt: true,
    }) as string;
  }

  const responsePrefix =
    input.toolChoice === "none" || hasToolMessages(input)
      ? undefined
      : getGenerationPrefix(modelFamily, forcedToolSelection(input));

  return {
    prompt: responsePrefix ? `${basePrompt}${responsePrefix}` : basePrompt,
    responsePrefix,
  };
}

/**
 * Builds the prompt a checkpoint consumer feeds: the checkpoint prefix's
 * messages followed by this call's tail, rendered with the same template
 * options as {@link renderHftPrefixPrompt} (prefix systemPrompt, prefix tools)
 * so on concatenative templates the result begins byte-for-byte with the
 * warm-up rendering. toolChoice adjustments that rewrite the shared region (a
 * "required" directive, a narrowed tool list) simply break that parity — the
 * caller's `startsWith` guard then falls back to a full re-encode, which stays
 * correct because the prompt carries the entire prefix.
 */
function buildCheckpointPromptAndPrefix(
  tokenizer: TextGenerationPipeline["tokenizer"],
  prefix: CheckpointPrefix,
  input: ToolCallingTaskInput,
  modelFamily: string | null
): { prompt: string; responsePrefix: string | undefined } {
  const tailMessages: ReadonlyArray<ChatMessage> =
    input.messages && input.messages.length > 0
      ? input.messages
      : [{ role: "user", content: [{ type: "text", text: extractPromptText(input.prompt) }] }];
  // A caller systemPrompt wins over the prefix's; when they differ the render
  // no longer starts with the warm-up rendering, so parity fails and the call
  // takes the full re-encode fallback — correctness over cache.
  const messages = buildHFTMessages(
    [...(prefix.messages ?? []), ...tailMessages],
    input.systemPrompt || prefix.systemPrompt,
    undefined,
    input.toolChoice
  );

  let tools: ReturnType<typeof mapHFTTools> | undefined;
  if (input.toolChoice === "none") {
    tools = undefined;
  } else if (
    typeof input.toolChoice === "string" &&
    input.toolChoice !== "auto" &&
    input.toolChoice !== "required"
  ) {
    const selected = (input.tools ?? []).filter((t: ToolDefinition) => t.name === input.toolChoice);
    const source = selected.length > 0 ? selected : (prefix.tools ?? input.tools);
    tools = source && source.length > 0 ? mapHFTTools(source) : undefined;
  } else {
    const source = prefix.tools && prefix.tools.length > 0 ? prefix.tools : input.tools;
    tools = source && source.length > 0 ? mapHFTTools(source) : undefined;
  }

  const basePrompt = tokenizer.apply_chat_template(messages as any, {
    ...(tools ? { tools: tools as any } : {}),
    tokenize: false,
    add_generation_prompt: true,
  }) as string;

  const responsePrefix =
    input.toolChoice === "none" || hasToolMessages(input)
      ? undefined
      : getGenerationPrefix(modelFamily, forcedToolSelection(input));

  return {
    prompt: responsePrefix ? `${basePrompt}${responsePrefix}` : basePrompt,
    responsePrefix,
  };
}

// ============================================================================
// Provider run functions
// ============================================================================

export const HFT_ToolCalling: AiProviderRunFn<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  HfTransformersOnnxModelConfig
> = async (input, model, signal, emit, _outputSchema, sessionContext) => {
  const sessionId = sessionContext?.sessionId;
  const isCheckpoint = sessionContext?.prefix !== undefined;
  await withHftPipelineInUse(getPipelineCacheKey(model!), async () => {
    const generateText = (await getPipeline(model!, emit, {}, signal)) as TextGenerationPipeline;
    const { TextStreamer, InterruptableStoppingCriteria } = await loadTransformersSDK();
    const modelFamily = detectModelFamilyFromConfig(model!);

    const modelPath = model!.provider_config.model_path;
    const cacheKey = getPipelineCacheKey(model!);
    let hftSession = sessionId ? getHftSession(sessionId) : undefined;

    // The exact text the stored KV tokens correspond to — the `startsWith`
    // anchor for prefix-rewind reuse. Resolved from the snapshot's own
    // encodedText when one exists (no per-call jinja re-render); re-rendered
    // otherwise: the fingerprint session's shared tools+systemPrompt region,
    // or the checkpoint prefix rendering.
    let prefixPrompt: string | undefined;
    let promptParts: { prompt: string; responsePrefix: string | undefined };
    if (isCheckpoint) {
      const prefix = sessionContext!.prefix!;
      prefixPrompt = resolveHftParityAnchor(hftSession, () =>
        renderHftPrefixPrompt(generateText.tokenizer, prefix)
      );
      promptParts = buildCheckpointPromptAndPrefix(
        generateText.tokenizer,
        prefix,
        input,
        modelFamily
      );
    } else {
      if (sessionId) {
        prefixPrompt = resolveHftParityAnchor(hftSession, () =>
          renderHftPrefixPrompt(generateText.tokenizer, {
            systemPrompt: input.systemPrompt,
            tools: input.tools,
          })
        );
      }
      promptParts = buildPromptAndPrefix(generateText.tokenizer, input, modelFamily);
    }
    const { prompt, responsePrefix } = promptParts;

    // Accumulate raw tokens for post-hoc tool-call parsing, and feed each
    // delta through a markup filter that emits cleaned text-delta events.
    let fullText = "";
    const filter = createToolCallMarkupFilter((text) => {
      emit({ type: "text-delta", port: "text", textDelta: text });
    });

    const streamer = createStreamingTextStreamer(
      generateText.tokenizer,
      (text) => {
        fullText += text;
        filter.feed(text);
      },
      TextStreamer,
      emit
    );
    const stopping_criteria = new InterruptableStoppingCriteria();
    if (signal) {
      signal.addEventListener("abort", () => stopping_criteria.interrupt(), { once: true });
    }

    // Session cache: prefix-rewind for tool calling (streaming)
    let past_key_values: any = undefined;

    // prefix-rewind trusts cached KV tokens positionally, so a snapshot is
    // only warmed / attached when the fed prompt provably starts with the
    // exact text the stored KV encodes; otherwise generation falls back to a
    // full re-encode of `prompt`, which stays correct.
    const prefixParityOk = prefixPrompt !== undefined && prompt.startsWith(prefixPrompt);

    if (sessionId && !hftSession && prefixParityOk) {
      // Warm the shared region — the fingerprint's tools+systemPrompt block or
      // a checkpoint's re-encoded prefix (worker restarted / state evicted).
      // Never the full prompt: snapshotting this call's user turn would poison
      // the cache for the next caller, whose different turn would be
      // positionally misaligned with the stored KV.
      const { DynamicCache } = await loadTransformersSDK();
      const cache = new DynamicCache();
      const tokenized = generateText.tokenizer(prefixPrompt!);
      await generateText.model.generate({
        ...tokenized,
        max_new_tokens: 0,
        past_key_values: cache,
      });
      hftSession = snapshotHftSession(
        sessionId,
        cache as Record<string, any>,
        modelPath,
        cacheKey,
        prefixPrompt
      );
    }

    if (
      hftSession?.mode === "prefix-rewind" &&
      hftSession.modelPath === modelPath &&
      prefixParityOk &&
      // WebGPU snapshots cannot be shared: the first decode step's update()
      // would dispose the snapshot's gpu-buffer tensors, so skip the attach
      // and re-encode the full prompt instead.
      !hasGpuBufferEntries(hftSession.baseEntries)
    ) {
      // Create a fresh DynamicCache from the prefix snapshot for this call
      const { DynamicCache } = await loadTransformersSDK();
      past_key_values = new DynamicCache(hftSession.baseEntries);
    }

    if (sessionContext?.emitCheckpointId && !past_key_values) {
      // Emitting without a consumable prefix KV (no parent checkpoint, or
      // parity fell back to a full re-encode): attach an empty cache so this
      // turn's KV can still be snapshotted under the emitted checkpoint id.
      const { DynamicCache } = await loadTransformersSDK();
      past_key_values = new DynamicCache();
    }

    try {
      await generateText(prompt, {
        max_new_tokens: input.maxTokens ?? 1024,
        temperature: input.temperature ?? undefined,
        return_full_text: false,
        streamer,
        stopping_criteria: [stopping_criteria],
        ...(past_key_values ? { past_key_values } : {}),
      });
    } finally {
      filter.flush();
    }

    // Parse the accumulated text for tool calls using the model-family-aware parser.
    // For models that use a generation prefix, prepend it so the parser sees the
    // full markup pattern.
    const parseableFullText = responsePrefix ? `${responsePrefix}${fullText}` : fullText;
    // Only the calls are taken: the parser's cleaned text is the same text the
    // markup filter already streamed, and the stream is the one copy.
    const { toolCalls } = adaptParserResult(
      parseToolCalls(parseableFullText, { parser: modelFamily })
    );
    const validToolCalls = filterValidToolCalls(
      normalizeParsedToolCalls(input, toolCalls),
      input.tools
    );

    if (validToolCalls.length > 0) {
      emit({ type: "object-delta", port: "toolCalls", objectDelta: [...validToolCalls] });
    }

    if (sessionContext?.emitCheckpointId && past_key_values) {
      // `fullText` is the raw generated text (pre markup-filter), so
      // prompt + fullText is exactly what the cache encodes.
      snapshotHftSession(
        sessionContext.emitCheckpointId,
        past_key_values,
        modelPath,
        cacheKey,
        prompt + fullText
      );
      if (sessionContext.supersedeParent && sessionId) {
        deleteHftSession(sessionId);
      }
    }

    // The markup filter above already emitted this text as deltas and the
    // tool calls as an object-delta; `TaskRunner` accumulates them. Repeating
    // either here hands the accumulator a second, competing copy.
    emit({
      type: "finish",
      data: { text: "", toolCalls: [] } as ToolCallingTaskOutput,
    });
  });
};
