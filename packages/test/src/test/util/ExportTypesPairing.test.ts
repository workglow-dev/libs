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
 * Every condition branch in an `exports` map that names an implementation must
 * declare the `types` target belonging to the implementation named *in that same
 * branch*. A branch whose `types` names a different target hands TypeScript the
 * wrong module: browser consumers of `@workglow/openai/ai` were type-checked
 * against the node build, which exports `_testOnly`,
 * `registerOpenAiImageValidator` and `OpenAI_ModelSearch_Stream` — symbols the
 * browser bundle genuinely does not export.
 *
 * A branch that declares no `types` is not typed by an outer one: resolution
 * stops at the branch that matched, and TypeScript then looks for a declaration
 * beside the resolved implementation (`.js` -> `.d.ts`). Declaring it explicitly
 * is what makes the pairing checkable here, and what survives a build that emits
 * the implementation without an adjacent declaration.
 */

/** Keys whose value is the module a runtime loads, in resolution order. */
const IMPLEMENTATION_KEYS = ["import", "require", "default"] as const;

/**
 * A string branch value that is a module rather than a plain asset, so
 * `"./package.json": "./package.json"` is not treated as a missing declaration.
 */
const MODULE_PATH = /\.[cm]?js$/;

/**
 * Branches exempt from the pairing rule, by label. An entry silences that
 * branch's violation whichever kind it is — a `types` naming a different target,
 * or an implementation with no `types` beside it. Each entry must say why the
 * declaration genuinely describes the other file. Empty on purpose: do not add
 * an entry to silence drift — fix the manifest, or emit the missing declaration.
 */
const ALLOWED_MISMATCHES: ReadonlySet<string> = new Set<string>([]);

interface BranchLocation {
  readonly manifest: string;
  readonly subpath: string;
  readonly condition: string;
  /**
   * Which of {@link IMPLEMENTATION_KEYS} named this implementation, or
   * `undefined` for the string-shorthand form where the condition's own value
   * IS the implementation and there is no separate key.
   *
   * Part of the identity because one object can now yield several branches —
   * `{types, require, default}` produces one per string-valued implementation
   * key — and they would otherwise share a label, colliding as the key for
   * `ALLOWED_MISMATCHES` and the staleness check.
   */
  readonly implementationKey: string | undefined;
  readonly implementation: string;
  readonly expectedTypes: string;
}

/**
 * A branch that declares `types`. It can only fail by naming the wrong
 * declaration, so its violation reason is fixed at collection time.
 */
interface DeclaredBranch extends BranchLocation {
  readonly reason: "mismatch";
  readonly types: string;
  /** Whether `types` precedes the implementation key in the same object. */
  readonly typesBeforeImplementation: boolean;
}

/** A branch naming an implementation with no `types` beside it. */
interface UndeclaredBranch extends BranchLocation {
  readonly reason: "missing";
  readonly types: undefined;
}

type Branch = DeclaredBranch | UndeclaredBranch;

/**
 * TypeScript honors a declaration extension only when it matches the module's:
 * `.cjs` is described by `.d.cts` and `.mjs` by `.d.mts`, not by `.d.ts`.
 */
function declarationFor(implementation: string): string {
  if (implementation.endsWith(".cjs")) return implementation.replace(/\.cjs$/, ".d.cts");
  if (implementation.endsWith(".mjs")) return implementation.replace(/\.mjs$/, ".d.mts");
  return implementation.replace(/\.js$/, ".d.ts");
}

/** Source entry extensions a `dist` target can be built from. */
const SOURCE_ENTRY_EXTENSIONS = [".ts", ".tsx"] as const;

/** `./dist/<stem>.<ext>` -> `<stem>`, or undefined for a layout this rule cannot describe. */
function distStem(target: string): string | undefined {
  return /^\.\/dist\/(.+?)(?:\.d\.ts|\.d\.cts|\.d\.mts|\.js|\.cjs|\.mjs)$/.exec(target)?.[1];
}

