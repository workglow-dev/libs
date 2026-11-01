/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from "vitest";
import { matchesLikeCriterion } from "../ITabularStorage";
import { StorageValidationError } from "../StorageError";
import {
  assertValidLikePattern,
  compileLikePattern,
  escapeLikePattern,
  likePatternError,
  likePatternToGlob,
  likePatternToPosixRegex,
  matchesLikePattern,
} from "../likePattern";

/**
 * The in-memory `like` matcher has to answer exactly as PostgreSQL's
 * `LIKE … ESCAPE '\'` does, because the same criterion runs against both. Each
 * expectation below is what PostgreSQL returns for that text and pattern.
 */
describe("matchesLikePattern", () => {
  const cases: ReadonlyArray<readonly [text: string, pattern: string, expected: boolean]> = [
    // Anchored: no wildcard means the whole string.
    ["abc", "abc", true],
    ["abc", "ab", false],
    ["abc", "bc", false],
    ["", "", true],
    ["a", "", false],
    // `%` is any run, including an empty one.
    ["abc", "%", true],
    ["", "%", true],
    ["abc", "a%", true],
    ["abc", "%c", true],
    ["abc", "%b%", true],
    ["abc", "%d%", false],
    ["abc", "a%%c", true],
    ["5.02,9.01", "%5.02%", true],
    ["5.0x2", "%5.02%", false],
    // `_` is exactly one character.
    ["abc", "a_c", true],
    ["ac", "a_c", false],
    ["abbc", "a_c", false],
    ["abc", "___", true],
    ["abc", "__", false],
    ["abc", "_%", true],
    ["", "_%", false],
    // One character is one code point, not one UTF-16 unit.
    ["a😀c", "a_c", true],
    ["😀", "_", true],
    ["é", "_", true],
    // Case-sensitive.
    ["ABC", "abc", false],
    ["abc", "%B%", false],
    ["aBc", "%B%", true],
    // `.` and other regex metacharacters are literal.
    ["5x02", "5.02", false],
    ["a+b", "a+b", true],
    ["(a)", "(a)", true],
    ["[a]", "[a]", true],
    ["a*b", "a*b", true],
    ["ab", "a*b", false],
    // Escapes: `\%`, `\_` and `\\` match themselves; `\x` is a literal x.
    ["100%", "100\\%", true],
    ["1000", "100\\%", false],
    ["a_b", "a\\_b", true],
    ["axb", "a\\_b", false],
    ["a\\b", "a\\\\b", true],
    ["ab", "a\\b", true],
    ["50% off", "%\\%%", true],
    ["50 off", "%\\%%", false],
    // `%` spans newlines.
    ["line one\nline two", "%one%two", true],
    ["a\nb", "a_b", true],
    ["a\nb", "a%", true],
  ];

  for (const [text, pattern, expected] of cases) {
    it(`${JSON.stringify(text)} LIKE ${JSON.stringify(pattern)} is ${expected}`, () => {
      expect(matchesLikePattern(text, pattern)).toBe(expected);
    });
  }

  it("throws for a pattern ending in a lone escape", () => {
    expect(() => matchesLikePattern("a\\", "a\\")).toThrow(StorageValidationError);
    expect(() => compileLikePattern("a\\")).toThrow(StorageValidationError);
  });

  it("stays fast on a pattern built to make a backtracking matcher explode", () => {
    // `%a%a%a…b` against a long run of `a`s with no `b`: exponential for a
    // naive recursive matcher or a backtracking RegExp, O(text × pattern) here.
    const pattern = `${"%a".repeat(30)}%b`;
    const text = "a".repeat(20_000);
    const started = performance.now();
    expect(matchesLikePattern(text, pattern)).toBe(false);
    expect(matchesLikePattern(`${text}b`, pattern)).toBe(true);
    expect(matchesLikePattern(text, `${"_%".repeat(30)}b`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("matchesLikeCriterion", () => {
  it("throws for a malformed pattern even when the column is null", () => {
    expect(() => matchesLikeCriterion(null, "a\\")).toThrow(StorageValidationError);
  });

  it("never matches a null, absent or non-string column", () => {
    expect(matchesLikeCriterion(null, "%")).toBe(false);
    expect(matchesLikeCriterion(undefined, "%")).toBe(false);
    expect(matchesLikeCriterion(502, "%")).toBe(false);
    expect(matchesLikeCriterion("", "%")).toBe(true);
  });
});

describe("escapeLikePattern", () => {
  it("leaves text without metacharacters alone", () => {
    expect(escapeLikePattern("5.02")).toBe("5.02");
    expect(escapeLikePattern("")).toBe("");
    expect(escapeLikePattern("a*b?[c]")).toBe("a*b?[c]");
  });

  it("escapes %, _ and the backslash", () => {
    expect(escapeLikePattern("a_b%")).toBe("a\\_b\\%");
    expect(escapeLikePattern("a\\b")).toBe("a\\\\b");
  });

  it("round-trips: an escaped string matches exactly itself", () => {
    for (const text of ["a_b%", "100%", "back\\slash", "\\%_", "plain", "5.02"]) {
      const escaped = escapeLikePattern(text);
      expect(matchesLikePattern(text, escaped)).toBe(true);
      expect(matchesLikePattern(`${text}x`, escaped)).toBe(false);
      expect(matchesLikePattern(`xx${text}yy`, `%${escaped}%`)).toBe(true);
      expect(likePatternError(escaped)).toBeUndefined();
    }
  });
});

describe("likePatternError", () => {
  it("rejects only a trailing unescaped backslash", () => {
    expect(likePatternError("a\\")).toBeDefined();
    expect(likePatternError("\\\\\\")).toBeDefined();
    expect(likePatternError("a\\\\")).toBeUndefined();
    expect(likePatternError("a\\%")).toBeUndefined();
    expect(likePatternError("")).toBeUndefined();
  });
});

describe("likePatternToGlob", () => {
  it("maps wildcards and brackets GLOB metacharacters", () => {
    expect(likePatternToGlob("%5.02%")).toBe("*5.02*");
    expect(likePatternToGlob("a_c")).toBe("a?c");
    expect(likePatternToGlob("a*b?c[d]")).toBe("a[*]b[?]c[[]d]");
    expect(likePatternToGlob("100\\%\\_\\\\")).toBe("100%_\\");
  });
});

describe("translators refuse a malformed pattern", () => {
  it("throws rather than dropping the dangling escape", () => {
    // Dropped, `a\` would translate to `a` and name a different row.
    expect(() => likePatternToGlob("a\\")).toThrow(StorageValidationError);
    expect(() => likePatternToPosixRegex("a*\\")).toThrow(StorageValidationError);
    expect(() => assertValidLikePattern("a\\")).toThrow(StorageValidationError);
    expect(() => assertValidLikePattern("a\\\\")).not.toThrow();
  });
});

describe("likePatternToPosixRegex", () => {
  it("anchors and escapes, mapping % and _ to .* and .", () => {
    expect(likePatternToPosixRegex("%a*b%")).toBe("^.*a\\*b.*$");
    expect(likePatternToPosixRegex("a_c")).toBe("^a.c$");
    expect(likePatternToPosixRegex("5.02\\%")).toBe("^5\\.02%$");
  });

  it("agrees with the matcher once compiled", () => {
    // JavaScript's `s` flag gives `.` PostgreSQL's newline-matching reading.
    const samples = ["a*b", "ab", "x a*b y", "a\n*b"];
    for (const pattern of ["%a*b%", "a*b", "a_*b", "%*%"]) {
      const regex = new RegExp(likePatternToPosixRegex(pattern), "su");
      for (const text of samples) {
        expect(regex.test(text)).toBe(matchesLikePattern(text, pattern));
      }
    }
  });
});
