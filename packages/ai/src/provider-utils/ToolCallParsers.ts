/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText } from "@workglow/util";
import { getLogger } from "@workglow/util/worker";
import type { ToolCallingTaskInput } from "../task/ToolCallingTask";
import type { ToolCalls } from "../task/ToolCallingUtils";
import { sanitizeToolArgs } from "../task/ToolCallingUtils";

// ============================================================================
// Types
// ============================================================================

export interface ToolCall {
  readonly name: string;
  readonly arguments: Record<string, unknown>;
  readonly id: string | null;
}

export interface ToolCallParserResult {
  readonly tool_calls: ReadonlyArray<ToolCall>;
  readonly content: string;
  readonly parser: string;
}

export interface ParseToolCallsOptions {
  readonly tokenizer?: TokenizerLike | null;
  readonly model?: string | null;
  readonly parser?: string | null;
}

/**
 * Minimal tokenizer shape used for model-family detection.
 * Compatible with `PreTrainedTokenizer` from `@huggingface/transformers`.
 */
export interface TokenizerLike {
  readonly config?: {
    readonly name_or_path?: string;
    readonly _name_or_path?: string;
    readonly model_type?: string;
  };
  readonly name_or_path?: string;
}

export type ParserFn = (text: string) => ToolCallParserResult | null;

// ============================================================================
// Text cleanup
// ============================================================================

/**
 * Strip thinking blocks (`<think>...</think>`) and HFT special tokens
 * (`<|im_end|>`, `<|end_of_turn|>`, etc.) from model output.
 * Used to clean up content text returned alongside tool calls.
 */
export function stripModelArtifacts(text: string): string {
  return text
    .replace(/<think>(?:[^<]|<(?!\/think>))*<\/think>/g, "")
    .replace(/<\|[a-z_]+\|>/g, "")
    .trim();
}

/**
 * Extract text from a content block that may be a string, array of content
 * blocks, or other structure.
 */
export function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return asText(content);
  }
  return content
    .filter(
      (block) => block && typeof block === "object" && (block as { type?: unknown }).type === "text"
    )
    .map((block) => asText((block as { text?: unknown }).text))
    .join("");
}

// ============================================================================
// Shared helpers
// ============================================================================

export function makeToolCall(
  name: string,
  args: Record<string, unknown>,
  id: string | null = null
): ToolCall {
  return { name, arguments: args, id };
}

export function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    getLogger().debug("ToolCallParsers tryParseJson failed", {
      error: (e as Error).message,
      textPrefix: text.slice(0, 120),
    });
    return undefined;
  }
}

/**
 * Scan `source` for balanced blocks delimited by `openChar`/`closeChar`
 * (e.g. `{`/`}` or `[`/`]`). Correctly handles JSON string literals so
 * that braces inside strings are not counted.
 *
 * This is a ReDoS-safe alternative to regex patterns like `\{[\s\S]*?\}`.
 */
function findBalancedBlocks(
  source: string,
  openChar: string,
  closeChar: string,
  startFrom: number = 0
): Array<{ text: string; start: number; end: number }> {
  const results: Array<{ text: string; start: number; end: number }> = [];
  const length = source.length;
  let i = startFrom;
  while (i < length) {
    if (source[i] !== openChar) {
      i++;
      continue;
    }
    let depth = 1;
    let j = i + 1;
    let inString = false;
    let escape = false;
    while (j < length && depth > 0) {
      const ch = source[j];
      if (inString) {
        if (escape) {
          escape = false;
        } else if (ch === "\\") {
          escape = true;
        } else if (ch === '"') {
          inString = false;
        }
      } else {
        if (ch === '"') {
          inString = true;
        } else if (ch === openChar) {
          depth++;
        } else if (ch === closeChar) {
          depth--;
        }
      }
      j++;
    }
    if (depth === 0) {
      results.push({ text: source.slice(i, j), start: i, end: j });
      i = j;
    } else {
      break;
    }
  }
  return results;
}

export function parseJsonToolCallArray(
  jsonStr: string,
  nameKey: string = "name",
  argsKeys: ReadonlyArray<string> = ["arguments", "parameters"]
): ReadonlyArray<ToolCall> | undefined {
  const parsed = tryParseJson(jsonStr.trim());
  if (!parsed) return undefined;

  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const calls = arr
    .filter(
      (c): c is Record<string, unknown> =>
        !!c && typeof c === "object" && !!(c as Record<string, unknown>)[nameKey]
    )
    .map((c) => {
      const args = argsKeys.reduce<Record<string, unknown> | undefined>(
        (found, key) => found ?? (c[key] as Record<string, unknown> | undefined),
        undefined
      );
      return makeToolCall(c[nameKey] as string, args ?? {}, (c.id as string | null) ?? null);
    });

  return calls.length > 0 ? calls : undefined;
}

/**
 * Parse key=value argument syntax used by Gorilla, NexusRaven, and Gemma.
 * Handles quoted strings (`"val"`, `'val'`) and bare values.
 */
export function parseKeyValueArgs(argsStr: string): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  if (!argsStr) return args;

  const argRegex = /\b(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
  let match: RegExpExecArray | null;
  while ((match = argRegex.exec(argsStr)) !== null) {
    const key = match[1];
    const value = match[2] ?? match[3] ?? match[4];
    args[key] = coerceArgValue(value);
  }
  return args;
}

export function coerceArgValue(value: string): unknown {
  if (value === "true") return true;
  if (value === "false") return false;
  if (value !== "" && !isNaN(Number(value))) return Number(value);
  return value;
}

// ============================================================================
// Tool choice utilities
// ============================================================================

export function toolChoiceForcesToolCall(toolChoice: ToolCallingTaskInput["toolChoice"]): boolean {
  return (
    toolChoice === "required" ||
    (toolChoice !== undefined && toolChoice !== "auto" && toolChoice !== "none")
  );
}

export function forcedToolSelection(input: ToolCallingTaskInput): string | undefined {
  if (
    typeof input.toolChoice === "string" &&
    input.toolChoice !== "auto" &&
    input.toolChoice !== "none"
  ) {
    if (input.toolChoice !== "required") {
      return input.toolChoice;
    }
  }
  if (input.toolChoice === "required" && input.tools.length === 1) {
    return input.tools[0]?.name;
  }
  return undefined;
}