/** Repo-relative source entry candidates for a target declared by `manifest`. */
function sourceCandidates(manifest: string, target: string): readonly string[] | undefined {
  const stem = distStem(target);
  if (stem === undefined) return undefined;
  const packageDir = dirname(manifest);
  return SOURCE_ENTRY_EXTENSIONS.map((ext) => `${packageDir}/src/${stem}${ext}`);
}

function collectBranches(
  manifest: string,
  subpath: string,
  conditionPath: readonly string[],
  node: unknown,
  out: Branch[]
): void {
  const condition = conditionPath.join(" > ") || "(default)";
  // Shorthand: the condition's value *is* the implementation, so nothing beside
  // it can declare types; TypeScript falls back to the declaration adjacent to
  // the resolved file rather than to an outer `types`.
  if (typeof node === "string") {
    if (MODULE_PATH.test(node)) {
      out.push({
        manifest,
        subpath,
        condition,
        implementationKey: undefined,
        types: undefined,
        reason: "missing",
        implementation: node,
        expectedTypes: declarationFor(node),
      });
    }
    return;
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;
  const entry = node as Record<string, unknown>;
  // EVERY string-valued implementation key, not just the first. A dual-package
  // object writes them flat — `{types, import: "./a.mjs", require: "./a.cjs"}` —
  // and taking only `import` left `require` unchecked, so a `.cjs` paired with a
  // `.d.ts` sailed through. The file's own `.cjs` fixtures use the nested form,
  // which is why the flat shape was never exercised.
  const implementationKeys = IMPLEMENTATION_KEYS.filter((key) => typeof entry[key] === "string");
  const keys = Object.keys(entry);
  for (const implementationKey of implementationKeys) {
    const implementation = entry[implementationKey] as string;
    const location: BranchLocation = {
      manifest,
      subpath,
      condition,
      implementationKey,
      implementation,
      expectedTypes: declarationFor(implementation),
    };
    const types = entry.types;
    out.push(
      typeof types === "string"
        ? {
            ...location,
            types,
            reason: "mismatch",
            // Node stops at the first matching condition, so a `types` declared
            // after the implementation key is never reached.
            typesBeforeImplementation: keys.indexOf("types") < keys.indexOf(implementationKey),
          }
        : { ...location, types: undefined, reason: "missing" }
    );
  }
  for (const [key, value] of Object.entries(entry)) {
    if (key === "types") continue;
    // An implementation key holding a string is this branch's implementation,
    // already recorded above. Holding an object it is a nested condition — the
    // `{ "import": { "types": …, "default": … } }` dual-package form — and its
    // pairing has to be checked like any other branch's.
    const isImplementationString =
      (IMPLEMENTATION_KEYS as readonly string[]).includes(key) && typeof value === "string";
    if (isImplementationString) continue;
    collectBranches(manifest, subpath, [...conditionPath, key], value, out);
  }
}

function label(branch: Branch): string {
  const key = branch.implementationKey === undefined ? "" : ` > ${branch.implementationKey}`;
  return `${branch.manifest} exports["${branch.subpath}"] [${branch.condition}${key}]`;
}

function isViolation(branch: Branch): boolean {
  if (branch.reason === "missing") return true;
  return branch.types !== branch.expectedTypes;
}

function violationMessage(branch: Branch): string {
  if (branch.reason === "missing") {
    return (
      `${label(branch)}: implementation "${branch.implementation}" declares no types ` +
      `(expected types="${branch.expectedTypes}")`
    );
  }
  return (
    `${label(branch)}: types="${branch.types}" but implementation is ` +
    `"${branch.implementation}" (expected types="${branch.expectedTypes}")`
  );
}

function branchesFor(manifest: string, exportsMap: Record<string, unknown>): Branch[] {
  const branches: Branch[] = [];
  for (const [subpath, value] of Object.entries(exportsMap)) {
    collectBranches(manifest, subpath, [], value, branches);
  }
  return branches;
}

/** Every branch of one `exports` map that pairs its implementation wrongly. */
function findViolations(manifest: string, exportsMap: Record<string, unknown>): string[] {
  return branchesFor(manifest, exportsMap)
    .filter(isViolation)
    .filter((branch) => !ALLOWED_MISMATCHES.has(label(branch)))
    .map(violationMessage);
}

/**
 * Conditions a plain `import` under Node matches, in the order Node tries
 * them. `browser`, `bun` and `react-native` are deliberately absent: the point
 * is to find the target a NODE consumer lands on, which is what a browser split
 * has to differ from.
 */
const NODE_IMPORT_CONDITIONS: ReadonlySet<string> = new Set(["node", "import", "default"]);

/**
 * The implementation a plain Node `import` of one subpath resolves to, or
 * `undefined` when nothing in the branch resolves under Node's conditions.
 * `types` is skipped because Node does not know that condition — only
 * TypeScript does.
 */
function nodeImportTarget(node: unknown): string | undefined {
  if (typeof node === "string") return MODULE_PATH.test(node) ? node : undefined;
  if (typeof node !== "object" || node === null || Array.isArray(node)) return undefined;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "types" || !NODE_IMPORT_CONDITIONS.has(key)) continue;
    const resolved = nodeImportTarget(value);
    if (resolved !== undefined) return resolved;
  }
  return undefined;
}

