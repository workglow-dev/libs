/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

export { compileSchema } from "@sroussey/json-schema-library";
export type { SchemaNode } from "@sroussey/json-schema-library";

import type { DataPortSchema } from "./DataPortSchema";
import type { JsonSchema } from "./JsonSchema";

// ========================================================================
// Schema Validation Types
// ========================================================================

export interface SchemaValidationError {
  readonly path: string;
  readonly message: string;
}

export interface SchemaValidationResult {
  readonly valid: boolean;
  readonly errors: readonly SchemaValidationError[];
}

const VALID_RESULT: SchemaValidationResult = Object.freeze({
  valid: true,
  errors: Object.freeze([] as SchemaValidationError[]),
});

/**
 * Pattern for format annotations used in dataflow compatibility checking.
 * A base "name" (letter-led) optionally followed by one or more colon-separated
 * narrowing segments (each may start with a digit), e.g. `model`,
 * `model:EmbeddingTask`, `points:3d:meters`.
 *
 * A segment may also be a comma-separated list of dotted tags, so a model port
 * can state the capabilities it needs — `model:text.generation,tool-use` — in
 * the vocabulary model dispatch matches on, rather than naming a task whose
 * `requires` happens to imply them. Each tag still starts with a letter or
 * digit, so an empty tag (`a,,b`, `a.`) is refused like an empty segment.
 * Reused from SchemaUtils.ts areFormatStringsCompatible().
 */
export const FORMAT_PATTERN = /^[a-z][\w-]*(?::[a-z0-9][\w-]*(?:[.,][a-z0-9][\w-]*)*)*$/i;

const VALID_JSON_SCHEMA_TYPES = new Set([
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
]);

// ========================================================================
// Schema Structure Validation
// ========================================================================

/**
 * Validates that a schema is a well-formed DataPortSchema.
 *
 * A DataPortSchema must be either a boolean or an object with `type: "object"`
 * and a `properties` record where no property value is a boolean.
 */
export function validateDataPortSchema(schema: DataPortSchema): SchemaValidationResult {
  if (typeof schema === "boolean") {
    return VALID_RESULT;
  }

  const errors: SchemaValidationError[] = [];

  if (typeof schema !== "object" || schema === null) {
    return { valid: false, errors: [{ path: "", message: "Schema must be a boolean or object" }] };
  }

  if (schema.type !== "object") {
    errors.push({
      path: "/type",
      message: `DataPortSchema must have type "object", got "${String(schema.type)}"`,
    });
  }

  if (
    !schema.properties ||
    typeof schema.properties !== "object" ||
    Array.isArray(schema.properties)
  ) {
    errors.push({
      path: "/properties",
      message: "DataPortSchema must have a properties object",
    });
  } else {
    for (const [key, value] of Object.entries(schema.properties)) {
      if (typeof value === "boolean") {
        errors.push({
          path: `/properties/${key}`,
          message: `Property "${key}" must not be a boolean schema`,
        });
        continue;
      }
      collectJsonSchemaErrors(value as JsonSchema, `/properties/${key}`, errors);
    }
  }

  return errors.length === 0 ? VALID_RESULT : { valid: false, errors };
}

/**
 * Validates structural correctness of a JsonSchema value (property, items, etc.).
 * Checks that `type` (if present) is a known JSON Schema type.
 */
function collectJsonSchemaErrors(
  schema: JsonSchema,
  path: string,
  errors: SchemaValidationError[]
): void {
  if (typeof schema === "boolean") {
    return;
  }

  if (schema === null || schema === undefined) {
    errors.push({ path, message: `Expected schema object, got ${typeof schema}` });
    return;
  }

  if (typeof schema !== "object") {
    errors.push({ path, message: `Expected schema object, got ${typeof schema}` });
    return;
  }

  // Arrays are `typeof === "object"` but are not valid schema objects.
  if (Array.isArray(schema)) {
    errors.push({ path, message: `Expected schema object, got array` });
    return;
  }

  if (schema.type !== undefined) {
    if (typeof schema.type === "string") {
      if (!VALID_JSON_SCHEMA_TYPES.has(schema.type)) {
        errors.push({
          path: `${path}/type`,
          message: `Unknown JSON Schema type "${schema.type}"`,
        });
      }
    } else if (Array.isArray(schema.type)) {
      for (const t of schema.type) {
        if (!VALID_JSON_SCHEMA_TYPES.has(t as string)) {
          errors.push({
            path: `${path}/type`,
            message: `Unknown JSON Schema type "${String(t)}" in type array`,
          });
        }
      }
    }
  }

  if (schema.properties && typeof schema.properties === "object") {
    for (const [key, value] of Object.entries(schema.properties)) {
      // Boolean schemas are valid in nested JSON Schema, only DataPortSchema top-level forbids them.
      if (typeof value === "boolean") {
        continue;
      }
      collectJsonSchemaErrors(value as JsonSchema, `${path}/properties/${key}`, errors);
    }
  }

  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    collectJsonSchemaErrors(schema.items as JsonSchema, `${path}/items`, errors);
  }

  if (Array.isArray(schema.items)) {
    for (let i = 0; i < schema.items.length; i++) {
      collectJsonSchemaErrors(schema.items[i] as JsonSchema, `${path}/items/${i}`, errors);
    }
  }

  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    const arr = (schema as Record<string, unknown>)[keyword];
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        collectJsonSchemaErrors(arr[i] as JsonSchema, `${path}/${keyword}/${i}`, errors);
      }
    }
  }
}