export function resolveParsedToolName(name: string, input: ToolCallingTaskInput): string {
  if (input.tools.some((tool) => tool.name === name)) {
    return name;
  }
  return forcedToolSelection(input) ?? name;
}

/**
 * Convert a low-level parser result to the workglow `ToolCalls` type.
 * When `input` is provided, tool names are resolved against the available
 * tools list (and forced selection is applied for unrecognized names).
 */
export function adaptParserResult(
  result: ToolCallParserResult,
  input?: ToolCallingTaskInput
): { text: string; toolCalls: ToolCalls } {
  return {
    text: stripModelArtifacts(result.content),
    toolCalls: result.tool_calls.map((call, index) => ({
      id: call.id ?? `call_${index}`,
      name: input ? resolveParsedToolName(call.name, input) : call.name,
      input: sanitizeToolArgs(call.arguments) as Record<string, unknown>,
    })),
  };
}

// ============================================================================
// Individual parsers for each model family
// ============================================================================

/**
 * Llama 3.1/3.2/3.3 (Meta)
 *
 * Formats:
 * - `<|python_tag|>{"name": "func", "parameters": {"arg": "val"}}`
 * - `<function=func>{"arg": "val"}</function>` (3.2 lightweight 1B/3B)
 * - `{"name": "func", "parameters": {...}}` (bare JSON)
 */
export const parseLlama: ParserFn = (text) => {
  const calls: ToolCall[] = [];
  let content = text;

  // Try <|python_tag|> format first
  const pythonTagMatch = text.match(
    /<\|python_tag\|>((?:[^<]|<(?!\|eot_id\|>|\|eom_id\|>))*)(?:<\|eot_id\|>|<\|eom_id\|>|$)/
  );
  if (pythonTagMatch) {
    content = text.slice(0, text.indexOf("<|python_tag|>")).trim();
    const jsonSection = pythonTagMatch[1].trim();
    for (const line of jsonSection.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parsed = tryParseJson(trimmed) as Record<string, unknown> | undefined;
      if (parsed?.name) {
        calls.push(
          makeToolCall(
            parsed.name as string,
            (parsed.parameters ?? parsed.arguments ?? {}) as Record<string, unknown>,
            (parsed.id as string | null) ?? null
          )
        );
      }
    }
  }

  // Try <function=name>{args}</function> format (Llama 3.2 lightweight 1B/3B)
  if (calls.length === 0) {
    const funcTagRegex = /<function=(\w+)>((?:[^<]|<(?!\/function>))*)<\/function>/g;
    let funcMatch: RegExpExecArray | null;
    while ((funcMatch = funcTagRegex.exec(text)) !== null) {
      const args = tryParseJson(funcMatch[2].trim()) as Record<string, unknown> | undefined;
      if (args) {
        calls.push(makeToolCall(funcMatch[1], args));
      }
    }
    if (calls.length > 0) {
      content = text.replace(/<function=\w+>(?:[^<]|<(?!\/function>))*<\/function>/g, "").trim();
    }
  }

  // Check for {"name":...} pattern at end of output (no python_tag)
  // Uses balanced-brace scanning instead of regex to avoid ReDoS
  if (calls.length === 0) {
    const blocks = findBalancedBlocks(text, "{", "}");
    let firstBlockStart: number | undefined;
    for (const block of blocks) {
      const parsed = tryParseJson(block.text) as Record<string, unknown> | undefined;
      if (parsed?.name && (parsed.parameters !== undefined || parsed.arguments !== undefined)) {
        if (firstBlockStart === undefined) {
          firstBlockStart = block.start;
        }
        calls.push(
          makeToolCall(
            parsed.name as string,
            (parsed.parameters ?? parsed.arguments ?? {}) as Record<string, unknown>,
            (parsed.id as string | null) ?? null
          )
        );
      }
    }
    if (calls.length > 0 && firstBlockStart !== undefined) {
      // Slice the leading content to the actual block start rather than
      // reconstructing the offset from a literal `{"name": "` prefix, which
      // breaks when the model emits a different key order or no space.
      content = text.slice(0, firstBlockStart).trim();
    }
  }

  return calls.length > 0 ? { tool_calls: calls, content, parser: "llama" } : null;
};

/**
 * Mistral / Mixtral (Mistral AI)
 *
 * Format: `[TOOL_CALLS] [{"name": "func", "arguments": {...}, "id": "9charID"}]`
 */
export const parseMistral: ParserFn = (text) => {
  const marker = "[TOOL_CALLS]";
  const idx = text.indexOf(marker);
  if (idx === -1) return null;

  const content = text.slice(0, idx).trim();
  const jsonStr = text.slice(idx + marker.length).trim();
  const calls = parseJsonToolCallArray(jsonStr);

  return calls ? { tool_calls: calls, content, parser: "mistral" } : null;
};

/**
 * Hermes (NousResearch) — also used by Qwen 2.5, Qwen 3, SOLAR, and others
 *
 * Format: `<tool_call>\n{"name": "func", "arguments": {...}}\n</tool_call>`
 */
export const parseHermes: ParserFn = (text) => {
  const regex = /<tool_call>((?:[^<]|<(?!\/tool_call>))*)<\/tool_call>/g;
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const parsed = tryParseJson(match[1].trim()) as Record<string, unknown> | undefined;
    if (parsed) {
      calls.push(
        makeToolCall(
          (parsed.name ?? "") as string,
          (parsed.arguments ?? parsed.parameters ?? {}) as Record<string, unknown>,
          (parsed.id as string | null) ?? null
        )
      );
    }
  }

  if (calls.length === 0) return null;

  const content = text.replace(/<tool_call>(?:[^<]|<(?!\/tool_call>))*<\/tool_call>/g, "").trim();
  return { tool_calls: calls, content, parser: "hermes" };
};

/**
 * Cohere Command-R / Command-R+
 *
 * Formats:
 * - `Action: ```json\n[{"tool_name": "func", "parameters": {...}}]\n````
 * - `Action: [{"tool_name": ..., "parameters": ...}]`
 */
