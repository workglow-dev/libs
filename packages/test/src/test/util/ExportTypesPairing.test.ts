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
 * branch*. A branch whose `types` names a different target — or that declares no
 * `types` at all, so resolution falls through to an outer one — hands TypeScript
 * the wrong module: browser consumers of `@workglow/openai/ai` were type-checked
 * against the node build, which exports `_testOnly`,
 * `registerOpenAiImageValidator` and `OpenAI_ModelSearch_Stream` — symbols the
 * browser bundle genuinely does not export.
 */

/** Keys whose value is the module a runtime loads, in resolution order. */
const IMPLEMENTATION_KEYS = ["import", "require", "default"] as const;

/**
 * A string branch value that is a module rather than a plain asset, so
 * `"./package.json": "./package.json"` is not treated as a missing declaration.
 */
const MODULE_PATH = /\.[cm]?js$/;

/**
 * Branches allowed to pair a `types` target with a differently-named
 * implementation. Each entry must say why the declaration genuinely describes
 * the other file. Empty on purpose: do not add an entry to silence drift — fix
 * the manifest, or emit the missing declaration.
 */
const ALLOWED_MISMATCHES: ReadonlySet<string> = new Set<string>([]);

interface BranchLocation {
  readonly manifest: string;
  readonly subpath: string;
  readonly condition: string;
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

function collectBranches(
  manifest: string,
  subpath: string,
  conditionPath: readonly string[],
  node: unknown,
  out: Branch[]
): void {
  const condition = conditionPath.join(" > ") || "(default)";
  // Shorthand: the condition's value *is* the implementation, so nothing beside
  // it can declare types and resolution falls through to an outer `types`.
  if (typeof node === "string") {
    if (MODULE_PATH.test(node)) {
      out.push({
        manifest,
        subpath,
        condition,
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
  const implementation = IMPLEMENTATION_KEYS.map((key) => entry[key]).find(
    (value): value is string => typeof value === "string"
  );
  if (implementation !== undefined) {
    const location: BranchLocation = {
      manifest,
      subpath,
      condition,
      implementation,
      expectedTypes: declarationFor(implementation),
    };
    const types = entry.types;
    out.push(
      typeof types === "string"
        ? { ...location, types, reason: "mismatch" }
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
  return `${branch.manifest} exports["${branch.subpath}"] [${branch.condition}]`;
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

function manifestsWithExports(): Manifest[] {
  const root = workspaceRoot();
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
  const manifests = manifestsWithExports();
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
      'fixture/package.json exports["."] [browser]: implementation "./dist/ai.browser.js" ' +
        'declares no types (expected types="./dist/ai.browser.d.ts")',
    ]);
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
      'fixture/package.json exports["."] [require]: types="./dist/ai.d.ts" but implementation ' +
        'is "./dist/ai.cjs" (expected types="./dist/ai.d.cts")',
    ]);
  });

  it("ignores a non-module string value such as the package manifest itself", () => {
    expect(findViolations("fixture/package.json", { "./package.json": "./package.json" })).toEqual(
      []
    );
  });
});
