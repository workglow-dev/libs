/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The static half of the ReDoS screen: predicates over a regex SOURCE, with no
 * dependency on the task framework and nothing that needs a `vm`.
 *
 * It lives here rather than beside a task because more than one surface has to
 * ask this question. A browser-side renderer compiling an agent-supplied
 * pattern needs the same answer a filesystem task does, and cannot take
 * `@workglow/tasks` to get it — which is how a second, weaker screen came to
 * be hand-rolled in `@workglow/a2ui`, one that read a group body quantified
 * `{n,m}` as safe and let `^(a{1,10})*$` through.
 *
 * The throwing half stays in `@workglow/tasks`, where the error type it raises
 * belongs.
 */

/**
 * `{n,}` / `{n,m}` starting exactly at an index. Sticky rather than
 * `test(pattern.slice(index))`, because slicing per character is the quadratic
 * shape this module exists to avoid.
 */
const UNBOUNDED_REPETITION_RE = /\{\d+,\d*\}/y;

/** True when a counted repetition starts at `index`. */
function isUnboundedRepetitionAt(pattern: string, index: number): boolean {
  if (pattern[index] !== "{") return false;
  UNBOUNDED_REPETITION_RE.lastIndex = index;
  return UNBOUNDED_REPETITION_RE.test(pattern);
}

/** `{n}` / `{n,}` / `{n,m}` starting exactly at an index, sticky for the same reason. */
const COUNTED_REPETITION_RE = /\{(\d+)(?:,(\d*))?\}/y;

/**
 * True when the quantifier at `index` permits TWO OR MORE repetitions, which is
 * what turns a quantifying group body into a backtracking blow-up.
 *
 * `?` and `{0,1}` do not: they bound the group to at most one repetition, so
 * `(\.\d+)?` stays linear no matter what its body quantifies. `{10}` does, even
 * though it is bounded — `(a+){10}` is measurably catastrophic.
 */
function quantifierAllowsRepeat(pattern: string, index: number): boolean {
  const char = pattern[index];
  if (char === "*" || char === "+") return true;
  if (char !== "{") return false;
  COUNTED_REPETITION_RE.lastIndex = index;
  const counted = COUNTED_REPETITION_RE.exec(pattern);
  if (counted === null) return false;
  const [, min, max] = counted;
  if (max === undefined) return Number(min) >= 2;
  if (max === "") return true;
  return Number(max) >= 2;
}

export interface PatternScan {
  /** Every `[` in the source, including literals inside a class. */
  readonly bracketCount: number;
  /** A quantified group whose own body already quantifies, e.g. `(a+)+`. */
  readonly nestedQuantifiers: boolean;
}

/**
 * Walks a regex source once, tracking character classes (so a quantifier
 * inside `[...]` is not read as one) and group nesting on a stack.
 *
 * The scan is hand-written rather than regex-driven on purpose: stripping
 * classes with `\[(?:[^\]\\]|\\.)*\]` is itself quadratic on a pattern that is
 * mostly unclosed `[`, since every one of them restarts a scan that runs to
 * the end of the string. Guarding against ReDoS with a pattern an attacker can
 * ReDoS defeats the guard.
 */
export function scanRegexPattern(pattern: string): PatternScan {
  let bracketCount = 0;
  let nestedQuantifiers = false;
  let inClass = false;

  /** One entry per open group; true once that group's body contains `*` or `+`. */
  const groupHasQuantifier: boolean[] = [];

  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index];

    if (char === "\\") {
      index++;
      continue;
    }

    if (inClass) {
      if (char === "[") {
        bracketCount++;
      } else if (char === "]") {
        inClass = false;
      }
      continue;
    }

    if (char === "[") {
      bracketCount++;
      inClass = true;
      continue;
    }

    if (char === "(") {
      groupHasQuantifier.push(false);
      continue;
    }

    if (char === ")") {
      const bodyQuantifies = groupHasQuantifier.pop();
      if (bodyQuantifies === undefined) {
        continue;
      }

      if (bodyQuantifies && quantifierAllowsRepeat(pattern, index + 1)) {
        nestedQuantifiers = true;
      }

      // A quantifying group counts as a quantifier for whatever encloses it.
      if (bodyQuantifies && groupHasQuantifier.length > 0) {
        groupHasQuantifier[groupHasQuantifier.length - 1] = true;
      }

      continue;
    }

    if (
      (char === "*" || char === "+" || isUnboundedRepetitionAt(pattern, index)) &&
      groupHasQuantifier.length > 0
    ) {
      groupHasQuantifier[groupHasQuantifier.length - 1] = true;
    }
  }

  return { bracketCount, nestedQuantifiers };
}

/** Stands in for a whole character class, which is a single atom to the emptiness test. */
const CLASS_ATOM = "\u0001";

/** An alternative made entirely of optional atoms, so it can match the empty string. */
const ALL_OPTIONAL_ATOMS_RE = /^(?:(?:\\.|[^\\*+?{}()|])(?:[*?]|\{0,\d*\}))+$/;

/** An alternative containing no regex metacharacters, so prefix comparison is meaningful. */
const LITERAL_ALTERNATIVE_RE = /^[^\\.*+?()[\]{}|^$]+$/;

/** Index just past the `]` closing the class at `index`, or the end if it never closes. */
function endOfCharacterClass(pattern: string, index: number): number {
  let i = index + 1;
  while (i < pattern.length && pattern[i] !== "]") {
    i += pattern[i] === "\\" ? 2 : 1;
  }
  return i < pattern.length ? i + 1 : pattern.length;
}