export const parseCohere: ParserFn = (text) => {
  const blockMatch = text.match(/Action:\s*```(?:json)?\n?((?:[^`]|`(?!``))*)\n?```/);
  // Use balanced-bracket scanning for inline format to avoid ReDoS
  let inlineJsonStr: string | undefined;
  if (!blockMatch) {
    const actionIdx = text.indexOf("Action:");
    if (actionIdx !== -1) {
      const afterAction = text.slice(actionIdx + "Action:".length).trimStart();
      if (afterAction.startsWith("[")) {
        const blocks = findBalancedBlocks(afterAction, "[", "]");
        if (blocks.length > 0) {
          inlineJsonStr = blocks[0].text;
        }
      }
    }
  }

  const jsonStr = blockMatch?.[1] ?? inlineJsonStr;
  if (!jsonStr) return null;

  const calls = parseJsonToolCallArray(jsonStr, "tool_name", ["parameters", "arguments"]);
  if (!calls) {
    // Retry with "name" key
    const fallbackCalls = parseJsonToolCallArray(jsonStr);
    if (!fallbackCalls) return null;

    const actionIdx = text.indexOf("Action:");
    const content = text.slice(0, actionIdx).trim();
    return { tool_calls: fallbackCalls, content, parser: "cohere" };
  }

  const actionIdx = text.indexOf("Action:");
  const content = text.slice(0, actionIdx).trim();
  return { tool_calls: calls, content, parser: "cohere" };
};

/**
 * DeepSeek V2/V3/V3.1
 *
 * V2 format: `<｜tool▁call▁begin｜>function_name\n```json\n{...}\n```<｜tool▁call▁end｜>`
 * V3.1 format: `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>name<｜tool▁sep｜>{args}<｜tool▁call▁end｜><｜tool▁calls▁end｜>`
 */
function parseDeepSeekV31Calls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const bars = ["|", "｜"] as const;
  const gapVariants = ["", " ", "\u2581", " \u2581", "\u2581 "] as const;

  const beginTags: string[] = [];
  const sepTags: string[] = [];
  const endTags: string[] = [];
  for (const bar of bars) {
    for (const gap1 of gapVariants) {
      for (const gap2 of gapVariants) {
        beginTags.push(`<${bar}tool${gap1}call${gap2}begin${bar}>`);
        endTags.push(`<${bar}tool${gap1}call${gap2}end${bar}>`);
      }
      sepTags.push(`<${bar}tool${gap1}sep${bar}>`);
    }
  }

  let searchFrom = 0;
  while (searchFrom < text.length) {
    let beginIdx = -1;
    let beginTag = "";
    for (const tag of beginTags) {
      const idx = text.indexOf(tag, searchFrom);
      if (idx !== -1 && (beginIdx === -1 || idx < beginIdx)) {
        beginIdx = idx;
        beginTag = tag;
      }
    }
    if (beginIdx === -1) break;

    let pos = beginIdx + beginTag.length;
    while (pos < text.length && /[ \t\u2581]/.test(text[pos]!)) pos += 1;

    const nameStart = pos;
    while (pos < text.length && /\w/.test(text[pos]!)) pos += 1;
    const name = text.slice(nameStart, pos);
    if (!name) {
      searchFrom = beginIdx + beginTag.length;
      continue;
    }

    while (pos < text.length && /[ \t\u2581]/.test(text[pos]!)) pos += 1;

    let sepTag = "";
    for (const tag of sepTags) {
      if (text.startsWith(tag, pos)) {
        sepTag = tag;
        break;
      }
    }
    if (!sepTag) {
      searchFrom = beginIdx + beginTag.length;
      continue;
    }
    pos += sepTag.length;

    while (pos < text.length && /[ \t\u2581]/.test(text[pos]!)) pos += 1;

    let endIdx = -1;
    let endTag = "";
    for (const tag of endTags) {
      const idx = text.indexOf(tag, pos);
      if (idx !== -1 && (endIdx === -1 || idx < endIdx)) {
        endIdx = idx;
        endTag = tag;
      }
    }
    if (endIdx === -1) break;

    const args = tryParseJson(text.slice(pos, endIdx).trim()) as
      | Record<string, unknown>
      | undefined;
    if (args) {
      calls.push(makeToolCall(name, args));
    }
    searchFrom = endIdx + endTag.length;
  }

  return calls;
}

export const parseDeepSeek: ParserFn = (text) => {
  const calls: ToolCall[] = parseDeepSeekV31Calls(text);

  // Helper to match both fullwidth ｜ and ASCII | bar variants, and ▁ or space
  const bar = "(?:｜|\\|)";
  const sep = "[\\s\u2581]";

  let match: RegExpExecArray | null;
  // Try V2 format: name\n```json\n{args}\n```
  if (calls.length === 0) {
    const v2Regex = new RegExp(
      `<${bar}tool${sep}call${sep}begin${bar}>\\s*(\\w+)\\s*\\n\`\`\`(?:json)?\\n([^\`]*(?:\`(?!\`\`)[^\`]*)*)\\n\`\`\`\\s*<${bar}tool${sep}call${sep}end${bar}>`,
      "g"
    );
    while ((match = v2Regex.exec(text)) !== null) {
      const args = tryParseJson(match[2].trim()) as Record<string, unknown> | undefined;
      if (args) {
        calls.push(makeToolCall(match[1], args));
      }
    }
  }

  if (calls.length === 0) return null;

  const content = text
    .replace(new RegExp(`<${bar}tool${sep}calls?${sep}(?:begin|end)${bar}>`, "g"), "")
    .replace(
      new RegExp(
        `<${bar}tool${sep}call${sep}(?:begin|end)${bar}>[^<]*(?:<(?!${bar}tool${sep}call${sep}end${bar}>)[^<]*)*<${bar}tool${sep}call${sep}end${bar}>`,
        "g"
      ),
      ""
    )
    .replace(new RegExp(`<${bar}tool${sep}sep${bar}>`, "g"), "")
    .trim();
  return { tool_calls: calls, content, parser: "deepseek" };
};

/**
 * Phi-4 / Phi-4-mini (Microsoft)
 *
 * Format: `<|tool_calls|>[{"name": "func", "arguments": {...}}]<|/tool_calls|>`
 */
