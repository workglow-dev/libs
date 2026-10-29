/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/** An assistant turn's tool call as a chat template reads it from `message.tool_calls`. */
export interface HftTemplateToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: Record<string, unknown> };
}

/**
 * A tool call in the `{ type: "function", function: { name, arguments } }` form
 * the Hugging Face chat-template convention defines. Llama 3.x and LFM2-VL
 * templates read only that form and fail to render a flat `{ name, arguments }`;
 * Qwen, LFM2, Granite and Phi templates unwrap `function` when it is there, and
 * render this form exactly as they render the flat one.
 */
export function hftTemplateToolCall(
  id: string,
  name: string,
  input: Record<string, unknown>
): HftTemplateToolCall {
  return { id, type: "function", function: { name, arguments: input } };
}
