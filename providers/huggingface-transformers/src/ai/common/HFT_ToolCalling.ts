/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "@workglow/util";
import { getLogger } from "@workglow/util/worker";
import type { LogitsProcessorList, TextGenerationPipeline } from "@huggingface/transformers";
import type { ResponseFormat } from "@huggingface/transformers-structured-output";
import type {
  AiProviderRunFn,
  AiSessionContext,
  ChatMessage,
  CheckpointPrefix,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  ToolDefinition,
} from "@workglow/ai";
import {
  adaptParserResult,
  createThinkTagFilter,
  createToolCallMarkupFilter,
  forcedToolSelection,
  getAvailableParsers,
  getGenerationPrefix,
  parseToolCalls,
  textOnlyToolResult,
} from "@workglow/ai/provider-utils";
import {
  buildToolDescription,
  filterValidToolCalls,
  toTextFlatMessages,
} from "@workglow/ai/worker";
import { renderHftPrefixPrompt, resolveHftParityAnchor } from "./HFT_CacheCheckpoint";
import type { ConstrainedToolCall } from "./HFT_ConstrainedToolCall";
import { resolveConstrainedToolCall } from "./HFT_ConstrainedToolCall";
import type { HfTransformersOnnxModelConfig } from "./HFT_ModelSchema";
import type { HftVisionLanguageModel } from "./HFT_Pipeline";
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
import { hftSamplingOptions } from "./HFT_Sampling";
import { createStreamingTextStreamer } from "./HFT_Streaming";
import { hftTemplateToolCall } from "./HFT_TemplateToolCall";
import {
  buildHftVisionMessages,
  generateHftVision,
  isHftVisionModel,
  promptAsUserMessage,
  renderHftVisionPrompt,
} from "./HFT_VisionLanguage";

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
 * tool calling. A call takes the {@link hftTemplateToolCall} form, which every
 * template renders and a flat `{ name, arguments }` does not. A tool result is text only, an image in it named by
 * {@link textOnlyToolResult}. An assistant turn's reasoning rides as `reasoning_content`,
 * which Qwen3-style templates read to keep the thinking of the current tool
 * loop in the rendered history; templates that do not know it ignore it.
 * A vision-language model, which is handed the images, takes
 * {@link buildHftVisionMessages} instead.
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
  // A tool_result names only the call it answers, so the tool's name is
  // resolved from the tool_use that raised it (most recent id wins).
  const toolNames = new Map<string, string>();
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
          return hftTemplateToolCall(tu.id, tu.name, tu.input);
        });
      for (const call of toolCalls) toolNames.set(call.id, call.function.name);
      const reasoning = msg.content
        .filter((b) => b.type === "reasoning")
        .map((b) => (b as { type: "reasoning"; text: string }).text)
        .join("");
      const entry: Record<string, unknown> = { role: "assistant", content: text };
      if (reasoning.length > 0) entry.reasoning_content = reasoning;
      if (toolCalls.length > 0) entry.tool_calls = toolCalls;
      out.push(entry);
    } else if (msg.role === "tool") {
      for (const b of msg.content) {
        if (b.type !== "tool_result") continue;
        // A chat template takes a tool result as text, so an image the tool
        // returned is named in its place rather than left out without a word.
        const name = toolNames.get(b.tool_use_id);
        out.push({
          role: "tool",
          content: textOnlyToolResult(b.content),
          tool_call_id: b.tool_use_id,
          ...(name !== undefined ? { name } : {}),
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

/**
 * Whether the history needs {@link buildHFTMessages} rather than flat text:
 * tool messages, or an assistant turn carrying reasoning, which only the
 * structured messages hand to the template as `reasoning_content`.
 */
function needsStructuredMessages(input: ToolCallingTaskInput): boolean {
  return (
    hasToolMessages(input) ||
    (input.messages?.some(
      (m) => m.role === "assistant" && m.content.some((b) => b.type === "reasoning" && b.text)
    ) ??
      false)
  );
}

function buildPromptAndPrefix(
  tokenizer: TextGenerationPipeline["tokenizer"],
  input: ToolCallingTaskInput,
  modelFamily: string | null
): { prompt: string; responsePrefix: string | undefined } {
  let basePrompt: string;

  if (needsStructuredMessages(input)) {
    // Multi-turn with tool results or reasoning: use structured messages so the
    // tokenizer can format tool_calls, tool responses and reasoning correctly.
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
    // No tool results and no reasoning: flat messages lose nothing.
    const messages = toTextFlatMessages(input);
    const tools = resolveHFTToolsAndMessages(input, messages);
    basePrompt = tokenizer.apply_chat_template(messages, {
      tools,
      tokenize: false,
      add_generation_prompt: true,
    }) as string;
  }

  const responsePrefix = generationPrefix(input, modelFamily);
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

  const tools = selectCheckpointTools(input, prefix);
  const basePrompt = tokenizer.apply_chat_template(messages as any, {
    ...(tools ? { tools: tools as any } : {}),
    tokenize: false,
    add_generation_prompt: true,
  }) as string;

  const responsePrefix = generationPrefix(input, modelFamily);
  return {
    prompt: responsePrefix ? `${basePrompt}${responsePrefix}` : basePrompt,
    responsePrefix,
  };
}

/**
 * The tools a checkpoint consumer renders: the prefix's, which the warm-up
 * rendered, unless the call narrows to one tool by name.
 */
function selectCheckpointTools(
  input: ToolCallingTaskInput,
  prefix: CheckpointPrefix
): ReturnType<typeof mapHFTTools> | undefined {
  if (input.toolChoice === "none") return undefined;
  if (
    typeof input.toolChoice === "string" &&
    input.toolChoice !== "auto" &&
    input.toolChoice !== "required"
  ) {
    const selected = (input.tools ?? []).filter((t: ToolDefinition) => t.name === input.toolChoice);
    const source = selected.length > 0 ? selected : (prefix.tools ?? input.tools);
    return source && source.length > 0 ? mapHFTTools(source) : undefined;
  }
  const source = prefix.tools && prefix.tools.length > 0 ? prefix.tools : input.tools;
  return source && source.length > 0 ? mapHFTTools(source) : undefined;
}

/**
 * The markup a model family's tool call opens with, appended to the prompt so
 * a forced call starts already inside it. None after tool results, where the
 * model is as likely to answer as to call again.
 */
function generationPrefix(
  input: ToolCallingTaskInput,
  modelFamily: string | null
): string | undefined {
  return input.toolChoice === "none" || hasToolMessages(input)
    ? undefined
    : getGenerationPrefix(modelFamily, forcedToolSelection(input));
}

// ============================================================================
// Streamed delta routing
// ============================================================================

/**
 * Routes decoded deltas to the ports: `<think>` content goes to `reasoning`,
 * and what remains goes through the `<tool_call>` markup filter to `text`.
 * Thinking is separated first, so a tool-call tag quoted inside it is not
 * mistaken for markup and neither is it recorded as the answer.
 *
 * `answerText` is the text-port content before the markup filter — what the
 * tool-call parser must read, without the model's thinking.
 */
export function createHftDeltaRouter(
  emit: (event: { type: "text-delta"; port: "text" | "reasoning"; textDelta: string }) => void,
  startInside: boolean
): {
  readonly feed: (delta: string) => void;
  readonly flush: () => void;
  readonly answerText: () => string;
} {
  let answer = "";
  const markup = createToolCallMarkupFilter((text) => {
    emit({ type: "text-delta", port: "text", textDelta: text });
  });
  const think = createThinkTagFilter({ startInside });
  const route = (parts: ReturnType<typeof think.push>): void => {
    for (const part of parts) {
      if (part.port === "reasoning") {
        emit({ type: "text-delta", port: "reasoning", textDelta: part.text });
      } else {
        answer += part.text;
        markup.feed(part.text);
      }
    }
  };
  return {
    feed: (delta) => route(think.push(delta)),
    flush: () => {
      route(think.flush());
      markup.flush();
    },
    answerText: () => answer,
  };
}

/**
 * Parse the answer text for tool calls with the model-family-aware parser and
 * emit the valid ones. A generation prefix is prepended so the parser sees the
 * full markup it opened. Only the calls are taken: the parser's cleaned text is
 * the same text the markup filter already streamed, and the stream is the one
 * copy. The answer text excludes thinking — a call quoted inside it was never
 * made.
 */
function emitParsedToolCalls(
  input: ToolCallingTaskInput,
  answerText: string,
  responsePrefix: string | undefined,
  modelFamily: string | null,
  tools: ReadonlyArray<ToolDefinition>,
  emit: (event: {
    type: "object-delta";
    port: "toolCalls";
    objectDelta: ToolCallingTaskOutput["toolCalls"];
  }) => void
): void {
  const parseableFullText = responsePrefix ? `${responsePrefix}${answerText}` : answerText;
  const { toolCalls } = adaptParserResult(
    parseToolCalls(parseableFullText, { parser: modelFamily })
  );
  const validToolCalls = filterValidToolCalls(normalizeParsedToolCalls(input, toolCalls), tools);
  if (validToolCalls.length > 0) {
    emit({ type: "object-delta", port: "toolCalls", objectDelta: [...validToolCalls] });
  }
}

/**
 * The tools a parsed call may name. A checkpoint turn may name a tool only its
 * prefix holds: the prompt (and, on a text model, the constraint) both list
 * that one, so a call to it is a valid call.
 */
function allowedTools(
  input: ToolCallingTaskInput,
  sessionContext: AiSessionContext | undefined
): ReadonlyArray<ToolDefinition> {
  const prefixTools = sessionContext?.prefix?.tools ?? [];
  return [
    ...(input.tools ?? []),
    ...prefixTools.filter((tool) => !input.tools?.some((own) => own.name === tool.name)),
  ];
}

// ============================================================================
// Vision-language models
// ============================================================================

/**
 * One tool-calling round on a vision-language model: the same markup, parser,
 * delta routing and sampling as a text model, with the conversation's images
 * handed to the processor ({@link buildHftVisionMessages} says where each
 * goes).
 *
 * No KV session is read or written. A checkpoint's prefix is rendered in full
 * every round instead, and an emitted checkpoint stores nothing here: its
 * registry entry carries the prefix, which the next round renders the same way.
 */
async function runVisionToolCalling(
  input: ToolCallingTaskInput,
  model: HfTransformersOnnxModelConfig,
  signal: AbortSignal | undefined,
  emit: Parameters<typeof HFT_ToolCalling>[3],
  sessionContext: AiSessionContext | undefined
): Promise<void> {
  const vlm = (await getPipeline(model, emit, {}, signal)) as HftVisionLanguageModel;
  const modelFamily = detectModelFamilyFromConfig(model);
  const prefix = sessionContext?.prefix;

  let conversation: ReturnType<typeof buildHftVisionMessages>;
  let tools: ReturnType<typeof mapHFTTools> | undefined;
  if (prefix) {
    const fromPrompt = promptAsUserMessage(input.prompt);
    const tail: ReadonlyArray<ChatMessage> =
      input.messages && input.messages.length > 0 ? input.messages : fromPrompt ? [fromPrompt] : [];
    conversation = buildHftVisionMessages(
      [...(prefix.messages ?? []), ...tail],
      input.systemPrompt || prefix.systemPrompt,
      undefined,
      input.toolChoice
    );
    tools = selectCheckpointTools(input, prefix);
  } else {
    conversation = buildHftVisionMessages(
      input.messages,
      input.systemPrompt,
      input.prompt,
      input.toolChoice
    );
    tools = selectHFTTools(input);
  }

  const responsePrefix = generationPrefix(input, modelFamily);
  const basePrompt = renderHftVisionPrompt(vlm, conversation.messages, tools);
  const prompt = responsePrefix ? `${basePrompt}${responsePrefix}` : basePrompt;

  const filter = createHftDeltaRouter((event) => emit(event), prompt.trimEnd().endsWith("<think>"));
  try {
    await generateHftVision({
      vlm,
      prompt,
      images: conversation.images,
      maxNewTokens: input.maxTokens ?? 1024,
      sampling: hftSamplingOptions(input.temperature, "model-default"),
      onText: (text) => filter.feed(text),
      emit,
      signal,
    });
  } finally {
    filter.flush();
  }

  emitParsedToolCalls(
    input,
    filter.answerText(),
    responsePrefix,
    modelFamily,
    allowedTools(input, sessionContext),
    emit
  );
  emit({ type: "finish", data: { text: "", toolCalls: [] } as ToolCallingTaskOutput });
}

// ============================================================================
// Provider run functions
// ============================================================================

/** A forced-call constraint paired with the logits processor that enforces it. */
interface ToolCallGrammar {
  readonly constraint: ConstrainedToolCall;
  readonly processor: LogitsProcessorList;
}

export const HFT_ToolCalling: AiProviderRunFn<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  HfTransformersOnnxModelConfig
> = async (input, model, signal, emit, _outputSchema, sessionContext) => {
  if (isHftVisionModel(model!)) {
    await withHftPipelineInUse(getPipelineCacheKey(model!), () =>
      runVisionToolCalling(input, model!, signal, emit, sessionContext)
    );
    return;
  }
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

    // A turn that must end in one call is decoded under a grammar when the
    // family's call format allows it. A schema the engine rejects (it refuses
    // `pattern` and most `format`s, which cannot be enforced incrementally)
    // leaves the turn unconstrained, as it was before. A generation prefix has
    // already opened the call itself, so there is no body left to constrain.
    const constrained =
      promptParts.responsePrefix === undefined
        ? resolveConstrainedToolCall(
            input,
            modelFamily,
            getModelTextCandidates(model!),
            promptParts.prompt,
            sessionContext?.prefix
          )
        : undefined;
    let grammar: ToolCallGrammar | undefined;
    if (constrained) {
      try {
        const { StructuredOutputProcessor } =
          await import("@huggingface/transformers-structured-output");
        grammar = {
          constraint: constrained,
          processor: new StructuredOutputProcessor(generateText.tokenizer, {
            type: "json_schema",
            json_schema: constrained.schema,
          } as Extract<ResponseFormat, { type: "json_schema" }>),
        };
      } catch (error) {
        getLogger().debug("HFT_ToolCalling: tool-call grammar not applied", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Usage snapshots replace one another downstream, and each decode starts its
    // own count. A retry adds what the failed attempt had reported, so the
    // totals a budget reads only grow, and the prompt it read twice is counted
    // twice.
    let carried = { input: 0, output: 0 };
    let reported = { input: 0, output: 0 };
    const emitCounted = (event: Parameters<typeof emit>[0]): void => {
      if (event.type !== "usage") {
        emit(event);
        return;
      }
      const { input: seen, output: made } = event.usage;
      const usage = {
        ...event.usage,
        input: seen === undefined ? undefined : seen + carried.input,
        output: made === undefined ? undefined : made + carried.output,
      };
      reported = { input: usage.input ?? reported.input, output: usage.output ?? reported.output };
      emit({ ...event, usage });
    };

    // One decode of the turn, under `grammar` or free. Everything a decode
    // touches is built here, so a second attempt starts from nothing: a failed
    // one leaves its streamer, its text and its KV cache half-written.
    const decode = async (
      active: ToolCallGrammar | undefined
    ): Promise<{
      readonly prompt: string;
      readonly responsePrefix: string | undefined;
      readonly fullText: string;
      readonly answerText: string;
      readonly past_key_values: any;
    }> => {
      const prompt = active
        ? `${promptParts.prompt}${active.constraint.prefix}`
        : promptParts.prompt;
      const responsePrefix = active ? active.constraint.prefix : promptParts.responsePrefix;

      // Accumulate raw tokens (the KV cache encodes them verbatim), and route
      // each delta: thinking to `reasoning`, the rest through the tool-call
      // markup filter to `text`. A template that opens `<think>` in the prompt
      // leaves the generation starting inside the block.
      let fullText = "";
      const filter = createHftDeltaRouter(
        (event) => emit(event),
        prompt.trimEnd().endsWith("<think>")
      );

      const streamer = createStreamingTextStreamer(
        generateText.tokenizer,
        (text) => {
          fullText += text;
          // A constrained body is the call itself, with no tags around it for the
          // markup filter to hide, so none of it is the assistant's text.
          if (!active) filter.feed(text);
        },
        TextStreamer,
        emitCounted
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
          // As for a chat turn, an unset temperature defers to the model's config.
          ...hftSamplingOptions(input.temperature, "model-default"),
          return_full_text: false,
          streamer,
          stopping_criteria: [stopping_criteria],
          ...(active ? { logits_processor: active.processor } : {}),
          ...(past_key_values ? { past_key_values } : {}),
        });
      } catch (error) {
        // A generate() that threw never reached its own end(), which is where the
        // throttled tail of the usage count is flushed; the retry carries it.
        streamer.end();
        throw error;
      } finally {
        filter.flush();
      }

      // Thinking is left out: a call quoted inside it was never made.
      const answerText = active ? `${fullText}${active.constraint.suffix}` : filter.answerText();
      return { prompt, responsePrefix, fullText, answerText, past_key_values };
    };

    // A grammar that cannot finish (the engine reaches a dead end, or its EOS is
    // not the model's) must not turn a call that decoded freely before into a
    // failed turn. Nothing of a constrained attempt reached the text ports, so
    // the free attempt starts clean.
    let turn: Awaited<ReturnType<typeof decode>>;
    try {
      turn = await decode(grammar);
    } catch (error) {
      if (!grammar || signal?.aborted) throw error;
      getLogger().warn("HFT_ToolCalling: constrained decoding failed; decoding without it", {
        error: error instanceof Error ? error.message : String(error),
      });
      carried = reported;
      turn = await decode(undefined);
    }
    const { prompt, responsePrefix, fullText, answerText, past_key_values } = turn;

    emitParsedToolCalls(
      input,
      answerText,
      responsePrefix,
      modelFamily,
      allowedTools(input, sessionContext),
      emit
    );

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