/** Every implementation string reachable inside one condition branch. */
function implementationsIn(node: unknown, out: string[]): void {
  if (typeof node === "string") {
    if (MODULE_PATH.test(node)) out.push(node);
    return;
  }
  if (typeof node !== "object" || node === null || Array.isArray(node)) return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === "types") continue;
    implementationsIn(value, out);
  }
}

/**
 * Subpaths that have a browser source entry beside them but do not route
 * browser consumers to it.
 *
 * Every other check in this file is internally self-consistent — it compares a
 * branch against itself — so a `browser` block that is a byte-for-byte copy of
 * the default branch passes all six while sending browser consumers to the NODE
 * bundle. That shape exists in the repo today (`providers/chrome-ai`,
 * `providers/tf-mediapipe`), where it is inert because neither package HAS a
 * browser source entry: the two bundles are legitimately the same file. The
 * source entry is what turns the duplicate into a bug, so it is what this rule
 * keys on — and why the probe is injected rather than performed here, so
 * fixtures can drive both sides of it.
 */
function browserSplitViolations(
  manifest: string,
  exportsMap: Record<string, unknown>,
  hasSourceEntry: (repoRelativePath: string) => boolean
): string[] {
  const out: string[] = [];
  const packageDir = dirname(manifest);
  for (const [subpath, value] of Object.entries(exportsMap)) {
    const nodeTarget = nodeImportTarget(value);
    if (nodeTarget === undefined) continue;
    const stem = distStem(nodeTarget);
    if (stem === undefined) continue;
    const browserEntry = SOURCE_ENTRY_EXTENSIONS.map(
      (ext) => `${packageDir}/src/${stem}.browser${ext}`
    );
    // No browser source entry: the packages under `packages/*` land here (stem
    // `node`, no `src/node.browser.ts`), as do the byte-duplicate provider
    // blocks. Nothing to split, so nothing to say.
    if (!browserEntry.some((candidate) => hasSourceEntry(candidate))) continue;

    const expected = `./dist/${stem}.browser.js`;
    const at = `${manifest} exports["${subpath}"]`;
    const branch = (value as Record<string, unknown>)?.browser;
    if (branch === undefined) {
      out.push(
        `${at}: ${browserEntry[0]} exists but no "browser" condition is declared, so browser ` +
          `consumers resolve the node bundle "${nodeTarget}" (expected "${expected}")`
      );
      continue;
    }
    const implementations: string[] = [];
    implementationsIn(branch, implementations);
    for (const implementation of implementations) {
      if (implementation === expected) continue;
      out.push(
        `${at} [browser]: implementation "${implementation}" is not the browser bundle, but ` +
          `${browserEntry[0]} exists (expected "${expected}")`
      );
    }
  }
  return out;
}

/**
 * Whether a value is selected unconditionally, so a runtime can never fall past
 * it to a later sibling. A string target always is. An object is only when one
 * of its own implementation keys resolves — a nested object holding nothing but
 * further conditions (`{ browser: … }`) leaves a runtime free to fall through.
 */
function resolvesUnconditionally(value: unknown): boolean {
  if (typeof value === "string") return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return IMPLEMENTATION_KEYS.some((key) => key in entry && resolvesUnconditionally(entry[key]));
}