export const parsePhi: ParserFn = (text) => {
  const match = text.match(/<\|tool_calls\|>((?:[^<]|<(?!\|\/tool_calls\|>))*)<\|\/tool_calls\|>/);
  if (!match) return null;

  const calls = parseJsonToolCallArray(match[1]);
  if (!calls) return null;

  const content = text.slice(0, text.indexOf("<|tool_calls|>")).trim();
  return { tool_calls: calls, content, parser: "phi" };
};

/**
 * Phi-3 functools format (legacy)
 *
 * Format: `functools[{"name": "func", "arguments": {...}}]`
 */
export const parsePhiFunctools: ParserFn = (text) => {
  const idx = text.indexOf("functools");
  if (idx === -1) return null;

  // Scan forward past optional whitespace to find the opening [
  let start = idx + "functools".length;
  while (start < text.length && /\s/.test(text[start])) start++;
  if (start >= text.length || text[start] !== "[") return null;

  const blocks = findBalancedBlocks(text, "[", "]", start);
  if (blocks.length === 0) return null;

  const calls = parseJsonToolCallArray(blocks[0].text);
  if (!calls) return null;

  const content = text.slice(0, idx).trim();
  return { tool_calls: calls, content, parser: "phi_functools" };
};

/**
 * InternLM 2 / 2.5 (Shanghai AI Lab)
 *
 * Format: `<|action_start|><|plugin|>\n{"name": "func", "parameters": {...}}<|action_end|>`
 */
export const parseInternLM: ParserFn = (text) => {
  const regex =
    /<\|action_start\|>\s*<\|plugin\|>((?:[^<]|<(?!\|action_end\|>))*)<\|action_end\|>/g;
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const parsed = tryParseJson(match[1].trim()) as Record<string, unknown> | undefined;
    if (parsed) {
      calls.push(
        makeToolCall(
          (parsed.name ?? "") as string,
          (parsed.parameters ?? parsed.arguments ?? {}) as Record<string, unknown>,
          (parsed.id as string | null) ?? null
        )
      );
    }
  }

  if (calls.length === 0) return null;

  const content = text
    .replace(/<\|action_start\|>\s*<\|plugin\|>(?:[^<]|<(?!\|action_end\|>))*<\|action_end\|>/g, "")
    .trim();
  return { tool_calls: calls, content, parser: "internlm" };
};

/**
 * ChatGLM / GLM-4 (Zhipu AI)
 *
 * Format: function name followed by newline and JSON arguments.
 * `func_name\n{"arg": "val"}`
 */
export const parseChatGLM: ParserFn = (text) => {
  const match = text.match(/^(\w+)\n(\{[\s\S]*\})\s*$/m);
  if (!match) return null;

  const args = tryParseJson(match[2].trim()) as Record<string, unknown> | undefined;
  if (!args) return null;

  return {
    tool_calls: [makeToolCall(match[1], args)],
    content: "",
    parser: "chatglm",
  };
};

/**
 * Functionary (MeetKai)
 *
 * Format: `>>>func_name\n{"arg": "val"}`
 * Uses `all` as a special function name for regular text.
 */
export const parseFunctionary: ParserFn = (text) => {
  const regex = />>>\s*(\w+)\s*\n((?:(?!>>>)[\s\S])*)/g;
  const calls: ToolCall[] = [];
  let content = "";
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const funcName = match[1].trim();
    const body = match[2].trim();

    if (funcName === "all") {
      content += body;
      continue;
    }

    const args = tryParseJson(body) as Record<string, unknown> | undefined;
    calls.push(makeToolCall(funcName, args ?? { content: body }));
  }

  if (calls.length === 0) return null;
  return { tool_calls: calls, content: content.trim(), parser: "functionary" };
};

/**
 * Gorilla (Berkeley)
 *
 * Format: `<<function>>func_name(arg1="val1", arg2=val2)`
 */
export const parseGorilla: ParserFn = (text) => {
  const regex = /<<function>>\s{0,20}(\w+)\(([^)]*)\)/g;
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    calls.push(makeToolCall(match[1], parseKeyValueArgs(match[2].trim())));
  }

  if (calls.length === 0) return null;

  const content = text.replace(/<<function>>\s{0,20}\w+\([^)]*\)/g, "").trim();
  return { tool_calls: calls, content, parser: "gorilla" };
};

/**
 * NexusRaven (Nexusflow)
 *
 * Format: `Call: func_name(arg1="val1", arg2=val2)\nThought: reasoning...`
 */
export const parseNexusRaven: ParserFn = (text) => {
  const regex = /Call:\s{0,20}(\w+)\(([^)]*)\)/g;
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    calls.push(makeToolCall(match[1], parseKeyValueArgs(match[2].trim())));
  }

  if (calls.length === 0) return null;

  const thoughtMatch = text.match(/Thought:\s*((?:(?!Call:)[\s\S])*)/);
  const content =
    thoughtMatch?.[1]?.trim() ?? text.replace(/Call:\s{0,20}\w+\([^)]*\)/g, "").trim();
  return { tool_calls: calls, content, parser: "nexusraven" };
};

/**
 * xLAM (Salesforce)
 *
 * Format: Raw JSON array of tool calls: `[{"name": "func", "arguments": {...}}]`
 * May be wrapped in ```json code blocks.
 */
export const parseXLAM: ParserFn = (text) => {
  // Try code block format first using ReDoS-safe backtick matching
  const codeBlockMatch = text.match(/```(?:json)?\n?((?:[^`]|`(?!``))*)\n?```/);
  let jsonStr: string | undefined;
  let isCodeBlock = false;

  if (codeBlockMatch) {
    const inner = codeBlockMatch[1].trim();
    if (inner.startsWith("[")) {
      jsonStr = inner;
      isCodeBlock = true;
    }
  }

  if (!jsonStr) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("[")) return null;
    jsonStr = trimmed;
  }

  const calls = parseJsonToolCallArray(jsonStr);
  if (!calls) return null;

  const content = isCodeBlock ? text.slice(0, text.indexOf("```")).trim() : "";
  return { tool_calls: calls, content, parser: "xlam" };
};

