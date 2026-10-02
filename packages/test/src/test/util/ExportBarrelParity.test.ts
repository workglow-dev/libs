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
 * Any `<stem>.browser.ts` under `providers/<vendor>/src/` and the `<stem>.ts`
 * beside it are two hand-maintained views of ONE set of modules, and must
 * export the same surface, except where the difference is deliberate and
 * stated here.
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
 * The scan is recursive but stays scoped to `providers/`, deliberately. Adding
 * `packages/` pulls in `packages/tasks/src/task/image/imageTextRender.browser.ts`,
 * a genuine implementation split whose browser file exports one factory against
 * the node module's fifteen names — an exemption of fifteen entries buying
 * nothing, since the provider tree is where the two-barrel convention lives.
 *
 * This guard is deliberately source-only: it reads the files as text, so it
 * runs under `use-source` and needs no `dist`.
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
 * A specifier, with a trailing `.browser` removed.
 *
 * The browser half of a pair names the browser half of every module it
 * re-exports, so without this every runtime pair reports as pure drift
 * (`* from "./common/Ollama_Client"` against
 * `* from "./common/Ollama_Client.browser"`) and the guard says nothing.
 *
 * The cost is that a star-export comparison across a `.browser` sibling becomes
 * NOMINAL — it asserts the two barrels name the same module NAME, not the same
 * names. The recursive scan is what closes that: `Ollama_Client.browser.ts` and
 * `Ollama_Client.ts` are themselves a compared pair now, so the surface behind
 * the specifier is checked one level down.
 */
function normalizeSpecifier(specifier: string): string {
  return specifier.replace(/\.browser$/, "");
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
      surface.add(`* from "${normalizeSpecifier(star[1] as string)}"`);
      continue;
    }
    const named = /^export\s+(?:type\s+)?\{([\s\S]*?)\}\s*(?:from\s+"([^"]+)")?/.exec(statement);
    if (named !== null) {
      const from = named[2] === undefined ? "" : ` from "${normalizeSpecifier(named[2])}"`;
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
 *
 * Keyed by the BROWSER file path, not the package: a package contributes as
 * many pairs as it has `.browser.ts` siblings, and an exemption belongs to the
 * one file that earns it.
 */
const INTENTIONAL_NODE_ONLY: ReadonlyMap<string, readonly string[]> = new Map([
  ["providers/deepseek/src/ai/index.browser.ts", ["_testOnly"]],
  ["providers/ollama/src/ai/index.browser.ts", ["_testOnly"]],
  ["providers/openai/src/ai/index.browser.ts", ["_testOnly"]],
  ["providers/openrouter/src/ai/index.browser.ts", ["_testOnly"]],
  ["providers/xai/src/ai/index.browser.ts", ["_testOnly"]],
]);

/**
 * Names the BROWSER barrel exports and the node barrel deliberately does not.
 *
 * Empty, and meant to stay that way. The one real case the both-directions
 * check found was `Ollama_JobRunFns.browser.ts` re-exporting `getClient`,
 * `getModelName` and `loadOllamaSDK` from `./Ollama_Client.browser` — and that
 * line was DEAD, not intentional: `runtime.browser.ts` already does
 * `export * from "./common/Ollama_Client.browser"`, so all three names reached
 * `@workglow/ollama/ai-runtime` regardless; `ai/index.browser.ts` never
 * re-exports the run-fns module, so `@workglow/ollama/ai` never saw them; and
 * nothing imported them from that path. It was deleted rather than pinned.
 *
 * Do NOT add an entry here to silence drift. A browser-only name is the same
 * defect as a node-only one, mirrored: a browser consumer compiles against a
 * symbol the node build cannot supply. An entry is a claim that the asymmetry
 * is deliberate, and the staleness check below holds it to that.
 */
const INTENTIONAL_BROWSER_ONLY: ReadonlyMap<string, readonly string[]> = new Map();

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

/** Every `<stem>.browser.ts?` under `dir`, recursively, as paths relative to `root`. */
function browserFilesUnder(root: string, dir: string, out: string[]): void {
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    if (entry.isDirectory()) {
      browserFilesUnder(root, `${dir}/${entry.name}`, out);
      continue;
    }
    if (/\.browser\.tsx?$/.test(entry.name)) out.push(`${dir}/${entry.name}`);
  }
}

