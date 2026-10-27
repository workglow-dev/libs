/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CheckpointPrefix, ToolCallingTaskInput, ToolDefinition } from "@workglow/ai";

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

/** Keywords whose value is a map of property name → subschema. */
const SCHEMA_MAP_KEYWORDS: ReadonlySet<string> = new Set([
  "properties",
  "patternProperties",
  "dependentSchemas",
  "dependencies",
  "$defs",
  "definitions",
]);

/** Keywords whose value is one subschema, or a list of them. */
const SCHEMA_KEYWORDS: ReadonlySet<string> = new Set([
  "items",
  "prefixItems",
  "additionalItems",
  "additionalProperties",
  "contains",
  "propertyNames",
  "not",
  "if",
  "then",
  "else",
  "allOf",
  "anyOf",
  "oneOf",
]);

/** One JSON-pointer segment as the engine reads it: URI-decoded, then `~1` and `~0` undone. */
const pointerSegment = (segment: string): string =>
  segment.replace(/~/g, "~0").replace(/\//g, "~1").replace(/%/g, "%25");

/**
 * A copy of a tool's input schema fit to sit at `root` inside the call
 * envelope; `pointer` is where the node being copied now stands. The grammar
 * engine reads the envelope as one document, so two things in a tool's own
 * schema stop meaning what they meant:
 *
 * - a local `$ref` (`#/$defs/Item`, or `#` for recursion) is relative to the
 *   tool's schema, and would resolve against the envelope instead — to nothing,
 *   or for `#` to the envelope itself — so each is re-rooted at `root`;
 * - the engine refuses any keyword it does not know, and the `x-…` extension
 *   keywords Workglow schemas carry (`x-ui-manual`, `x-auto-generated`) are
 *   annotations that never constrain a value, so they are left out.
 *
 * It walks schema positions only: a property that happens to be called `x-api-key`
 * stays, and a `const`, `enum` or `default` value that looks like a schema is data.
 */
function embedSchema(schema: unknown, pointer: string, root: string): unknown {
  if (Array.isArray(schema)) {
    return schema.map((item, index) => embedSchema(item, `${pointer}/${index}`, root));
  }
  if (schema === null || typeof schema !== "object") return schema;
  const out: Record<string, unknown> = {};
  for (const [keyword, value] of Object.entries(schema)) {
    if (keyword.startsWith("x-")) continue;
    const at = `${pointer}/${pointerSegment(keyword)}`;
    if (keyword === "$ref" && typeof value === "string" && value.startsWith("#")) {
      out[keyword] = `${root}${value.slice(1)}`;
    } else if (SCHEMA_MAP_KEYWORDS.has(keyword) && value !== null && typeof value === "object") {
      out[keyword] = Object.fromEntries(
        Object.entries(value).map(([name, child]) => [
          name,
          // draft-07 `dependencies` maps a property to a list of names or a schema.
          Array.isArray(child) && keyword === "dependencies"
            ? child
            : embedSchema(child, `${at}/${pointerSegment(name)}`, root),
        ])
      );
    } else if (SCHEMA_KEYWORDS.has(keyword)) {
      out[keyword] = embedSchema(value, at, root);
    } else {
      out[keyword] = value;
    }
  }
  return out;
}

function singleCallSchema(tool: ToolDefinition): Record<string, unknown> {
  const root = "#/properties/arguments";
  return {
    type: "object",
    properties: {
      name: { const: tool.name },
      arguments: embedSchema(tool.inputSchema, root, root),
    },
    required: ["name", "arguments"],
    additionalProperties: false,
  };
}

/**
 * One call out of several tools. The name is an `enum`, which the engine prunes
 * token by token, so a name that is not a tool's is impossible to write. A
 * root `oneOf` of per-tool envelopes reads the same on paper but is only checked
 * when the object closes: until then any key and any name is allowed, and a
 * model that drifts finds the only legal token left is whitespace.
 *
 * Each tool's schema sits under `$defs`, not inside the `allOf` array that picks
 * it: the engine resolves a `$ref` pointer through objects only, so a schema
 * reachable only through an array index could not use its own `$defs`.
 */
function manyCallSchema(tools: ReadonlyArray<ToolDefinition>): Record<string, unknown> {
  const roots = tools.map((_, index) => `#/$defs/arguments${index}`);
  return {
    type: "object",
    properties: {
      name: { enum: tools.map((tool) => tool.name) },
      arguments: { type: "object" },
    },
    required: ["name", "arguments"],
    additionalProperties: false,
    allOf: tools.map((tool, index) => ({
      if: { properties: { name: { const: tool.name } }, required: ["name"] },
      then: { properties: { arguments: { $ref: roots[index] } } },
    })),
    $defs: Object.fromEntries(
      tools.map((tool, index) => [
        `arguments${index}`,
        embedSchema(tool.inputSchema, roots[index]!, roots[index]!),
      ])
    ),
  };
}

/**
 * The engine keys its per-schema mask cache on the schema object, so a fresh
 * envelope each turn recomputes every mask: about a second per call on a
 * 150k-token vocabulary, against tens of milliseconds for a schema it has seen.
 * Turns arrive through a worker as new copies of the same tools, so the object
 * is found by content.
 */
const ENVELOPE_CACHE_SIZE = 16;
const envelopes = new Map<string, Record<string, unknown>>();

function callSchema(tools: ReadonlyArray<ToolDefinition>): Record<string, unknown> {
  const key = JSON.stringify(tools.map((tool) => [tool.name, tool.inputSchema]));
  const cached = envelopes.get(key);
  if (cached !== undefined) {
    envelopes.delete(key);
    envelopes.set(key, cached);
    return cached;
  }
  const schema = tools.length === 1 ? singleCallSchema(tools[0]!) : manyCallSchema(tools);
  envelopes.set(key, schema);
  if (envelopes.size > ENVELOPE_CACHE_SIZE) {
    envelopes.delete(envelopes.keys().next().value!);
  }
  return schema;
}

/**
 * The tools a forced turn may call, by the same rule the prompt used to list
 * them: a checkpoint carries the shared tools, and the call's own list wins
 * only when it names the tool asked for.
 */
function candidateTools(
  input: ToolCallingTaskInput,
  prefix: CheckpointPrefix | undefined
): ReadonlyArray<ToolDefinition> {
  const toolChoice = input.toolChoice;
  if (toolChoice === "required") {
    return prefix?.tools && prefix.tools.length > 0 ? prefix.tools : (input.tools ?? []);
  }
  if (typeof toolChoice !== "string" || toolChoice === "auto" || toolChoice === "none") return [];
  const named = (tools: ReadonlyArray<ToolDefinition>): ToolDefinition[] =>
    tools.filter((tool) => tool.name === toolChoice);
  const own = named(input.tools ?? []);
  return own.length > 0 ? own : named(prefix?.tools ?? []);
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
 * JSON-in-tag one. A checkpoint's history and tools live on `prefix`, not on
 * the call, so both are read from there too.
 */
export function resolveConstrainedToolCall(
  input: ToolCallingTaskInput,
  family: string | null,
  modelTexts: ReadonlyArray<string>,
  prompt: string,
  prefix: CheckpointPrefix | undefined
): ConstrainedToolCall | undefined {
  if (family === null || !JSON_TAG_FAMILIES.has(family)) return undefined;
  if (modelTexts.some((text) => QWEN_XML_MARKER.test(text))) return undefined;
  const history = [...(prefix?.messages ?? []), ...(input.messages ?? [])];
  if (history.some((message) => message.role === "tool")) return undefined;
  if (prompt.trimEnd().endsWith("<think>")) return undefined;

  const candidates = candidateTools(input, prefix);
  if (candidates.length === 0) return undefined;

  return {
    prefix: HFT_TOOL_CALL_OPEN,
    suffix: HFT_TOOL_CALL_CLOSE,
    schema: callSchema(candidates),
  };
}
