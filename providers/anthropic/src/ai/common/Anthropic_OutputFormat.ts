/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AnthropicModelConfig } from "./Anthropic_ModelSchema";
import type { AnthropicCapabilityResolution } from "./Anthropic_RequestParams";
import {
  ANTHROPIC_KNOWN_FAMILIES,
  ANTHROPIC_LATEST_KNOWN_MAJOR,
  anthropicCapabilityOverride,
  parsedModelName,
} from "./Anthropic_RequestParams";

/**
 * Native structured outputs: `output_config.format = {type: "json_schema"}`.
 *
 * The response is constrained to the schema as it is generated, so it parses
 * and conforms by construction — the synthetic-tool route it replaces could
 * only ask. It also leaves `tool_choice` alone, which matters twice over: the
 * newest models reject a forced tool choice outright, and a forced choice
 * cannot carry extended thinking.
 */

/** Generation-4 minors that accept `output_config.format`, per family. */
const GENERATION_4_OUTPUT_FORMAT_MINORS: Readonly<Record<string, readonly number[]>> = {
  opus: [8, 5, 1],
  haiku: [5],
  sonnet: [],
  fable: [],
  mythos: [],
};

/**
 * Whether the configured model accepts `output_config.format`, and how that was
 * decided. `provider_config.supports_output_format` overrides everything;
 * otherwise the id is read against the tables.
 *
 * Generation 5 and later in every family; in generation 4, Opus 4.8, Opus 4.5,
 * Opus 4.1 and Haiku 4.5. Opus 4.7, Opus 4.6 and the Sonnet 4.x line keep the
 * tool route. A wrong `true` is a 400 and a wrong `false` costs only the older
 * route, so an id the parser cannot read, or a generation-4 family the table
 * does not name, answers `false`. A generation beyond the newest the table
 * knows, or a generation-5 family it does not name, answers `true`: the newest
 * known generation supports it and rejects a forced tool choice, and a future
 * id is assumed to behave as that one does (see `resolveAnthropicForcedToolChoice`).
 */
export function resolveAnthropicOutputFormatSupport(
  model: AnthropicModelConfig | undefined
): AnthropicCapabilityResolution {
  const override = anthropicCapabilityOverride(model, "supports_output_format");
  if (override !== undefined) return override;
  const parsed = parsedModelName(model);
  if (parsed === undefined) return { value: false, source: "default" };
  if (parsed.major < 4) return { value: false, source: "table" };
  const known = ANTHROPIC_KNOWN_FAMILIES.has(parsed.family);
  if (parsed.major === 4) {
    const minors = GENERATION_4_OUTPUT_FORMAT_MINORS[parsed.family];
    if (!known || minors === undefined) return { value: false, source: "default" };
    return { value: minors.includes(parsed.minor ?? 0), source: "table" };
  }
  return {
    value: true,
    source: known && parsed.major <= ANTHROPIC_LATEST_KNOWN_MAJOR ? "table" : "default",
  };
}

export function anthropicSupportsOutputFormat(model: AnthropicModelConfig | undefined): boolean {
  return resolveAnthropicOutputFormatSupport(model).value;
}

/**
 * Keywords the constrained decoder does not accept. They are dropped from the
 * schema sent to the API and remain in force where the caller validates the
 * result against its own, full schema.
 */
const DROPPED_KEYWORDS = new Set([
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "minProperties",
  "maxProperties",
]);

/** Keywords whose meaning the API has no way to express: such a schema keeps the tool route. */
const INEXPRESSIBLE_KEYWORDS = new Set([
  "patternProperties",
  "propertyNames",
  "dependentSchemas",
  "dependentRequired",
  "if",
  "then",
  "else",
  "not",
  "$dynamicRef",
  "$recursiveRef",
  "unevaluatedProperties",
  "unevaluatedItems",
]);

/** String formats the API accepts; any other `format` is dropped. */
const SUPPORTED_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

class Inexpressible extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Whether a local `$ref` chain leads back to a definition already being expanded. */
function hasRefCycle(root: Record<string, unknown>): boolean {
  const resolve = (ref: string): unknown =>
    ref
      .replace(/^#\/?/, "")
      .split("/")
      .filter((part) => part.length > 0)
      .reduce<unknown>(
        (node, part) =>
          isRecord(node) ? node[part.replace(/~1/g, "/").replace(/~0/g, "~")] : undefined,
        root
      );
  // `open` holds refs on the current path, `done` refs whose whole subtree was
  // explored without finding a cycle. Without `done`, a definition referenced
  // twice by each of N levels is re-expanded 2^N times.
  const open = new Set<string>();
  const done = new Set<string>();
  const visit = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(visit);
    if (!isRecord(node)) return false;
    const ref = node.$ref;
    if (typeof ref === "string" && ref.startsWith("#") && !done.has(ref)) {
      if (open.has(ref)) return true;
      open.add(ref);
      if (visit(resolve(ref))) return true;
      open.delete(ref);
      done.add(ref);
    }
    return Object.entries(node).some(([key, child]) => key !== "$ref" && visit(child));
  };
  return visit(root);
}

function adapt(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(adapt);
  if (!isRecord(node)) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) {
    if (INEXPRESSIBLE_KEYWORDS.has(key)) throw new Inexpressible(key);
    if (DROPPED_KEYWORDS.has(key)) continue;
    if (key === "format" && (typeof value !== "string" || !SUPPORTED_FORMATS.has(value))) continue;
    // `minItems` is accepted only as 0 or 1.
    if (key === "minItems" && (typeof value !== "number" || value > 1)) continue;
    // One-of is any-of plus exclusivity the caller's validator still checks.
    if (key === "oneOf") {
      out.anyOf = adapt(value);
      continue;
    }
    // Literal values, not schemas: copied as written.
    if (key === "enum" || key === "const" || key === "default" || key === "examples") {
      out[key] = value;
      continue;
    }
    if (key === "properties" || key === "$defs" || key === "definitions") {
      out[key] = isRecord(value)
        ? Object.fromEntries(Object.entries(value).map(([name, child]) => [name, adapt(child)]))
        : value;
      continue;
    }
    if (key === "additionalProperties") {
      // A map-shaped object (`additionalProperties: {schema}`) has no equivalent.
      if (value !== false && value !== undefined) throw new Inexpressible(key);
      continue;
    }
    out[key] = adapt(value);
  }
  const isObject =
    out.type === "object" ||
    (Array.isArray(out.type) && out.type.includes("object")) ||
    isRecord(out.properties);
  if (isObject) out.additionalProperties = false;
  return out;
}

/**
 * The caller's JSON Schema in the form `output_config.format` accepts, or
 * undefined when it cannot be expressed there — recursion, a map-shaped
 * object, a conditional — and the request should take the tool route instead.
 *
 * Every object is closed with `additionalProperties: false`, which the API
 * requires; constraints the decoder does not support are dropped and left to
 * the caller's own validation of the result.
 */
export function toAnthropicOutputSchema(schema: unknown): Record<string, unknown> | undefined {
  if (!isRecord(schema)) return undefined;
  if (hasRefCycle(schema)) return undefined;
  try {
    const adapted = adapt(schema);
    return isRecord(adapted) ? adapted : undefined;
  } catch (err) {
    if (err instanceof Inexpressible) return undefined;
    throw err;
  }
}

/** The `output_config.format` fragment for a schema already adapted by {@link toAnthropicOutputSchema}. */
export function anthropicJsonSchemaFormat(schema: Record<string, unknown>): {
  readonly type: "json_schema";
  readonly schema: Record<string, unknown>;
} {
  return { type: "json_schema", schema };
}
