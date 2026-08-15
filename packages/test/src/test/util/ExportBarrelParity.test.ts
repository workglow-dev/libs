/**
 * @license
 * Copyright 2026 Steven Roussey <sroussey@gmail.com>
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * A provider whose `src/ai/index.ts` and `src/ai/index.browser.ts` are two
 * hand-maintained barrels over ONE set of modules must export the same surface
 * from both, except where the difference is deliberate and stated here.
 *
 * `ExportTypesPairing.test.ts` proves the manifest routes a browser consumer to
 * the browser declarations. That is what turns a barrel omission from invisible
 * into a hard `TS2305`: before it, a `customConditions: ["browser"]` consumer
 * was type-checked against the NODE barrel, so a symbol missing from the
 * browser one still compiled and still autocompleted. Five providers had such
 * omissions — every one a module with no platform-specific code, already
 * compiled into the browser bundle through the runtime entry, missing only its
 * `export *` line.
 *
 * This guard is deliberately source-only: it reads the two barrels as text, so
 * it runs under `use-source` and needs no `dist`.
 */

/** The exported names of one top-level statement, as a stable comparable key. */
type SurfaceEntry = string;

interface ParsedBarrel {
  readonly surface: ReadonlySet<SurfaceEntry>;
  /**
   * Statements this parser could not classify. Reported rather than skipped:
   * the parser is regex-based, and a shape it silently dropped is exactly where
   * a real asymmetry would hide. (`buildEntryViolations` in the sibling file
   * makes the same call for an underivable dist stem.)
   */
  readonly unparseable: readonly string[];
}

/** Strip block and whole-line comments so they cannot be read as statements. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

/**
 * Whether every `{` in the text is closed, ignoring braces inside strings.
 *
 * This is what lets a statement span lines: the closing brace of a multi-line
 * `export { a, b } from "x";` sits at column 0, so a column-0 boundary on its
 * own cuts the statement in half and reports `export {` as an unparseable line.
 */
function bracesBalanced(text: string): boolean {
  const withoutStrings = text.replace(
    /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g,
    '""'
  );
  let depth = 0;
  for (const char of withoutStrings) {
    if (char === "{") depth++;
    else if (char === "}") depth--;
  }
  return depth === 0;
}

/**
 * Every top-level statement beginning with `export`.
 *
 * A statement starts at a line beginning with `export` and runs to the first
 * column-0 boundary at which its braces are balanced, so both multi-line forms
 * these barrels use — the named re-export list and the `_testOnly` object
 * literal, each closing at column 0 — arrive whole.
 */
function topLevelExportStatements(text: string): string[] {
  const stripped = stripComments(text);
  const starts = [...stripped.matchAll(/^\S/gm)].map((match) => match.index);
  const statements: string[] = [];
  let pending = "";
  for (let i = 0; i < starts.length; i++) {
    const chunk = stripped.slice(starts[i], starts[i + 1] ?? stripped.length);
    if (pending === "" && !chunk.startsWith("export")) continue;
    pending += chunk;
    if (!bracesBalanced(pending)) continue;
    statements.push(pending.trim());
    pending = "";
  }
  // An unterminated statement is handed back rather than dropped; the caller
  // classifies it as unparseable.
  if (pending !== "") statements.push(pending.trim());
  return statements;
}

/** `{ a, b as c, type D }` -> the names a consumer can import: `a`, `c`, `D`. */
function memberNames(clause: string): string[] {
  return clause
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => {
      const aliased = /\bas\s+([A-Za-z_$][\w$]*)$/.exec(part);
      if (aliased !== null) return aliased[1] as string;
      return part.replace(/^type\s+/, "").trim();
    });
}

/**
 * The surface one barrel exports, as one entry per importable name.
 *
 * A `export * from "x"` cannot be expanded without resolving `x`, so it is kept
 * whole and compared as a unit — two barrels that both star-export the same
 * specifier export the same names by construction, and one that does not is the
 * difference worth reporting.
 */
function parseBarrel(text: string): ParsedBarrel {
  const surface = new Set<SurfaceEntry>();
  const unparseable: string[] = [];
  for (const statement of topLevelExportStatements(text)) {
    const star = /^export\s+(?:type\s+)?\*\s+from\s+"([^"]+)"/.exec(statement);
    if (star !== null) {
      surface.add(`* from "${star[1]}"`);
      continue;
    }
    const named = /^export\s+(?:type\s+)?\{([\s\S]*?)\}\s*(?:from\s+"([^"]+)")?/.exec(statement);
    if (named !== null) {
      const from = named[2] === undefined ? "" : ` from "${named[2]}"`;
      for (const name of memberNames(named[1] as string)) surface.add(`${name}${from}`);
      continue;
    }
    const declared =
      /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)/.exec(
        statement
      );
    if (declared !== null) {
      surface.add(declared[1] as string);
      continue;
    }
    unparseable.push(statement.split("\n")[0] as string);
  }
  return { surface, unparseable };
}

/**
 * Names the node barrel exports and the browser barrel deliberately does not.
 *
 * `_testOnly` is `@internal` — a bag of run-fn specs, queued providers and
 * client-injection hooks that exists for `@workglow/test` alone, never for a
 * consumer. It stays node-only because that is where the tests importing it
 * run; `packages/ai` has already moved the equivalent surface behind a
 * dedicated `./test` entry, which is where these belong too. Until then, its
 * absence from the browser barrel is intent, not drift.
 *
 * Anything else appearing here is a real asymmetry: the modules behind these
 * barrels carry no `node:` imports, and each omitted module was already in the
 * browser bundle via the runtime entry — only its `export *` was missing.
 */
