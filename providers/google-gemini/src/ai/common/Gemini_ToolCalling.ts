/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { FunctionCallingConfigMode } from "@google/genai";
import type {
  AiProviderRunFn,
  ChatMessage,
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
} from "@workglow/ai";
import { createUsageSnapshotEmitter } from "@workglow/ai/provider-utils";
import { filterValidToolCalls, sanitizeToolArgs } from "@workglow/ai/worker";
import { coerceGeminiToolArgs } from "./Gemini_Schema";
import {
  buildGeminiFunctionDeclarations,
  buildGeminiPrefixedContents,
  geminiCachedToolsMatch,
  geminiCachedToolsMatchCanonical,
} from "./Gemini_CacheCheckpoint";
import { generateGeminiStreamWithCacheFallback } from "./Gemini_CachedContentFallback";
import { evictIfStaleGeminiCachedContent, getGeminiCachedContent } from "./Gemini_CacheStore";
import {
  createGeminiClient,
  getGeminiSeed,
  getModelName,
  resolveThinkingConfig,
} from "./Gemini_Client";
import type { GeminiModelConfig } from "./Gemini_ModelSchema";
import { emitGeminiRefusal, geminiRefusalCategory } from "./Gemini_Refusal";
import { mapGeminiUsage } from "./Gemini_Usage";

export function buildGeminiContents(
  messages: ReadonlyArray<ChatMessage> | undefined,
  prompt: unknown
): any[] {
  if (!messages || messages.length === 0) {
    return [{ role: "user", parts: [{ text: prompt }] }];
  }

  // Resolve tool_use id → name for the functionResponse (Gemini wants the
  // function name there, not just the id). Built during the single ordered pass
  // rather than up front: the provider assigns ids per run starting at `call_0`,
  // so ids collide across turns. Updating the map as each assistant turn is
  // processed makes every tool_result resolve against the most-recent preceding
  // tool_use with that id — the call it actually answers — instead of a global
  // last-write-wins that would mislabel earlier turns.
  const toolUseNames = new Map<string, string>();

  const contents: any[] = [];
  for (const msg of messages) {
    if (msg.role === "user") {
      const parts: any[] = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ text: block.text });
        } else if (block.type === "image") {
          parts.push({ inlineData: { mimeType: block.mimeType, data: block.data } });
        }
      }
      contents.push({ role: "user", parts });
    } else if (msg.role === "assistant") {
      const parts: any[] = [];
      for (const block of msg.content) {
        if (block.type === "text" && block.text) {
          parts.push({ text: block.text });
        } else if (block.type === "tool_use") {
          toolUseNames.set(block.id, block.name);
          // Thinking models (Gemini 2.5+/3.x) return an opaque `thoughtSignature`
          // alongside each functionCall part. It MUST be echoed back verbatim on
          // the same part in later turns or the API rejects the request with
          // "Function call is missing a thought_signature".
          const part: Record<string, unknown> = {
            functionCall: { name: block.name, args: block.input },
          };
          if (block.providerSignature) {
            part.thoughtSignature = block.providerSignature;
          }
          parts.push(part);
        }
      }
      if (parts.length > 0) contents.push({ role: "model", parts });
    } else if (msg.role === "tool") {
      const parts: any[] = [];
      for (const block of msg.content) {
        if (block.type !== "tool_result") continue;
        const name = toolUseNames.get(block.tool_use_id) ?? "unknown";
        const text = block.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { type: "text"; text: string }).text)
          .join("");
        const images = block.content.filter(
          (b): b is Extract<typeof b, { type: "image" }> => b.type === "image"
        );
        let response: Record<string, unknown>;
        if (block.is_error) {
          response = { error: text };
        } else {
          let parsed: unknown = text;
          try {
            parsed = JSON.parse(text);
          } catch {
            // Not JSON: sent as the text it is.
          }
          // `response` must be an object; a scalar, array or null result is wrapped.
          response =
            parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
              ? (parsed as Record<string, unknown>)
              : { result: parsed };
        }
        const functionResponse: Record<string, unknown> = { name, response };
        if (images.length > 0) {
          functionResponse.parts = images.map((image) => ({
            inlineData: { mimeType: image.mimeType, data: image.data },
          }));
        }
        parts.push({ functionResponse });
      }
      if (parts.length > 0) contents.push({ role: "user", parts });
    }
  }
  return contents;
}