function isImplementationString(entry: Record<string, unknown>, key: string): boolean {
  return (IMPLEMENTATION_KEYS as readonly string[]).includes(key) && typeof entry[key] === "string";
}

/**
 * Whether this key shadows the siblings declared after it. String-valued
 * implementation keys always did; an implementation key holding an OBJECT does
 * too whenever that object resolves unconditionally, which a string-only test
 * missed — `{ "import": { default: … }, "browser": … }` reads as two conditions
 * and behaves as one dead branch.
 */
function isShadowingImplementation(entry: Record<string, unknown>, key: string): boolean {
  return (
    (IMPLEMENTATION_KEYS as readonly string[]).includes(key) && resolvesUnconditionally(entry[key])
  );
}

/**
 * Condition keys made unreachable by a SIBLING declared before them.
 *
 * The pairing rule and its `typesBeforeImplementation` flag both look inside a
 * single object, so they see nothing wrong with a map whose branches are
 * individually well formed but ordered so that one can never be selected.
 * Resolution stops at the first key that matches, so:
 *
 * - `{types, browser: {…}, import}` — TypeScript matches the outer `types` and
 *   never looks at `browser`, which is exactly the browser-typed-as-node bug
 *   this file exists to prevent, expressed through ordering instead of through
 *   a wrong target; and
 * - `{import, browser: {…}}` — a runtime honoring `browser` still matches
 *   `import` first, so the browser build never loads.
 *
 * Both shapes yield `violations: []` and `late: []` from the existing checks.
 *
 * The string-shorthand form (`browser: "./dist/x.js"`) is included: it is just
 * as dead as the object form, and this repo demonstrably writes it.
 */
function orderViolations(manifest: string, exportsMap: Record<string, unknown>): string[] {
  const out: string[] = [];
  const walk = (subpath: string, conditionPath: readonly string[], node: unknown): void => {
    if (typeof node !== "object" || node === null || Array.isArray(node)) return;
    const entry = node as Record<string, unknown>;
    const keys = Object.keys(entry);
    const typesIndex = keys.indexOf("types");
    const implementationIndex = keys.findIndex((key) => isShadowingImplementation(entry, key));
    const where = conditionPath.join(" > ") || "(default)";
    const at = `${manifest} exports["${subpath}"] [${where}]`;

    keys.forEach((key, index) => {
      // Only condition keys can be shadowed. `types` and the implementation
      // strings are the things that DO the shadowing.
      if (key === "types" || isImplementationString(entry, key)) return;
      if (typesIndex >= 0 && typesIndex < index) {
        out.push(
          `${at}: condition "${key}" is declared after "types", so TypeScript resolves ` +
            `"types" first and "${key}" is never reached`
        );
      }
      if (implementationIndex >= 0 && implementationIndex < index) {
        out.push(
          `${at}: condition "${key}" is declared after "${keys[implementationIndex]}", so ` +
            `resolution stops there and "${key}" is never reached`
        );
      }
    });

    for (const [key, value] of Object.entries(entry)) {
      if (key === "types" || typeof value === "string") continue;
      walk(subpath, [...conditionPath, key], value);
    }
  };
  for (const [subpath, value] of Object.entries(exportsMap)) {
    walk(subpath, [], value);
  }
  return out;
}

interface WorkspaceRoot {
  readonly dir: string;
  /** Directories holding workspace packages, from the root `workspaces` globs. */
  readonly groups: readonly string[];
}

function workspaceRoot(): WorkspaceRoot {
  // Walk up from this file until the workspace root manifest is found.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { workspaces?: unknown };
      if (Array.isArray(pkg.workspaces)) {
        const groups = pkg.workspaces
          .filter((pattern): pattern is string => typeof pattern === "string")
          .map((pattern) => pattern.replace(/^\.\//, "").replace(/\/\*+$/, ""))
          .filter((group) => !group.includes("*"));
        return { dir, groups };
      }
    }
    dir = dirname(dir);
  }
  throw new Error("could not locate the workspace root from " + import.meta.url);
}

