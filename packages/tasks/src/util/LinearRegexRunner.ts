/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 *
 * A {@link RegexRunnerFactory} over a linear-time (RE2-family) engine, for hosts
 * that can neither interrupt a match nor afford one that never ends: a Worker or
 * Durable Object has no `vm` timeout, and a catastrophic pattern there stalls
 * every object sharing the isolate until the platform kills the invocation.
 *
 * The engine is handed in rather than imported, so this package takes no
 * dependency; `re2js`'s `RE2JS` class satisfies {@link ILinearRegexEngine} as is.
 *
 * Matching runs in time linear in the input, which is the containment. The cost
 * is syntax: a linear engine cannot express backreferences or lookaround, so a
 * pattern using them is refused with a {@link TaskInvalidInputError} rather than
 * matched without a bound. Where JavaScript and RE2 read the same syntax
 * differently, the source is rewritten to JavaScript's meaning:
 *
 * - `\s` / `\S` cover JavaScript's whitespace set, not RE2's ASCII one.
 * - `.` excludes `\r`, `\u2028` and `\u2029` as well as `\n`.
 * - Under `m`, `^` also matches after `\r`, `\u2028` and `\u2029`.
 * - `[^]` matches any character; `[\b]` is a backspace.
 *
 * Two differences remain and are refused or accepted explicitly:
 *
 * - Under `m`, RE2's `$` matches only before `\n`. A pattern with a multiline
 *   `$` is refused for an input holding `\r`, `\u2028` or `\u2029`.
 * - Without the `u` flag JavaScript sees an astral character as two code units;
 *   RE2 always sees one code point. A pattern that counts characters (`^.$`)
 *   can therefore match an emoji here that the native engine would not.
 */

import { TaskInvalidInputError } from "@workglow/task-graph";
import type { RegexRunner, RegexRunnerFactory } from "./BoundedRegexRunner";

/** One scan of an input, advanced match by match. */
export interface ILinearRegexMatcher {
  find(): boolean;
  groupCount(): number;
  group(index: number): string | null;
}

export interface ILinearRegexPattern {
  matcher(input: string): ILinearRegexMatcher;
}

/** The surface of `re2js`'s `RE2JS` class this runner uses. */
export interface ILinearRegexEngine {
  compile(source: string, flags: number): ILinearRegexPattern;
  /** Rewrites JavaScript-only spellings (named groups, `\u` escapes) into RE2 syntax. */
  translateRegExp(source: string): string;
  readonly CASE_INSENSITIVE: number;
  readonly DOTALL: number;
  readonly MULTILINE: number;
  readonly LOOKBEHINDS: number;
}

/** JavaScript's `\s`, spelled for inside a character class. */
const JS_WHITESPACE =
  "\\t\\n\\u000b\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";

/** The complement of {@link JS_WHITESPACE} over every code point, for `\S` inside a class. */
const JS_NON_WHITESPACE =
  "\\u0000-\\u0008\\u000e-\\u001f!-\\u009f\\u00a1-\\u167f\\u1681-\\u1fff\\u200b-\\u2027" +
  "\\u202a-\\u202e\\u2030-\\u205e\\u2060-\\u2fff\\u3001-\\ufefe\\uff00-\\u{10ffff}";

/** JavaScript's line terminators other than `\n`, which RE2 already treats as one. */
const EXTRA_LINE_TERMINATORS = "\\r\\u2028\\u2029";

const EXTRA_LINE_TERMINATOR_IN_INPUT = /[\r\u2028\u2029]/;

/** The pattern rewritten for the linear engine, and what matching it still has to check. */
export interface LinearRegexSource {
  /** JavaScript regex syntax, still to go through {@link ILinearRegexEngine.translateRegExp}. */
  readonly source: string;
  /** True when a multiline `$` cannot be matched faithfully over an input holding `\r`. */
  readonly multilineDollar: boolean;
  /** True when the rewrite added a lookbehind, which the engine compiles only behind its flag. */
  readonly usesLookbehind: boolean;
}

function refuse(regex: RegExp, feature: string): never {
  throw new TaskInvalidInputError(
    `Regex pattern /${regex.source}/ uses ${feature}, which this host cannot match in bounded ` +
      `time. Rewrite the pattern without it.`
  );
}

