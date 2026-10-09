/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared message conversion utilities for converting provider-agnostic
 * ChatMessage arrays to provider-specific formats.
 *
 * These are pure functions safe for both main-thread and worker contexts.
 * Providers with unique requirements (Anthropic, Gemini, LlamaCpp)
 * maintain their own conversion logic.
 */

import { asText } from "@workglow/util";
import type { ChatMessage, ContentBlock } from "./ChatMessage";
import type { ToolCallingTaskInput } from "./ToolCallingTask";

/**
 * Lifts a task `prompt` (string or block array) into a user-message tail for
 * checkpoint replay. An absent/empty prompt yields no tail message — the
 * shared message builders fall back to `prompt` only when the message list is
 * empty, and a checkpoint consumer with no tail must not append an empty turn.
 */
export function promptToTailMessages(prompt: unknown): ChatMessage[] {
  if (prompt === undefined || prompt === "") return [];
  if (typeof prompt === "string") {
    return [{ role: "user", content: [{ type: "text", text: prompt }] }];
  }
  if (Array.isArray(prompt)) {
    const blocks = prompt.map((p): ContentBlock => {
      if (typeof p === "string") return { type: "text", text: p };
      return p as ContentBlock;
    });
    return [{ role: "user", content: blocks }];
  }
  return [{ role: "user", content: [{ type: "text", text: asText(prompt) }] }];
}

function getInputMessages(input: ToolCallingTaskInput): ReadonlyArray<ChatMessage> | undefined {
  const messages = input.messages;
  if (!messages || messages.length === 0) return undefined;
  return messages;
}

export interface OpenAICompatMessage {
  role: string;
  content: string | null | Array<{ type: string; [key: string]: unknown }>;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  /** An assistant turn's reasoning, under the name the provider reads it back by. */
  reasoning_content?: string;
  /** The provider's own output items for this turn, for the Responses converter to replay. */
  native_items?: unknown[];
}

export interface OpenAIMessageOptions {
  /**
   * Send each assistant turn's reasoning back as `reasoning_content`. DeepSeek's
   * thinking models read it on the turns of a tool-calling loop; other
   * OpenAI-compatible APIs do not know the field, so it is opt-in and reasoning
   * blocks are otherwise dropped.
   */
  readonly replayReasoning?: boolean | undefined;
  /**
   * Chat-completions accepts only text in a `tool` message. With this set, the
   * images a turn's tools returned are sent in one user message after that
   * turn's tool results, and each tool message says an image follows. Without
   * it they stay inline in the tool message, for APIs that accept that.
   */
  readonly toolImagesInUserMessage?: boolean | undefined;
  /**
   * Attach an assistant turn's native items (`native_items`) when its reasoning
   * block was produced by this provider, for the Responses converter to replay.
   */
  readonly nativeTurnProvider?: string | undefined;
}

/**
 * Converts ToolCallingTaskInput to OpenAI-compatible message format.
 * Used by OpenAI and HuggingFace Inference providers.
 *
 * Multi-turn capable: preserves full tool call metadata across turns.
 */
