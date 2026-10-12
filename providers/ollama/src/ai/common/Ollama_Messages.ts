/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallingTaskInput } from "@workglow/ai";
import { liftSystemMessages } from "@workglow/ai/worker";
import { PermanentJobError } from "@workglow/job-queue";

/**
 * One message on Ollama's `/api/chat`. `tool_calls` carry no ids — Ollama pairs
 * a result to its call by `tool_name` on the `tool` message instead.
 */
export interface OllamaChatMessage {
  readonly role: string;
  readonly content: string;
  readonly thinking?: string;
  readonly images?: readonly string[];
  readonly tool_calls?: ReadonlyArray<{
    readonly function: {
      readonly name: string;
      readonly arguments: Record<string, unknown>;
    };
  }>;
  readonly tool_name?: string;
}

interface TextOrImage {
  readonly type: string;
  readonly text?: unknown;
  readonly data?: unknown;
}

/**
 * Splits text/image blocks into the joined text and the base64 image list. With
 * `keepOther`, any other block (data a tool returned) is kept as JSON text.
 * With `markImagesAfter`, each image leaves a numbered marker where it stood,
 * counting on from that many images already set aside, so text around an image
 * still points at it once the image itself has moved to a later message.
 * Audio is refused wherever it appears.
 */
function flattenBlocks(
  blocks: ReadonlyArray<TextOrImage>,
  separator: string,
  keepOther = false,
  markImagesAfter?: number
): { readonly text: string; readonly images: string[] } {
  const texts: string[] = [];
  const images: string[] = [];
  for (const block of blocks) {
    if (block.type === "audio") {
      // Ollama's chat API has no audio field, and sending the turn without it
      // would have the model answer as if it had heard nothing.
      throw new PermanentJobError("Ollama's chat API does not accept audio input.");
    }
    if (block.type === "text" && typeof block.text === "string") {
      texts.push(block.text);
    } else if (block.type === "image" && typeof block.data === "string") {
      images.push(block.data);
      if (markImagesAfter !== undefined) {
        texts.push(`[image ${markImagesAfter + images.length}] follows in the next message`);
      }
    } else if (keepOther && block.type !== "text" && block.type !== "image") {
      texts.push(JSON.stringify(block));
    }
  }
  return { text: texts.join(separator), images };
}

function withImages(message: OllamaChatMessage, images: readonly string[]): OllamaChatMessage {
  return images.length > 0 ? { ...message, images } : message;
}

/**
 * Converts a tool-calling request into Ollama chat messages, keeping the model's
 * own tool calls, the tool name each result answers, thinking, and images.
 *
 * `messages` wins over `prompt` whenever it is non-empty: the agent loop sends
 * both, and `messages` already starts with that prompt.
 */
export function toOllamaMessages(input: ToolCallingTaskInput): OllamaChatMessage[] {
  const out: OllamaChatMessage[] = [];
  // System turns in the history join the system prompt, as on the
  // text-generation path, rather than being dropped.
  const lifted = liftSystemMessages(input.messages ?? [], input.systemPrompt);

  if (lifted.systemPrompt) {
    out.push({ role: "system", content: lifted.systemPrompt });
  }

  // A history of system turns alone is still the history: the prompt is what a
  // caller with no history sends, never a stand-in for one.
  const history = lifted.messages;
  if (!input.messages || input.messages.length === 0) {
    const prompt = input.prompt as unknown;
    if (typeof prompt === "string") {
      out.push({ role: "user", content: prompt });
    } else if (Array.isArray(prompt)) {
      const blocks = prompt.map((item): TextOrImage =>
        typeof item === "string" ? { type: "text", text: item } : (item as TextOrImage)
      );
      const { text, images } = flattenBlocks(blocks, "\n");
      out.push(withImages({ role: "user", content: text }, images));
    }
    return out;
  }

  // Provider-assigned ids restart at `call_0` each run, so they repeat across
  // turns. The map is updated as each assistant turn is read, so a result
  // resolves against the most recent preceding call with its id.
  const toolNames = new Map<string, string>();
  // Ollama's chat templates render a tool message's text only, so images a tool
  // returned ride on a user turn — after the whole run of tool messages, so it
  // never sits between two results of one assistant turn.
  let toolImages: string[] = [];
  const flushToolImages = (): void => {
    if (toolImages.length === 0) return;
    const labels = toolImages.map((_, i) => `[image ${i + 1}]`).join(", ");
    out.push({
      role: "user",
      content: `Images returned by the tool calls above, in order: ${labels}`,
      images: toolImages,
    });
    toolImages = [];
  };

  for (const msg of history) {
    if (msg.role !== "tool") flushToolImages();
    if (msg.role === "user") {
      const { text, images } = flattenBlocks(msg.content, "\n");
      out.push(withImages({ role: "user", content: text }, images));
    } else if (msg.role === "assistant") {
      const texts: string[] = [];
      const thoughts: string[] = [];
      const calls: Array<{
        function: { name: string; arguments: Record<string, unknown> };
      }> = [];
      for (const block of msg.content) {
        if (block.type === "text") {
          texts.push(block.text);
        } else if (block.type === "reasoning") {
          if (block.text) thoughts.push(block.text);
        } else if (block.type === "tool_use") {
          toolNames.set(block.id, block.name);
          calls.push({ function: { name: block.name, arguments: block.input } });
        }
      }
      const content = texts.join("");
      if (content === "" && thoughts.length === 0 && calls.length === 0) continue;
      let message: OllamaChatMessage = { role: "assistant", content };
      if (thoughts.length > 0) message = { ...message, thinking: thoughts.join("") };
      if (calls.length > 0) message = { ...message, tool_calls: calls };
      out.push(message);
    } else if (msg.role === "tool") {
      for (const block of msg.content) {
        if (block.type !== "tool_result") continue;
        const { text, images } = flattenBlocks(block.content, "\n", true, toolImages.length);
        let message: OllamaChatMessage = {
          role: "tool",
          content: block.is_error ? `Error: ${text}` : text,
        };
        const name = toolNames.get(block.tool_use_id);
        if (name !== undefined) message = { ...message, tool_name: name };
        out.push(message);
        toolImages.push(...images);
      }
    }
  }
  flushToolImages();

  return out;
}
