/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ToolCallingTaskInput, ToolDefinition } from "@workglow/ai";
import { forcedToolSelection } from "@workglow/ai/provider-utils";

/**
 * Families whose template asks for `<tool_call>{"name": …, "arguments": …}</tool_call>`
 * — a JSON body inside a tag, so the body can be grammar-constrained and the
 * tags written around it. Other families wrap or spell a call differently and
 * stay unconstrained rather than be handed JSON they would not parse.
 */
const JSON_TAG_FAMILIES: ReadonlySet<string> = new Set(["qwen", "qwen2", "qwen3", "hermes"]);

/** Qwen3.5 shares the `qwen` name but calls tools in XML children, not JSON. */
const QWEN_XML_MARKER = /qwen[-_.]?3[-_.]?5/;

export const HFT_TOOL_CALL_OPEN = "<tool_call>\n";
export const HFT_TOOL_CALL_CLOSE = "\n</tool_call>";

export interface ConstrainedToolCall {
  /** Appended to the prompt: generation starts inside the tag, on the JSON body. */
  readonly prefix: string;
  /** Written after the generated body, so the family parser sees a whole tag. */
  readonly suffix: string;
  readonly schema: Record<string, unknown>;
}

function callSchema(tool: ToolDefinition): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      name: { const: tool.name },
      arguments: tool.inputSchema,
    },
    required: ["name", "arguments"],
    additionalProperties: false,
  };
}

/**
 * The constraint for a turn that must end in exactly one tool call: a named
 * `toolChoice`, or `"required"`. `"auto"` is the model's decision between
 * answering and calling, and a grammar cannot make that decision — it would
 * force a call every turn — so it is left to the model.
 *
 * Returns `undefined` whenever the constraint cannot be applied faithfully:
 * history already holds tool results (the turn may be the answer), the prompt
 * ends inside an open `<think>` block, or the family's call format is not the
 * JSON-in-tag one.
 */
export function resolveConstrainedToolCall(
  input: ToolCallingTaskInput,
  family: string | null,
  modelTexts: ReadonlyArray<string>,
  prompt: string
): ConstrainedToolCall | undefined {
  if (family === null || !JSON_TAG_FAMILIES.has(family)) return undefined;
  if (modelTexts.some((text) => QWEN_XML_MARKER.test(text))) return undefined;
  if (input.messages?.some((m) => m.role === "tool")) return undefined;
  if (prompt.trimEnd().endsWith("<think>")) return undefined;

  const forced = forcedToolSelection(input);
  const tools = input.tools ?? [];
  let candidates: ReadonlyArray<ToolDefinition>;
  if (forced !== undefined) {
    candidates = tools.filter((t) => t.name === forced);
  } else if (input.toolChoice === "required") {
    candidates = tools;
  } else {
    return undefined;
  }
  if (candidates.length === 0) return undefined;

  const schemas = candidates.map(callSchema);
  return {
    prefix: HFT_TOOL_CALL_OPEN,
    suffix: HFT_TOOL_CALL_CLOSE,
    schema: schemas.length === 1 ? schemas[0]! : { oneOf: schemas },
  };
}
