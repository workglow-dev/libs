/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { setLogger } from "@workglow/util";
import type { JsonSchema } from "@workglow/util/schema";
import {
  areObjectSchemasSemanticallyCompatible,
  areSemanticallyCompatible,
} from "@workglow/util/schema";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, it } from "vitest";

describe("SchemaUtils", () => {
  let logger = getTestingLogger();
  setLogger(logger);
  describe("areSemanticallyCompatible", () => {
    describe("boolean schemas", () => {
      it("should return incompatible when target is false", () => {
        const source: JsonSchema = { type: "string" };
        const target: JsonSchema = false;

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should return static when target is true (accepts anything)", () => {
        const source: JsonSchema = { type: "string" };
        const target: JsonSchema = true;

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should return incompatible when source is false", () => {
        const source: JsonSchema = false;
        const target: JsonSchema = { type: "string" };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should return runtime when source is true (can be anything)", () => {
        const source: JsonSchema = true;
        const target: JsonSchema = { type: "string" };

        expect(areSemanticallyCompatible(source, target)).toBe("runtime");
      });

      it("should return runtime when source is true and target has semantic annotation", () => {
        const source: JsonSchema = true;
        const target: JsonSchema = {
          type: "string",
          format: "model",
        };

        expect(areSemanticallyCompatible(source, target)).toBe("runtime");
      });
    });

    describe("capability-list formats", () => {
      const caps = "model:text.generation,tool-use";

      it("matches the same capability list statically", () => {
        const source: JsonSchema = { type: "string", format: caps };
        const target: JsonSchema = { type: "string", format: caps };
        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("narrows a plain model port at runtime", () => {
        const source: JsonSchema = { type: "string", format: "model" };
        const target: JsonSchema = { type: "string", format: caps };
        expect(areSemanticallyCompatible(source, target)).toBe("runtime");
      });

      it("feeds a plain model port statically", () => {
        const source: JsonSchema = { type: "string", format: caps };
        const target: JsonSchema = { type: "string", format: "model" };
        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });
    });

    describe("allOf in source", () => {
      it("should return incompatible if any allOf schema is incompatible", () => {
        const source: JsonSchema = {
          allOf: [
            { type: "string" },
            { type: "number" }, // incompatible with target
          ],
        };
        const target: JsonSchema = { type: "string" };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should return runtime if any allOf schema requires runtime check", () => {
        const source = {
          allOf: [{ type: "string", format: "model" }, { type: "string" }],
        } as const satisfies JsonSchema;
        const target = {
          type: "string",
          format: "model:EmbeddingTask",
        } as const satisfies JsonSchema;

        expect(areSemanticallyCompatible(source, target)).toBe("runtime");
      });

      it("should return static if all allOf schemas are statically compatible", () => {
        const source: JsonSchema = {
          allOf: [{ type: "string" }, { type: "string" }],
        };
        const target: JsonSchema = { type: "string" };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });
    });

    describe("allOf in target", () => {
      it("should return incompatible if source is incompatible with any allOf schema", () => {
        const source: JsonSchema = { type: "string" };
        const target: JsonSchema = {
          allOf: [{ type: "number" }], // incompatible
        };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should return runtime if source requires runtime check with any allOf schema", () => {
        const source: JsonSchema = { type: "string", format: "model" };
        const target: JsonSchema = {
          allOf: [{ type: "string", format: "model:EmbeddingTask" }, { type: "string" }],
        };

        expect(areSemanticallyCompatible(source, target)).toBe("runtime");
      });

      it("should return static if source is compatible with all allOf schemas", () => {
        const source: JsonSchema = { type: "string" };
        const target: JsonSchema = {
          allOf: [{ type: "string" }, { type: "string" }],
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });
    });

    describe("oneOf/anyOf in target", () => {
      it("should return static when source is compatible with any oneOf option", () => {
        const source: JsonSchema = { type: "string" };
        const target: JsonSchema = {
          oneOf: [{ type: "string" }, { type: "number" }],
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should return runtime when source requires runtime check with oneOf", () => {
        const source: JsonSchema = { type: "string", format: "model" };
        const target: JsonSchema = {
          oneOf: [{ type: "string", format: "model:EmbeddingTask" }, { type: "number" }],
        };

        expect(areSemanticallyCompatible(source, target)).toBe("runtime");
      });

      it("should return incompatible when source is incompatible with all oneOf options", () => {
        const source: JsonSchema = { type: "boolean" };
        const target: JsonSchema = {
          oneOf: [{ type: "string" }, { type: "number" }],
        };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should work with anyOf similar to oneOf", () => {
        const source: JsonSchema = { type: "string" };
        const target: JsonSchema = {
          anyOf: [{ type: "string" }, { type: "number" }],
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });
    });

    describe("object schemas", () => {
      it("should return static when target has no properties constraint", () => {
        const source: JsonSchema = {
          type: "object",
          properties: { foo: { type: "string" } },
        };
        const target: JsonSchema = { type: "object" };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should return incompatible when source has no properties but target requires specific properties", () => {
        const source: JsonSchema = { type: "object" };
        const target: JsonSchema = {
          type: "object",
          properties: { foo: { type: "string" } },
          required: ["foo"],
          additionalProperties: false,
        };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should return static when source has no properties but target allows additional properties", () => {
        const source: JsonSchema = { type: "object" };
        const target: JsonSchema = {
          type: "object",
          properties: { foo: { type: "string" } },
          additionalProperties: true,
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should return incompatible when target requires a property that source doesn't have", () => {
        const source: JsonSchema = {
          type: "object",
          properties: { bar: { type: "string" } },
        };
        const target: JsonSchema = {
          type: "object",
          properties: { foo: { type: "string" } },
          required: ["foo"],
        };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should return static when all required properties are compatible", () => {
        const source: JsonSchema = {
          type: "object",
          properties: {
            foo: { type: "string" },
            bar: { type: "number" },
          },
        };
        const target: JsonSchema = {
          type: "object",
          properties: {
            foo: { type: "string" },
            bar: { type: "number" },
          },
          required: ["foo", "bar"],
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should return runtime when property compatibility requires runtime check", () => {
        const source: JsonSchema = {
          type: "object",
          properties: {
            model: { type: "string", format: "model" },
          },
        };
        const target: JsonSchema = {
          type: "object",
          properties: {
            model: { type: "string", format: "model:EmbeddingTask" },
          },
          required: ["model"],
        };

        expect(areSemanticallyCompatible(source, target)).toBe("runtime");
      });

      it("should return incompatible when source has extra properties and target doesn't allow additional properties", () => {
        const source: JsonSchema = {
          type: "object",
          properties: {
            foo: { type: "string" },
            extra: { type: "string" },
          },
        };
        const target: JsonSchema = {
          type: "object",
          properties: {
            foo: { type: "string" },
          },
          additionalProperties: false,
        };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should return static when source has extra properties but target allows additional properties", () => {
        const source: JsonSchema = {
          type: "object",
          properties: {
            foo: { type: "string" },
            extra: { type: "string" },
          },
        };
        const target: JsonSchema = {
          type: "object",
          properties: {
            foo: { type: "string" },
          },
          additionalProperties: true,
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should return static when target has optional properties that source doesn't have", () => {
        const source: JsonSchema = {
          type: "object",
          properties: {
            foo: { type: "string" },
          },
        };
        const target: JsonSchema = {
          type: "object",
          properties: {
            foo: { type: "string" },
            bar: { type: "number" }, // optional (not in required)
          },
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should reject an optional target property present on source with an incompatible type", () => {
        const source: JsonSchema = {
          type: "object",
          properties: {
            count: { type: "string" },
          },
        };
        const target: JsonSchema = {
          type: "object",
          properties: {
            count: { type: "number" }, // optional (not required) but present on source
          },
        };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should mark runtime when an optional shared property narrows via format", () => {
        const source: JsonSchema = {
          type: "object",
          properties: {
            model: { type: "string", format: "model" },
          },
        };
        const target: JsonSchema = {
          type: "object",
          properties: {
            model: { type: "string", format: "model:EmbeddingTask" }, // optional
          },
        };

        expect(areSemanticallyCompatible(source, target)).toBe("runtime");
      });
    });

    describe("array schemas", () => {
      it("should return static when both arrays have compatible item types", () => {
        const source: JsonSchema = {
          type: "array",
          items: { type: "string" },
        };
        const target: JsonSchema = {
          type: "array",
          items: { type: "string" },
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should return runtime when array items require runtime check", () => {
        const source: JsonSchema = {
          type: "array",
          items: { type: "string", format: "model" },
        };
        const target: JsonSchema = {
          type: "array",
          items: { type: "string", format: "model:EmbeddingTask" },
        };

        expect(areSemanticallyCompatible(source, target)).toBe("runtime");
      });

      it("should return static when target accepts any array items", () => {
        const source: JsonSchema = {
          type: "array",
          items: { type: "string" },
        };
        const target: JsonSchema = { type: "array" };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should return incompatible when source has no items but target requires specific items", () => {
        const source: JsonSchema = { type: "array" };
        const target: JsonSchema = {
          type: "array",
          items: { type: "string" },
        };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should require a uniform source to satisfy every tuple position", () => {
        // A uniform string[] source cannot satisfy a [string, number] tuple
        // target: every element must fit every position, and string ≠ number.
        const source: JsonSchema = {
          type: "array",
          items: { type: "string" },
        };
        const target: JsonSchema = {
          type: "array",
          items: [{ type: "string" }, { type: "number" }],
        };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should accept a uniform source matching every tuple position statically", () => {
        const source: JsonSchema = {
          type: "array",
          items: { type: "string" },
        };
        const target: JsonSchema = {
          type: "array",
          items: [{ type: "string" }, { type: "string" }],
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should mark a uniform source as runtime when a tuple position narrows", () => {
        const source: JsonSchema = {
          type: "array",
          items: { type: "string", format: "model" },
        };
        const target: JsonSchema = {
          type: "array",
          items: [
            { type: "string", format: "model" },
            { type: "string", format: "model:EmbeddingTask" },
          ],
        };

        expect(areSemanticallyCompatible(source, target)).toBe("runtime");
      });

      it("should return incompatible when array items are incompatible", () => {
        const source: JsonSchema = {
          type: "array",
          items: { type: "string" },
        };
        const target: JsonSchema = {
          type: "array",
          items: { type: "number" },
        };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      describe("typed arrays with semantic annotations", () => {
        it("should return incompatible when typed arrays with different item semantic annotations but same base type", () => {
          // Both are number arrays, just different semantic annotations
          const source: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Float64" },
          };
          const target: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Float32" },
          };

          expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
        });

        it("should return static when typed arrays match exactly", () => {
          const source: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Float64" },
            format: "Float64Array",
          };
          const target: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Float64" },
            format: "Float64Array",
          };

          expect(areSemanticallyCompatible(source, target)).toBe("static");
        });

        it("should return incompatible when generic number array connects to typed array", () => {
          const source: JsonSchema = {
            type: "array",
            items: { type: "number" },
          };
          const target: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Float64" },
          };

          expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
        });

        it("should return static when typed array connects to generic number array", () => {
          const source: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Float64" },
          };
          const target: JsonSchema = {
            type: "array",
            items: { type: "number" },
          };

          expect(areSemanticallyCompatible(source, target)).toBe("static");
        });

        it("should return static when typed array matches anyOf typed array schema", () => {
          const source: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Float64" },
            format: "Float64Array",
          };
          const target: JsonSchema = {
            anyOf: [
              {
                type: "array",
                items: { type: "number", format: "Float64" },
                format: "Float64Array",
              },
              {
                type: "array",
                items: { type: "number", format: "Float32" },
                format: "Float32Array",
              },
            ],
          };

          expect(areSemanticallyCompatible(source, target)).toBe("static");
        });

        it("should return static when typed array matches another typed array in anyOf", () => {
          const source: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Int32" },
            format: "Int32Array",
          };
          const target: JsonSchema = {
            anyOf: [
              {
                type: "array",
                items: { type: "number", format: "Float64" },
                format: "Float64Array",
              },
              {
                type: "array",
                items: { type: "number", format: "Float32" },
                format: "Float32Array",
              },
              {
                type: "array",
                items: { type: "number", format: "Int32" },
                format: "Int32Array",
              },
            ],
          };

          expect(areSemanticallyCompatible(source, target)).toBe("static");
        });

        it("should return incompatible when generic number array connects to anyOf typed array schema", () => {
          const source: JsonSchema = {
            type: "array",
            items: { type: "number" },
          };
          const target: JsonSchema = {
            anyOf: [
              {
                type: "array",
                items: { type: "number", format: "Float64" },
                format: "Float64Array",
              },
              {
                type: "array",
                items: { type: "number", format: "Float32" },
                format: "Float32Array",
              },
            ],
          };

          expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
        });

        it("should return static when oneOf typed array schema connects to typed array", () => {
          const source: JsonSchema = {
            oneOf: [
              {
                type: "array",
                items: { type: "number", format: "Float64" },
                format: "Float64Array",
              },
              {
                type: "array",
                items: { type: "number", format: "Float32" },
                format: "Float32Array",
              },
            ],
          };
          const target: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Float64" },
            format: "Float64Array",
          };

          expect(areSemanticallyCompatible(source, target)).toBe("static");
        });

        it("should handle Uint8Array typed arrays", () => {
          const source: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Uint8" },
            format: "Uint8Array",
          };
          const target: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Uint8" },
            format: "Uint8Array",
          };

          expect(areSemanticallyCompatible(source, target)).toBe("static");
        });

        it("should handle Int16Array typed arrays", () => {
          const source: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Int16" },
            format: "Int16Array",
          };
          const target: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Int16" },
            format: "Int16Array",
          };

          expect(areSemanticallyCompatible(source, target)).toBe("static");
        });

        it("should return incompatible when different typed arrays with same item type connect", () => {
          // Different array-level semantics but same item type
          const source: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Float64" },
            format: "Float64Array",
          };
          const target: JsonSchema = {
            type: "array",
            items: { type: "number", format: "Float64" },
            format: "DifferentArrayType",
          };

          // Array-level semantics don't affect compatibility (only item semantics for strings)
          expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
        });
      });
    });

    describe("type compatibility", () => {
      it("should return static when types match exactly", () => {
        const source: JsonSchema = { type: "string" };
        const target: JsonSchema = { type: "string" };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should return incompatible when types don't match", () => {
        const source: JsonSchema = { type: "string" };
        const target: JsonSchema = { type: "number" };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should return static when target has no type constraint", () => {
        const source: JsonSchema = { type: "string" };
        const target: JsonSchema = {};

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should handle array types in type field", () => {
        const source: JsonSchema = { type: ["string", "number"] };
        const target: JsonSchema = { type: "string" };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should handle array types in target type field", () => {
        const source: JsonSchema = { type: "string" };
        const target: JsonSchema = { type: ["string", "number"] };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });
    });

    describe("format annotations", () => {
      it("should return static when semantic annotations match exactly", () => {
        const source: JsonSchema = {
          type: "string",
          format: "model",
        };
        const target: JsonSchema = {
          type: "string",
          format: "model",
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should return static when source has narrowing but target doesn't", () => {
        const source: JsonSchema = {
          type: "string",
          format: "model:EmbeddingTask",
        };
        const target: JsonSchema = {
          type: "string",
          format: "model",
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should return runtime when target has narrowing but source doesn't", () => {
        const source: JsonSchema = {
          type: "string",
          format: "model",
        };
        const target: JsonSchema = {
          type: "string",
          format: "model:EmbeddingTask",
        };

        expect(areSemanticallyCompatible(source, target)).toBe("runtime");
      });

      it("should return static when both have same narrowing", () => {
        const source: JsonSchema = {
          type: "string",
          format: "model:EmbeddingTask",
        };
        const target: JsonSchema = {
          type: "string",
          format: "model:EmbeddingTask",
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should return incompatible when semantic names differ", () => {
        const source: JsonSchema = {
          type: "string",
          format: "model",
        };
        const target: JsonSchema = {
          type: "string",
          format: "prompt",
        };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should return incompatible when narrowing differs", () => {
        const source: JsonSchema = {
          type: "string",
          format: "model:EmbeddingTask",
        };
        const target: JsonSchema = {
          type: "string",
          format: "model:TextGenerationTask",
        };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should compare the full multi-segment narrowing tail (incompatible)", () => {
        // Both share name `points` and first narrowing segment `3d`, but differ
        // in the third segment. The comparator must not collapse to `3d`.
        const source: JsonSchema = {
          type: "string",
          format: "points:3d:relative",
        };
        const target: JsonSchema = {
          type: "string",
          format: "points:3d:meters",
        };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should treat identical multi-segment narrowing as static", () => {
        const source: JsonSchema = {
          type: "string",
          format: "points:3d:meters",
        };
        const target: JsonSchema = {
          type: "string",
          format: "points:3d:meters",
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should check format compatibility for all types", () => {
        const source: JsonSchema = {
          type: "number",
          format: "model",
        };
        const target: JsonSchema = {
          type: "number",
          format: "prompt",
        };

        // Format annotations are checked for all types
        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should return static when only source has semantic annotation", () => {
        const source: JsonSchema = {
          type: "string",
          format: "model",
        };
        const target: JsonSchema = { type: "string" };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should return incompatible when only target has semantic annotation", () => {
        const source: JsonSchema = { type: "string" };
        const target: JsonSchema = {
          type: "string",
          format: "model",
        };

        expect(areSemanticallyCompatible(source, target)).toBe("incompatible");
      });

      it("should return static when source has no type but target has semantic annotation", () => {
        const source: JsonSchema = {};
        const target: JsonSchema = {
          type: "string",
          format: "model",
        };

        expect(areSemanticallyCompatible(source, target)).toBe("runtime");
      });
    });

    describe("edge cases", () => {
      it("should handle complex nested schemas", () => {
        const source: JsonSchema = {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                },
              },
            },
          },
        };
        const target: JsonSchema = {
          type: "object",
          properties: {
            items: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                },
              },
            },
          },
        };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should handle source with no type constraint", () => {
        const source: JsonSchema = {};
        const target: JsonSchema = { type: "string" };

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });

      it("should handle both schemas with no type constraint", () => {
        const source: JsonSchema = {};
        const target: JsonSchema = {};

        expect(areSemanticallyCompatible(source, target)).toBe("static");
      });
    });
  });

  describe("areObjectSchemasSemanticallyCompatible", () => {
    it("should be a wrapper around areSemanticallyCompatible", () => {
      const source: JsonSchema = {
        type: "object",
        properties: {
          foo: { type: "string" },
        },
      };
      const target: JsonSchema = {
        type: "object",
        properties: {
          foo: { type: "string" },
        },
      };

      expect(areObjectSchemasSemanticallyCompatible(source, target)).toBe("static");
    });

    it("should return the same result as areSemanticallyCompatible", () => {
      const source: JsonSchema = {
        type: "object",
        properties: {
          model: { type: "string", format: "model" },
        },
      };
      const target: JsonSchema = {
        type: "object",
        properties: {
          model: { type: "string", format: "model:EmbeddingTask" },
        },
        required: ["model"],
      };

      const objectResult = areObjectSchemasSemanticallyCompatible(source, target);
      const generalResult = areSemanticallyCompatible(source, target);

      expect(objectResult).toBe(generalResult);
      expect(objectResult).toBe("runtime");
    });
  });
});