/**
 * Whether the browser file is nothing but a re-export of its node sibling.
 *
 * That shape is in parity by construction — it IS the node surface — and it is
 * the shape this convention wants where a package has no platform-specific
 * source. `providers/openrouter/src/ai/runtime.browser.ts` is the one live
 * instance: the two server providers that used to be the example no longer
 * have a browser entry at all. Comparing it would report the node file's every
 * other statement as drift.
 */
function isSiblingReExport(browser: ParsedBarrel, nodeStem: string): boolean {
  return browser.surface.size === 1 && browser.surface.has(`* from "./${nodeStem}"`);
}

function barrelPairs(root: string): BarrelPair[] {
  const pairs: BarrelPair[] = [];
  const providersDir = join(root, "providers");
  for (const entry of readdirSync(providersDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packageDir = `providers/${entry.name}`;
    if (!existsSync(join(root, packageDir, "src"))) continue;
    const browserFiles: string[] = [];
    browserFilesUnder(root, `${packageDir}/src`, browserFiles);
    for (const browserPath of browserFiles) {
      const stem = /^(.+)\.browser\.(tsx?)$/.exec(browserPath);
      if (stem === null) continue;
      const nodePath = `${stem[1]}.${stem[2]}`;
      if (!existsSync(join(root, nodePath))) continue;
      const browser = parseBarrel(readFileSync(join(root, browserPath), "utf8"));
      const nodeStem = (nodePath.split("/").pop() as string).replace(/\.tsx?$/, "");
      if (isSiblingReExport(browser, nodeStem)) continue;
      pairs.push({
        packageDir,
        nodePath,
        browserPath,
        node: parseBarrel(readFileSync(join(root, nodePath), "utf8")),
        browser,
      });
    }
  }
  return pairs;
}

/** Names in `from`'s surface and not in `other`'s. Sorted, so failures are stable. */
function onlyIn(from: ParsedBarrel, other: ParsedBarrel): string[] {
  return [...from.surface].filter((name) => !other.surface.has(name)).sort();
}

function nodeOnly(pair: BarrelPair): string[] {
  return onlyIn(pair.node, pair.browser);
}

function browserOnly(pair: BarrelPair): string[] {
  return onlyIn(pair.browser, pair.node);
}

describe("provider ai barrels", () => {
  const root = repoRoot();
  const pairs = barrelPairs(root);

  it("finds the barrel pairs to check", () => {
    // Vacuous-pass guard, in two parts: the scan reached the provider tree, and
    // it recursed into it. Deliberately NOT an equality against the pinned
    // keys — a pin is an exemption, so requiring one per pair would mean a
    // correct new provider fails until somebody registers it as needing none.
    expect(pairs.length).toBeGreaterThan(40);
    expect(pairs.some((pair) => pair.browserPath.includes("/src/ai/"))).toBe(true);
  });

  it("parses every top-level export in both barrels", () => {
    const unparseable = pairs.flatMap((pair) => [
      ...pair.node.unparseable.map((line) => `${pair.nodePath}: ${line}`),
      ...pair.browser.unparseable.map((line) => `${pair.browserPath}: ${line}`),
    ]);
    expect(unparseable).toEqual([]);
  });

  it("exports the same surface from both barrels apart from the pinned exceptions", () => {
    // Both directions, which is what the title always claimed. A browser-only
    // name is the same defect mirrored: a browser consumer compiles against a
    // symbol the node build cannot supply, and the one-direction check said
    // nothing about it.
    const drift: string[] = [];
    for (const pair of pairs) {
      const pinnedNode = [...(INTENTIONAL_NODE_ONLY.get(pair.browserPath) ?? [])].sort();
      const extraNode = nodeOnly(pair).filter((name) => !pinnedNode.includes(name));
      if (extraNode.length > 0) {
        drift.push(
          `${pair.nodePath} exports ${extraNode.join(", ")} but ${pair.browserPath} does not`
        );
      }
      const pinnedBrowser = [...(INTENTIONAL_BROWSER_ONLY.get(pair.browserPath) ?? [])].sort();
      const extraBrowser = browserOnly(pair).filter((name) => !pinnedBrowser.includes(name));
      if (extraBrowser.length > 0) {
        drift.push(
          `${pair.browserPath} exports ${extraBrowser.join(", ")} but ${pair.nodePath} does not`
        );
      }
    }
    expect(drift).toEqual([]);
  });

  it("keeps the surface pins free of names that no longer differ", () => {
    // Staleness, mirroring `ALLOWED_MISMATCHES` in `ExportTypesPairing.test.ts`:
    // a pin that stops describing a real difference is an exemption nobody
    // asked for, and hides the next omission behind an entry that reads as
    // deliberate.
    const stale: string[] = [];
    const checkStale = (
      pins: ReadonlyMap<string, readonly string[]>,
      side: (pair: BarrelPair) => string[],
      label: string
    ): void => {
      for (const [browserPath, names] of pins) {
        const pair = pairs.find((candidate) => candidate.browserPath === browserPath);
        expect(pair, `${browserPath} is pinned but has no barrel pair`).toBeDefined();
        if (pair === undefined) continue;
        const actual = side(pair);
        for (const name of names) {
          if (actual.includes(name)) continue;
          stale.push(`${browserPath}: "${name}" is pinned ${label} but both barrels export it`);
        }
      }
    };
    checkStale(INTENTIONAL_NODE_ONLY, nodeOnly, "node-only");
    checkStale(INTENTIONAL_BROWSER_ONLY, browserOnly, "browser-only");
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

  it("keys a `.browser` sibling under the same specifier as its node peer", () => {
    // Without this the two halves of every runtime pair agree on nothing and
    // the guard reports each one as total drift.
    const node = parseBarrel('export * from "./common/Ollama_Client";\n');
    const browser = parseBarrel('export * from "./common/Ollama_Client.browser";\n');
    expect([...browser.surface]).toEqual([...node.surface]);
  });

  it("normalizes a `.browser` specifier on a named re-export too", () => {
    const { surface } = parseBarrel('export { createClient } from "./common/Client.browser";\n');
    expect([...surface]).toEqual(['createClient from "./common/Client"']);
  });

  it("does not strip `.browser` from the middle of a specifier", () => {
    const { surface } = parseBarrel('export * from "./common/Client.browser.impl";\n');
    expect([...surface]).toEqual(['* from "./common/Client.browser.impl"']);
  });
});

describe("sibling re-export detection", () => {
  it("recognizes a browser file that is only a re-export of its node peer", () => {
    expect(isSiblingReExport(parseBarrel('export * from "./ai-runtime";\n'), "ai-runtime")).toBe(
      true
    );
  });

  it("does not treat a barrel that also re-exports other modules as one", () => {
    const browser = parseBarrel(
      ['export * from "./ai";', 'export * from "./common/Extra";'].join("\n")
    );
    expect(isSiblingReExport(browser, "ai")).toBe(false);
  });

  it("does not treat a re-export of a different module as one", () => {
    expect(isSiblingReExport(parseBarrel('export * from "./ai/index";\n'), "ai")).toBe(false);
  });

  /**
   * The comparison itself, in both directions. No pair in the tree differs
   * either way once the dead ollama re-export is gone, so the drift branches
   * would otherwise ship untested — and the browser-only one is NEW, so the
   * first case below is the go-red proof: the old one-direction check returned
   * `[]` for exactly this input.
   */
  describe("surface comparison", () => {
    function pairOf(nodeText: string, browserText: string): BarrelPair {
      return {
        packageDir: "providers/p",
        nodePath: "providers/p/src/ai/index.ts",
        browserPath: "providers/p/src/ai/index.browser.ts",
        node: parseBarrel(nodeText),
        browser: parseBarrel(browserText),
      };
    }

    it("reports a name only the browser barrel exports", () => {
      const pair = pairOf('export * from "./A";\n', 'export * from "./A";\nexport * from "./B";\n');
      expect(browserOnly(pair)).toEqual(['* from "./B"']);
      // The half the one-direction check could not see.
      expect(nodeOnly(pair)).toEqual([]);
    });

    it("reports a name only the node barrel exports", () => {
      const pair = pairOf('export * from "./A";\nexport * from "./B";\n', 'export * from "./A";\n');
      expect(nodeOnly(pair)).toEqual(['* from "./B"']);
      expect(browserOnly(pair)).toEqual([]);
    });

    it("says nothing when the surfaces match", () => {
      const pair = pairOf(
        'export * from "./A";\nexport { thing } from "./B";\n',
        'export { thing } from "./B";\nexport * from "./A";\n'
      );
      expect(nodeOnly(pair)).toEqual([]);
      expect(browserOnly(pair)).toEqual([]);
    });
  });
});