export function toOpenAIMessages(
  input: ToolCallingTaskInput,
  options: OpenAIMessageOptions = {}
): OpenAICompatMessage[] {
  const messages: OpenAICompatMessage[] = [];

  if (input.systemPrompt) {
    messages.push({ role: "system", content: input.systemPrompt });
  }

  const inputMessages = getInputMessages(input);
  if (!inputMessages) {
    if (!Array.isArray(input.prompt)) {
      messages.push({ role: "user", content: input.prompt });
    } else if (input.prompt.every((item) => typeof item === "string")) {
      messages.push({ role: "user", content: (input.prompt as string[]).join("\n") });
    } else {
      const parts: Array<{ type: string; [key: string]: unknown }> = [];
      for (const item of input.prompt) {
        if (typeof item === "string") {
          parts.push({ type: "text", text: item });
        } else {
          const b = item as Record<string, unknown>;
          if (b.type === "text") {
            parts.push({ type: "text", text: b.text as string });
          } else if (b.type === "image") {
            parts.push({
              type: "image_url",
              image_url: { url: `data:${String(b.mimeType)};base64,${String(b.data)}` },
            });
          } else if (b.type === "audio") {
            const format = (b.mimeType as string).replace(/^audio\//, "");
            parts.push({
              type: "input_audio",
              input_audio: { data: b.data as string, format },
            });
          }
        }
      }
      messages.push({ role: "user", content: parts });
    }
    return messages;
  }

  for (const msg of inputMessages) {
    if (msg.role === "user") {
      const parts: Array<{ type: string; [key: string]: unknown }> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          parts.push({ type: "text", text: block.text });
        } else if (block.type === "image") {
          parts.push({
            type: "image_url",
            image_url: { url: `data:${block.mimeType};base64,${block.data}` },
          });
        }
        // tool_use / tool_result not valid in a user message — skip
      }
      messages.push({ role: "user", content: parts });
    } else if (msg.role === "assistant") {
      const textParts = msg.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      const toolCalls = msg.content
        .filter((b): b is Extract<ContentBlock, { type: "tool_use" }> => b.type === "tool_use")
        .map((b) => ({
          id: b.id,
          type: "function" as const,
          function: {
            name: b.name,
            arguments: JSON.stringify(b.input),
          },
        }));
      const entry: OpenAICompatMessage = {
        role: "assistant",
        // A turn with neither text nor calls (the model only reasoned) still needs a
        // content string: chat-completions APIs reject `null` without `tool_calls`.
        content: textParts.length > 0 ? textParts : toolCalls.length > 0 ? null : "",
      };
      if (toolCalls.length > 0) {
        entry.tool_calls = toolCalls;
      }
      if (options.replayReasoning) {
        // Sent even when empty: DeepSeek returns an empty reasoning on some
        // turns and still expects the field on every assistant turn it reads.
        entry.reasoning_content = msg.content
          .filter((b): b is Extract<ContentBlock, { type: "reasoning" }> => b.type === "reasoning")
          .map((b) => b.text)
          .join("");
      }
      if (options.nativeTurnProvider !== undefined) {
        const own = msg.content.find(
          (b): b is Extract<ContentBlock, { type: "reasoning" }> =>
            b.type === "reasoning" &&
            b.provider === options.nativeTurnProvider &&
            b.payload !== undefined
        );
        if (own) {
          try {
            const items = JSON.parse(own.payload!) as unknown;
            if (Array.isArray(items)) entry.native_items = items;
          } catch {
            // A payload this provider cannot read is not replayed; the turn is rebuilt.
          }
        }
      }
      messages.push(entry);
    } else if (msg.role === "tool") {
      const deferredImages: Array<{ type: string; [key: string]: unknown }> = [];
      for (const block of msg.content) {
        if (block.type !== "tool_result") continue;
        let content: string | Array<{ type: string; [key: string]: unknown }>;
        const onlyText = block.content.every((inner) => inner.type === "text");
        if (onlyText) {
          // Several text blocks, or none, still become one string: some chat-completions
          // APIs reject a parts array in a tool message.
          content = block.content.map((inner) => (inner as { text: string }).text).join("\n");
        } else if (options.toolImagesInUserMessage) {
          const text = block.content
            .filter((inner) => inner.type === "text")
            .map((inner) => (inner as { text: string }).text)
            .join("\n");
          const images = block.content.filter(
            (inner): inner is Extract<typeof inner, { type: "image" }> => inner.type === "image"
          );
          for (const image of images) {
            deferredImages.push({
              type: "image_url",
              image_url: { url: `data:${image.mimeType};base64,${image.data}` },
            });
          }
          const note =
            images.length > 0
              ? `[${images.length} image(s) from this result follow in the next message]`
              : "";
          content = [text, note].filter((part) => part.length > 0).join("\n");
        } else {
          const parts: Array<{ type: string; [key: string]: unknown }> = [];
          for (const inner of block.content) {
            if (inner.type === "text") {
              parts.push({ type: "text", text: inner.text });
            } else if (inner.type === "image") {
              parts.push({
                type: "image_url",
                image_url: { url: `data:${inner.mimeType};base64,${inner.data}` },
              });
            }
          }
          content = parts;
        }
        messages.push({ role: "tool", content, tool_call_id: block.tool_use_id });
      }
      if (deferredImages.length > 0) {
        messages.push({
          role: "user",
          content: [
            { type: "text", text: "Images returned by the tool calls above:" },
            ...deferredImages,
          ],
        });
      }
    }
  }

  return messages;
}