/**
 * FireFunction (Fireworks AI)
 *
 * Format: `{"tool_calls": [{"function": {"name": "...", "arguments": "..."}}]}`
 */
export const parseFireFunction: ParserFn = (text) => {
  // Use balanced-bracket scanning to avoid ReDoS
  const toolCallsIdx = text.indexOf('"tool_calls"');
  if (toolCallsIdx === -1) return null;

  // Find the opening [ after "tool_calls":
  let bracketStart = text.indexOf("[", toolCallsIdx);
  if (bracketStart === -1) return null;

  const blocks = findBalancedBlocks(text, "[", "]", bracketStart);
  if (blocks.length === 0) return null;

  const parsed = tryParseJson(blocks[0].text) as Array<Record<string, unknown>> | undefined;
  if (!parsed || !Array.isArray(parsed)) return null;

  const calls: ToolCall[] = [];
  for (const c of parsed) {
    const fn = c.function as Record<string, unknown> | undefined;
    if (!fn?.name) continue;

    let args = fn.arguments ?? {};
    if (typeof args === "string") {
      args = tryParseJson(args) ?? {};
    }
    calls.push(
      makeToolCall(
        fn.name as string,
        args as Record<string, unknown>,
        (c.id as string | null) ?? null
      )
    );
  }

  return calls.length > 0 ? { tool_calls: calls, content: "", parser: "firefunction" } : null;
};

/**
 * Granite (IBM)
 *
 * Format: `<|tool_call|>{"name": "func", "arguments": {...}}<|/tool_call|>` or `<|end_of_text|>`
 */
export const parseGranite: ParserFn = (text) => {
  const regex =
    /<\|tool_call\|>((?:[^<]|<(?!\|\/tool_call\|>|\|end_of_text\|>))*?)(?:<\|\/tool_call\|>|<\|end_of_text\|>|$)/g;
  const calls: ToolCall[] = [];
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const parsed = tryParseJson(match[1].trim()) as Record<string, unknown> | undefined;
    if (parsed) {
      calls.push(
        makeToolCall(
          (parsed.name ?? "") as string,
          (parsed.arguments ?? parsed.parameters ?? {}) as Record<string, unknown>,
          (parsed.id as string | null) ?? null
        )
      );
    }
  }

  if (calls.length === 0) return null;

  const content = text
    .replace(
      /<\|tool_call\|>(?:[^<]|<(?!\|\/tool_call\|>|\|end_of_text\|>))*(?:<\|\/tool_call\|>|$)/g,
      ""
    )
    .trim();
  return { tool_calls: calls, content, parser: "granite" };
};

/**
 * Gemma 2/3 (Google) — prompt-based, no dedicated tokens
 *
 * Formats:
 * - ```tool_code\nfunc(arg=val)\n```
 * - `{"name": "func", "parameters": {...}}`
 */
export const parseGemma: ParserFn = (text) => {
  // Manual extraction to avoid ReDoS with backtick-matching regexes
  const openMarker = "```tool_code";
  const openIdx = text.indexOf(openMarker);
  if (openIdx === -1) return null;
  const lineStart = text.indexOf("\n", openIdx + openMarker.length);
  if (lineStart === -1) return null;
  // Find closing ``` on its own line after the content
  let closeIdx = -1;
  let searchFrom = lineStart + 1;
  while (searchFrom < text.length) {
    const candidate = text.indexOf("```", searchFrom);
    if (candidate === -1) break;
    // Ensure the ``` is preceded by a newline (possibly with whitespace)
    const lineBegin = text.lastIndexOf("\n", candidate - 1);
    if (lineBegin >= lineStart && text.slice(lineBegin + 1, candidate).trim() === "") {
      closeIdx = candidate;
      break;
    }
    searchFrom = candidate + 3;
  }
  if (closeIdx === -1) return null;

  const rawCode = text.slice(lineStart + 1, closeIdx).replace(/\n[ \t]*$/, "");
  const code = rawCode.trim();
  const funcMatch = code.match(/^(\w+)\(([\s\S]*)\)$/);
  if (!funcMatch) return null;

  // Remove the entire fenced block from content
  const blockEnd = closeIdx + 3;
  const content = (text.slice(0, openIdx) + text.slice(blockEnd)).trim();
  return {
    tool_calls: [makeToolCall(funcMatch[1], parseKeyValueArgs(funcMatch[2].trim()))],
    content,
    parser: "gemma",
  };
};

/**
 * Parse Liquid/LFM-style Pythonic function call arguments.
 * Handles both `key=val, key2=val2` and `params=JSON` patterns.
 * When a single `params` argument contains a JSON object, spreads it.
 */
function parseLiquidArgs(argsStr: string): Record<string, unknown> {
  const trimmed = argsStr.trim();

  // Try params=JSON pattern: params={"key": "val", ...} or params={'key': 'val', ...}
  const paramsMatch = trimmed.match(/^params\s*=\s*(\{[\s\S]*\})$/);
  if (paramsMatch) {
    const jsonStr = paramsMatch[1].replace(/'/g, '"');
    const parsed = tryParseJson(jsonStr) as Record<string, unknown> | undefined;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  }

  // Try bare JSON object: { key: "val", ... } (JS-style, keys may be unquoted)
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    // Add quotes around unquoted keys for JSON.parse
    const jsonified = trimmed.replace(/([{,]\s*)(\w+)\s*:/g, '$1"$2":');
    const parsed = tryParseJson(jsonified) as Record<string, unknown> | undefined;
    if (parsed && typeof parsed === "object") {
      return parsed;
    }
  }

  // Fall back to key=value parsing
  return parseKeyValueArgs(argsStr);
}

/**
 * Extract Pythonic function calls from text: `func_name(args)` or `[func(args)]`.
 * Handles balanced parentheses so JSON in args doesn't break matching.
 */
function extractPythonicCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const startRegex = /\b(\w+)\(/g;
  let startMatch: RegExpExecArray | null;
  while ((startMatch = startRegex.exec(text)) !== null) {
    const funcName = startMatch[1];
    const argsStart = startMatch.index + startMatch[0].length;
    // Balance parentheses to find the closing )
    let depth = 1;
    let i = argsStart;
    while (i < text.length && depth > 0) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")") depth--;
      i++;
    }
    if (depth === 0) {
      const argsStr = text.slice(argsStart, i - 1);
      calls.push(makeToolCall(funcName, parseLiquidArgs(argsStr)));
      // Advance regex scanning position past this complete call to avoid matching inside args
      startRegex.lastIndex = i;
    }
  }
  return calls;
}