const INTENTIONAL_NODE_ONLY: ReadonlyMap<string, readonly string[]> = new Map([
  ["providers/deepseek", ["_testOnly"]],
  ["providers/ollama", ["_testOnly"]],
  ["providers/openai", ["_testOnly"]],
  ["providers/openrouter", ["_testOnly"]],
  ["providers/xai", ["_testOnly"]],
]);

interface BarrelPair {
  readonly packageDir: string;
  readonly nodePath: string;
  readonly browserPath: string;
  readonly node: ParsedBarrel;
  readonly browser: ParsedBarrel;
}

function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { workspaces?: unknown };
      if (Array.isArray(pkg.workspaces)) return dir;
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate the workspace root from " + import.meta.url);
}

function barrelPairs(root: string): BarrelPair[] {
  const pairs: BarrelPair[] = [];
  const providersDir = join(root, "providers");
  for (const entry of readdirSync(providersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = `providers/${entry.name}`;
    const nodePath = `${packageDir}/src/ai/index.ts`;
    const browserPath = `${packageDir}/src/ai/index.browser.ts`;
    if (!existsSync(join(root, nodePath)) || !existsSync(join(root, browserPath))) continue;
    pairs.push({
      packageDir,
      nodePath,
      browserPath,
      node: parseBarrel(readFileSync(join(root, nodePath), "utf8")),
      browser: parseBarrel(readFileSync(join(root, browserPath), "utf8")),
    });
  }
  return pairs;
}

/** Sorted so a failure message is stable across runs. */
function nodeOnly(pair: BarrelPair): string[] {
  return [...pair.node.surface].filter((name) => !pair.browser.surface.has(name)).sort();
}

describe("provider ai barrels", () => {
  const root = repoRoot();
  const pairs = barrelPairs(root);

  it("finds the barrel pairs to check", () => {
    // Vacuous-pass guard: the scan keying on a path that no longer exists would
    // otherwise turn this whole file into a no-op.
    expect(pairs.map((pair) => pair.packageDir).sort()).toEqual([...INTENTIONAL_NODE_ONLY.keys()]);
  });

  it("parses every top-level export in both barrels", () => {
    const unparseable = pairs.flatMap((pair) => [
      ...pair.node.unparseable.map((line) => `${pair.nodePath}: ${line}`),
      ...pair.browser.unparseable.map((line) => `${pair.browserPath}: ${line}`),
    ]);
    expect(unparseable).toEqual([]);
  });

  it("exports the same surface from both barrels apart from the pinned node-only names", () => {
    const drift: string[] = [];
    for (const pair of pairs) {
      const expected = [...(INTENTIONAL_NODE_ONLY.get(pair.packageDir) ?? [])].sort();
      const actual = nodeOnly(pair);
      const extra = actual.filter((name) => !expected.includes(name));
      if (extra.length === 0) continue;
      drift.push(
        `${pair.packageDir}: ${pair.nodePath} exports ${extra.join(", ")} but ` +
          `${pair.browserPath} does not`
      );
    }
    expect(drift).toEqual([]);
  });

  it("keeps the node-only pins free of names that no longer differ", () => {
    // Staleness, mirroring `ALLOWED_MISMATCHES` in `ExportTypesPairing.test.ts`:
    // a pin that stops describing a real difference is an exemption nobody
    // asked for, and hides the next omission behind an entry that reads as
    // deliberate.
    const stale: string[] = [];
    for (const [packageDir, names] of INTENTIONAL_NODE_ONLY) {
      const pair = pairs.find((candidate) => candidate.packageDir === packageDir);
      expect(pair, `${packageDir} is pinned but has no barrel pair`).toBeDefined();
      if (pair === undefined) continue;
      const actual = nodeOnly(pair);
      for (const name of names) {
        if (actual.includes(name)) continue;
        stale.push(`${packageDir}: "${name}" is pinned node-only but both barrels export it`);
      }
    }
    expect(stale).toEqual([]);
  });
});

/**
 * The parser. Its behavior on the shapes these barrels really use is what the
 * guard above is worth, so it is exercised directly rather than only through
 * the tree.
 */
describe("barrel parsing", () => {
  it("reads star, named, aliased and locally declared exports", () => {
    const { surface, unparseable } = parseBarrel(
      [
        "/**\n * @license\n */",
        "",
        "// organize-imports-ignore",
        "",
        'export * from "./common/Constants";',
        "export {",
        "  ALLOWED_HOSTS,",
        "  resolveMaxTokens as resolveTokens,",
        "  type Options,",
        '} from "./common/Client";',
        'import { thing } from "./common/Thing";',
        "export const _testOnly = {",
        "  thing,",
        "} as const;",
        "",
      ].join("\n")
    );
    expect(unparseable).toEqual([]);
    expect([...surface].sort()).toEqual([
      '* from "./common/Constants"',
      'ALLOWED_HOSTS from "./common/Client"',
      'Options from "./common/Client"',
      "_testOnly",
      'resolveTokens from "./common/Client"',
    ]);
  });

  it("reports a statement it cannot classify rather than dropping it", () => {
    // Regex-based, so an unrecognized shape must be loud. Silently skipping it
    // would let a real asymmetry ride in on a form nobody taught the parser.
    const { surface, unparseable } = parseBarrel("export default registerThing;\n");
    expect(surface.size).toBe(0);
    expect(unparseable).toEqual(["export default registerThing;"]);
  });

  it("does not read a re-export inside a comment as a statement", () => {
    const { surface } = parseBarrel(
      ['// export * from "./common/Gone";', 'export * from "./common/Here";'].join("\n")
    );
    expect([...surface]).toEqual(['* from "./common/Here"']);
  });
});
