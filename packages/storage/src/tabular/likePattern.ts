/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SQL `LIKE` patterns, evaluated the way PostgreSQL evaluates them with
 * `ESCAPE '\'`: case-sensitive, anchored at both ends, `%` matching any run of
 * characters (newlines included), `_` matching exactly one character (a code
 * point, not a UTF-16 unit), and `\` making the next character literal.
 *
 * A pattern ending in a lone `\` is an error in PostgreSQL ("LIKE pattern must
 * not end with escape character"); {@link likePatternError} reports it so every
 * backend refuses the same pattern before reaching a database.
 */

/** One unit of a parsed pattern. */
type LikeToken =
  | { readonly kind: "any" }
  | { readonly kind: "one" }
  | { readonly kind: "literal"; readonly char: string };

/**
 * Escapes `text` so it matches itself literally inside a `like` pattern —
 * every `\`, `%` and `_` gets a backslash in front.
 *
 * @example
 * // "contains X", whatever X holds
 * { items: { operator: "like", value: `%${escapeLikePattern(x)}%` } }
 */
export function escapeLikePattern(text: string): string {
  return text.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * Why `pattern` cannot be used as a `like` value, or `undefined` when it can.
 * Today the only malformed pattern is one ending in an unescaped backslash.
 */
export function likePatternError(pattern: string): string | undefined {
  let escaped = false;
  for (const ch of pattern) {
    escaped = !escaped && ch === "\\";
  }
  return escaped ? "a like pattern must not end with the escape character `\\`" : undefined;
}

function tokenizeLikePattern(pattern: string): LikeToken[] {
  const tokens: LikeToken[] = [];
  let escaped = false;
  for (const ch of pattern) {
    if (escaped) {
      tokens.push({ kind: "literal", char: ch });
      escaped = false;
    } else if (ch === "\\") {
      escaped = true;
    } else if (ch === "%") {
      // Adjacent `%` are one wildcard; collapsing them keeps the matcher's
      // backtrack state to a single position.
      if (tokens.at(-1)?.kind !== "any") tokens.push({ kind: "any" });
    } else if (ch === "_") {
      tokens.push({ kind: "one" });
    } else {
      tokens.push({ kind: "literal", char: ch });
    }
  }
  return tokens;
}

/**
 * Whether `text` matches the `like` pattern, with PostgreSQL's semantics.
 *
 * A two-pointer wildcard matcher rather than a translated RegExp: it remembers
 * only the most recent `%` and how much of the text that `%` has consumed, so
 * it runs in O(text × pattern) at worst and never backtracks exponentially,
 * whatever a caller-supplied pattern holds. Retrying from only the last `%` is
 * sound because a later `%` can absorb anything an earlier one would have.
 *
 * A pattern ending in a lone `\` matches nothing here; validation refuses it
 * before a query reaches any backend.
 */
export function matchesLikePattern(text: string, pattern: string): boolean {
  if (likePatternError(pattern) !== undefined) return false;
  const tokens = tokenizeLikePattern(pattern);
  const chars = Array.from(text);
  let t = 0;
  let p = 0;
  let starP = -1;
  let starT = 0;
  while (t < chars.length) {
    const token = tokens[p];
    if (token !== undefined && token.kind === "any") {
      starP = p++;
      starT = t;
    } else if (
      token !== undefined &&
      (token.kind === "one" || (token.kind === "literal" && token.char === chars[t]))
    ) {
      p++;
      t++;
    } else if (starP >= 0) {
      p = starP + 1;
      t = ++starT;
    } else {
      return false;
    }
  }
  while (p < tokens.length && tokens[p]!.kind === "any") p++;
  return p === tokens.length;
}

/**
 * Translates a `like` pattern into an equivalent SQLite `GLOB` pattern.
 *
 * SQLite's `LIKE` folds ASCII case unless `PRAGMA case_sensitive_like` is on,
 * and that pragma is connection-wide state a shared handle cannot scope to one
 * statement. `GLOB` is always case-sensitive, so the SQLite dialect renders the
 * criterion as `col GLOB ?` instead: `%` → `*`, `_` → `?`, and the GLOB
 * metacharacters `*`, `?` and `[` are bracketed to stay literal. `]` needs no
 * escape outside a bracket expression.
 */
export function likePatternToGlob(pattern: string): string {
  let out = "";
  for (const token of tokenizeLikePattern(pattern)) {
    if (token.kind === "any") out += "*";
    else if (token.kind === "one") out += "?";
    else if (token.char === "*" || token.char === "?" || token.char === "[") {
      out += `[${token.char}]`;
    } else out += token.char;
  }
  return out;
}

/**
 * Translates a `like` pattern into an anchored POSIX regular expression with
 * the same meaning under PostgreSQL's `~` operator (whose `.` matches a
 * newline and whose `$` anchors only at the end of the string by default).
 *
 * For backends that must route a pattern through a regex operator — PostgREST
 * rewrites every `*` in a `like` value to `%`, so a pattern holding a literal
 * `*` cannot be sent as `like` at all. PostgreSQL's regex engine is not a
 * backtracking one, so the translation carries no ReDoS risk to the server.
 */
export function likePatternToPosixRegex(pattern: string): string {
  let out = "^";
  for (const token of tokenizeLikePattern(pattern)) {
    if (token.kind === "any") out += ".*";
    else if (token.kind === "one") out += ".";
    else out += /[\\^$.|?*+()[\]{}]/.test(token.char) ? `\\${token.char}` : token.char;
  }
  return `${out}$`;
}
