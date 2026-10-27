/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { TaskInvalidInputError } from "@workglow/task-graph";
import {
  createLinearRegexRunnerFactory,
  defaultRegexRunnerFactory,
  LINEAR_REGEX_MAX_INPUT_LENGTH,
  registerRegexRunnerFactory,
  RegexTask,
  toLinearRegexSource,
} from "@workglow/tasks";
import type { RegexRunnerFactory } from "@workglow/tasks";
import { RE2JS } from "re2js";
import { afterEach, describe, expect, it } from "vitest";

const linear = createLinearRegexRunnerFactory(RE2JS);

/** Patterns whose meaning the rewrite preserves, each run over every input below. */
const PATTERNS: readonly [string, string][] = [
  ["hello", ""],
  ["hello", "gi"],
  ["(\\d{4})-(\\d{2})", "g"],
  ["(?<year>\\d{4})-(?<month>\\d{2})", ""],
  ["(a)|(b)", ""],
  ["\\s+", "g"],
  ["\\S+", "g"],
  ["[\\s\\S]+", ""],
  ["[^\\s]+", "g"],
  ["a.c", "g"],
  ["a.c", "gs"],
  ["[^]", "g"],
  ["[\\b]", "g"],
  ["^\\w+", "gm"],
  ["^", "gm"],
  ["x*", "g"],
  ["x*", ""],
  ["|a", "g"],
  ["\\bcat\\b", "gi"],
  ["\\u00e9", "gi"],
  ["[a-c]{2,}", "g"],
  ["\\d+(?:\\.\\d+)?", "g"],
  ["colou?r", "g"],
  // A `[` inside a class is a literal, not the start of a POSIX class.
  ["[[:digit:]]", "g"],
  // Without `u`, these escapes are the letter itself, not RE2's operator.
  ["\\A", "g"],
  ["a\\z", "g"],
  ["\\a", "g"],
  ["\\Qa.b", "g"],
  // With no named group, `\k` is the letter, in a class or out.
  ["\\k<x>", "g"],
  ["[\\k]", "g"],
  ["\\pL", "g"],
  ["\\x{2}", "g"],
  ["\\u{2}", "g"],
  ["\\c1", "g"],
  ["[\\c1]", "g"],
  // A `-` beside `\s` / `\S` in a class is a literal, as JavaScript reads it.
  ["[\\s-z]", "g"],
  ["[%-\\s]", "g"],
  ["[\\d\\s-()]+", "g"],
  ["[\\S-]+", "g"],
];

const INPUTS: readonly string[] = [
  "",
  "hello world, Hello again",
  "on 2026-10 and 1999-01",
  "ab",
  "tab\there\u00a0nbsp\u2003em\u3000ideo\ufeffbom space",
  "abc a\nc a\rc a\u2028c axc",
  "first line\nsecond line\rthird\u2029fourth",
  "axxbxc",
  "The cat sat on the Cat-alog, concatenate",
  "caf\u00e9 CAF\u00c9",
  "aabbcc abcabc",
  "pi is 3.14 and e is 2.718",
  "color colour colr",
  "back\bspace",
  "A [:] d] 5 az pL Qaxb xx uu \\c1 \u0011 \u0007",
  "call (555) 123-4567 or -z %",
  "kk<x> k<y>",
];

describe("createLinearRegexRunnerFactory", () => {
  describe("agrees with the native engine", () => {
    for (const [source, flags] of PATTERNS) {
      it(`/${source}/${flags}`, () => {
        const native = defaultRegexRunnerFactory(new RegExp(source, flags));
        const bounded = linear(new RegExp(source, flags));
        for (const input of INPUTS) {
          expect(bounded.exec(input), JSON.stringify(input)).toEqual(native.exec(input));
          expect(bounded.execAll(input), JSON.stringify(input)).toEqual(native.execAll(input));
        }
      });
    }
  });

  describe("refuses what it cannot match in linear time", () => {
    const refused: readonly [string, string, string][] = [
      ["(a)\\1", "", "backreference"],
      ["(?<x>a)\\k<x>", "", "named backreference"],
      ["a(?=b)", "", "lookahead"],
      ["a(?!b)", "", "lookahead"],
      ["(?<=a)b", "", "lookbehind"],
      ["(?<!a)b", "", "lookbehind"],
      ["a", "y", "sticky"],
      ["[]", "", "empty character class"],
      ["\\p{Letter}", "u", "syntax a linear-time engine does not support"],
    ];
    for (const [source, flags, reason] of refused) {
      it(`/${source}/${flags}`, () => {
        expect(() => linear(new RegExp(source, flags))).toThrow(TaskInvalidInputError);
        expect(() => linear(new RegExp(source, flags))).toThrow(reason);
      });
    }

    it("reports what matching a rewritten pattern still has to check", () => {
      expect(toLinearRegexSource(/^a$/m)).toMatchObject({
        multilineDollar: true,
        usesLookbehind: true,
      });
      expect(toLinearRegexSource(/^a$/)).toMatchObject({
        multilineDollar: false,
        usesLookbehind: false,
      });
    });

    it("refuses an input longer than the cap, for one match and a global scan", () => {
      const atCap = "a".repeat(LINEAR_REGEX_MAX_INPUT_LENGTH);
      expect(linear(/b/).exec(atCap)).toBeUndefined();
      expect(linear(/b/g).execAll(atCap)).toEqual([]);
      const over = atCap + "b";
      expect(() => linear(/b/).exec(over)).toThrow(TaskInvalidInputError);
      expect(() => linear(/b/g).execAll(over)).toThrow("at most 65536");
    });

    it("refuses a multiline $ only over an input with \\r line endings", () => {
      const runner = linear(/\w+$/gm);
      expect(runner.execAll("one\ntwo")).toEqual(["one", "two"]);
      expect(() => runner.execAll("one\r\ntwo")).toThrow(TaskInvalidInputError);
    });
  });

  describe("bounds patterns that backtrack catastrophically", () => {
    // `^(a?b?)*$` passes the shape screen and still backtracks exponentially natively. The
    // patterns are data, as in RegexTask's own test: they reach the linear engine only, never
    // the native one.
    const hostile: readonly [string, string][] = [
      ["(a|a)*$", "a".repeat(50_000) + "!"],
      ["^(a?b?)*$", "ab".repeat(25_000) + "!"],
      ["(\\w|\\d)*$", "1".repeat(50_000) + "!"],
    ];
    for (const [source, input] of hostile) {
      it(`/${source}/`, () => {
        const started = performance.now();
        linear(new RegExp(source)).exec(input);
        expect(performance.now() - started).toBeLessThan(5_000);
      });
    }
  });

  describe("as RegexTask's runner", () => {
    // Restore what was installed rather than the unbounded default: the Node entry
    // registers a bounded runner, and other files in this process rely on it.
    let previous: RegexRunnerFactory | undefined;
    afterEach(() => {
      if (previous !== undefined) registerRegexRunnerFactory(previous);
      previous = undefined;
    });

    it("serves RegexTask once registered", async () => {
      previous = registerRegexRunnerFactory(linear);
      const task = new RegexTask({ id: "linear-regex" });
      const result = await task.run({ value: "a1 b22 c333", pattern: "\\d+", flags: "g" });
      expect(result.match).toBe(true);
      expect(result.matches).toEqual(["1", "22", "333"]);
    });

    it("fails the task on a pattern it refuses", async () => {
      previous = registerRegexRunnerFactory(linear);
      const task = new RegexTask({ id: "linear-regex-refused" });
      await expect(task.run({ value: "aa", pattern: "(a)\\1" })).rejects.toThrow("backreference");
    });
  });
});
