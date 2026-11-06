/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { asText, getLogger } from "@workglow/util";

/**
 * Comparison operators supported by the UI condition builder.
 */
export type ComparisonOperator =
  | "equals"
  | "not_equals"
  | "greater_than"
  | "greater_or_equal"
  | "less_than"
  | "less_or_equal"
  | "contains"
  | "starts_with"
  | "ends_with"
  | "is_empty"
  | "is_not_empty"
  | "is_true"
  | "is_false";

/**
 * Serialized condition branch configuration from the UI builder.
 * Used by ConditionalTask to auto-build runtime condition functions.
 */
export interface UIConditionBranch {
  id: string;
  field: string;
  operator: ComparisonOperator;
  value: string;
}

/**
 * Serialized condition configuration from the UI builder.
 * Used by ConditionalTask to auto-build runtime branch configs.
 */
export interface UIConditionConfig {
  branches: UIConditionBranch[];
  exclusive: boolean;
  defaultBranch?: string;
}

/**
 * The number a condition operand stands for, or NaN when it is not numeric.
 *
 * `Number()` alone reads a blank string, a whitespace-only string and an empty
 * array as 0, which would make a field nobody filled equal "0" and an unfilled
 * compare value satisfy `x > ""` for every positive x. Blank is not a number.
 */
function conditionNumber(value: unknown): number {
  if (typeof value === "string" && value.trim() === "") return NaN;
  if (Array.isArray(value) && value.length === 0) return NaN;
  return Number(value);
}

const ORDERING_OPERATORS: ReadonlySet<ComparisonOperator> = new Set([
  "greater_than",
  "greater_or_equal",
  "less_than",
  "less_or_equal",
]);

/**
 * Why a compare value can never satisfy its operator, or undefined if it can. An
 * ordering comparison needs a number on both sides, and the compare value is fixed
 * by the config, so a non-numeric one is known before anything is evaluated.
 */
export function conditionCompareValueError(
  operator: ComparisonOperator,
  compareValue: string
): string | undefined {
  if (!ORDERING_OPERATORS.has(operator) || !isNaN(conditionNumber(compareValue))) {
    return undefined;
  }
  return `'${operator}' compares numbers, and ${JSON.stringify(compareValue)} is not one`;
}

/**
 * Evaluates a condition based on operator type.
 *
 * @param fieldValue - The value of the field being tested
 * @param operator - The comparison operator to apply
 * @param compareValue - The value to compare against (always a string from the UI)
 * @returns true if the condition is met, false otherwise
 */
export function evaluateCondition(
  fieldValue: unknown,
  operator: ComparisonOperator,
  compareValue: string
): boolean {
  // Handle null/undefined
  if (fieldValue === null || fieldValue === undefined) {
    switch (operator) {
      case "is_empty":
        return true;
      case "is_not_empty":
        return false;
      case "is_true":
        return false;
      case "is_false":
        return true;
      default:
        return false;
    }
  }

  const strValue = asText(fieldValue);
  const numValue = conditionNumber(fieldValue);
  const compareNum = conditionNumber(compareValue);

  switch (operator) {
    case "equals":
      // Try numeric comparison first, then string
      if (!isNaN(numValue) && !isNaN(compareNum)) {
        return numValue === compareNum;
      }
      return strValue === compareValue;

    case "not_equals":
      if (!isNaN(numValue) && !isNaN(compareNum)) {
        return numValue !== compareNum;
      }
      return strValue !== compareValue;

    case "greater_than":
    case "greater_or_equal":
    case "less_than":
    case "less_or_equal": {
      // Ordering operators require numeric operands. If either side is
      // non-numeric (Number(...) is NaN) the comparison can never be true and
      // would silently never fire; surface it as a clear diagnostic and return
      // false rather than failing quietly forever.
      if (isNaN(numValue) || isNaN(compareNum)) {
        getLogger().warn(
          `Non-numeric operand in '${operator}' comparison (field=${JSON.stringify(fieldValue)}, compare=${JSON.stringify(compareValue)}); evaluating as false`
        );
        return false;
      }
      if (operator === "greater_than") return numValue > compareNum;
      if (operator === "greater_or_equal") return numValue >= compareNum;
      if (operator === "less_than") return numValue < compareNum;
      return numValue <= compareNum;
    }

    case "contains":
      return strValue.toLowerCase().includes(compareValue.toLowerCase());

    case "starts_with":
      return strValue.toLowerCase().startsWith(compareValue.toLowerCase());

    case "ends_with":
      return strValue.toLowerCase().endsWith(compareValue.toLowerCase());

    case "is_empty":
      return strValue === "" || (Array.isArray(fieldValue) && fieldValue.length === 0);

    case "is_not_empty":
      return strValue !== "" && !(Array.isArray(fieldValue) && fieldValue.length === 0);

    case "is_true":
      return Boolean(fieldValue) === true;

    case "is_false":
      return Boolean(fieldValue) === false;

    default:
      return false;
  }
}

/**
 * Get a value from a nested object using dot notation.
 * e.g., "user.name" would get obj.user.name
 *
 * @param obj - The object to read from
 * @param path - Dot-separated path to the value
 * @returns The value at the path, or undefined if any segment is missing
 */
export function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}