/**
 * Rewrites `regex`'s source to JavaScript's meaning under RE2 syntax, refusing
 * what a linear engine cannot express. Exported for its tests.
 */
export function toLinearRegexSource(regex: RegExp): LinearRegexSource {
  if (regex.sticky) refuse(regex, "the sticky (y) flag");
  if (regex.unicodeSets) refuse(regex, "the v flag");

  const src = regex.source;
  let out = "";
  let inClass = false;
  let multilineDollar = false;
  let usesLookbehind = false;

  for (let i = 0; i < src.length; i++) {
    const ch = src[i];

    if (ch === "\\") {
      const next = src[i + 1];
      i++;
      if (next === "k") refuse(regex, "a named backreference (\\k)");
      if (next >= "1" && next <= "9") refuse(regex, `a backreference or octal escape (\\${next})`);
      if (inClass) {
        if (next === "s") out += JS_WHITESPACE;
        else if (next === "S") out += JS_NON_WHITESPACE;
        else if (next === "b") out += "\\x08";
        else out += "\\" + next;
      } else if (next === "s") {
        out += `[${JS_WHITESPACE}]`;
      } else if (next === "S") {
        out += `[^${JS_WHITESPACE}]`;
      } else {
        out += "\\" + next;
      }
      continue;
    }

    if (inClass) {
      if (ch === "]") inClass = false;
      out += ch;
      continue;
    }

    switch (ch) {
      case "[":
        if (src.startsWith("[^]", i)) {
          out += "[\\u0000-\\u{10ffff}]";
          i += 2;
        } else if (src.startsWith("[]", i)) {
          refuse(regex, "an empty character class ([])");
        } else {
          inClass = true;
          out += ch;
        }
        break;
      case "(":
        if (src.startsWith("(?=", i) || src.startsWith("(?!", i)) refuse(regex, "a lookahead");
        if (src.startsWith("(?<=", i) || src.startsWith("(?<!", i)) refuse(regex, "a lookbehind");
        out += ch;
        break;
      case ".":
        out += regex.dotAll ? "." : "[^\\n" + EXTRA_LINE_TERMINATORS + "]";
        break;
      case "^":
        if (regex.multiline) {
          out += `(?:^|(?<=[${EXTRA_LINE_TERMINATORS}]))`;
          usesLookbehind = true;
        } else {
          out += ch;
        }
        break;
      case "$":
        if (regex.multiline) multilineDollar = true;
        out += ch;
        break;
      default:
        out += ch;
    }
  }

  return { source: out, multilineDollar, usesLookbehind };
}

/**
 * Builds a runner factory over `engine`. Each regex is compiled once, when the
 * factory is called with it; a pattern the engine cannot compile is refused.
 */
export function createLinearRegexRunnerFactory(engine: ILinearRegexEngine): RegexRunnerFactory {
  return (regex): RegexRunner => {
    const linear = toLinearRegexSource(regex);
    let flags = 0;
    if (regex.ignoreCase) flags |= engine.CASE_INSENSITIVE;
    if (regex.multiline) flags |= engine.MULTILINE;
    if (regex.dotAll) flags |= engine.DOTALL;
    if (linear.usesLookbehind) flags |= engine.LOOKBEHINDS;

    let pattern: ILinearRegexPattern;
    try {
      pattern = engine.compile(engine.translateRegExp(linear.source), flags);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      refuse(regex, `syntax a linear-time engine does not support (${reason})`);
    }

    const scan = (value: string): ILinearRegexMatcher => {
      if (linear.multilineDollar && EXTRA_LINE_TERMINATOR_IN_INPUT.test(value)) {
        refuse(regex, "a multiline $ over an input with \\r, \\u2028 or \\u2029 line endings");
      }
      return pattern.matcher(value);
    };

    return {
      exec: (value) => {
        const m = scan(value);
        if (!m.find()) return undefined;
        const groups: (string | undefined)[] = [];
        for (let g = 0; g <= m.groupCount(); g++) groups.push(m.group(g) ?? undefined);
        return groups;
      },
      execAll: (value) => {
        const m = scan(value);
        const matches: string[] = [];
        while (m.find()) {
          const match = m.group(0) ?? "";
          // Without `g` the native runner looks once, so an empty first match yields nothing.
          if (!regex.global) return match.length > 0 ? [match] : [];
          if (match.length > 0) matches.push(match);
        }
        return matches;
      },
    };
  };
}