/**
 * LiquidAI LFM / LFM2 / LFM2.5
 *
 * Formats:
 * - `<|tool_call_start|>[func_name(key="value", key2=123)]<|tool_call_end|>`
 * - `[func_name(params={"key": "val"})]` (bracket-only, no special tokens)
 * Parallel calls: `<|tool_call_start|>[func1(a="b"), func2(c="d")]<|tool_call_end|>`
 * Uses Pythonic function call syntax.
 */
export const parseLiquid: ParserFn = (text) => {
  // Try special token format first
  const specialMatch = text.match(
    /<\|tool_call_start\|>((?:[^<]|<(?!\|tool_call_end\|>))*)<\|tool_call_end\|>/
  );
  if (specialMatch) {
    const inner = specialMatch[1].trim();
    const unwrapped = inner.startsWith("[") && inner.endsWith("]") ? inner.slice(1, -1) : inner;
    const calls = extractPythonicCalls(unwrapped);
    if (calls.length > 0) {
      const content = stripModelArtifacts(
        text.replace(
          /<\|tool_call_start\|>(?:[^<]|<(?!\|tool_call_end\|>))*<\|tool_call_end\|>/g,
          ""
        )
      );
      return { tool_calls: calls, content, parser: "liquid" };
    }
  }

  // Try bracket-only format: [func(args)] without special tokens
  // Use manual balanced-paren extraction to avoid ReDoS
  const bracketCalls: ToolCall[] = [];
  const bracketSpans: Array<[number, number]> = [];
  {
    const bracketOpenRegex = /\[(?=\w+\()/g;
    let bm: RegExpExecArray | null;
    while ((bm = bracketOpenRegex.exec(text)) !== null) {
      const innerStart = bm.index + 1;
      // Find balanced closing ] by tracking parens
      let depth = 0;
      let i = innerStart;
      let foundClose = false;
      while (i < text.length) {
        const ch = text[i];
        if (ch === "(") depth++;
        else if (ch === ")") {
          depth--;
          if (depth === 0 && i + 1 < text.length && text[i + 1] === "]") {
            const inner = text.slice(innerStart, i + 1);
            const calls = extractPythonicCalls(inner);
            bracketCalls.push(...calls);
            bracketSpans.push([bm.index, i + 2]);
            bracketOpenRegex.lastIndex = i + 2;
            foundClose = true;
            break;
          }
        }
        i++;
      }
      if (!foundClose) break;
    }
  }

  if (bracketCalls.length > 0) {
    let content = text;
    for (let k = bracketSpans.length - 1; k >= 0; k--) {
      content = content.slice(0, bracketSpans[k][0]) + content.slice(bracketSpans[k][1]);
    }
    return { tool_calls: bracketCalls, content: stripModelArtifacts(content), parser: "liquid" };
  }

  // Try ||Call: format (LFM2 text-based variant): ||Call: func_name(args)
  const callPrefixRegex = /\|{0,2}Call:\s*/g;
  let callPrefixMatch: RegExpExecArray | null;
  const callCalls: ToolCall[] = [];
  while ((callPrefixMatch = callPrefixRegex.exec(text)) !== null) {
    const afterPrefix = text.slice(callPrefixMatch.index + callPrefixMatch[0].length);
    const calls = extractPythonicCalls(afterPrefix);
    if (calls.length > 0) {
      callCalls.push(calls[0]);
    }
  }

  if (callCalls.length > 0) {
    const content = stripModelArtifacts(text.replace(/\|{0,2}Call:\s{0,20}\w+\([^)]*\)/g, ""));
    return { tool_calls: callCalls, content, parser: "liquid" };
  }

  return null;
};

/**
 * Jamba (AI21)
 *
 * Format: `<tool_calls>[{"name": "func", "arguments": {...}}]</tool_calls>`
 * Also supports OpenAI-compatible format via FireFunction fallback.
 */
export const parseJamba: ParserFn = (text) => {
  const tagMatch = text.match(/<tool_calls>((?:[^<]|<(?!\/tool_calls>))*)<\/tool_calls>/);
  if (tagMatch) {
    const parsed = tryParseJson(tagMatch[1].trim());
    if (parsed) {
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      const calls: ToolCall[] = [];
      for (const c of arr as Array<Record<string, unknown>>) {
        if (!c.name) continue;
        let args = c.arguments ?? c.parameters ?? {};
        if (typeof args === "string") {
          args = tryParseJson(args) ?? {};
        }
        calls.push(
          makeToolCall(
            c.name as string,
            args as Record<string, unknown>,
            (c.id as string | null) ?? null
          )
        );
      }
      if (calls.length > 0) {
        const content = text.slice(0, text.indexOf("<tool_calls>")).trim();
        return { tool_calls: calls, content, parser: "jamba" };
      }
    }
  }

  return parseFireFunction(text);
};

/**
 * Qwen 3.5 XML format
 *
 * Format:
 * ```
 * <tool_call>
 * <function=function_name>
 * <parameter=param_name>value</parameter>
 * ...
 * </function>
 * </tool_call>
 * ```
 *
 * The special `params` parameter may contain a JSON object to be spread
 * into the arguments.
 */
export const parseQwen35Xml: ParserFn = (text) => {
  const toolCallMatches = text.matchAll(/<tool_call>((?:[^<]|<(?!\/tool_call>))*)<\/tool_call>/g);
  const calls: ToolCall[] = [];
  for (const [_, toolCallBody] of toolCallMatches) {
    const functionMatch = toolCallBody
      .trim()
      .match(/<function=([^>\n<]+)>((?:[^<]|<(?!\/function>))*)<\/function>/);
    if (!functionMatch) {
      continue;
    }
    const [, rawName, functionBody] = functionMatch;
    const parsedInput: Record<string, unknown> = {};
    const parameterMatches = functionBody.matchAll(
      /<parameter=([^>\n<]+)>((?:[^<]|<(?!\/parameter>))*)<\/parameter>/g
    );
    for (const [__, rawParamName, rawValue] of parameterMatches) {
      const paramName = rawParamName.trim();
      const valueText = rawValue.trim();
      if (paramName === "params") {
        try {
          const parsedValue = JSON.parse(valueText);
          if (parsedValue && typeof parsedValue === "object" && !Array.isArray(parsedValue)) {
            Object.assign(parsedInput, parsedValue);
            continue;
          }
        } catch {
          // Fall back to keeping the raw string.
        }
      }
      parsedInput[paramName] = valueText;
    }
    calls.push(makeToolCall(rawName.trim(), parsedInput));
  }

  if (calls.length === 0) return null;

  const content = text.replace(/<tool_call>(?:[^<]|<(?!\/tool_call>))*<\/tool_call>/g, "").trim();
  return { tool_calls: calls, content, parser: "qwen35xml" };
};

// ============================================================================
// Model family detection
// ============================================================================

/**
 * Model-family-specific parser chains.
 *
 * Each chain is ordered by likelihood: the parser matching the model's native
 * tool-call format comes first, followed by fallbacks for common alternative
 * formats the model may produce (most often Hermes `<tool_call>` tags or
 * Llama-style bare JSON).
 *
 * Multiple keys may map to the same chain when model names vary across
 * providers (e.g. `cohere` / `command`, `chatglm` / `glm`).
 */
const MODEL_PARSERS: Record<string, ReadonlyArray<ParserFn>> = {
  llama: [parseLlama, parseHermes],
  mistral: [parseMistral, parseHermes],
  mixtral: [parseMistral, parseHermes],
  qwen: [parseHermes, parseLlama],
  qwen2: [parseHermes, parseLlama],
  qwen3: [parseHermes, parseQwen35Xml, parseLlama],
  qwen35: [parseQwen35Xml, parseHermes, parseLlama],
  cohere: [parseCohere, parseHermes],
  command: [parseCohere, parseHermes],
  deepseek: [parseDeepSeek, parseHermes],
  hermes: [parseHermes],
  phi: [parsePhi, parsePhiFunctools, parseHermes],
  internlm: [parseInternLM, parseHermes],
  chatglm: [parseChatGLM],
  glm: [parseChatGLM],
  gemma: [parseGemma, parseHermes],
  functionary: [parseFunctionary],
  gorilla: [parseGorilla],
  nexusraven: [parseNexusRaven],
  xlam: [parseXLAM],
  firefunction: [parseFireFunction, parsePhiFunctools],
  granite: [parseGranite, parseHermes],
  solar: [parseHermes],
  jamba: [parseJamba, parseHermes],
  // LFM3 renders tool calls as Qwen-style XML, and must precede `liquid` and
  // `lfm`, which also match a `LiquidAI/LFM3-…` path.
  lfm3: [parseQwen35Xml, parseLiquid, parseHermes],
  liquid: [parseLiquid, parseHermes],
  lfm: [parseLiquid, parseHermes],
  yi: [parseHermes, parseLlama],
  falcon: [parseHermes, parseLlama],
};

/**
 * Default parser chain used when the model family cannot be determined.
 *
 * Ordering rationale — parsers that rely on highly distinctive, unlikely-to-
 * false-positive markers come first; generic / loose formats come last:
 *
 *  1. **Unique delimiters** — Phi (`<|tool_calls|>`), Mistral (`[TOOL_CALLS]`),
 *     DeepSeek (`<|tool▁calls|>`), InternLM (`<|action_start|>`),
 *     Granite (`<|tool_call_start|>`), FunctionGemma (`<start_function_call>`).
 *     Each uses a distinctive tag or token that won't appear in normal text.
 *
 *  2. **Structured tags** — Qwen35 XML (`<tool_call>` with XML children),
 *     Hermes (`<tool_call>` with JSON body), Cohere (`Action:` blocks).
 *     Hermes is widely adopted but its `<tool_call>` tag is shared by several
 *     model families, so it sits after the more unique delimiters.
 *
 *  3. **Specialized formats** — Functionary (`>>>func_name`),
 *     Gorilla (`<<function>>` calls), NexusRaven (`Call:`),
 *     FireFunction (`<function=>`), PhiFunctools (`functools[...]`),
 *     Liquid (pythonic `func_name(args)`).
 *
 *  4. **Loose / generic** — Llama (bare JSON objects), Gemma (key=value args),
 *     XLAM (JSON arrays). These match broad patterns and are tried last to
 *     avoid false positives when a more specific parser should have matched.
 */
const DEFAULT_PARSER_CHAIN: ReadonlyArray<ParserFn> = [
  // 1. Unique delimiters
  parsePhi,
  parseMistral,
  parseDeepSeek,
  parseInternLM,
  parseGranite,
  // 2. Structured tags
  parseQwen35Xml,
  parseHermes,
  parseCohere,
  // 3. Specialized formats
  parseFunctionary,
  parseGorilla,
  parseNexusRaven,
  parseFireFunction,
  parsePhiFunctools,
  parseLiquid,
  // 4. Loose / generic
  parseLlama,
  parseGemma,
  parseXLAM,
];

/**
 * Detect the model family from a tokenizer instance or model name string.
 */
function detectModelFamily(tokenizerOrName: TokenizerLike | string | null): string | null {
  let name = "";

  if (typeof tokenizerOrName === "string") {
    name = tokenizerOrName.toLowerCase();
  } else if (tokenizerOrName) {
    const config = tokenizerOrName.config ?? {};
    name = (
      config.name_or_path ??
      config._name_or_path ??
      config.model_type ??
      tokenizerOrName.name_or_path ??
      ""
    ).toLowerCase();
  }

  if (!name) return null;

  for (const family of Object.keys(MODEL_PARSERS)) {
    if (name.includes(family)) {
      return family;
    }
  }

  return null;
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Parse tool calls from LLM output text.
 *
 * Automatically detects the model family from the tokenizer and applies the
 * appropriate parser(s). Falls back to trying all known formats if the model
 * family cannot be determined.
 */
export function parseToolCalls(
  text: string,
  { tokenizer = null, model = null, parser = null }: ParseToolCallsOptions = {}
): ToolCallParserResult {
  if (!text || typeof text !== "string") {
    return { tool_calls: [], content: text ?? "", parser: "none" };
  }

  const log = getLogger();
  let parsersToTry: ReadonlyArray<ParserFn>;
  let source: string;

  if (parser) {
    const key = parser.toLowerCase();
    const found = MODEL_PARSERS[key];
    if (!found) {
      throw new Error(
        `Unknown parser "${parser}". Available parsers: ${Object.keys(MODEL_PARSERS).join(", ")}`
      );
    }
    parsersToTry = found;
    source = `explicit parser "${key}"`;
  } else {
    const family = detectModelFamily(tokenizer ?? model ?? null);
    if (family) {
      parsersToTry = MODEL_PARSERS[family]!;
      source = `model family "${family}"`;
    } else {
      parsersToTry = DEFAULT_PARSER_CHAIN;
      source = "default chain (unknown model)";
    }
  }

  log.debug("ToolCallParsers parseToolCalls", { source, parserCount: parsersToTry.length });

  for (const parserFn of parsersToTry) {
    const result = parserFn(text);
    if (result) {
      log.debug("ToolCallParsers parseToolCalls matched", {
        parser: result.parser,
        toolCallCount: result.tool_calls.length,
      });
      return result;
    }
  }

  log.debug("ToolCallParsers parseToolCalls no parser matched", {
    source,
    textPrefix: text.slice(0, 120),
  });
  return { tool_calls: [], content: text, parser: "none" };
}

/**
 * Check if text likely contains tool calls without fully parsing them.
 * Faster than `parseToolCalls` when you only need presence detection.
 */
export function hasToolCalls(text: string): boolean {
  if (!text) return false;
  return (
    text.includes("<tool_call>") ||
    text.includes("[TOOL_CALLS]") ||
    text.includes("<|python_tag|>") ||
    text.includes("<function=") ||
    text.includes("<|tool_calls|>") ||
    text.includes("<tool_calls>") ||
    text.includes("<|action_start|>") ||
    text.includes("<<function>>") ||
    text.includes(">>>") ||
    text.includes("Call:") ||
    text.includes("Action:") ||
    text.includes("functools") ||
    text.includes("<start_function_call>") ||
    text.includes("<|tool_call|>") ||
    text.includes("<|tool_call_start|>") ||
    /tool[\s\u2581]call[\s\u2581]begin/.test(text)
  );
}

/**
 * Get the list of available parser names.
 */
export function getAvailableParsers(): ReadonlyArray<string> {
  return Object.keys(MODEL_PARSERS);
}

/**
 * Get a model-family-specific generation prefix that guides the model to
 * produce tool calls. Appended to the prompt before generation and prepended
 * to the decoded output before parsing.
 *
 * @param family - The detected model family (from `getAvailableParsers` / `detectModelFamily`).
 * @param forcedToolName - When a specific tool is forced, include its name in the prefix.
 * @returns The prefix string, or `undefined` if no prefix is needed.
 */
export function getGenerationPrefix(
  family: string | null,
  _forcedToolName: string | undefined
): string | undefined {
  if (!family) return undefined;

  switch (family) {
    default:
      return undefined;
  }
}

// ============================================================================
// High-level parsing returning workglow ToolCalls type
// ============================================================================

/**
 * Parse tool calls from model-generated text, returning the workglow `ToolCalls`
 * type directly (with `input` field instead of `arguments`).
 *
 * Tries, in order:
 * 1. `<tool_call>JSON</tool_call>` tags (Qwen/Hermes)
 * 2. Bare JSON objects with `name` + `arguments`/`parameters` keys
 * 3. `{"function": {"name": ..., "arguments": ...}}` format
 *
 * Returns both the cleaned text (with tool-call markup removed) and the parsed
 * ToolCall array.
 */
export function parseToolCallsFromText(responseText: string): {
  text: string;
  toolCalls: ToolCalls;
} {
  // Try Hermes/Qwen tag-based format
  const hermesResult = parseHermes(responseText);
  if (hermesResult && hermesResult.tool_calls.length > 0) {
    return {
      text: hermesResult.content,
      toolCalls: hermesResult.tool_calls.map((call, index) => ({
        id: call.id ?? `call_${index}`,
        name: call.name,
        input: sanitizeToolArgs(call.arguments) as Record<string, unknown>,
      })),
    };
  }

  // Fallback: brace-balanced scanner for bare JSON objects
  const toolCalls: ToolCalls = [];
  let callIndex = 0;

  const jsonCandidates = findBalancedBlocks(responseText, "{", "}");

  const matchedRanges: Array<{ start: number; end: number }> = [];
  for (const candidate of jsonCandidates) {
    try {
      const parsed = JSON.parse(candidate.text);
      if (parsed.name && (parsed.arguments !== undefined || parsed.parameters !== undefined)) {
        const id = `call_${callIndex++}`;
        toolCalls.push({
          id,
          name: parsed.name as string,
          input: sanitizeToolArgs(parsed.arguments ?? parsed.parameters ?? {}) as Record<
            string,
            unknown
          >,
        });
        matchedRanges.push({ start: candidate.start, end: candidate.end });
      } else if (parsed.function?.name) {
        let functionArgs: unknown = parsed.function.arguments ?? {};
        if (typeof functionArgs === "string") {
          try {
            functionArgs = JSON.parse(functionArgs);
          } catch {
            functionArgs = {};
          }
        }
        const id = `call_${callIndex++}`;
        toolCalls.push({
          id,
          name: parsed.function.name as string,
          input: sanitizeToolArgs(functionArgs ?? {}) as Record<string, unknown>,
        });
        matchedRanges.push({ start: candidate.start, end: candidate.end });
      }
    } catch {
      // Not valid JSON, skip
    }
  }

  let cleanedText = responseText;
  if (toolCalls.length > 0) {
    let result = "";
    let lastIndex = 0;
    for (const range of matchedRanges) {
      result += responseText.slice(lastIndex, range.start);
      lastIndex = range.end;
    }
    result += responseText.slice(lastIndex);
    cleanedText = result.trim();
  }

  return { text: cleanedText, toolCalls };
}