/** Every workspace manifest, as a repo-root-relative path. */
function workspaceManifests(root: WorkspaceRoot): string[] {
  const manifests: string[] = [];
  for (const group of root.groups) {
    const groupDir = join(root.dir, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (existsSync(join(groupDir, entry.name, "package.json"))) {
        manifests.push(`${group}/${entry.name}/package.json`);
      }
    }
  }
  return manifests.sort();
}

interface Manifest {
  readonly relative: string;
  readonly exports: Record<string, unknown>;
}

function manifestsWithExports(root: WorkspaceRoot): Manifest[] {
  const found: Manifest[] = [];
  for (const relative of workspaceManifests(root)) {
    const pkg = JSON.parse(readFileSync(join(root.dir, relative), "utf8")) as {
      exports?: Record<string, unknown>;
    };
    if (!pkg.exports) continue;
    found.push({ relative, exports: pkg.exports });
  }
  return found;
}

describe("workspace exports maps", () => {
  const root = workspaceRoot();
  const manifests = manifestsWithExports(root);
  const branches = manifests.flatMap((manifest) =>
    branchesFor(manifest.relative, manifest.exports)
  );

  it("finds condition branches to check", () => {
    // Guards against the scan silently finding nothing and the suite passing vacuously.
    expect(branches.length).toBeGreaterThan(50);
  });

  it("pairs every `types` target with the implementation beside it", () => {
    const violations = manifests.flatMap((manifest) =>
      findViolations(manifest.relative, manifest.exports)
    );
    expect(violations).toEqual([]);
  });

  it("declares only targets a source entry file can emit", () => {
    // Pairing alone cannot see a self-consistent branch for a build that does not
    // exist — copying another package's `browser` block declares a `.d.ts`/`.js`
    // pair naming each other correctly while nothing emits either file. The
    // source entry beside them is the cheapest evidence that the build produces
    // the target at all.
    const unrecognized: string[] = [];
    const missing: string[] = [];
    for (const branch of branches) {
      for (const target of [branch.types, branch.implementation]) {
        if (target === undefined) continue;
        const candidates = sourceCandidates(branch.manifest, target);
        if (candidates === undefined) {
          unrecognized.push(`${label(branch)}: "${target}" is not ./dist/<stem>.<ext>`);
          continue;
        }
        if (candidates.some((candidate) => existsSync(join(root.dir, candidate)))) continue;
        missing.push(
          `${label(branch)}: "${target}" has no source entry (${candidates.join(" or ")})`
        );
      }
    }
    // A target whose layout the derivation cannot describe is reported, not
    // skipped: silently skipping it would reopen the hole this closes.
    expect(unrecognized).toEqual([]);
    expect(missing).toEqual([]);
  });

  it("declares `types` before the implementation in the same branch", () => {
    const late = branches
      .filter((branch): branch is DeclaredBranch => branch.reason === "mismatch")
      .filter((branch) => !branch.typesBeforeImplementation)
      .map(
        (branch) =>
          `${label(branch)}: types="${branch.types}" is declared after "${branch.implementation}"`
      );
    expect(late).toEqual([]);
  });

  it("routes browser consumers to the browser bundle wherever one is built", () => {
    const split = manifests.flatMap((manifest) =>
      browserSplitViolations(manifest.relative, manifest.exports, (candidate) =>
        existsSync(join(root.dir, candidate))
      )
    );
    expect(split).toEqual([]);
  });

  it("declares every condition before the siblings that would shadow it", () => {
    const shadowed = manifests.flatMap((manifest) =>
      orderViolations(manifest.relative, manifest.exports)
    );
    expect(shadowed).toEqual([]);
  });

  it("keeps the allowlist free of entries that no longer mismatch", () => {
    const stale = [...ALLOWED_MISMATCHES].filter(
      (entry) => !branches.some((branch) => label(branch) === entry && isViolation(branch))
    );
    expect(stale).toEqual([]);
  });
});

/**
 * A correct manifest is only half of it: TypeScript's condition set is
 * `["import", "types"]` under `moduleResolution: "bundler"`, so `"browser"` is
 * never applied unless the consumer names it in `customConditions`. Without that
 * line a browser project bundles `dist/browser.js` while `tsc` type-checks it
 * against the node declarations — no error anywhere, and the symbols the browser
 * bundle omits still autocomplete.
 */