// ========================================================================
// Format Annotation Validation
// ========================================================================

/**
 * Validates that all `format` annotations in a schema match the expected pattern.
 *
 * Format annotations are validated against {@link FORMAT_PATTERN}
 * (`/^[a-z][\w-]*(?::[a-z0-9][\w-]*)*$/i`): a letter-led base name optionally
 * followed by one or more colon-separated narrowing segments, where a narrowing
 * segment may begin with a digit (e.g., `"model"`, `"model:EmbeddingTask"`,
 * `"storage:tabular"`, `"points:3d:meters"`).
 *
 * Standard JSON Schema formats (e.g., `"date-time"`, `"uri"`, `"email"`) also pass
 * since they match the pattern.
 */
export function validateFormatAnnotations(schema: DataPortSchema): SchemaValidationResult {
  if (typeof schema === "boolean") {
    return VALID_RESULT;
  }

  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    return {
      valid: false,
      errors: [{ path: "", message: "Schema must be a JSON Schema object or boolean" }],
    };
  }

  const errors: SchemaValidationError[] = [];
  collectFormatErrors(schema as JsonSchema, "", errors);
  return errors.length === 0 ? VALID_RESULT : { valid: false, errors };
}

function collectFormatErrors(
  schema: JsonSchema,
  path: string,
  errors: SchemaValidationError[]
): void {
  if (typeof schema !== "object" || schema === null) {
    return;
  }

  const format = (schema as Record<string, unknown>).format;
  if (typeof format === "string" && !FORMAT_PATTERN.test(format)) {
    errors.push({
      path: `${path}/format`,
      message: `Invalid format annotation "${format}" — must match pattern ${FORMAT_PATTERN.source}`,
    });
  }

  if (schema.properties && typeof schema.properties === "object") {
    for (const [key, value] of Object.entries(schema.properties)) {
      collectFormatErrors(value as JsonSchema, `${path}/properties/${key}`, errors);
    }
  }

  if (schema.items && typeof schema.items === "object" && !Array.isArray(schema.items)) {
    collectFormatErrors(schema.items as JsonSchema, `${path}/items`, errors);
  }

  if (Array.isArray(schema.items)) {
    for (let i = 0; i < schema.items.length; i++) {
      collectFormatErrors(schema.items[i] as JsonSchema, `${path}/items/${i}`, errors);
    }
  }

  for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
    const arr = (schema as Record<string, unknown>)[keyword];
    if (Array.isArray(arr)) {
      for (let i = 0; i < arr.length; i++) {
        collectFormatErrors(arr[i] as JsonSchema, `${path}/${keyword}/${i}`, errors);
      }
    }
  }
}

// ========================================================================
// Combined Validation
// ========================================================================

/**
 * Validates a DataPortSchema for both structural correctness and valid format annotations.
 * Convenience function combining {@link validateDataPortSchema} and {@link validateFormatAnnotations}.
 */
export function validateSchema(schema: DataPortSchema): SchemaValidationResult {
  if (typeof schema === "boolean") {
    return VALID_RESULT;
  }

  const structureResult = validateDataPortSchema(schema);
  const formatResult = validateFormatAnnotations(schema);

  const allErrors = [...structureResult.errors, ...formatResult.errors];
  return allErrors.length === 0 ? VALID_RESULT : { valid: false, errors: allErrors };
}
