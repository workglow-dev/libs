/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  conditionCompareValueError,
  evaluateCondition,
  getNestedValue,
} from "@workglow/task-graph";
import { setLogger } from "@workglow/util";
import { getTestingLogger } from "@workglow/util/test";
import { describe, expect, it } from "vitest";

// ============================================================================
// evaluateCondition
// ============================================================================

describe("ConditionUtils", () => {
  let logger = getTestingLogger();
  setLogger(logger);

  describe("evaluateCondition", () => {
    describe("equals", () => {
      it("should match equal strings", () => {
        expect(evaluateCondition("hello", "equals", "hello")).toBe(true);
      });

      it("should not match different strings", () => {
        expect(evaluateCondition("hello", "equals", "world")).toBe(false);
      });

      it("should match equal numbers via numeric comparison", () => {
        expect(evaluateCondition(42, "equals", "42")).toBe(true);
      });

      it("should match equal float numbers", () => {
        expect(evaluateCondition(3.14, "equals", "3.14")).toBe(true);
      });

      it("should not match different numbers", () => {
        expect(evaluateCondition(42, "equals", "43")).toBe(false);
      });
    });

    describe("not_equals", () => {
      it("should not match equal strings", () => {
        expect(evaluateCondition("hello", "not_equals", "hello")).toBe(false);
      });

      it("should match different strings", () => {
        expect(evaluateCondition("hello", "not_equals", "world")).toBe(true);
      });

      it("should not match equal numbers", () => {
        expect(evaluateCondition(42, "not_equals", "42")).toBe(false);
      });

      it("should match different numbers", () => {
        expect(evaluateCondition(42, "not_equals", "43")).toBe(true);
      });
    });

    describe("greater_than", () => {
      it("should return true when field is greater", () => {
        expect(evaluateCondition(10, "greater_than", "5")).toBe(true);
      });

      it("should return false when equal", () => {
        expect(evaluateCondition(5, "greater_than", "5")).toBe(false);
      });

      it("should return false when less", () => {
        expect(evaluateCondition(3, "greater_than", "5")).toBe(false);
      });
    });

    describe("greater_or_equal", () => {
      it("should return true when field is greater", () => {
        expect(evaluateCondition(10, "greater_or_equal", "5")).toBe(true);
      });

      it("should return true when equal", () => {
        expect(evaluateCondition(5, "greater_or_equal", "5")).toBe(true);
      });

      it("should return false when less", () => {
        expect(evaluateCondition(3, "greater_or_equal", "5")).toBe(false);
      });
    });

    describe("less_than", () => {
      it("should return true when field is less", () => {
        expect(evaluateCondition(3, "less_than", "5")).toBe(true);
      });

      it("should return false when equal", () => {
        expect(evaluateCondition(5, "less_than", "5")).toBe(false);
      });

      it("should return false when greater", () => {
        expect(evaluateCondition(10, "less_than", "5")).toBe(false);
      });
    });

    describe("less_or_equal", () => {
      it("should return true when field is less", () => {
        expect(evaluateCondition(3, "less_or_equal", "5")).toBe(true);
      });

      it("should return true when equal", () => {
        expect(evaluateCondition(5, "less_or_equal", "5")).toBe(true);
      });

      it("should return false when greater", () => {
        expect(evaluateCondition(10, "less_or_equal", "5")).toBe(false);
      });
    });

    describe("contains", () => {
      it("should return true when string contains substring", () => {
        expect(evaluateCondition("hello world", "contains", "world")).toBe(true);
      });

      it("should be case-insensitive", () => {
        expect(evaluateCondition("Hello World", "contains", "hello")).toBe(true);
      });

      it("should return false when string does not contain substring", () => {
        expect(evaluateCondition("hello world", "contains", "foo")).toBe(false);
      });
    });

    describe("starts_with", () => {
      it("should return true when string starts with prefix", () => {
        expect(evaluateCondition("hello world", "starts_with", "hello")).toBe(true);
      });

      it("should be case-insensitive", () => {
        expect(evaluateCondition("Hello World", "starts_with", "hello")).toBe(true);
      });

      it("should return false when string does not start with prefix", () => {
        expect(evaluateCondition("hello world", "starts_with", "world")).toBe(false);
      });
    });

    describe("ends_with", () => {
      it("should return true when string ends with suffix", () => {
        expect(evaluateCondition("hello world", "ends_with", "world")).toBe(true);
      });

      it("should be case-insensitive", () => {
        expect(evaluateCondition("Hello World", "ends_with", "WORLD")).toBe(true);
      });

      it("should return false when string does not end with suffix", () => {
        expect(evaluateCondition("hello world", "ends_with", "hello")).toBe(false);
      });
    });

    describe("is_empty", () => {
      it("should return true for empty string", () => {
        expect(evaluateCondition("", "is_empty", "")).toBe(true);
      });

      it("should return false for non-empty string", () => {
        expect(evaluateCondition("hello", "is_empty", "")).toBe(false);
      });

      it("should return true for empty array", () => {
        expect(evaluateCondition([], "is_empty", "")).toBe(true);
      });

      it("should return false for non-empty array", () => {
        expect(evaluateCondition([1, 2], "is_empty", "")).toBe(false);
      });

      it("should return true for null", () => {
        expect(evaluateCondition(null, "is_empty", "")).toBe(true);
      });

      it("should return true for undefined", () => {
        expect(evaluateCondition(undefined, "is_empty", "")).toBe(true);
      });
    });

    describe("is_not_empty", () => {
      it("should return false for empty string", () => {
        expect(evaluateCondition("", "is_not_empty", "")).toBe(false);
      });

      it("should return true for non-empty string", () => {
        expect(evaluateCondition("hello", "is_not_empty", "")).toBe(true);
      });

      it("should return false for empty array", () => {
        expect(evaluateCondition([], "is_not_empty", "")).toBe(false);
      });

      it("should return true for non-empty array", () => {
        expect(evaluateCondition([1, 2], "is_not_empty", "")).toBe(true);
      });

      it("should return false for null", () => {
        expect(evaluateCondition(null, "is_not_empty", "")).toBe(false);
      });

      it("should return false for undefined", () => {
        expect(evaluateCondition(undefined, "is_not_empty", "")).toBe(false);
      });
    });

    describe("is_true", () => {
      it("should return true for boolean true", () => {
        expect(evaluateCondition(true, "is_true", "")).toBe(true);
      });

      it("should return false for boolean false", () => {
        expect(evaluateCondition(false, "is_true", "")).toBe(false);
      });

      it("should return true for truthy number", () => {
        expect(evaluateCondition(1, "is_true", "")).toBe(true);
      });

      it("should return false for zero", () => {
        expect(evaluateCondition(0, "is_true", "")).toBe(false);
      });

      it("should return false for null", () => {
        expect(evaluateCondition(null, "is_true", "")).toBe(false);
      });

      it("should return false for undefined", () => {
        expect(evaluateCondition(undefined, "is_true", "")).toBe(false);
      });
    });

    describe("is_false", () => {
      it("should return true for boolean false", () => {
        expect(evaluateCondition(false, "is_false", "")).toBe(true);
      });

      it("should return false for boolean true", () => {
        expect(evaluateCondition(true, "is_false", "")).toBe(false);
      });

      it("should return true for zero", () => {
        expect(evaluateCondition(0, "is_false", "")).toBe(true);
      });

      it("should return false for truthy number", () => {
        expect(evaluateCondition(1, "is_false", "")).toBe(false);
      });

      it("should return true for null", () => {
        expect(evaluateCondition(null, "is_false", "")).toBe(true);
      });

      it("should return true for undefined", () => {
        expect(evaluateCondition(undefined, "is_false", "")).toBe(true);
      });
    });

    describe("null/undefined edge cases", () => {
      it("should return false for null with equals", () => {
        expect(evaluateCondition(null, "equals", "test")).toBe(false);
      });

      it("should return false for undefined with greater_than", () => {
        expect(evaluateCondition(undefined, "greater_than", "5")).toBe(false);
      });

      it("should return false for null with contains", () => {
        expect(evaluateCondition(null, "contains", "foo")).toBe(false);
      });
    });

    describe("blank values are not the number 0", () => {
      // `Number("")`, `Number("  ")` and `Number([])` are all 0, so a blank value
      // used to compare numerically — a field nobody filled equalled "0", and an
      // unfilled compare value made `x > ""` true for every positive x.
      it("does not equate a blank field with 0", () => {
        expect(evaluateCondition("", "equals", "0")).toBe(false);
        expect(evaluateCondition("  ", "equals", "0")).toBe(false);
        expect(evaluateCondition([], "equals", "0")).toBe(false);
        expect(evaluateCondition("", "not_equals", "0")).toBe(true);
      });

      it("does not equate 0 with a blank compare value", () => {
        expect(evaluateCondition(0, "equals", "")).toBe(false);
        expect(evaluateCondition(0, "not_equals", "")).toBe(true);
      });

      it("still equates two blanks as strings", () => {
        expect(evaluateCondition("", "equals", "")).toBe(true);
      });

      it("treats a blank operand to an ordering operator as non-numeric", () => {
        expect(evaluateCondition("", "less_than", "1")).toBe(false);
        expect(evaluateCondition("", "greater_or_equal", "0")).toBe(false);
        expect(evaluateCondition(5, "greater_than", "")).toBe(false);
        expect(evaluateCondition(-5, "less_or_equal", " ")).toBe(false);
      });

      it("keeps numeric comparison for padded numerals", () => {
        expect(evaluateCondition(" 42 ", "equals", "42")).toBe(true);
        expect(evaluateCondition("7", "greater_than", " 5 ")).toBe(true);
      });
    });

    describe("unknown operator", () => {
      it("should return false for unknown operator", () => {
        expect(evaluateCondition("hello", "unknown_op" as any, "hello")).toBe(false);
      });
    });
  });

  // ============================================================================
  // getNestedValue
  // ============================================================================

  describe("getNestedValue", () => {
    it("should get a flat property", () => {
      expect(getNestedValue({ foo: "bar" }, "foo")).toBe("bar");
    });

    it("should get a nested property with dot notation", () => {
      expect(getNestedValue({ a: { b: { c: 42 } } }, "a.b.c")).toBe(42);
    });

    it("should return undefined for missing path", () => {
      expect(getNestedValue({ a: 1 }, "b")).toBeUndefined();
    });

    it("should return undefined for deep missing path", () => {
      expect(getNestedValue({ a: { b: 1 } }, "a.c.d")).toBeUndefined();
    });

    it("should return undefined when traversing through non-object", () => {
      expect(getNestedValue({ a: "string" }, "a.b")).toBeUndefined();
    });

    it("should return undefined when traversing through null", () => {
      expect(getNestedValue({ a: null } as any, "a.b")).toBeUndefined();
    });

    it("should handle numeric values", () => {
      expect(getNestedValue({ count: 0 }, "count")).toBe(0);
    });

    it("should handle boolean values", () => {
      expect(getNestedValue({ active: false }, "active")).toBe(false);
    });

    it("should handle array values", () => {
      const arr = [1, 2, 3];
      expect(getNestedValue({ items: arr }, "items")).toBe(arr);
    });
  });

  describe("conditionCompareValueError", () => {
    it("refuses a non-numeric or blank value for an ordering operator", () => {
      expect(conditionCompareValueError("less_than", "ninety")).toMatch(/"ninety"/);
      expect(conditionCompareValueError("greater_or_equal", "  ")).toBeDefined();
    });

    it("accepts a numeric value, and any value for a non-ordering operator", () => {
      expect(conditionCompareValueError("less_than", "0.9")).toBeUndefined();
      expect(conditionCompareValueError("equals", "ninety")).toBeUndefined();
      expect(conditionCompareValueError("contains", "")).toBeUndefined();
    });
  });
});