/** `tsconfig.json` is JSONC, so its comments have to go before `JSON.parse`. */
function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text[i + 1] ?? "";
        i++;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
      continue;
    }
    if (char === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 1;
      continue;
    }
    out += char;
  }
  return out;
}

describe("browser consumers opt into the browser condition", () => {
  it("examples/web sets customConditions", () => {
    // examples/web is the repo's only browser-bundled TypeScript project, and it
    // imports packages that carry `browser` conditions (`@workglow/util`,
    // `@workglow/indexeddb/storage`, `@workglow/tf-mediapipe/ai`). If that project
    // is renamed or moved, repoint this path at its replacement rather than
    // deleting the check.
    const root = workspaceRoot();
    const tsconfig = JSON.parse(
      stripJsonComments(readFileSync(join(root.dir, "examples/web/tsconfig.json"), "utf8"))
    ) as { compilerOptions?: { customConditions?: readonly string[] } };
    expect(tsconfig.compilerOptions?.customConditions).toContain("browser");
  });
});

/**
 * No manifest violates these rules today, so the code paths that catch them would
 * ship untested. These fixtures exercise them directly.
 */
describe("exports map violation detection", () => {
  it("catches a string-shorthand branch that declares no types", () => {
    expect(
      findViolations("fixture/package.json", {
        ".": {
          browser: "./dist/ai.browser.js",
          types: "./dist/ai.node.d.ts",
          import: "./dist/ai.node.js",
        },
      })
    ).toEqual([
      'fixture/package.json exports["."] [browser]: implementation "./dist/ai.browser.js" ' +
        'declares no types (expected types="./dist/ai.browser.d.ts")',
    ]);
  });

  it("catches an object branch with an implementation but no types", () => {
    expect(
      findViolations("fixture/package.json", {
        ".": {
          browser: { import: "./dist/ai.browser.js" },
          types: "./dist/ai.node.d.ts",
          import: "./dist/ai.node.js",
        },
      })
    ).toEqual([
      'fixture/package.json exports["."] [browser > import]: implementation ' +
        '"./dist/ai.browser.js" declares no types (expected types="./dist/ai.browser.d.ts")',
    ]);
  });

  /**
   * A flat dual-package object. `IMPLEMENTATION_KEYS.find(...)` stopped at
   * `import`, so `require`'s `.cjs` was never paired against anything and its
   * `.d.ts` mismatch went unreported. The nested `require: {types, default}`
   * form the fixtures below use is what hid this.
   */
  it("checks every implementation key in a flat dual-package branch", () => {
    expect(
      findViolations("fixture/package.json", {
        ".": {
          types: "./dist/a.d.ts",
          import: "./dist/a.js",
          require: "./dist/a.cjs",
        },
      })
    ).toEqual([
      'fixture/package.json exports["."] [(default) > require]: types="./dist/a.d.ts" but ' +
        'implementation is "./dist/a.cjs" (expected types="./dist/a.d.cts")',
    ]);
  });

  it("does not turn extra agreeing implementation keys into noise", () => {
    expect(
      findViolations("fixture/package.json", {
        ".": {
          types: "./dist/a.d.ts",
          import: "./dist/a.js",
          default: "./dist/a.js",
        },
      })
    ).toEqual([]);
  });

  it("accepts a `.cjs`/`.mjs` implementation declared by its own extension", () => {
    expect(
      findViolations("fixture/package.json", {
        ".": {
          require: { types: "./dist/ai.d.cts", default: "./dist/ai.cjs" },
          types: "./dist/ai.d.mts",
          import: "./dist/ai.mjs",
        },
      })
    ).toEqual([]);
  });

  it("rejects a `.cjs` implementation declared by a `.d.ts`", () => {
    expect(
      findViolations("fixture/package.json", {
        ".": {
          require: { types: "./dist/ai.d.ts", default: "./dist/ai.cjs" },
          types: "./dist/ai.d.mts",
          import: "./dist/ai.mjs",
        },
      })
    ).toEqual([
      'fixture/package.json exports["."] [require > default]: types="./dist/ai.d.ts" but ' +
        'implementation is "./dist/ai.cjs" (expected types="./dist/ai.d.cts")',
    ]);
  });

  it("ignores a non-module string value such as the package manifest itself", () => {
    expect(findViolations("fixture/package.json", { "./package.json": "./package.json" })).toEqual(
      []
    );
  });

  /**
   * Ordering hazards. Each shape is internally well formed — every `types`
   * names the right target beside the right implementation — so the pairing
   * rule and the `typesBeforeImplementation` flag both pass them, which is the
   * whole reason the order check has to exist separately.
   */
  describe("condition ordering", () => {
    const outerTypesFirst = {
      ".": {
        types: "./dist/node.d.ts",
        browser: { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
        import: "./dist/node.js",
      },
    };

    it("reports a nested condition shadowed by an outer `types`", () => {
      // Documenting WHY a second check is needed: the pairing rule is silent
      // here, so without this the dead `browser` branch ships unnoticed.
      expect(findViolations("fixture/package.json", outerTypesFirst)).toEqual([]);

      expect(orderViolations("fixture/package.json", outerTypesFirst)).toEqual([
        'fixture/package.json exports["."] [(default)]: condition "browser" is declared after ' +
          '"types", so TypeScript resolves "types" first and "browser" is never reached',
      ]);
    });

    it("reports a nested condition shadowed by an implementation key", () => {
      const implementationFirst = {
        ".": {
          import: "./dist/node.js",
          browser: { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
        },
      };
      expect(orderViolations("fixture/package.json", implementationFirst)).toEqual([
        'fixture/package.json exports["."] [(default)]: condition "browser" is declared after ' +
          '"import", so resolution stops there and "browser" is never reached',
      ]);
    });

    // Guards against an "objects only" implementation: a string shorthand is
    // just as dead, and this repo writes that form.
    it("reports a string-shorthand condition declared after `types`", () => {
      const shorthandLate = {
        ".": {
          types: "./dist/node.d.ts",
          import: "./dist/node.js",
          browser: "./dist/browser.js",
        },
      };
      expect(orderViolations("fixture/package.json", shorthandLate)).toEqual([
        'fixture/package.json exports["."] [(default)]: condition "browser" is declared after ' +
          '"types", so TypeScript resolves "types" first and "browser" is never reached',
        'fixture/package.json exports["."] [(default)]: condition "browser" is declared after ' +
          '"import", so resolution stops there and "browser" is never reached',
      ]);
    });

    it("accepts a condition declared before both", () => {
      expect(
        orderViolations("fixture/package.json", {
          ".": {
            browser: { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
            types: "./dist/node.d.ts",
            import: "./dist/node.js",
          },
        })
      ).toEqual([]);
    });
  });

  /**
   * The browser/node split. The probe is injected, so each fixture states both
   * the manifest shape AND whether the browser source entry exists — the pair
   * this rule is a function of.
   */
  describe("browser split", () => {
    const always = (): boolean => true;
    const never = (): boolean => false;

    /** `providers/chrome-ai` verbatim: `browser` duplicates the default branch. */
    const duplicatedBrowserBlock = {
      "./ai": {
        browser: { types: "./dist/ai.d.ts", import: "./dist/ai.js" },
        types: "./dist/ai.d.ts",
        import: "./dist/ai.js",
      },
    };

    it("reports a browser condition that names the node bundle", () => {
      // The go-red proof: every other check in this file passes this manifest.
      expect(findViolations("providers/chrome-ai/package.json", duplicatedBrowserBlock)).toEqual(
        []
      );
      expect(orderViolations("providers/chrome-ai/package.json", duplicatedBrowserBlock)).toEqual(
        []
      );

      expect(
        browserSplitViolations("providers/chrome-ai/package.json", duplicatedBrowserBlock, always)
      ).toEqual([
        'providers/chrome-ai/package.json exports["./ai"] [browser]: implementation ' +
          '"./dist/ai.js" is not the browser bundle, but providers/chrome-ai/src/ai.browser.ts ' +
          'exists (expected "./dist/ai.browser.js")',
      ]);
    });

    it("says nothing about that same shape while no browser source entry exists", () => {
      // Today's tree. chrome-ai and tf-mediapipe are browser-only packages with
      // one entry each, so the duplicate is honest and must not be repointed at
      // a bundle nothing builds.
      expect(
        browserSplitViolations("providers/chrome-ai/package.json", duplicatedBrowserBlock, never)
      ).toEqual([]);
    });

    it("accepts a provider that splits its browser entry properly", () => {
      expect(
        browserSplitViolations(
          "providers/deepseek/package.json",
          {
            "./ai": {
              browser: { types: "./dist/ai.browser.d.ts", import: "./dist/ai.browser.js" },
              types: "./dist/ai.d.ts",
              import: "./dist/ai.js",
            },
          },
          always
        )
      ).toEqual([]);
    });

    it("reports a built browser entry that no condition routes to", () => {
      expect(
        browserSplitViolations(
          "providers/deepseek/package.json",
          { "./ai": { types: "./dist/ai.d.ts", import: "./dist/ai.js" } },
          always
        )
      ).toEqual([
        'providers/deepseek/package.json exports["./ai"]: providers/deepseek/src/ai.browser.ts ' +
          'exists but no "browser" condition is declared, so browser consumers resolve the node ' +
          'bundle "./dist/ai.js" (expected "./dist/ai.browser.js")',
      ]);
    });

    it("leaves the packages/* browser/node layout alone", () => {
      // Stem `node`, so the probe asks for `src/node.browser.ts` and finds
      // nothing — the split here is expressed as two peer entries, not a
      // `.browser` suffix, and must not be reported as missing one.
      expect(
        browserSplitViolations(
          "packages/storage/package.json",
          {
            ".": {
              browser: { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
              types: "./dist/node.d.ts",
              import: "./dist/node.js",
            },
          },
          never
        )
      ).toEqual([]);
    });
  });

  /**
   * A nested implementation object shadows exactly like a string one when it
   * always resolves, and not at all when it does not.
   */
  describe("object-valued implementation keys as shadowers", () => {
    it("reports a condition hidden behind a nested `import` that always resolves", () => {
      expect(
        orderViolations("fixture/package.json", {
          ".": {
            import: { types: "./dist/node.d.ts", default: "./dist/node.js" },
            browser: { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
          },
        })
      ).toEqual([
        'fixture/package.json exports["."] [(default)]: condition "browser" is declared after ' +
          '"import", so resolution stops there and "browser" is never reached',
      ]);
    });

    it("does not treat a nested object with no unconditional target as a shadower", () => {
      // `{ import: { node: … } }` resolves to nothing off Node, so a runtime
      // falls through to `browser` exactly as written.
      expect(
        orderViolations("fixture/package.json", {
          ".": {
            import: { node: "./dist/node.js" },
            browser: { types: "./dist/browser.d.ts", import: "./dist/browser.js" },
          },
        })
      ).toEqual([]);
    });
  });

  it("derives a source entry from a dist target", () => {
    expect(sourceCandidates("providers/openai/package.json", "./dist/ai.browser.d.ts")).toEqual([
      "providers/openai/src/ai.browser.ts",
      "providers/openai/src/ai.browser.tsx",
    ]);
    // A nested stem keeps its directory, so `./dist/storage/bun.js` is built
    // from `src/storage/bun.ts`, not from a flattened `src/bun.ts`.
    expect(sourceCandidates("providers/sqlite/package.json", "./dist/storage/bun.js")).toEqual([
      "providers/sqlite/src/storage/bun.ts",
      "providers/sqlite/src/storage/bun.tsx",
    ]);
    // The declaration extension is part of the suffix, so `.d.cts` strips whole
    // rather than leaving a `ai.d` stem.
    expect(sourceCandidates("p/package.json", "./dist/ai.d.cts")).toEqual([
      "p/src/ai.ts",
      "p/src/ai.tsx",
    ]);
  });

  it("reports a target outside ./dist as underivable rather than skipping it", () => {
    expect(sourceCandidates("p/package.json", "./lib/ai.js")).toBeUndefined();
  });
});