/** Returns true when a repetition quantifier starts at `index`. */
function isRepetitionAt(pattern: string, index: number): boolean {
  const ch = pattern[index];
  if (ch === "*" || ch === "+") return true;
  return isUnboundedRepetitionAt(pattern, index);
}

/** Bodies of every group immediately followed by a repetition quantifier. */
function quantifiedGroupBodies(pattern: string): string[] {
  const bodies: string[] = [];
  const open: number[] = [];

  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\") {
      i++;
    } else if (ch === "[") {
      i = endOfCharacterClass(pattern, i) - 1;
    } else if (ch === "(") {
      open.push(i);
    } else if (ch === ")") {
      const start = open.pop();
      if (start !== undefined && isRepetitionAt(pattern, i + 1)) {
        bodies.push(pattern.slice(start + 1, i));
      }
    }
  }

  return bodies;
}

/**
 * Drops a group modifier prefix. Returns undefined for lookarounds, which this
 * screen does not model.
 */
function groupBodyAfterModifier(body: string): string | undefined {
  if (!body.startsWith("?")) return body;
  if (body.startsWith("?:")) return body.slice(2);
  const named = /^\?<[A-Z_$][\w$]*>/i.exec(body);
  if (named) return body.slice(named[0].length);
  return undefined;
}

/** Splits an alternation on `|` at nesting depth zero. */
function splitTopLevelAlternatives(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === "\\") i++;
    else if (ch === "[") i = endOfCharacterClass(body, i) - 1;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "|" && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }

  parts.push(body.slice(start));
  return parts;
}

/**
 * Collapses each character class to one placeholder character, because a class
 * IS a single atom for the can-it-match-empty question. Only that question uses
 * this — comparing two alternatives for overlap reads the class text verbatim,
 * so `[a-z]` and `[A-Z]` stay distinguishable.
 */
function collapseCharacterClasses(alternative: string): string {
  let out = "";
  let i = 0;

  while (i < alternative.length) {
    const ch = alternative[i];
    if (ch === "\\") {
      out += alternative.slice(i, i + 2);
      i += 2;
    } else if (ch === "[") {
      out += CLASS_ATOM;
      i = endOfCharacterClass(alternative, i);
    } else {
      out += ch;
      i += 1;
    }
  }

  return out;
}

function alternativeCanMatchEmpty(alternative: string): boolean {
  if (alternative.length === 0) return true;
  // A nested group is not modelled; do not claim it can match empty.
  if (alternative.includes("(")) return false;
  return ALL_OPTIONAL_ATOMS_RE.test(collapseCharacterClasses(alternative));
}

/**
 * True when a quantified alternation has branches that overlap, so the engine
 * has more than one way to consume the same input: `(a|a)*`, `(?:a|a)*`,
 * `(a|ab)+`, `(a*|b)+`.
 *
 * {@link scanRegexPattern} does not model this — it pops `(a|a)` with a body that
 * carries no quantifier of its own — yet the family is measurably exponential:
 * `/(a|a)*$/` against `"a".repeat(n) + "!"` runs 52 ms at n=18, 118 ms at n=22,
 * 466 ms at n=24 and 1821 ms at n=26, doubling per added character, and
 * `(a|a|a)+$` at n=20 ran past a 120 s timeout.
 *
 * Sharing a first character is NOT enough — `(foo|far)+` is not exponential and
 * a first-character rule would reject a large class of ordinary patterns.
 */
export function hasOverlappingRegexAlternation(pattern: string): boolean {
  for (const rawBody of quantifiedGroupBodies(pattern)) {
    const body = groupBodyAfterModifier(rawBody);
    if (body === undefined) continue;

    const alternatives = splitTopLevelAlternatives(body);
    if (alternatives.length < 2) continue;

    if (alternatives.some(alternativeCanMatchEmpty)) return true;

    for (let i = 0; i < alternatives.length; i++) {
      for (let j = i + 1; j < alternatives.length; j++) {
        const a = alternatives[i]!;
        const b = alternatives[j]!;
        if (a === b) return true;
        if (
          LITERAL_ALTERNATIVE_RE.test(a) &&
          LITERAL_ALTERNATIVE_RE.test(b) &&
          (a.startsWith(b) || b.startsWith(a))
        ) {
          return true;
        }
      }
    }
  }

  return false;
}

/**
 * Screen for the catastrophic-backtracking shapes this module models, without
 * throwing.
 *
 * A `false` is not a safety guarantee, only the absence of a modelled shape:
 * the screen is a heuristic, not a decision procedure. What is actually
 * ENFORCED is the match budget applied at match time — see
 * `createBoundedRegexMatcher`, which interrupts a running match after a fixed
 * wall-clock budget. Treat this as a fast, friendly rejection of obviously
 * dangerous input, never as the containment.
 */
export function hasUnsafeRegexShape(pattern: string): boolean {
  return scanRegexPattern(pattern).nestedQuantifiers || hasOverlappingRegexAlternation(pattern);
}

/**
 * Escapes every regex metacharacter, so caller text can be compiled into a
 * pattern that matches it literally rather than being read as one. The other
 * half of {@link assertSafeRegexPattern}: that guards text the caller *meant*
 * as a pattern, this guards text they did not.
 */
export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
