/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { setLogger } from "@workglow/util";
import type { DataPortSchema } from "@workglow/util/schema";
import {
  validateDataPortSchema,
  validateFormatAnnotations,
  validateSchema,
} from "@workglow/util/schema";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, it } from "vitest";

describe("SchemaValidation", () => {
  const logger = getTestingLogger();
  setLogger(logger);

  describe("validateDataPortSchema", () => {
    it("should accept boolean true schema", () => {
      const result = validateDataPortSchema(true);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should accept boolean false schema", () => {
      const result = validateDataPortSchema(false);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should accept a valid object schema with properties", () => {
      const schema: DataPortSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "number" },
        },
      } as const satisfies DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should accept a valid schema with empty properties", () => {
      const schema: DataPortSchema = {
        type: "object",
        properties: {},
        additionalProperties: false,
      } as const satisfies DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(true);
    });

    it("should reject a schema missing type object", () => {
      const schema = {
        type: "string",
        properties: {},
      } as unknown as DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === "/type")).toBe(true);
    });

    it("should reject a schema missing properties", () => {
      const schema = {
        type: "object",
      } as unknown as DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === "/properties")).toBe(true);
    });

    it("should reject boolean property values", () => {
      const schema = {
        type: "object",
        properties: {
          allowed: true,
        },
      } as unknown as DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === "/properties/allowed")).toBe(true);
    });

    it("should detect unknown JSON Schema types in properties", () => {
      const schema = {
        type: "object",
        properties: {
          field: { type: "invalid_type" },
        },
      } as unknown as DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.message.includes("Unknown JSON Schema type"))).toBe(true);
    });

    it("should accept valid nested object schemas", () => {
      const schema: DataPortSchema = {
        type: "object",
        properties: {
          nested: {
            type: "object",
            properties: {
              inner: { type: "string" },
            },
          },
        },
      } as const satisfies DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(true);
    });

    it("should accept schemas with array properties", () => {
      const schema: DataPortSchema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "string" },
          },
        },
      } as const satisfies DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(true);
    });

    it("should accept schemas with oneOf/anyOf/allOf", () => {
      const schema: DataPortSchema = {
        type: "object",
        properties: {
          value: {
            oneOf: [{ type: "string" }, { type: "number" }],
          },
        },
      } as const satisfies DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(true);
    });

    it("should reject an array passed as properties", () => {
      const schema = {
        type: "object",
        properties: ["not", "a", "record"],
      } as unknown as DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.path === "/properties")).toBe(true);
    });

    it("should report null property values as errors", () => {
      const schema = {
        type: "object",
        properties: {
          field: null,
        },
      } as unknown as DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) => e.path === "/properties/field" && e.message.includes("Expected schema object")
        )
      ).toBe(true);
    });

    it("should report undefined property values as errors", () => {
      const schema = {
        type: "object",
        properties: {
          field: undefined,
        },
      } as unknown as DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) => e.path === "/properties/field" && e.message.includes("Expected schema object")
        )
      ).toBe(true);
    });

    it("should report array property values as errors", () => {
      const schema = {
        type: "object",
        properties: {
          field: [],
        },
      } as unknown as DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(false);
      expect(
        result.errors.some(
          (e) => e.path === "/properties/field" && e.message.includes("Expected schema object")
        )
      ).toBe(true);
    });

    it("should detect unknown types in deeply nested schemas", () => {
      const schema = {
        type: "object",
        properties: {
          items: {
            type: "array",
            items: { type: "badtype" },
          },
        },
      } as unknown as DataPortSchema;

      const result = validateDataPortSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe("/properties/items/items/type");
    });
  });

  describe("validateFormatAnnotations", () => {
    it("should accept boolean schemas", () => {
      expect(validateFormatAnnotations(true).valid).toBe(true);
      expect(validateFormatAnnotations(false).valid).toBe(true);
    });

    it("should accept valid format annotations", () => {
      const schema: DataPortSchema = {
        type: "object",
        properties: {
          model: { type: "string", format: "model" },
          embedding: { type: "string", format: "model:EmbeddingTask" },
          repo: { type: "string", format: "storage:tabular" },
          kb: { type: "string", format: "knowledge-base" },
          cred: { type: "string", format: "credential" },
          url: { type: "string", format: "uri" },
          dt: { type: "string", format: "date-time" },
        },
      } as const satisfies DataPortSchema;

      const result = validateFormatAnnotations(schema);
      expect(result.valid).toBe(true);
    });

    it("should accept a capability list as a narrowing segment", () => {
      const schema: DataPortSchema = {
        type: "object",
        properties: {
          one: { type: "string", format: "model:text.generation" },
          two: { type: "string", format: "model:text.generation,tool-use" },
          three: { type: "string", format: "model:text.generation,tool-use,json-mode" },
        },
      } as const satisfies DataPortSchema;

      expect(validateFormatAnnotations(schema).valid).toBe(true);
    });

    it("should reject a capability list with an empty tag", () => {
      for (const format of [
        "model:text.generation,",
        "model:,tool-use",
        "model:text..generation",
        "model:text.",
        "model:a,,b",
        "model.text",
      ]) {
        const schema = {
          type: "object",
          properties: { field: { type: "string", format } },
        } as unknown as DataPortSchema;
        expect(validateFormatAnnotations(schema).valid, format).toBe(false);
      }
    });

    it("should reject empty format string", () => {
      const schema = {
        type: "object",
        properties: {
          field: { type: "string", format: "" },
        },
      } as unknown as DataPortSchema;

      const result = validateFormatAnnotations(schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe("/properties/field/format");
    });

    it("should reject format starting with a number", () => {
      const schema = {
        type: "object",
        properties: {
          field: { type: "string", format: "123abc" },
        },
      } as unknown as DataPortSchema;

      const result = validateFormatAnnotations(schema);
      expect(result.valid).toBe(false);
    });

    it("should reject format with double colons", () => {
      const schema = {
        type: "object",
        properties: {
          field: { type: "string", format: "model::sub" },
        },
      } as unknown as DataPortSchema;

      const result = validateFormatAnnotations(schema);
      expect(result.valid).toBe(false);
    });

    it("should reject format with special characters", () => {
      const schema = {
        type: "object",
        properties: {
          field: { type: "string", format: "model@special" },
        },
      } as unknown as DataPortSchema;

      const result = validateFormatAnnotations(schema);
      expect(result.valid).toBe(false);
    });

    it("should validate formats in nested array items", () => {
      const schema = {
        type: "object",
        properties: {
          vectors: {
            type: "array",
            items: { type: "number", format: "!!bad!!" },
          },
        },
      } as unknown as DataPortSchema;

      const result = validateFormatAnnotations(schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe("/properties/vectors/items/format");
    });

    it("should validate formats inside oneOf", () => {
      const schema = {
        type: "object",
        properties: {
          value: {
            oneOf: [
              { type: "string", format: "model" },
              { type: "string", format: "bad format!" },
            ],
          },
        },
      } as unknown as DataPortSchema;

      const result = validateFormatAnnotations(schema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].path).toBe("/properties/value/oneOf/1/format");
    });

    it("should accept format on array type itself", () => {
      const schema: DataPortSchema = {
        type: "object",
        properties: {
          vector: {
            type: "array",
            items: { type: "number" },
            format: "TypedArray:Float32Array",
          },
        },
      } as const satisfies DataPortSchema;

      const result = validateFormatAnnotations(schema);
      expect(result.valid).toBe(true);
    });

    it("should reject null cast as schema", () => {
      const result = validateFormatAnnotations(null as unknown as DataPortSchema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain("Schema must be a JSON Schema object or boolean");
    });

    it("should reject an array cast as schema", () => {
      const result = validateFormatAnnotations([] as unknown as DataPortSchema);
      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain("Schema must be a JSON Schema object or boolean");
    });

    it("should accept schemas with no format annotations", () => {
      const schema: DataPortSchema = {
        type: "object",
        properties: {
          name: { type: "string" },
          count: { type: "number" },
        },
      } as const satisfies DataPortSchema;

      const result = validateFormatAnnotations(schema);
      expect(result.valid).toBe(true);
    });
  });

  describe("validateSchema", () => {
    it("should pass for a well-formed schema with valid formats", () => {
      const schema: DataPortSchema = {
        type: "object",
        properties: {
          model: { type: "string", format: "model:EmbeddingTask" },
          text: { type: "string" },
        },
      } as const satisfies DataPortSchema;

      const result = validateSchema(schema);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should accumulate errors from both structure and format checks", () => {
      const schema = {
        type: "string",
        properties: {
          field: { type: "string", format: "!!invalid!!" },
        },
      } as unknown as DataPortSchema;

      const result = validateSchema(schema);
      expect(result.valid).toBe(false);
      // Should have at least one structural error (type not "object") and one format error
      expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });

    it("should pass for boolean schemas", () => {
      expect(validateSchema(true).valid).toBe(true);
      expect(validateSchema(false).valid).toBe(true);
    });

    it("should pass for typical task schemas", () => {
      // Mimics a real task's inputSchema
      const inputSchema: DataPortSchema = {
        type: "object",
        properties: {
          model: { type: "string", format: "model" },
          text: { type: "string" },
          temperature: { type: "number" },
        },
        required: ["model", "text"],
      } as const satisfies DataPortSchema;

      const outputSchema: DataPortSchema = {
        type: "object",
        properties: {
          result: { type: "string" },
        },
      } as const satisfies DataPortSchema;

      expect(validateSchema(inputSchema).valid).toBe(true);
      expect(validateSchema(outputSchema).valid).toBe(true);
    });
  });
});