/** A message whose content is either workglow content blocks or a bare string. */
export interface LooseChatMessage {
  readonly role: string;
  readonly content: string | ReadonlyArray<ContentBlock>;
}

/**
 * Chat history as content blocks, accepting the bare-string `content` that
 * text-generation callers have always been allowed to pass. A provider runs
 * this before its converter, so a string message and a block message reach the
 * wire the same way instead of the array being forwarded unconverted.
 */
export function normalizeChatMessages(messages: ReadonlyArray<LooseChatMessage>): ChatMessage[] {
  return messages.map((message) => ({
    role: message.role as ChatMessage["role"],
    content:
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content,
  }));
}

/**
 * Moves system-role messages out of a history and into the system prompt. The
 * converters take the system prompt as its own input and skip system turns in
 * `messages`, so a caller that put its instructions in the history would
 * otherwise lose them.
 */
export function liftSystemMessages(
  history: ReadonlyArray<ChatMessage>,
  systemPrompt: string | undefined
): { readonly messages: ChatMessage[]; readonly systemPrompt: string | undefined } {
  const lifted = history
    .filter((message) => message.role === "system")
    .map((message) =>
      message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("")
    )
    .filter((text) => text.length > 0);
  const parts = [systemPrompt, ...lifted].filter((text): text is string => !!text);
  return {
    messages: history.filter((message) => message.role !== "system"),
    systemPrompt: parts.length > 0 ? parts.join("\n\n") : undefined,
  };
}

export interface TextFlatMessage {
  role: string;
  content: string;
}

/**
 * Converts ToolCallingTaskInput to a simplified text-only message format.
 * Used for single-turn prompts by providers whose template takes only role and
 * text. A tool-calling loop must not use it:
 *
 * NOTE: This format discards tool_use blocks from assistant messages.
 * The LLM will not see what tools it previously called. Multi-turn tool
 * calling will have degraded quality on these providers.
 */
export function toTextFlatMessages(input: ToolCallingTaskInput): TextFlatMessage[] {
  const messages: TextFlatMessage[] = [];

  if (input.systemPrompt) {
    messages.push({ role: "system", content: input.systemPrompt });
  }

  const inputMessages = getInputMessages(input);
  if (!inputMessages) {
    let promptContent: string;
    if (!Array.isArray(input.prompt)) {
      promptContent = input.prompt;
    } else {
      // Extract text content only; media blocks are dropped in text-flat format
      promptContent = input.prompt
        .map((item) => {
          if (typeof item === "string") return item;
          const b = item as Record<string, unknown>;
          return b.type === "text" ? (b.text as string) : "";
        })
        .filter((s) => s !== "")
        .join("\n");
    }
    messages.push({ role: "user", content: promptContent });
    return messages;
  }

  for (const msg of inputMessages) {
    if (msg.role === "user") {
      // Extract only text blocks; media blocks are dropped in text-flat format
      const content = msg.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      messages.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      const text = msg.content
        .filter((b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) {
        messages.push({ role: "assistant", content: text });
      }
    } else if (msg.role === "tool") {
      for (const block of msg.content) {
        if (block.type !== "tool_result") continue;
        // Extract only text blocks from multi-part tool results
        const content = block.content
          .filter(
            (inner): inner is Extract<ContentBlock, { type: "text" }> => inner.type === "text"
          )
          .map((inner) => inner.text)
          .join("");
        messages.push({ role: "tool", content });
      }
    }
  }

  return messages;
}