function mapGeminiToolConfig(
  toolChoice: string | undefined
):
  | { functionCallingConfig: { mode: FunctionCallingConfigMode; allowedFunctionNames?: string[] } }
  | undefined {
  if (!toolChoice || toolChoice === "auto") {
    return { functionCallingConfig: { mode: "AUTO" as FunctionCallingConfigMode } };
  }
  if (toolChoice === "none") {
    return { functionCallingConfig: { mode: "NONE" as FunctionCallingConfigMode } };
  }
  if (toolChoice === "required") {
    return { functionCallingConfig: { mode: "ANY" as FunctionCallingConfigMode } };
  }
  return {
    functionCallingConfig: {
      mode: "ANY" as FunctionCallingConfigMode,
      allowedFunctionNames: [toolChoice],
    },
  };
}

export const Gemini_ToolCalling_Stream: AiProviderRunFn<
  ToolCallingTaskInput,
  ToolCallingTaskOutput,
  GeminiModelConfig
> = async (input, model, signal, emit, _outputSchema, sessionContext) => {
  const ai = await createGeminiClient(model);

  const functionDeclarations = buildGeminiFunctionDeclarations(input.tools);

  const toolConfig = mapGeminiToolConfig(input.toolChoice);

  // Checkpoint consumption. Preferred path: reference the warm-up's explicit
  // CachedContent (which carries the warmed systemInstruction + tool
  // declarations) and send only the tail. The API rejects requests that set
  // systemInstruction / tools / toolConfig alongside cachedContent, so the
  // handle is only usable when this call adds none of those beyond what the
  // cache holds: no own system prompt (or the cache's own), and a default
  // ("auto") tool choice. Anything else — including after the cache's TTL
  // expiry — replays the prefix content inline; implicit caching still applies.
  const prefix = sessionContext?.prefix;
  const checkpointId = sessionContext?.sessionId;
  const cachedEntry = checkpointId ? getGeminiCachedContent(checkpointId) : undefined;
  const defaultToolChoice = input.toolChoice === undefined || input.toolChoice === "auto";
  let useCachedContent =
    prefix !== undefined &&
    cachedEntry !== undefined &&
    defaultToolChoice &&
    prefix.tools !== undefined &&
    prefix.tools.length > 0 &&
    (input.systemPrompt === undefined ||
      input.systemPrompt === "" ||
      input.systemPrompt === cachedEntry.systemPrompt);

  // Proactive stale eviction — drop a nearly-expired runtime-local entry up
  // front and replay inline instead of eating a reactive NOT_FOUND. Runs
  // before the tools comparison below so a doomed entry never pays for it.
  if (
    useCachedContent &&
    cachedEntry &&
    checkpointId &&
    evictIfStaleGeminiCachedContent(checkpointId, cachedEntry)
  ) {
    useCachedContent = false;
  }

  // Tools comparison last — it recursively canonicalizes the declarations, so
  // the cheap eligibility checks (and the stale eviction) must not pay for it.
  // The prefix side was canonicalized once at cache creation; an entry seeded
  // without `canonicalTools` falls back to canonicalizing both sides.
  if (useCachedContent && prefix?.tools !== undefined && cachedEntry !== undefined) {
    useCachedContent =
      cachedEntry.canonicalTools !== undefined
        ? geminiCachedToolsMatchCanonical(cachedEntry.canonicalTools, input.tools)
        : geminiCachedToolsMatch(prefix.tools, input.tools);
  }

  // Thinking is opt-in here (no default budget): the model uses its own default
  // reasoning unless `provider_config.thinking_budget` is set, in which case the
  // output cap is padded so reasoning can't starve the tool call / answer.
  const { thinkingConfig, maxOutputTokens } = resolveThinkingConfig(
    model,
    input.maxTokens,
    undefined,
    { includeThoughts: true }
  );

  /** Build the tail-only request that references the CachedContent handle. */
  const buildCachedRequest = (): Record<string, unknown> => ({
    model: getModelName(model),
    contents: buildGeminiContents(input.messages, input.prompt),
    config: {
      abortSignal: signal ?? undefined,
      systemInstruction: undefined,
      maxOutputTokens,
      temperature: input.temperature,
      seed: getGeminiSeed(model),
      cachedContent: cachedEntry!.name,
      thinkingConfig,
    },
  });

  /** Build the full inline-replay request (prefix messages + tail + tools). */
  const buildInlineReplayRequest = (): Record<string, unknown> => {
    const contents = prefix
      ? buildGeminiPrefixedContents(prefix, input.messages, input.prompt)
      : buildGeminiContents(input.messages, input.prompt);
    const systemInstruction = input.systemPrompt || (prefix ? prefix.systemPrompt : undefined);
    return {
      model: getModelName(model),
      contents,
      config: {
        abortSignal: signal ?? undefined,
        systemInstruction,
        maxOutputTokens,
        temperature: input.temperature,
        seed: getGeminiSeed(model),
        tools: [{ functionDeclarations }],
        toolConfig: toolConfig as any,
        thinkingConfig,
      },
    };
  };

  const result = await generateGeminiStreamWithCacheFallback({
    useCachedContent,
    checkpointId,
    buildRequest: (useCached) => (useCached ? buildCachedRequest() : buildInlineReplayRequest()),
    runStream: (request) =>
      ai.models.generateContentStream(
        request as unknown as Parameters<typeof ai.models.generateContentStream>[0]
      ),
  });

  let callIndex = 0;
  let refusalCategory: string | undefined;
  let lastUsageMetadata: unknown;
  const snapshotUsage = createUsageSnapshotEmitter(emit);

  for await (const chunk of result) {
    lastUsageMetadata = chunk.usageMetadata ?? lastUsageMetadata;
    snapshotUsage(mapGeminiUsage(lastUsageMetadata));
    refusalCategory = refusalCategory ?? geminiRefusalCategory(chunk);
    const parts = chunk.candidates?.[0]?.content?.parts ?? [];
    for (const part of parts) {
      if (part.text && part.thought) {
        emit({ type: "text-delta", port: "reasoning", textDelta: part.text });
      } else if (part.text) {
        emit({ type: "text-delta", port: "text", textDelta: part.text });
      }
      if (part.functionCall) {
        const id = `call_${callIndex++}`;
        const toolName = part.functionCall.name ?? "";
        const rawArgs = (part.functionCall.args as Record<string, unknown>) ?? {};
        // The wire schema stringifies non-string enums for Gemini (see
        // sanitizeSchemaForGemini), so map values back to the original tool
        // schema types before validation/dispatch. Upstream never sees the
        // stringified form.
        const coercedArgs = coerceGeminiToolArgs(
          toolName,
          sanitizeToolArgs(rawArgs) as Record<string, unknown>,
          input.tools
        );
        // Defence-in-depth: drop tool calls whose name isn't in the
        // declared tool set before emitting. Gemini's tool API respects
        // `input.tools` but a stray response that hallucinates a function
        // name would otherwise propagate to dispatch.
        const validated = filterValidToolCalls(
          [
            {
              id,
              name: toolName,
              input: coercedArgs,
              // Carry the opaque thinking-model signature so the consumer can
              // replay it on the next turn (see buildGeminiContents).
              ...(part.thoughtSignature ? { providerSignature: part.thoughtSignature } : {}),
            },
          ],
          input.tools
        );
        if (validated.length > 0) {
          emit({
            type: "object-delta",
            port: "toolCalls",
            objectDelta: validated,
          });
        }
      }
    }
  }

  emitGeminiRefusal(emit, refusalCategory);
  emit({
    type: "finish",
    data: { text: "", toolCalls: [] } as ToolCallingTaskOutput,
    usage: mapGeminiUsage(lastUsageMetadata),
  });
};
