/**
 * @license
 * Copyright 2025 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskInvalidInputError } from "@workglow/task-graph";
import { hasOverlappingRegexAlternation, scanRegexPattern, SECURITY_LIMITS } from "@workglow/util";

export { escapeRegExp, hasUnsafeRegexShape } from "@workglow/util";

/**
 * Rejects regex sources prone to catastrophic backtracking (ReDoS) before they
 * ever reach `new RegExp`. Throws {@link TaskInvalidInputError} for a pattern
 * with too many `[` characters, with nested quantifiers like `(a+)+`, or with a
 * quantified alternation whose branches overlap like `(a|a)*`.
 *
 * This is a screen, not the containment — see {@link hasUnsafeRegexShape}.
 */
export function assertSafeRegexPattern(pattern: string): void {
  const { bracketCount, nestedQuantifiers } = scanRegexPattern(pattern);

  if (bracketCount > SECURITY_LIMITS.regexMaxBracketCount) {
    throw new TaskInvalidInputError(
      "Regex pattern rejected: too many '[' characters (potential ReDoS). " +
        "Simplify the pattern to reduce complexity."
    );
  }

  if (nestedQuantifiers) {
    throw new TaskInvalidInputError(
      "Regex pattern rejected: nested quantifiers detected (potential ReDoS). " +
        "Simplify the pattern to avoid catastrophic backtracking."
    );
  }

  if (hasOverlappingRegexAlternation(pattern)) {
    throw new TaskInvalidInputError(
      "Regex pattern rejected: a repeated alternation has overlapping branches " +
        "(potential ReDoS). Make the branches mutually exclusive."
    );
  }
}

/** Screens a pattern, then compiles it. */
export function compileSafeRegex(pattern: string, flags: string): RegExp {
  assertSafeRegexPattern(pattern);
  try {
    return new RegExp(pattern, flags);
  } catch {
    throw new TaskInvalidInputError(`Invalid regular expression: ${pattern}`);
  }
}
